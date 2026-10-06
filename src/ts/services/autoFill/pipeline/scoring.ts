/**
 * Fill pipeline, first stages: load the candidate library and score it.
 */

import { buildChosenCandidates, selectBlockEnrichmentSet } from '../../photoPicker';
import { enrichCandidates } from '../../photoStats';
import { resolveSemanticScores, resolveIgnoreWords, fetchCandidatesForChallenge } from '../candidates';
import { makeFallbackLogger } from '../fillLogging';
import type { Challenge } from '../../../types/gurushots';
import type {
    ChosenPick,
    IgnoreWords,
    PickerPhoto,
    ScoredCandidate,
    SemanticScoreMap,
} from '../../../types/photoPicker';
import type { FetchErrorResult, RankDeps } from '../../../types/autoFill';
import { errorMessage } from '../../../errorMessage';

/**
 * First half of the fill pipeline: fetch the candidate library for a challenge
 * and score it semantically. Shared by runFillAttempt and
 * rankCandidatesForChallenge so a swap ranks photos exactly the way a fill
 * does. `walkedUnfiltered` says the fetch already read the whole unfiltered
 * library, which the chosen-photos lookup in runFillAttempt uses to know there
 * is nothing left to find; swap ignores it.
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
    | {
          status: 'loaded';
          eligible: PickerPhoto[];
          semanticScores: SemanticScoreMap | null;
          ignoreWords: IgnoreWords;
          walkedUnfiltered: boolean;
      }
> => {
    const { logger, getEligiblePhotos, searchTagAutocomplete, getCurrentMemberProfile } = deps;
    // One lookup for the whole fill — see resolveIgnoreWords for why it is not
    // threaded in from each caller like the tag settings are.
    const ignoreWords = resolveIgnoreWords(deps.settings, challenge);

    let eligible;
    const trace = { walkedUnfiltered: false };
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
            { getEligiblePhotos, logger, searchTagAutocomplete, getCurrentMemberProfile, usage, trace },
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
    return { status: 'loaded', eligible, semanticScores, ignoreWords, walkedUnfiltered: trace.walkedUnfiltered };
};

/**
 * Second half of the fill pipeline: build the scored candidate list and enrich
 * the contested ones with real stats. Returns the FULL scored pool —
 * finalizePick (which truncates to wantCount) is the caller's job.
 *
 * With `chosen` the pool is split into the user's chosen block and the rest
 * (see buildChosenCandidates), and enrichment runs per block; `chosenIds`
 * names the chosen block for finalizePick, verifyFillPick and the logging.
 * Without it nothing differs from the ranking a swap uses.
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
    chosen = null,
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
    chosen?: ChosenPick | null;
}): Promise<{
    scored: ScoredCandidate[];
    contested: PickerPhoto[];
    contestedIds: Set<string>;
    chosenIds: ReadonlySet<string> | null;
}> => {
    const { logger } = deps;
    const { scored, chosenIds } = buildChosenCandidates(challenge, eligible, {
        mustIncludeTags,
        shouldIncludeTags,
        fillWithoutTagMatch,
        semanticScores,
        ignoreWords,
        onFallback: makeFallbackLogger(label, challenge, logger),
        chosen,
    });

    // Stat enrichment. selectEnrichmentSet returns the candidates still
    // competing for the last slot after the theme tiers — i.e. exactly the set
    // whose order the popularity tiers decide. It is empty whenever the theme
    // settled things, so a clean match costs no extra requests.
    const contested = selectBlockEnrichmentSet(scored, wantCount, chosenIds);
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
    return { scored, contested, contestedIds, chosenIds };
};

export { loadFillCandidates, scoreFillCandidates };
