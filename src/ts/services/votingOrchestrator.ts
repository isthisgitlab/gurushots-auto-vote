/**
 * The voting-pass orchestration shared by BOTH API strategies
 * (strategies/real and mock/strategy.ts): the mock runs the identical strategy
 * path over its fake endpoints, so auto-fill, emergency fill, turbo-earn and
 * the timer-ordered deadline actions behave the same in both modes.
 *
 * `deps.api` is the endpoint set (real api/* modules or mockApiClient — the
 * same surface apiFactory's ApiStrategy describes minus authenticate and
 * this function itself). Strategy-specific behavior is injected:
 *   - interChallengeDelay: real mode mimics a human (2-5s random); mock
 *     uses a short fixed delay.
 *   - cleanupStaleMetadata: real mode prunes stale per-challenge metadata;
 *     mock passes null — the metadata store is SHARED and un-namespaced,
 *     and mock challenge ids never match real ones, so running cleanup in
 *     mock mode would purge the user's real voting metadata.
 *
 * Runners execute SEQUENTIALLY by design: auto-fill mutates the shared
 * challenge object (reflectNewEntry) so a later turbo/boost in the same
 * cycle sees the consumed slot and new entry. Do not parallelize them.
 *
 * @param challengeIdFilter - restricts the strategy pass
 *   to one challenge (per-card "Run"); stale-metadata cleanup still runs
 *   against the full active list first.
 * @param deps - see types/votingPass.ts
 *   `entryTracker` backs the voteOnNewEntry feature. Real mode passes a
 *   metadata.json-backed tracker; mock passes an in-memory one for the same reason
 *   it passes cleanupStaleMetadata: null — the metadata store is shared and
 *   un-namespaced, and mock challenge ids would accumulate there unpruned. Omitting
 *   it entirely makes the feature inert.
 *   `entryAges` records when each entry entered its challenge, for the boost's
 *   fresh-entry wait (boostFreshEntryWait). Real mode persists it; mock passes an
 *   in-memory one. Omitting it means a boost is never held.
 *   `currency` backs the automatic key / swap / fill spends (services/currencyAuto.ts):
 *   `strategy` is the endpoint set the spend services take (the same shape the manual
 *   currency handlers pass), `swapLedger` the swap-back ledger and `spendLedger` the
 *   automatic-fill counter. Mock passes in-memory ledgers for the same reason it passes
 *   cleanupStaleMetadata: null. Omitting it makes the automation inert.
 *   `missions` is what the active missions still need (services/missions.ts): a
 *   turbo win or a fill this pass counts down its mission, and a vote mission
 *   splits its remaining votes over the challenges (missionVoteQuota). Omitted =
 *   no mission is followed.
 *   `challenges` is the full active list this cycle fetched (not the
 *   filtered subset) so callers can reuse it for threshold scheduling.
 */

import * as logger from '../logger';
import * as settings from '../settings';
import * as votingLogic from './VotingLogic';
import * as autoFill from './autoFill';
import * as photoStats from './photoStats';
import * as newEntryTracker from './newEntryTracker';
import * as currencyAuto from './currencyAuto';
import { consumeMission, isMissionVoteCandidate, missionVoteQuota, registerMissionNeeds } from './missions';
import { claimTurboRun, releaseTurboRun, turboRunSnapshot, wasManualTurboRunSince } from './turboRunLock';
import { runScenarioStep } from './scenarioRunner';
import * as cancellation from '../voting/cancellation';
import { formatDuration } from '../format/duration';
import { failureText, oneLine } from '../format/logSafe';
import { sleep } from '../timing';
import { finiteOr } from '../numbers';

import type { Challenge, MemberBoost, VoteImagesResponse } from '../types/gurushots';
import type { VotingPassApi, VotingPassDeps, VotingPassResult, ScenarioDeps } from '../types/votingPass';
import type { CurrencyPassDeps } from './currencyAuto';
import type { EntryTracker } from './newEntryTracker';
import type { EntryAgeLedger } from '../types/stores';
import type { AutoVoteDecision } from './decisions/voteDecisions';
import type { MissionNeeds } from './missions';
import { errorMessage } from '../errorMessage';

/**
 * Per-challenge context threaded to every deadline-action runner. All of a
 * runner's per-pass state comes through here explicitly — module-scope
 * imports (logger, settings, votingLogic, autoFill, formatDuration) are the
 * only other things they touch.
 */
type ActionContext = {
    challenge: Challenge;
    token: string;
    now: number;
    api: VotingPassApi;
    fillDeps: FillDeps;
    entryAges: EntryAgeLedger | null;
};

/**
 * Which kind of boost the challenge currently offers. Optional-chained to match
 * shouldApplyBoost/shouldApplyTurbo, which guard the same tree, so a payload
 * without `member` reads as "no boost" instead of throwing out of the
 * per-action loop.
 */
const readBoostAvailability = (
    challenge: Challenge,
): { boost: MemberBoost; isTimerBasedAvailable: boolean; isKeyUnlockedAvailable: boolean } => {
    const boost: MemberBoost = challenge?.member?.boost || {};
    const hasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;
    return {
        boost,
        isTimerBasedAvailable: boost.state === 'AVAILABLE' && hasTimeout,
        isKeyUnlockedAvailable: boost.state === 'AVAILABLE_KEY' || (boost.state === 'AVAILABLE' && !hasTimeout),
    };
};

/**
 * Close the outer boost-<id> operation as a failure/skip with `reason`.
 */
const endBoostOperation = (challenge: Challenge, reason: string) => {
    logger.withCategory('boost').endOperation(`boost-${challenge.id}`, null, reason);
};

/**
 * Boost the entry fill-new submitted. applyBoost raises the `boosted` flag
 * itself (it owns the entry pick); the explicit-entry call cannot, so reflect it
 * here.
 *
 * @param imageId - the entry fill-new submitted
 * @returns the boost result; falsy once the operation is closed
 */
