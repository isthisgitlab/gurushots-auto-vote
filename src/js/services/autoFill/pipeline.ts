/**
 * Auto-fill — the shared fill pipeline: load and score candidates, enrich the
 * contested ones, visually verify the pick, and submit (runFillAttempt), plus
 * the submit-free ranking the swap flow uses (rankCandidatesForChallenge).
 */

import { buildScoredCandidates, selectEnrichmentSet, finalizePick } from '../photoPicker';
import { rankVisually } from '../visionVerifier';
import { enrichCandidates } from '../photoStats';
import { resolveSemanticScores, resolveIgnoreWords, fetchCandidatesForChallenge } from './candidates';
import { refreshChallengeState } from './challengeState';
import { describeSubmitFailure, makeFallbackLogger, logPopularityPick, logSelectionDetails } from './fillLogging';

import type { Challenge } from '../../types/gurushots';
import type { IgnoreWords, PickerPhoto, ScoredCandidate, SemanticScoreMap } from '../../types/photoPicker';
import type { FetchErrorResult, FillAttemptParams, FillAttemptResult, RankDeps } from '../../types/autoFill';
import { errorMessage } from '../../errorMessage';

/**
 * First half of the fill pipeline: fetch the candidate library for a challenge
 * and score it semantically. Shared by runFillAttempt and
 * rankCandidatesForChallenge so a swap ranks photos exactly the way a fill
 * does.
 */
const loadFillCandidates = async ({
    label,
    challenge,
    token,
    deps,
    mustIncludeTags,
    shouldIncludeTags,
    usage,
}: {
    label: string;
    challenge: Challenge;
    token: string;
    deps: RankDeps;
    mustIncludeTags: readonly string[] | null;
    shouldIncludeTags: readonly string[] | null;
    usage?: string;
}): Promise<
    | FetchErrorResult
    | { status: 'loaded'; eligible: PickerPhoto[]; semanticScores: SemanticScoreMap | null; ignoreWords: IgnoreWords }
> => {
    const { logger, getEligiblePhotos, searchTagAutocomplete, getCurrentMemberProfile } = deps;
    // One lookup for the whole fill — see resolveIgnoreWords for why it is not
    // threaded in from each caller like the tag settings are.
    const ignoreWords = resolveIgnoreWords(deps.settings, challenge);

    let eligible;
    try {
        eligible = await fetchCandidatesForChallenge(
            challenge,
            token,
            { mustIncludeTags, shouldIncludeTags, ignoreWords },
            // Forward the tag-resolution pair. This call rebuilds a fresh deps
            // object rather than spreading `deps`, so anything not named here is
            // silently dropped — which is how resolution can look wired (the
            // orchestrator supplies it) while never reaching THIS path, the one
            // that does ordinary auto-fill, emergency fill and manual fill.
            { getEligiblePhotos, logger, searchTagAutocomplete, getCurrentMemberProfile, usage },
        );
    } catch (error) {
        logger
            .withCategory('autoFill')
            .warning(
                `${label}: failed to fetch eligible photos for ${logger.challengeTag(challenge)}: ${errorMessage(error) || error}`,
                null,
            );
        return { status: 'fetch-error', error };
    }

    // Score once and reuse for every picker call in this fill (the emergency
    // probe and its actual pick rank the same eligible set, so they must see
    // the same map).
    const semanticScores = await resolveSemanticScores(challenge, eligible, { ...deps, ignoreWords });
    return { status: 'loaded', eligible, semanticScores, ignoreWords };
};

/**
 * Second half of the fill pipeline: build the scored candidate list and enrich
 * the contested ones with real stats. Returns the FULL scored pool —
 * finalizePick (which truncates to wantCount) is the caller's job.
 */
const scoreFillCandidates = async ({
    label,
    challenge,
    token,
    deps,
    eligible,
    semanticScores,
    ignoreWords,
    wantCount,
    mustIncludeTags,
    shouldIncludeTags,
    fillWithoutTagMatch,
}: {
    label: string;
    challenge: Challenge;
    token: string;
    deps: RankDeps;
    eligible: PickerPhoto[];
    semanticScores: SemanticScoreMap | null;
    ignoreWords: IgnoreWords;
    wantCount: number;
    mustIncludeTags: readonly string[] | null;
    shouldIncludeTags: readonly string[] | null;
    fillWithoutTagMatch: boolean | undefined;
}): Promise<{ scored: ScoredCandidate[]; contested: PickerPhoto[]; contestedIds: Set<string> }> => {
    const { logger } = deps;
    const scored = buildScoredCandidates(challenge, eligible, {
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        semanticScores,
        ignoreWords,
        onFallback: makeFallbackLogger(label, challenge, logger),
    });

    // Stat enrichment. selectEnrichmentSet returns the candidates still
    // competing for the last slot after the theme tiers — i.e. exactly the set
    // whose order the popularity tiers decide. It is empty whenever the theme
    // settled things, so a clean match costs no extra requests.
    const contested = selectEnrichmentSet(scored, wantCount);
    const contestedIds = new Set(contested.map((photo) => String(photo.id)));
    if (contested.length > 0) {
        const enriched = await enrichCandidates(contested, token, deps);
        const statsById = new Map(enriched.map((photo) => [String(photo.id), photo]));
        for (const entry of scored) {
            const fresh = statsById.get(String(entry.id));
            if (!fresh) continue;
            entry.statsKnown = fresh.statsKnown === true;
            if (entry.statsKnown) {
                // enrichCandidates only marks statsKnown on entries whose three
                // fields it has already coerced to finite non-negative integers.
                entry.votes = fresh.votes as number;
                entry.views = fresh.views as number;
                entry.achievementCount = fresh.achievementCount as number;
            }
        }
    }
    return { scored, contested, contestedIds };
};

