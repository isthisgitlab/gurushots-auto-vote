/**
 * The fill attempt: pick, guard, re-check and submit.
 */

import { finalizePick } from '../../photoPicker';
import { clockMs } from '../../../simulationScope';
import { refreshChallengeState, swappedOutIds } from '../challengeState';
import { resolveSemanticScores } from '../candidates';
import { clearChosenSkip, enteredIds, logChosenSkipOnce, logPoolBlockOnce, resolveChosenPhotos } from '../chosenPhotos';
import type { ChosenSettings } from '../chosenPhotos';
import { refuseRememberedChosen, resolveMissingChosen } from '../chosenWalkMemo';
import { describeSubmitFailure, logPopularityPicks, logSelectionDetails } from '../fillLogging';
import type {
    FetchErrorResult,
    FillAttemptParams,
    FillAttemptResult,
    FillLabel,
    FillLogger,
    RankDeps,
} from '../../../types/autoFill';
import type { Challenge } from '../../../types/gurushots';
import type { ChosenPick, IgnoreWords, LibraryUsage, PickerPhoto, ScoredCandidate } from '../../../types/photoPicker';
import type { PhotoPoolBlock } from '../../../types/stores';
import { errorMessage } from '../../../errorMessage';
import { loadFillCandidates, scoreFillCandidates } from './scoring';
import { recordUncertainSubmission, verifyFillPick } from './verify';

// The paths that honour Submit Only Chosen Photos: the scheduled fill paths and the photo
// suggestions. Emergency fill exists so no slot is left empty at the buzzer and manual fill is
// explicit user intent, so neither does; both still rank the chosen photos first.
// A swap ranking honours it only when its caller enforces it. The automatic swap and a scenario
// swap step do. The manual Swap suggestion and the swap picker's Auto pass `ignoreOnly`.
const ONLY_LABELS: ReadonlySet<string> = new Set(['autoSubmit', 'fillNew', 'suggest', 'swap', 'scenarioScan']);

/**
 * The log prefix of a ranking that reads the Chosen Photos settings: a fill path, or the
 * submit-free rankings (the photo suggestions, the swap ranking and the scenario scan), which are not a FillLabel,
 * so runFillAttempt never takes them. The scan reads the settings as the scheduled fill does (Submit Only included).
 */
type ChosenLabel = FillLabel | 'suggest' | 'swap' | 'scenarioScan';

/** What the chosen-photo steps read: no submitter, so the suggestions cannot reach one. */
type ChosenParams = { label: ChosenLabel; challenge: Challenge; token: string; deps: RankDeps };

/**
 * `ignoreOnly`: the pick ranks the chosen photos first but never enforces Submit Only (the swap
 * picker's Auto). `onlyIds`: an explicit id pool that replaces the saved Chosen Photos settings
 * entirely — the pick is restricted to those ids, in that order, and Submit Only is never
 * enforced from them (the Boost-pinned submit; see FillAttemptParams.onlyIds).
 */
type PlanParams = ChosenParams & { ignoreOnly?: boolean; onlyIds?: readonly string[] };

/**
 * What the Chosen Photos settings mean for this attempt: the resolved settings,
 * whether Submit Only applies on this path, the chosen photos not yet entered,
 * and the pick options the scorer takes (null when no list is set).
 */
const planChosen = ({ label, challenge, deps, ignoreOnly = false, onlyIds }: PlanParams) => {
    const pool = onlyIds ? null : deps.settings?.getChosenPoolView?.(String(challenge.id));
    const settings: ChosenSettings = onlyIds
        ? { ids: [...onlyIds], only: true, inOrder: true }
        : resolveChosenPhotos({
              read: (key) => deps.settings?.getEffectiveSetting(key, String(challenge.id)),
              blocked: pool?.block,
          });
    const pinned = onlyIds !== undefined;
    const enforceOnly = !pinned && settings.only && ONLY_LABELS.has(label) && !ignoreOnly;
    const entered = enteredIds(challenge);
    const chosen: ChosenPick | null =
        settings.ids.length > 0
            ? { ids: settings.ids, only: pinned || enforceOnly, inOrder: settings.inOrder, excludeIds: entered }
            : null;
    return {
        settings,
        enforceOnly,
        blocked: enforceOnly ? (settings.blocked ?? null) : null,
        poolName: pool?.name ?? '',
        unentered: settings.ids.filter((id) => !entered.has(id)),
        chosen,
    };
};