const boostFreshEntry = async (
    { challenge, token, api }: ActionContext,
    cid: string,
    imageId: string,
): Promise<unknown> => {
    const boostResult = await api.applyBoostToEntry(cid, imageId, token);
    if (boostResult) {
        autoFill.reflectEntryFlag(challenge, imageId, 'boosted');
    } else {
        // applyBoostToEntry logs its own apply-boost-entry-* operation,
        // but the outer boost-<id> operation opened by applyAvailableBoost would
        // dangle open on failure (the applyBoost fallback path closes its own).
        endBoostOperation(challenge, 'boost apply to fresh entry failed');
    }
    return boostResult;
};

const logBoostTarget = (challenge: Challenge, message: string) => {
    logger.withCategory('boost').info(`${logger.challengeTag(challenge)} ${message}`, null);
};

/**
 * The entry a due boost lands on: the photo an earlier fill-new submitted and the
 * boost is still waiting on; else, with fill-new on, a fresh photo submitted now
 * (remembered as pending, so a held boost reuses it instead of submitting
 * another); else the configured Boost Entry.
 *
 * @returns null when
 *   fill-new found no valid target and the boost is skipped (already logged)
 */
const resolveBoostTarget = async (ctx: ActionContext): Promise<{ imageId: string | null; fresh: boolean } | null> => {
    const { challenge, token, now, fillDeps, entryAges } = ctx;
    const cid = challenge.id.toString();
    const pending = entryAges?.pending(cid);
    if (pending) return { imageId: pending, fresh: true };
    const existing = () => ({ imageId: votingLogic.pickBoostEntry(challenge, cid)?.id ?? null, fresh: false });
    // 'always' = boostFillNew; 'conflict' = boostFillNewOnConflict when
    // the only existing entry is turboed; 'no' = boost an existing entry.
    const fillMode = votingLogic.resolveBoostFillNewMode(challenge, cid);
    if (fillMode === 'no') return existing();
    const filled = await autoFill.submitNewEntryForAction(challenge, token, fillDeps);
    if (filled.ok) {
        // An ok fill always carries the submitted imageId.
        const imageId = String(filled.imageId);
        autoFill.reflectNewEntry(challenge, imageId);
        entryAges?.markPending(challenge, imageId, now);
        return { imageId, fresh: true };
    }
    if (filled.reason === 'challenge-gone') {
        // The live re-check confirmed the challenge left the active list —
        // boosting an existing entry on it would just be a second failing call.
        logBoostTarget(challenge, 'challenge left the active list — boost skipped');
        return null;
    }
    if (fillMode === 'conflict') {
        // On-conflict mode only fires when the single existing entry is already
        // turboed, so there is no valid fallback target — skip instead of an
        // applyBoost that would fail with "only entry already has Turbo".
        logBoostTarget(
            challenge,
            `boost fill-new unavailable (${filled.reason}); only entry already has Turbo — boost skipped`,
        );
        return null;
    }
    // 'always' mode falls back to the configured Boost Entry when no fresh
    // photo can be submitted (full / none / failed).
    logBoostTarget(challenge, `boost fill-new unavailable (${filled.reason}); boosting existing entry`);
    return existing();
};

/**
 * @param target - from resolveBoostTarget
 * @param timeUntilDisplayBase - seconds to the boost timeout (timer-based) or challenge end
 */
const applyAvailableBoost = async (
    ctx: ActionContext,
    target: { imageId: string | null; fresh: boolean },
    isTimerBasedAvailable: boolean,
    timeUntilDisplayBase: number,
) => {
    const { challenge, token, api } = ctx;
    // Surface the override so an applied boost on a challenge with
    // Auto-Apply Boost off is explained rather than looking like a bug.
    if (!settings.getEffectiveSetting('autoBoost', challenge.id.toString())) {
        logger
            .withCategory('boost')
            .info(
                `${logger.challengeTag(challenge)} Emergency Fill window — applying available boost despite Auto-Apply Boost being off`,
                null,
            );
    }
    const timeDisplay = formatDuration(timeUntilDisplayBase);

    const applyingMsg = isTimerBasedAvailable
        ? `Applying boost to challenge ${challenge.title}`
        : `Applying boost to challenge ${challenge.title} (key-unlocked)`;
    logger.withCategory('boost').startOperation(`boost-${challenge.id}`, applyingMsg);

    try {
        const boostResult = target.fresh
            ? await boostFreshEntry(ctx, challenge.id.toString(), target.imageId as string)
            : await api.applyBoost(challenge, token);
        if (boostResult) {
            ctx.entryAges?.clearPending(challenge.id, ctx.now);
            const successSuffix = isTimerBasedAvailable
                ? `${timeDisplay} remaining`
                : `${timeDisplay} until challenge ends`;
            logger
                .withCategory('boost')
                .endOperation(`boost-${challenge.id}`, `Boost applied successfully (${successSuffix})`);
        }
        // On null/falsy result the operation is already closed with the failure
        // reason (by applyBoost itself, or by boostFreshEntry) — no caller-side
        // fallback log needed (mirrors the turbo handling shape).
    } catch (error) {
        endBoostOperation(challenge, failureText(error));
    }
};

/**
 * @param effectiveBoostTime - the timer-based threshold in seconds
 */
const logBoostNotReady = (
    challenge: Challenge,
    isTimerBasedAvailable: boolean,
    timeUntilDisplayBase: number,
    effectiveBoostTime: number,
) => {
    const timeDisplay = formatDuration(timeUntilDisplayBase);
    // Both branches render the threshold they actually use: the key-unlocked window
    // is a setting, so it is read here rather than restated as a constant.
    const keyUnlockedWindow = votingLogic.getEffectiveKeyUnlockedBoostTime(challenge.id.toString());
    const reason = isTimerBasedAvailable
        ? `${timeDisplay} until deadline (threshold: ${effectiveBoostTime / 60}m)`
        : `${timeDisplay} until challenge ends (needs ≤ ${Math.round(keyUnlockedWindow / 60)}m to auto-apply)`;
    logger.withCategory('voting').info(`${logger.challengeTag(challenge)} Boost not ready - ${reason}`, null);
};