// Visual re-rank of the tag pick (see services/visionVerifier.ts). The picked
// ids lead the shortlist so a model that abstains returns exactly them; the
// rest of the tag ranking follows as alternatives it may promote.
const verifyFillPick = async (
    challenge: Challenge,
    scored: ScoredCandidate[],
    eligible: PickerPhoto[],
    picked: string[],
    ignoreWords: IgnoreWords,
    deps: RankDeps,
): Promise<string[]> => {
    const ranked = finalizePick(scored, Math.max(12, picked.length));
    const selected = new Set(picked.map(String));
    const preferred = [...picked, ...ranked.filter((id) => !selected.has(String(id)))];
    try {
        const rank = deps.rankVisually || rankVisually;
        const result = await rank(challenge, preferred, eligible, picked.length, { logger: deps.logger, ignoreWords });
        return Array.isArray(result) && result.length === picked.length ? result : picked;
    } catch (error) {
        deps.logger
            .withCategory('autoFill')
            .warning(
                `Visual check failed for ${deps.logger.challengeTag(challenge)}: ${errorMessage(error) || error}`,
                null,
            );
        return picked;
    }
};

/**
 * Ranks a challenge's candidate photos with the same pipeline a fill uses, but
 * submits nothing. Every id in `excludeIds` is removed BEFORE scoring and
 * enrichment — finalizePick truncates after sorting, so filtering afterwards
 * could discard every valid alternative when the top picks are excluded.
 *
 * @param deps - same shape as the fill deps
 *   picked: the top `wantCount` candidate photo records (with id + member_id), best first
 */
const rankCandidatesForChallenge = async (
    challenge: Challenge,
    token: string,
    deps: RankDeps,
    opts: {
        label?: string;
        usage?: 'submit' | 'swap';
        excludeIds?: Set<string>;
        wantCount?: number;
        mustIncludeTags?: readonly string[] | null;
        shouldIncludeTags?: readonly string[] | null;
        fillWithoutTagMatch?: boolean;
    } = {},
): Promise<FetchErrorResult | { status: 'ranked'; picked: PickerPhoto[] }> => {
    const {
        label = 'rank',
        usage = 'submit',
        excludeIds = new Set(),
        wantCount = 1,
        mustIncludeTags = null,
        shouldIncludeTags = null,
        fillWithoutTagMatch = true,
    } = opts;
    const loaded = await loadFillCandidates({
        label,
        challenge,
        token,
        deps,
        mustIncludeTags,
        shouldIncludeTags,
        usage,
    });
    if (loaded.status === 'fetch-error') {
        return loaded;
    }
    const eligible = loaded.eligible.filter((photo) => photo && !excludeIds.has(String(photo.id)));
    const { scored } = await scoreFillCandidates({
        label,
        challenge,
        token,
        deps,
        eligible,
        semanticScores: loaded.semanticScores,
        ignoreWords: loaded.ignoreWords,
        wantCount,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
    });
    const byId = new Map(eligible.map((photo) => [String(photo.id), photo]));
    const pickedIds = await verifyFillPick(
        challenge,
        scored,
        eligible,
        finalizePick(scored, wantCount),
        loaded.ignoreWords,
        deps,
    );
    const picked = pickedIds.map((id) => byId.get(String(id))).filter(Boolean) as PickerPhoto[];
    return { status: 'ranked', picked };
};