/**
 * The loaded candidates plus any chosen photo the themed search did not return
 * but the library holds (found by one lookup — never on the emergency path,
 * which only reuses what an earlier lookup found), scored like the rest.
 */
const addMissedChosen = async ({
    label,
    challenge,
    token,
    deps,
    wantCount,
    unentered,
    inOrder,
    loaded,
    usage,
    onlyIds,
}: ChosenParams & {
    wantCount: number;
    unentered: string[];
    inOrder: boolean;
    /** What the chosen-photo lookup reads eligibility for (submit when omitted). */
    usage?: LibraryUsage;
    loaded: Extract<Awaited<ReturnType<typeof loadFillCandidates>>, { status: 'loaded' }>;
    /**
     * An explicit id pool walks even after an unfiltered read: that read does not report whether
     * it reached the end of the library, and only a walk that reached the end (or stopped at the
     * page cap) can give the pinned submit a definitive answer.
     */
    onlyIds?: readonly string[];
}) => {
    const { eligible, semanticScores, ignoreWords } = loaded;
    const missed = await resolveMissingChosen({
        challenge,
        token,
        ids: unentered,
        eligible,
        wantCount,
        allowWalk: label !== 'emergencySubmit' && (!loaded.walkedUnfiltered || onlyIds !== undefined),
        inOrder,
        deps,
        label,
        usage,
    });
    if (missed.length === 0) return { eligible, semanticScores };
    const missedScores = await resolveSemanticScores(challenge, missed, { ...deps, ignoreWords });
    return {
        eligible: [...eligible, ...missed],
        semanticScores: missedScores ? new Map([...(semanticScores ?? []), ...missedScores]) : semanticScores,
    };
};

/**
 * What a submitted fill leaves in the log and in the uncertain-subject record:
 * why the popularity tiers decided (when they did), the exact ranking inputs of
 * each submitted photo, and any weak subject evidence.
 */
const explainSubmission = async ({
    label,
    challenge,
    deps,
    scored,
    picked,
    contested,
    contestedIds,
    chosenIds,
    inOrder,
    visualEvidence,
    ignoreWords,
}: Pick<FillAttemptParams, 'label' | 'challenge' | 'deps'> & {
    scored: ScoredCandidate[];
    picked: string[];
    contested: PickerPhoto[];
    contestedIds: Set<string>;
    chosenIds: ReadonlySet<string> | null;
    inOrder: boolean;
    visualEvidence: Set<string> | null;
    ignoreWords: IgnoreWords;
}) => {
    const { logger } = deps;
    if (contested.length > 0) {
        logPopularityPicks({ label, challenge, scored, chosenIds, inOrder, contestedIds, picked, logger });
    }
    logSelectionDetails({ prefix: label, challenge, scored, picked, contestedIds, chosenIds, inOrder, logger });
    await recordUncertainSubmission({ challenge, label, scored, picked, visualEvidence, ignoreWords, chosenIds, deps });
};

const finalEligibilityStandsDown = async (
    finalEligibility: FillAttemptParams['finalEligibility'],
    picked: readonly string[],
): Promise<boolean> => (await finalEligibility?.(picked))?.standDown === true;

/** Why a fill stops before it picks anything: the outcomes of the preparation that are not a pick. */
type PrepareStop =
    | FetchErrorResult
    | { status: 'probe-stand-down' }
    | { status: 'no-chosen'; reason?: PhotoPoolBlock }
    | { status: 'no-pick'; detail: string | null };

/** What the preparation leaves for the steps after the pick: the live re-check, the visual check and the submit. */
type PreparedPick = {
    eligible: PickerPhoto[];
    scored: ScoredCandidate[];
    contested: PickerPhoto[];
    contestedIds: Set<string>;
    chosenIds: ReadonlySet<string> | null;
    inOrder: boolean;
    picked: string[];
    ignoreWords: IgnoreWords;
};

/**
 * `incomplete`: some read of the library stopped early or failed, or (a scan) a chosen photo the themed search missed
 * was not looked up, so the pool may lack photos the library holds. Only a scan tracks it. `stop` or `ready`, never both.
 */