/**
 * Hold a due boost while its target photo is newer than `boostFreshEntryWait`
 * (VotingLogic.getBoostHoldUntil). The release instant goes on the challenge so
 * the cadence decision lands the next cycle on it.
 *
 * @param imageId - the entry the boost would land on
 * @returns true when the boost waits this pass
 */
const holdBoostForFreshEntry = ({ challenge, now, entryAges }: ActionContext, imageId: string | null): boolean => {
    if (!imageId || !entryAges) return false;
    const holdUntil = votingLogic.getBoostHoldUntil(challenge, entryAges.enteredAt(challenge.id, imageId), now);
    if (holdUntil === null) return false;
    challenge.boostHoldUntil = holdUntil;
    logBoostTarget(
        challenge,
        `Boost held ${formatDuration(holdUntil - now)} — photo ${imageId} entered the challenge too recently to be boosted yet`,
    );
    return true;
};

const runBoost = async (ctx: ActionContext) => {
    const { challenge, now } = ctx;
    // Every pass, so an entry's first-seen time is as close to its real entry
    // time as the cadence allows — including entries this pass just reflected.
    ctx.entryAges?.observe(challenge, now);
    const { boost, isTimerBasedAvailable, isKeyUnlockedAvailable } = readBoostAvailability(challenge);
    if (!isTimerBasedAvailable && !isKeyUnlockedAvailable) return;

    logger.withCategory('voting').info(`${logger.challengeTag(challenge)} Boost available`, null);

    // Use the centralized voting logic service for boost decisions.
    // emergency:true lets shouldApplyBoost apply an available boost
    // near the deadline even if autoBoost is off for this challenge.
    const shouldApplyBoost = votingLogic.shouldApplyBoost(challenge, now, { emergency: true });
    const effectiveBoostTime = votingLogic.getEffectiveBoostTime(challenge.id.toString());
    // For timer-based availability use boost.timeout; for key-unlocked use challenge end time
    const timeUntilDisplayBase = isTimerBasedAvailable ? finiteOr(boost.timeout, 0) - now : challenge.close_time - now;

    if (!shouldApplyBoost) {
        logBoostNotReady(challenge, isTimerBasedAvailable, timeUntilDisplayBase, effectiveBoostTime);
        return;
    }
    const target = await resolveBoostTarget(ctx);
    if (
        target?.imageId &&
        !isTimerBasedAvailable &&
        !votingLogic.isWithinEmergencyWindow(challenge, now) &&
        settings.getEffectiveSetting('protectUncertainAutoFills', challenge.id.toString()) &&
        ctx.entryAges?.isUncertain(challenge.id, target.imageId)
    ) {
        logBoostTarget(challenge, `auto-Boost skipped for uncertain auto-submitted photo ${oneLine(target.imageId)}`);
        return;
    }
    if (!target || holdBoostForFreshEntry(ctx, target.imageId)) return;
    await applyAvailableBoost(ctx, target, isTimerBasedAvailable, timeUntilDisplayBase);
};

/**
 * Resolve the entry a fill-new turbo lands on: the freshly submitted photo, or
 * — when none could be submitted (full / none / failed) — the configured Turbo
 * Entry, if any.
 *
 *   `skipped` when the challenge left the active list (already logged)
 */
const resolveFillNewTurboTarget = async (
    { challenge, token, fillDeps }: ActionContext,
    configuredImageId: string | null | undefined,
): Promise<{ skipped: true } | { skipped: false; imageId: string | null | undefined }> => {
    const filled = await autoFill.submitNewEntryForAction(challenge, token, fillDeps);
    if (filled.ok) {
        autoFill.reflectNewEntry(challenge, filled.imageId);
        return { skipped: false, imageId: filled.imageId };
    }
    if (filled.reason === 'challenge-gone') {
        // The live re-check confirmed the challenge left the active
        // list — applying turbo to an existing entry on it would just
        // be a second failing call and a confusing log.
        logger
            .withCategory('turbo')
            .info(
                `${logger.challengeTag(challenge)} turbo fill-new: challenge left the active list — turbo skipped`,
                null,
            );
        return { skipped: true };
    }
    if (configuredImageId) {
        logger
            .withCategory('turbo')
            .info(
                `${logger.challengeTag(challenge)} turbo fill-new unavailable (${filled.reason}); applying to existing entry`,
                null,
            );
    }
    return { skipped: false, imageId: configuredImageId };
};

/**
 * fill-new was requested but no fresh photo could be submitted, so the target
 * never resolved. The two ways to land here need different logs: in the
 * on-conflict (or always-blocked) path an entry DOES exist — it just already
 * has Boost, so turbo cannot go on it and there is no valid fallback; only in
 * always mode on an empty challenge is there genuinely no entry at all.
 */
const logTurboWithoutTarget = (challenge: Challenge) => {
    const hasExistingEntry = (challenge?.member?.ranking?.entries?.length ?? 0) > 0;
    const skipReason = hasExistingEntry
        ? 'only entry already has Boost — turbo skipped'
        : 'could not submit a fresh photo and there is no existing entry — turbo skipped';
    logger.withCategory('turbo').info(`${logger.challengeTag(challenge)} turbo fill-new ${skipReason}`, null);
};

const applyTurboToEntry = async ({ challenge, token, api }: ActionContext, imageId: string) => {
    logger
        .withCategory('turbo')
        .startOperation(`turbo-apply-${challenge.id}`, `Applying turbo to entry ${imageId} on ${challenge.title}`);
    try {
        const result = await api.applyTurbo(challenge.id, imageId, token);
        if (result.ok) {
            // Mark the entry so a boost running later in this same pass avoids it.
            autoFill.reflectEntryFlag(challenge, imageId, 'turbo');
            logger
                .withCategory('turbo')
                .endOperation(`turbo-apply-${challenge.id}`, `Turbo applied to entry ${imageId}`);
        } else {
            logger
                .withCategory('turbo')
                .endOperation(`turbo-apply-${challenge.id}`, null, 'Apply request returned ok=false');
        }
    } catch (error) {
        logger.withCategory('turbo').endOperation(`turbo-apply-${challenge.id}`, null, failureText(error));
    }
};