/**
 * The one fill pipeline all four public entry points share:
 *
 *   fetch candidates → semantic scores → (optional probe) → pick →
 *   (optional pick guard) → (optional pre-submit live re-check) → submit
 *
 * maybeAutoFillChallenge / maybeEmergencyFillChallenge / fillChallengeNow /
 * submitNewEntryForAction all run this exact sequence and differ only in
 * their entry guards, their per-path hooks, and how they map the outcome to
 * their own return shape — so the sequence lives here once, parameterized by
 * `label` (the log prefix: autoFill/emergencyFill/manualFill/fillNew, which
 * also names the refresh flow) and the hooks below. Every log line the
 * pipeline emits keeps the exact wording the four paths always had.
 *
 * IMPORTANT — reflectNewEntry is deliberately NOT called here. The four
 * paths disagree about it:
 *   - maybeAutoFillChallenge and maybeEmergencyFillChallenge reflect
 *     internally after a successful submit;
 *   - fillChallengeNow never reflects;
 *   - submitNewEntryForAction leaves the reflect to its orchestrator
 *     callers, which call autoFill.reflectNewEntry(challenge, imageId)
 *     after a successful return.
 * Reflecting in this helper would make those orchestrator callers reflect
 * TWICE, silently duplicating the entry in challenge.member.ranking.entries
 * and corrupting getSlotsRemaining plus boost/turbo entry selection for the
 * rest of the voting pass. The helper only returns the submitted `picked`
 * ids; each entry point owns its reflect behavior.
 *
 * Hooks (each used by exactly one path; all optional):
 *   - probeStandDown({ eligible, semanticScores }) → truthy to stand down
 *     before the real pick (emergency fill's dry-run "would the staggered
 *     path have filled this?" probe — it must not emit fallback warnings,
 *     so the hook runs its own picker call without onFallback).
 *   - onEmptyPick(eligible) → replaces the default
 *     "`label`: no eligible photos" info line; its return value comes back
 *     as `detail` (manual fill derives its user-facing error string here).
 *   - onRefreshed(picked) → runs after refreshChallengeState returns
 *     'refreshed'; return { standDown: true } to abort, { picked } to
 *     replace the batch (emergency fill truncates to the fresh free-slot
 *     count), or null to proceed. When the hook is absent the live
 *     re-check is skipped entirely (manual fill).
 */
const runFillAttempt = async ({
    label,
    challenge,
    token,
    deps,
    wantCount,
    mustIncludeTags,
    shouldIncludeTags,
    fillWithoutTagMatch,
    probeStandDown = null,
    onEmptyPick = null,
    onRefreshed = null,
}: FillAttemptParams): Promise<FillAttemptResult> => {
    const { logger, submitToChallenge } = deps;
    const loaded = await loadFillCandidates({ label, challenge, token, deps, mustIncludeTags, shouldIncludeTags });
    if (loaded.status === 'fetch-error') {
        return loaded;
    }
    const { eligible, semanticScores, ignoreWords } = loaded;

    if (probeStandDown && probeStandDown({ eligible, semanticScores })) {
        return { status: 'probe-stand-down' };
    }

    // Everything below is submission-bound. The probe above deliberately runs
    // FIRST and on unenriched data: it decides only WHETHER to stand down, never
    // WHICH photo to submit, so it does not need real vote counts — and it runs
    // on every scheduler cycle inside the emergency window, usually to stand
    // down. Enriching before it would spend a burst of get_image_data requests
    // per cycle to submit nothing. Do not "fix" this asymmetry.
    const { scored, contested, contestedIds } = await scoreFillCandidates({
        label,
        challenge,
        token,
        deps,
        eligible,
        semanticScores,
        ignoreWords,
        wantCount,
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
    });

    let picked = finalizePick(scored, wantCount);
    if (picked.length === 0) {
        if (onEmptyPick) {
            return { status: 'no-pick', detail: onEmptyPick(eligible) };
        }
        logger
            .withCategory('autoFill')
            .info(`${label}: no eligible photos for ${logger.challengeTag(challenge)}`, null);
        return { status: 'no-pick', detail: null };
    }

    // Live re-check just before consuming a slot: the pass-start snapshot can
    // be minutes old, and an entry added outside this run (e.g. a manual
    // submission) must stand the fill down instead of over-submitting.
    if (onRefreshed) {
        const refresh = await refreshChallengeState(challenge, token, deps, label);
        if (refresh === 'gone') {
            return { status: 'gone' };
        }
        if (refresh === 'refreshed') {
            const verdict = onRefreshed(picked);
            if (verdict && verdict.standDown) {
                return { status: 'refresh-stand-down' };
            }
            if (verdict && Array.isArray(verdict.picked)) {
                picked = verdict.picked;
            }
        }
    }

    picked = await verifyFillPick(challenge, scored, eligible, picked, ignoreWords, deps);

    try {
        const result = await submitToChallenge(challenge.id, picked, token);
        if (result && result.ok) {
            // Explain the pick only once it actually became an entry. Logging
            // earlier would tell the user "this photo was chosen" for a fill
            // that then stood down on the live re-check or was rejected — an
            // entry they would go looking for and never find. `picked` is also
            // final only here: onRefreshed can replace it.
            if (contested.length > 0) {
                logPopularityPick(label, challenge, scored, contestedIds, picked, logger);
            }
            logSelectionDetails({ prefix: label, challenge, scored, picked, contestedIds, logger });
            return { status: 'submitted', picked };
        }
        const reason = describeSubmitFailure(result && result.raw);
        logger
            .withCategory('autoFill')
            .warning(`${label}: submit rejected for ${logger.challengeTag(challenge)}: ${reason}`, null);
        return { status: 'submit-rejected', reason };
    } catch (error) {
        logger
            .withCategory('autoFill')
            .warning(
                `${label}: submit threw for ${logger.challengeTag(challenge)}: ${errorMessage(error) || error}`,
                null,
            );
        return { status: 'submit-threw', error };
    }
};

export { rankCandidatesForChallenge, runFillAttempt };