type Preparation = { incomplete: boolean } & (
    | { stop: PrepareStop; ready?: undefined }
    | { stop?: undefined; ready: PreparedPick }
);

type PrepareParams = Pick<
    FillAttemptParams,
    | 'challenge'
    | 'token'
    | 'wantCount'
    | 'mustIncludeTags'
    | 'shouldIncludeTags'
    | 'submitWithoutTagMatch'
    | 'probeStandDown'
    | 'onEmptyPick'
    | 'onlyIds'
> & {
    label: FillLabel | 'scenarioScan';
    deps: RankDeps;
    /**
     * The read-only scan: tracks whether any read stopped early, and leaves everything a real fill remembers alone —
     * the Submit-Only skip-log latch is neither read nor set, and the chosen-photo walk (whose memo and log line a
     * later fill owns) is not made. A submission never sets it.
     */
    scan?: boolean;
};

/**
 * Everything a fill does before it spends anything: plan the chosen photos, load and score the candidates, apply the
 * swap history, run the stand-down probe, rank, and pick. Submission (runFillAttempt) and the read-only scan
 * (scanFillCandidates) both run exactly this, so one rule decides which photos are eligible. It submits nothing and
 * touches no entry.
 */
const prepareFillPick = async ({
    label,
    challenge,
    token,
    deps,
    wantCount,
    mustIncludeTags,
    shouldIncludeTags,
    submitWithoutTagMatch,
    probeStandDown = null,
    onEmptyPick = null,
    onlyIds,
    scan = false,
}: PrepareParams): Promise<Preparation> => {
    const { logger } = deps;
    const {
        settings: chosenSettings,
        enforceOnly,
        blocked,
        poolName,
        unentered,
        chosen,
    } = planChosen({
        label,
        challenge,
        token,
        deps,
        onlyIds,
    });
    // A photo pool with nothing to give, and Submit Only: nothing is picked, and never anything else instead.
    if (blocked !== null) {
        if (!scan) logPoolBlockOnce(logger, challenge, label, blocked, poolName);
        return { incomplete: false, stop: { status: 'no-chosen', reason: blocked } };
    }
    // Every chosen photo is already an entry here: nothing is left to choose,
    // so there is nothing to fetch either.
    if (enforceOnly && unentered.length === 0) {
        if (!scan) logChosenSkipOnce(logger, challenge, label, 'all-entered');
        return { incomplete: false, stop: { status: 'no-chosen' } };
    }

    const loaded = await loadFillCandidates({
        label,
        challenge,
        token,
        deps,
        mustIncludeTags,
        shouldIncludeTags,
        trackReads: scan,
        // The scan's lines carry its own label, never a fill's.
        ...(scan ? { logLabel: label } : {}),
    });
    if (loaded.status === 'fetch-error') {
        return { incomplete: true, stop: loaded };
    }
    const { ignoreWords } = loaded;
    // A scan does not look up a chosen photo the themed search missed (that lookup keeps a memo and writes a line a
    // later fill owns): a pool that lacks one is a lower bound.
    const missedChosen = scan
        ? unentered.some((id) => !loaded.eligible.some((photo) => String(photo.id) === id))
        : false;
    const incomplete = loaded.incomplete || missedChosen;
    const { eligible: fetched, semanticScores } = scan
        ? loaded
        : await addMissedChosen({
              label,
              challenge,
              token,
              deps,
              wantCount,
              unentered,
              inOrder: chosenSettings.inOrder,
              loaded,
              onlyIds,
          });
    // A photo the swap history took out is not picked again on its own; listing
    // it in Chosen Photos allows it. The fetch's eligibility decisions are
    // already swapped-aware — an all-swapped-out themed result fell back to the
    // unfiltered walk above — so this filter remains the single place the pool
    // is narrowed, re-allowing chosen ids.
    const swapped = swappedOutIds(challenge);
    const eligible = fetched.filter(
        (photo) => !swapped.has(String(photo.id)) || chosenSettings.ids.includes(String(photo.id)),
    );

    // The stand-down probe asks what the NORMAL path would do, so it sees the
    // setting as saved even where this path would not honour Submit Only.
    if (
        probeStandDown &&
        probeStandDown({ eligible, semanticScores, chosen: chosen && { ...chosen, only: chosenSettings.only } })
    ) {
        return { incomplete, stop: { status: 'probe-stand-down' } };
    }

    // Everything below is submission-bound. The probe above deliberately runs
    // FIRST and on unenriched data: it decides only WHETHER to stand down, never
    // WHICH photo to submit, so it does not need real vote counts — and it runs
    // on every scheduler cycle inside the emergency window, usually to stand
    // down. Enriching before it would spend a burst of get_image_data requests
    // per cycle to submit nothing. Do not "fix" this asymmetry.
    const { scored, contested, contestedIds, chosenIds, orderedIds } = await scoreFillCandidates({
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
        submitWithoutTagMatch,
        chosen,
    });

    // With Submit Only the pool holds nothing but chosen photos, so an empty
    // pool means none of them can be submitted. That is a deliberate skip, not
    // an empty library.
    if (enforceOnly && scored.length === 0) {
        if (!scan) logChosenSkipOnce(logger, challenge, label, 'none-usable');
        return { incomplete, stop: { status: 'no-chosen' } };
    }
    // An explicit id pool (the Boost-pinned submit) is not a Submit Only skip:
    // it leaves the scheduled fill's skip line — its explaining and its
    // clearing — alone.
    if (onlyIds === undefined && !scan) clearChosenSkip(challenge);

    const inOrder = chosenSettings.inOrder;
    const picked = finalizePick(scored, wantCount, chosenIds, inOrder ? orderedIds : null);
    if (picked.length === 0) {
        if (onEmptyPick) {
            return { incomplete, stop: { status: 'no-pick', detail: onEmptyPick(eligible) } };
        }
        logger
            .withCategory('autoSubmit')
            .info(`${label}: no eligible photos for ${logger.challengeTag(challenge)}`, null);
        return { incomplete, stop: { status: 'no-pick', detail: null } };
    }
    return {
        incomplete,
        ready: { eligible, scored, contested, contestedIds, chosenIds, inOrder, picked, ignoreWords },
    };
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
 * `label` (the log prefix: autoSubmit/emergencySubmit/manualFill/fillNew, which
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
 * The user's chosen photos (Chosen Photos / Submit Only Chosen Photos) are
 * resolved here, from `deps.settings`, rather than threaded in by each path:
 * they rank first (see scoreFillCandidates), a chosen photo the themed fetch
 * missed is looked up once (see resolveMissingChosen), and with Submit Only on
 * a challenge with no usable chosen photo ends as `no-chosen` instead of being
 * topped up. They are NOT resolved in loadFillCandidates, which the swap
 * ranking shares: each caller reads them through planChosen.
 *
 * Hooks (each used by exactly one path; all optional):
 *   - probeStandDown({ eligible, semanticScores, chosen }) → truthy to stand down
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
    submitWithoutTagMatch,
    probeStandDown = null,
    onEmptyPick = null,
    onRefreshed = null,
    finalEligibility = null,
    onlyIds,
}: FillAttemptParams): Promise<FillAttemptResult> => {
    const { logger, submitToChallenge } = deps;
    const prepared = await prepareFillPick({
        label,
        challenge,
        token,
        deps,
        wantCount,
        mustIncludeTags,
        shouldIncludeTags,
        submitWithoutTagMatch,
        probeStandDown,
        onEmptyPick,
        onlyIds,
    });
    if (prepared.stop) return prepared.stop;
    const { eligible, scored, contested, contestedIds, chosenIds, inOrder, ignoreWords } = prepared.ready;
    let { picked } = prepared.ready;

    // Live re-check just before consuming a slot: the pass-start snapshot can
    // be minutes old, and an entry added outside this run (e.g. a manual
    // submission) must stand the fill down instead of over-submitting.
    if (onRefreshed) {
        const refresh = await refreshChallengeState(challenge, token, deps, label);
        if (refresh === 'gone') {
            return { status: 'gone' };
        }
        if (refresh === 'invalid') {
            return { status: 'invalid' };
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

    const verified = await verifyFillPick(
        challenge,
        token,
        scored,
        eligible,
        picked,
        ignoreWords,
        deps,
        chosenIds,
        inOrder,
    );
    picked = verified.picked;

    if (await finalEligibilityStandsDown(finalEligibility, picked)) {
        return { status: 'refresh-stand-down' };
    }

    try {
        const result = await submitToChallenge(challenge.id, picked, token);
        if (result && result.ok) {
            // Explain the pick only once it actually became an entry. Logging
            // earlier would tell the user "this photo was chosen" for a fill
            // that then stood down on the live re-check or was rejected — an
            // entry they would go looking for and never find. `picked` is also
            // final only here: onRefreshed can replace it.
            await explainSubmission({
                label,
                challenge,
                deps,
                scored,
                picked,
                contested,
                contestedIds,
                chosenIds,
                inOrder,
                visualEvidence: verified.visualEvidence,
                ignoreWords,
            });
            return { status: 'submitted', picked };
        }
        // Any body that came back with a submit that was not ok is the server's answer: the remembered
        // photos in this pick are held back for a short while (it does not say which one it refused).
        // Only no body at all (null raw) or a throw is "no answer", and teaches nothing.
        if (result?.raw) refuseRememberedChosen(challenge, picked, clockMs());
        const reason = describeSubmitFailure(result && result.raw);
        // A body is the server's refusal; no body at all is no answer — the request may not have
        // landed. The two log differently and travel apart as statuses, so a caller can latch the
        // refusal and retry the other.
        if (result?.raw) {
            logger
                .withCategory('autoSubmit')
                .warning(`${label}: submit rejected for ${logger.challengeTag(challenge)}: ${reason}`, null);
            return { status: 'submit-rejected', reason };
        }
        logger
            .withCategory('autoSubmit')
            .warning(`${label}: submit got no answer for ${logger.challengeTag(challenge)}: ${reason}`, null);
        return { status: 'submit-unanswered', reason };
    } catch (error) {
        logger
            .withCategory('autoSubmit')
            .warning(
                `${label}: submit threw for ${logger.challengeTag(challenge)}: ${errorMessage(error) || error}`,
                null,
            );
        return { status: 'submit-threw', error };
    }
};

/** What a read-only scan of the photos a submission would consider found. */
type PhotoScan = {
    /** How many photos the submission's ranking pool holds (a lower bound while `complete` is false). */
    eligible: number;
    /** False when the scan stopped early: a read failed or was cut short, or the visual check cannot run. */
    complete: boolean;
    /** Why there is nothing to submit, or why the scan is incomplete. */
    firstReason?: string;
};

/**
 * Reads, without submitting anything, what a scheduled fill of this challenge would find: the same candidate listing
 * and scoring a submission runs (prepareFillPick). The vision check is not run: it only reorders a pick and cannot
 * change the count. A scan that stopped early is incomplete: it proves a lower bound, never zero.
 *
 * It leaves no trace a real fill would notice: its log lines go to the `scenarioScan` category and carry that label,
 * and it neither reads nor sets the Submit-Only skip-log latch or the chosen-photo walk memo.
 */
const scanFillCandidates = async (
    params: Pick<
        FillAttemptParams,
        'challenge' | 'token' | 'mustIncludeTags' | 'shouldIncludeTags' | 'submitWithoutTagMatch'
    > & { deps: RankDeps },
): Promise<PhotoScan> => {
    const label = 'scenarioScan';
    const { logger } = params.deps;
    const scanLogger: FillLogger = {
        withCategory: () => logger.withCategory(label),
        challengeTag: logger.challengeTag,
    };
    const prepared = await prepareFillPick({
        ...params,
        deps: { ...params.deps, logger: scanLogger },
        label,
        wantCount: 1,
        scan: true,
    });
    if (prepared.stop) {
        const { status } = prepared.stop;
        if (status === 'fetch-error') return { eligible: 0, complete: false, firstReason: 'photo-read-failed' };
        const reason = status === 'no-chosen' ? 'no-chosen-photo' : 'no-eligible-photo';
        return { eligible: 0, complete: !prepared.incomplete, firstReason: reason };
    }
    const eligible = prepared.ready.scored.length;
    return prepared.incomplete
        ? { eligible, complete: false, firstReason: 'photo-read-incomplete' }
        : { eligible, complete: true };
};

export { runFillAttempt, scanFillCandidates, planChosen, addMissedChosen };