const runTurboApply = async (ctx: ActionContext) => {
    const { challenge, now } = ctx;
    // Auto-apply a won turbo when eligible. emergency:true lets
    // shouldApplyTurbo apply a won turbo near the deadline even if
    // Auto-Apply Turbo (useTurbo) is off for this challenge.
    const turboApply = votingLogic.shouldApplyTurbo(challenge, now, { emergency: true });
    if (!turboApply.apply) return;

    // Surface the override so an applied turbo on a challenge with
    // Auto-Apply Turbo off is explained rather than looking like a bug.
    if (!settings.getEffectiveSetting('useTurbo', challenge.id.toString())) {
        logger
            .withCategory('turbo')
            .info(
                `${logger.challengeTag(challenge)} Emergency Fill window — applying won turbo despite Auto-Apply Turbo being off`,
                null,
            );
    }

    // Fill-new: submit a fresh photo and turbo that entry instead of an
    // existing one.
    const target = turboApply.fillNew
        ? await resolveFillNewTurboTarget(ctx, turboApply.imageId)
        : { skipped: false, imageId: turboApply.imageId };
    if (target.skipped) return;
    if (!target.imageId) {
        logTurboWithoutTarget(challenge);
        return;
    }
    if (
        !votingLogic.isWithinEmergencyWindow(challenge, now) &&
        settings.getEffectiveSetting('protectUncertainAutoFills', challenge.id.toString()) &&
        ctx.entryAges?.isUncertain(challenge.id, target.imageId)
    ) {
        logger
            .withCategory('turbo')
            .info(
                `${logger.challengeTag(challenge)} auto-Turbo skipped for uncertain auto-submitted photo ${oneLine(target.imageId)}`,
                null,
            );
        return;
    }
    await applyTurboToEntry(ctx, target.imageId);
};

const runAutoFill = async (ctx: ActionContext) => {
    const { challenge, token, now, fillDeps } = ctx;
    // Auto-fill missing entries near deadline (one slot per cycle, staggered).
    // On submit it reflects the new entry locally, so a turbo/boost that runs
    // later this cycle (timer order) acts on it instead of waiting a cycle.
    const fillResult = await autoFill.maybeAutoFillChallenge(challenge, token, now, fillDeps);
    if (fillResult === 'submitted') {
        logger
            .withCategory('voting')
            .info(
                `${logger.challengeTag(challenge)} autoFill: entry submitted (available to later actions this cycle)`,
                null,
            );
    }
};

const runEmergencyFill = async (ctx: ActionContext) => {
    const { challenge, token, now, fillDeps } = ctx;
    // Emergency fill: net for slots that staggered auto-fill leaves
    // empty (auto-fill off, or tags set with no match) — fills all
    // remaining slots once the challenge is inside the emergency window.
    const emergencyResult = await autoFill.maybeEmergencyFillChallenge(challenge, token, now, fillDeps);
    if (emergencyResult === 'submitted') {
        logger
            .withCategory('voting')
            .info(`${logger.challengeTag(challenge)} emergencyFill: entries submitted near deadline`, null);
    }
};

const actionRunners: Record<string, ((ctx: ActionContext) => Promise<void>) | undefined> = {
    boost: runBoost,
    turbo: runTurboApply,
    autoFill: runAutoFill,
    emergencyFill: runEmergencyFill,
};

/**
 * Shared dependency bundle for every auto-fill entry point this pass
 * (fill-new on boost/turbo, staggered auto-fill, emergency fill).
 */
const buildFillDeps = (api: VotingPassApi, entryAges: EntryAgeLedger | null) => ({
    settings,
    logger,
    getEligiblePhotos: api.getEligiblePhotos,
    getImageData: api.getImageData,
    submitToChallenge: api.submitToChallenge,
    entryAges,
    getActiveChallenges: api.getActiveChallenges,
    // Enables tag resolution on the themed-search miss path; without the
    // pair the themed search skips tag resolution.
    searchTagAutocomplete: api.searchTagAutocomplete,
    getCurrentMemberProfile: api.getCurrentMemberProfile,
});

/**
 * Per-pass context threaded to every per-challenge phase below.
 */
export type PassContext = {
    token: string;
    api: VotingPassApi;
    fillDeps: FillDeps;
    interChallengeDelay: () => number;
    entryTracker: EntryTracker | null;
    entryAges: EntryAgeLedger | null;
    currency: CurrencyPassDeps | null;
    scenarios: ScenarioDeps | null;
    missions: MissionNeeds | null;
    refreshMissionNeeds: (() => Promise<MissionNeeds | null>) | null;
    /** Photos each eligible challenge votes on this cycle for a vote mission; 0 = none. */
    missionVoteQuota: number;
    allChallenges: Challenge[];
    turboSnapshot: number;
};

type FillDeps = ReturnType<typeof buildFillDeps>;

/**
 * Standard cancelled-pass exit shared by every cancellation checkpoint: one
 * warn, close the operation, surface the full active list.
 */
const cancelPass = (allChallenges: Challenge[], warning: string = '🛑 Voting cancelled by user'): VotingPassResult => {
    logger.withCategory('voting').warning(warning, null);
    logger.withCategory('voting').endOperation('voting-process', null, 'Voting cancelled by user');
    return { success: false, message: 'Voting cancelled by user', challenges: allChallenges };
};

/**
 * Failed-pass exit before any challenge is processed: log on the challenges
 * category, close the operation with the same message, surface the list.
 */
const abortPass = (msg: string, allChallenges: Challenge[], level: 'error' | 'warning'): VotingPassResult => {
    logger.withCategory('challenges')[level](msg, null);
    logger.withCategory('voting').endOperation('voting-process', null, msg);
    return { success: false, error: msg, challenges: allChallenges };
};

/**
 * Cleanup stale metadata against the full active list — must run before any
 * per-challenge filter so we don't drop metadata for challenges the user is
 * simply not running this pass.
 */
const pruneStaleMetadata = (
    cleanupStaleMetadata: (activeChallengeIds: string[]) => boolean,
    allChallenges: Challenge[],
) => {
    try {
        const activeChallengeIds = allChallenges.map((challenge) => challenge.id.toString());
        const cleanupSuccess = cleanupStaleMetadata(activeChallengeIds);
        if (cleanupSuccess) {
            logger.withCategory('api').debug('Successfully cleaned up stale metadata', null);
        } else {
            logger.withCategory('api').warning('Failed to cleanup stale metadata', null);
        }
    } catch (error) {
        logger.withCategory('api').warning('Error during metadata cleanup:', error);
    }
};

/**
 * Narrow the pass to the per-card "Run" challenge when a filter is set.
 *
 *   `result` is the pass's exit value when the filtered challenge is not active.
 */
const selectPassChallenges = (
    allChallenges: Challenge[],
    challengeIdFilter: string | number | null,
): { challenges: Challenge[]; result?: undefined } | { result: VotingPassResult; challenges?: undefined } => {
    if (challengeIdFilter == null) {
        return {
            challenges: [...allChallenges].sort((a, b) => (a?.close_time ?? Infinity) - (b?.close_time ?? Infinity)),
        };
    }
    const idStr = String(challengeIdFilter);
    const challenges = allChallenges.filter((c) => String(c.id) === idStr);
    if (challenges.length === 0) {
        return { result: abortPass(`Challenge ${idStr} is not active`, allChallenges, 'warning') };
    }
    logger.withCategory('voting').info(`🎯 Run scoped to single challenge: ${challenges[0].title} (${idStr})`, null);
    return { challenges };
};

/**
 * Auto-earn turbo by playing the mini-game when eligible. This has no
 * close-time threshold (it plays whenever a turbo is winnable). It runs ahead
 * of the timer-ordered deadline actions so a win can be applied in this pass.
 * With Save Turbos for Missions on, the earn waits (isTurboEarnSaved) unless a
 * "Win Turbo" mission still needs wins; every win counts down that mission.
 */
const playAutoTurbo = async (
    challenge: Challenge,
    now: number,
    { api, token, missions, refreshMissionNeeds, turboSnapshot }: PassContext,
) => {
    if (!votingLogic.shouldPlayAutoTurbo(challenge, now)) return;
    const savedForMission = votingLogic.isTurboEarnSaved(challenge, now);
    if (savedForMission && missions && missions.turbo > 0 && refreshMissionNeeds) {
        const fresh = await refreshMissionNeeds();
        if (!fresh) return;
        missions.turbo = Math.min(missions.turbo, fresh.turbo);
    }
    if (wasManualTurboRunSince(challenge.id, turboSnapshot)) return;
    const missionWants = (missions?.turbo ?? 0) > 0;
    if (!missionWants && savedForMission) {
        logger.withCategory('turbo').debug(`${logger.challengeTag(challenge)} Turbo saved for a mission`, null);
        return;
    }
    if (!claimTurboRun(challenge.id)) return;
    const purpose = missionWants ? ` for the turbo mission (${missions?.turbo} to go)` : '';
    logger
        .withCategory('turbo')
        .startOperation(`turbo-earn-${challenge.id}`, `Playing turbo mini-game on ${challenge.title}${purpose}`);
    try {
        const result = await api.runTurboMiniGame(challenge, token);
        if (result.won) {
            consumeMission(missions, 'turbo');
            // The API confirmed the win; let this pass's apply decision see it.
            if (challenge.member?.turbo) challenge.member.turbo.state = 'WON';
        }
        const summary = `played=${result.played} correct=${result.correct} flipped=${result.flipped} doubleFailed=${result.doubleFailed} won=${result.won}`;
        logger.withCategory('turbo').endOperation(`turbo-earn-${challenge.id}`, summary);
    } catch (error) {
        logger.withCategory('turbo').endOperation(`turbo-earn-${challenge.id}`, null, failureText(error));
    } finally {
        releaseTurboRun(challenge.id, 'automatic');
    }
};

/**
 * Deadline actions (boost / auto-fill / turbo apply / emergency fill) run in the
 * order their configured timers imply — largest seconds-before-close window
 * first — instead of a fixed code order, so e.g. auto-fill (15m) acts before
 * turbo (12m) when both are due. Each runner keeps its own full eligibility
 * check, so an action that isn't actually due just no-ops.
 *
 * @returns the cancelled-pass result, or null to continue
 */
const runDeadlineActions = async (
    challenge: Challenge,
    now: number,
    pass: PassContext,
): Promise<VotingPassResult | null> => {
    const actionCtx: ActionContext = {
        challenge,
        token: pass.token,
        now,
        api: pass.api,
        fillDeps: pass.fillDeps,
        entryAges: pass.entryAges,
    };
    for (const { action } of votingLogic.orderDeadlineActions(challenge)) {
        // Honor cancellation between actions, same as the per-challenge guard.
        if (cancellation.isCancelled()) {
            return cancelPass(pass.allChallenges);
        }
        // Defensive: orderDeadlineActions only emits the four known keys, but
        // guard the dispatch so a future action added there without a matching
        // runner degrades to a skip instead of throwing and aborting the loop.
        const run = actionRunners[action];
        if (typeof run === 'function') await run(actionCtx);
    }
    return null;
};

/**
 * New-entry detection (voteOnNewEntry) state for one challenge.
 *
 * The setting is read HERE and nowhere else — VotingLogic takes the
 * already-gated boolean. Gating the whole block (not just the decision) keeps
 * the feature genuinely opt-in: metadata.json is a synchronous whole-file
 * read/write, and a user who never enables this should pay none of it.
 */
const detectNewEntry = (challenge: Challenge, entryTracker: EntryTracker | null) => {
    const challengeId = challenge.id.toString();
    const tracking =
        entryTracker && settings.getEffectiveSetting('voteOnNewEntry', challengeId) === true
            ? newEntryTracker.readEntryIds(challenge)
            : null;
    // `tracking` is only set when entryTracker is.
    const previousIds = tracking ? (entryTracker as EntryTracker).get(challengeId) : null;
    const hasNewEntry = tracking ? newEntryTracker.hasNewEntries(previousIds, tracking) : false;
    return { challengeId, tracking, previousIds, hasNewEntry };
};

/**
 * How a detected new entry played out in the vote decision. Logged AFTER the
 * decision so the line matches the outcome: the voting pause holds the trigger
 * armed, so claiming "forcing a vote this cycle" off `hasNewEntry` alone would
 * repeat every cycle for the whole pause, directly above a "Skipping voting -
 * voting paused" line saying the opposite.
 */
const describeNewEntryOutcome = (
    { forcedByNewEntry, preservesNewEntryTrigger, shouldVote }: AutoVoteDecision,
    missionVote: boolean,
) => {
    if (missionVote) return 'voting for the vote mission';
    if (forcedByNewEntry) return 'forcing a vote this cycle';
    if (preservesNewEntryTrigger) return 'vote deferred until the pause ends — trigger stays armed';
    return shouldVote ? 'already eligible on its own' : 'not voting this cycle';
};

/**
 * Record the entry snapshot, which disarms the trigger. Called after the vote,
 * and additionally from the post-submit cancellation return — that one bails
 * out of the whole pass after the vote already landed, so skipping the record
 * there would re-force the identical vote next pass. The two earlier
 * cancellation returns deliberately do NOT record: no vote went out yet, so the
 * trigger must stay armed.
 *
 * Skipped only when a vote this trigger FORCED threw, so the next cycle retries
 * it — that is the whole retry contract. Deliberately NOT skipped for:
 *   - "no vote images available", which is not a throw; treating it as a
 *     failure would force a getVoteImages call every cycle forever on a
 *     challenge that never has any.
 *   - a blocked decision (onlyBoost / vote-only-in-last-minute /
 *     scheduled-fill-only / not started), which consumes the trigger. Every
 *     block that can later lift, lifts into a rule that already votes to 100%
 *     or re-reads exposure from scratch, so nothing is lost.
 *
 * The exception to that last point is a block that sets
 * `preservesNewEntryTrigger` — today only the voting pause. It lifts into the
 * NORMAL threshold rule, which votes only while exposure is below the trigger,
 * so consuming the trigger here would drop the new entry's vote entirely
 * instead of deferring it past the pause.
 */
const recordEntrySnapshot = (
    entryTracker: EntryTracker | null,
    entry: ReturnType<typeof detectNewEntry>,
    decision: AutoVoteDecision,
    voteThrew: boolean,
) => {
    if (!entry.tracking || (decision.forcedByNewEntry && voteThrew)) return;
    if (decision.preservesNewEntryTrigger && entry.hasNewEntry) return;
    if (!newEntryTracker.shouldRecordSnapshot(entry.previousIds, entry.tracking)) return;
    // `entry.tracking` is only set when entryTracker is.
    (entryTracker as EntryTracker).set(entry.challengeId, entry.tracking);
};

/**
 * Submit votes from an already-fetched pool, then pace before the next challenge.
 *
 * @param onVoteLanded - records the snapshot when a cancel follows a landed vote
 * @returns the cancelled-pass result, or null to continue
 */
const submitVoteImages = async (
    challenge: Challenge,
    voteImages: VoteImagesResponse,
    targetExposure: number,
    pass: PassContext,
    onVoteLanded: () => void,
    maxVotes?: number,
): Promise<VotingPassResult | null> => {
    // Check for cancellation before submitting votes
    if (cancellation.isCancelled()) {
        return cancelPass(pass.allChallenges, '🛑 Voting cancelled by user before vote submission');
    }

    logger
        .withCategory('voting')
        .info(
            `${logger.challengeTag(challenge)} Submitting votes for ${Math.min(voteImages.images.length, maxVotes ?? Infinity)} images`,
            null,
        );

    // Submit votes to target exposure (dynamic based on voting rules)
    await pass.api.submitVotes(voteImages, pass.token, targetExposure, maxVotes);

    // Check for cancellation before delay
    if (cancellation.isCancelled()) {
        // The vote already went through, so the trigger is spent —
        // record before bailing or the next pass re-votes it.
        onVoteLanded();
        return cancelPass(pass.allChallenges, '🛑 Voting cancelled by user after vote submission');
    }

    logger.withCategory('voting').endOperation(`vote-${challenge.id}`, 'voting attempt complete');

    // Add a delay between challenges (strategy-specific pacing)
    const delay = pass.interChallengeDelay();
    logger.withCategory('voting').debug(`Adding ${delay}ms delay between challenges`, null);
    await sleep(delay);
    return null;
};

type VoteOutcome = {
    cancelled: VotingPassResult | null;
    voteThrew: boolean;
    votePool: VoteImagesResponse | null | undefined;
};

/**
 * Vote on the challenge when the decision says so.
 *
 * `votePool` is the pool this pass voted from — handed to the exposure-fill
 * rule, which only spends when voting cannot reach its threshold. undefined =
 * voting didn't run (the rule fetches the pool itself); null = none.
 *
 * @param maxVotes - caps the photos voted on (a vote mission's share)
 */
const voteOnChallenge = async (
    challenge: Challenge,
    decision: { shouldVote: boolean; voteReason: string; targetExposure: number },
    pass: PassContext,
    onVoteLanded: () => void,
    maxVotes?: number,
): Promise<VoteOutcome> => {
    const outcome: VoteOutcome = { cancelled: null, voteThrew: false, votePool: undefined };
    if (!decision.shouldVote) {
        // Log why voting was skipped
        logger
            .withCategory('voting')
            .info(`${logger.challengeTag(challenge)} Skipping voting - ${decision.voteReason}`, null);
        return outcome;
    }

    logger
        .withCategory('voting')
        .startOperation(`vote-${challenge.id}`, `Voting on ${logger.challengeTag(challenge)}`, 'DEBUG');

    try {
        // Check for cancellation before voting
        if (cancellation.isCancelled()) {
            outcome.cancelled = cancelPass(
                pass.allChallenges,
                '🛑 Voting cancelled by user during challenge processing',
            );
            return outcome;
        }

        logger
            .withCategory('voting')
            .info(`${logger.challengeTag(challenge)} Starting voting process - ${decision.voteReason}`, null);

        // Get images to vote on
        const voteImages = await pass.api.getVoteImages(challenge, pass.token);
        // A capped mission pool is handed to the fill step whole, like any other.
        outcome.votePool = voteImages ?? null;
        if (voteImages && voteImages.images) {
            outcome.cancelled = await submitVoteImages(
                challenge,
                voteImages,
                decision.targetExposure,
                pass,
                onVoteLanded,
                maxVotes,
            );
        } else {
            // No images is a valid "nothing to do" state — close the op as a
            // DEBUG success (silent) and surface one WARN for user visibility.
            logger.withCategory('voting').endOperation(`vote-${challenge.id}`, 'no vote images available');
            logger
                .withCategory('voting')
                .warning(`${logger.challengeTag(challenge)} No vote images available — skipping`, null);
        }
    } catch (error) {
        outcome.voteThrew = true;
        logger.withCategory('voting').endOperation(`vote-${challenge.id}`, null, failureText(error));
    }
    return outcome;
};

/**
 * The vote a vote mission makes on a challenge the normal rules left waiting:
 * a replacement decision (up to 100%) plus the photo cap, or null when the
 * mission has no part here — no quota, the normal rule already votes, the
 * decision is blocked, or the challenge can't take votes.
 */
const missionVoteDecision = (
    challenge: Challenge,
    decision: AutoVoteDecision,
    pass: PassContext,
    now: number,
): { decision: AutoVoteDecision; maxVotes: number } | null => {
    const quota = pass.missionVoteQuota;
    if (!(quota >= 1) || decision.shouldVote || decision.blocked || !isMissionVoteCandidate(challenge, now)) {
        return null;
    }
    return {
        decision: {
            shouldVote: true,
            targetExposure: 100,
            voteReason: `vote mission: ${pass.missions?.vote} left at cycle start — voting on up to ${quota} photos`,
            forcedByNewEntry: false,
        },
        maxVotes: quota,
    };
};

/**
 * One challenge's full pass: its user-defined scenario, turbo-earn, currency
 * automation, deadline actions, new-entry detection, the vote, and the
 * post-vote exposure fill — in that order.
 *
 * @param position - 1-based index for progress reporting
 * @returns the cancelled-pass result, or null to continue
 */
const processChallenge = async (
    challenge: Challenge,
    now: number,
    position: number,
    total: number,
    pass: PassContext,
): Promise<VotingPassResult | null> => {
    // Check for cancellation before processing each challenge
    if (cancellation.isCancelled()) {
        return cancelPass(pass.allChallenges);
    }

    logger
        .withCategory('voting')
        .progress(`Processing challenge ${position}/${total}: ${challenge.title}`, position, total);

    // The challenge's scenario runs first: its actions (and a phase change)
    // land before the built-in steps, which then read the new phase's
    // settings overlay through getEffectiveSetting.
    await runScenarioStep(challenge, now, pass);

    await playAutoTurbo(challenge, now, pass);

    // Automatic key unlock and photo swap (opt-in per challenge/profile). They
    // run ahead of the deadline actions on purpose: an unlocked boost is then
    // available to the boost runner this same pass, and a swap happens before a
    // boost/turbo lands, so neither spends on the photo about to be replaced.
    const currencyCtx = { challenge, token: pass.token, now, currency: pass.currency };
    await currencyAuto.runAutoKey(currencyCtx);
    await currencyAuto.runAutoSwap(currencyCtx);

    const actionsCancelled = await runDeadlineActions(challenge, now, pass);
    if (actionsCancelled) return actionsCancelled;

    // New-entry detection runs AFTER the deadline actions on purpose: auto-fill /
    // emergency fill / boost-turbo fill-new all reflect their new entry into
    // challenge.member.ranking.entries, so an entry submitted seconds ago in this
    // very cycle is detected in this very cycle rather than waiting for the next one.
    const entry = detectNewEntry(challenge, pass.entryTracker);
    // Use the centralized voting logic service
    const decision = votingLogic.evaluateVotingDecision(challenge, now, { hasNewEntry: entry.hasNewEntry });
    // What actually runs: a vote mission may turn a threshold-wait into a capped vote.
    const missionVote = missionVoteDecision(challenge, decision, pass, now);
    const voteDecision = missionVote?.decision ?? decision;

    if (entry.hasNewEntry) {
        logger
            .withCategory('voting')
            .info(
                `${logger.challengeTag(challenge)} New entry detected — ${describeNewEntryOutcome(voteDecision, missionVote !== null)}`,
                null,
            );
    }

    // onVoteLanded fires only when a cancel follows a submit that already
    // landed, so it records the snapshot with voteThrew=false; calling it from
    // a failure path would disarm a forced-vote retry.
    const vote = await voteOnChallenge(
        challenge,
        voteDecision,
        pass,
        () => recordEntrySnapshot(pass.entryTracker, entry, decision, false),
        missionVote?.maxVotes,
    );
    if (vote.cancelled) return vote.cancelled;

    recordEntrySnapshot(pass.entryTracker, entry, decision, vote.voteThrew);

    // Automatic exposure fill, AFTER the vote: a fill is only worth spending
    // when this pass's voting could not lift exposure to the fill threshold.
    // Failing that, a "Use Fill" mission may want one; either counts toward it.
    if (!vote.voteThrew) {
        const filled =
            (await currencyAuto.runAutoExposureFill(currencyCtx, vote.votePool)) ||
            (await currencyAuto.runMissionFill(currencyCtx, pass.missions?.fill ?? 0));
        if (filled) consumeMission(pass.missions, 'fill');
    }
    return null;
};

// The last "no challenge can take votes" line logged, so a stall that lasts
// cycles after cycle is reported once, and again after a cycle that voted.
let lastVoteStall = '';

// Test hook: forget the last logged stall.
const resetMissionVoteLog = () => {
    lastVoteStall = '';
};

/**
 * This cycle's per-challenge share of an active vote mission, over the whole
 * active list; 0 when there is none to do. A single-challenge run never does
 * mission votes. Logs when a mission is active but no challenge can take votes
 * (not again until that changes). A challenge the normal rules already vote on
 * takes no share: it gets no mission top-up.
 */
const planMissionVotes = (
    missions: MissionNeeds | null,
    challengeIdFilter: string | number | null,
    allChallenges: Challenge[],
): number => {
    const votesLeft = missions?.vote ?? 0;
    if (!(votesLeft > 0) || challengeIdFilter != null) return 0;
    const nowSec = Math.floor(Date.now() / 1000);
    const quota = missionVoteQuota(votesLeft, allChallenges, nowSec, (challenge) => {
        const decision = votingLogic.evaluateVotingDecision(challenge, nowSec);
        return decision.blocked === true || decision.shouldVote;
    });
    if (quota > 0) {
        lastVoteStall = '';
        return quota;
    }
    const stall = `🗳️ Vote mission: ${votesLeft} left — no challenge can take votes now (all full, flash or held by your settings); retrying next cycle`;
    if (stall !== lastVoteStall) {
        lastVoteStall = stall;
        logger.withCategory('voting').info(stall, null);
    }
    return quota;
};

/**
 * The voting pass — see the file header.
 */
const runVotingPass = async (
    token: string,
    challengeIdFilter: string | number | null,
    deps: VotingPassDeps,
): Promise<VotingPassResult> => {
    const {
        api,
        cleanupStaleMetadata,
        interChallengeDelay,
        entryTracker = null,
        entryAges = null,
        currency = null,
        scenarios = null,
        missions = null,
        refreshMissionNeeds = null,
    } = deps;
    const fillDeps = buildFillDeps(api, entryAges);
    // Clear the photo-stats failure breaker so a pass that hit a rate limit does
    // not disable stat enrichment for every later pass in the session.
    photoStats.resetPassState();
    logger.withCategory('voting').startOperation('voting-process', 'Voting process');
    const unregisterMissionNeeds = registerMissionNeeds(token, missions);

    try {
        // Get all active challenges
        logger.withCategory('challenges').info('🔄 Loading active challenges', null);
        const turboSnapshot = turboRunSnapshot();
        const { challenges: allChallenges, fetchFailed } = await api.getActiveChallenges(token);

        // A failed fetch is not an empty account. makePostRequest resolves null once retries
        // are exhausted, which would otherwise arrive here as an empty list and be reported
        // as a successful pass with "No active challenges found" — an outage indistinguishable
        // from having nothing to vote on, with the scheduler re-arming as if all were well.
        if (fetchFailed) {
            return abortPass('Could not load active challenges — the API request failed', allChallenges, 'error');
        }

        logger.withCategory('challenges').info(`📋 Found ${allChallenges.length} active challenges`, null);

        if (allChallenges.length === 0) {
            logger.withCategory('challenges').warning('No active challenges found', null);
            logger.withCategory('voting').endOperation('voting-process', 'No challenges to process');
            return { success: true, message: 'No active challenges found', challenges: allChallenges };
        }

        if (cleanupStaleMetadata) pruneStaleMetadata(cleanupStaleMetadata, allChallenges);

        const scope = selectPassChallenges(allChallenges, challengeIdFilter);
        if (scope.result) return scope.result;
        const { challenges } = scope;

        const pass: PassContext = {
            token,
            api,
            fillDeps,
            interChallengeDelay,
            entryTracker,
            entryAges,
            currency,
            scenarios,
            missions,
            refreshMissionNeeds,
            missionVoteQuota: planMissionVotes(missions, challengeIdFilter, allChallenges),
            allChallenges,
            turboSnapshot,
        };

        // Process each challenge
        let processedCount = 0;
        for (const challenge of challenges) {
            processedCount++;

            // Current timestamp in seconds (Unix epoch time), re-read per challenge rather
            // than captured once for the whole pass. A pass spends 2-5s of inter-challenge
            // delay per challenge, plus retries (up to 30s per request), paginated library
            // walks and up to 25 get_image_data calls per fill — minutes in total. A single
            // pass-start clock would evaluate every later challenge against a time biased
            // into the past, missing last-minute/emergency/boost/turbo windows that opened
            // mid-pass and treating an already-closed challenge as still open.
            const now = Math.floor(Date.now() / 1000);

            // One malformed challenge must not cost the pass every challenge after it: an
            // unguarded property read would otherwise throw into the single outer catch
            // below and abandon the whole pass. Catching here lets the loop move on to the
            // next challenge; the cancellation checkpoints inside return a result rather
            // than throw, so cancellation still exits the pass immediately rather than
            // being swallowed as a per-challenge error.
            try {
                const cancelled = await processChallenge(challenge, now, processedCount, challenges.length, pass);
                if (cancelled) return cancelled;
            } catch (error) {
                logger
                    .withCategory('voting')
                    .error(
                        `${logger.challengeTag(challenge)} Skipped after an unexpected error — continuing with the remaining challenges`,
                        error,
                    );
            }
        }

        // Complete the voting process
        logger
            .withCategory('voting')
            .endOperation('voting-process', `All ${challenges.length} challenges processed successfully`);

        return { success: true, message: 'Voting process completed successfully', challenges: allChallenges };
    } catch (error) {
        logger.withCategory('voting').endOperation('voting-process', null, failureText(error));
        return {
            success: false,
            error: errorMessage(error) || 'Voting process failed',
        };
    } finally {
        unregisterMissionNeeds?.();
    }
};

export { runVotingPass, resetMissionVoteLog };
