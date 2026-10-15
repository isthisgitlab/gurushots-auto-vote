import * as logger from '../../logger';
import * as settings from '../../settings';
import * as votingLogic from '../VotingLogic';
import * as autoFill from '../autoFill';
import { formatDuration } from '../../format/duration';
import { failureText, oneLine } from '../../format/logSafe';
import { secondsToBoostDeadline } from '../../voting/boostWindow';
import { consumeMission } from '../missions';
import { buildFillDeps } from './context';

import type { Challenge, MemberBoost } from '../../types/gurushots';
import type { ActionContext } from './context';
import type { VotingPassApi } from '../../types/votingPass';
import type { EntryAgeLedger } from '../../types/stores';

// `explicit`: sent by id (boostEntryById), not left to applyBoost's own pick.
// `pinned`: the photo the user pinned for Boost, which counts as their confirmation of it.
// `atRelease`: a photo pinned for Turbo, boosted at the instant its pin gives way (sleep boost only).
type BoostTarget = { imageId: string; explicit: boolean; pinned?: boolean; atRelease?: boolean };

/** What a boost sent on device sleep came to. */
export type SuspendBoostOutcome = 'applied' | 'unconfirmed' | 'skipped';

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

/** Close the outer boost-<id> operation as a failure/skip with `reason`. */
const endBoostOperation = (challenge: Challenge, reason: string) => {
    logger.withCategory('boost').endOperation(`boost-${challenge.id}`, null, reason);
};

/**
 * Boost a named entry. applyBoost raises the `boosted` flag itself (it owns the
 * entry pick); the explicit-entry call cannot, so reflect it here.
 *
 * @param imageId - the entry to boost
 * @returns the boost result; falsy once the operation is closed
 */
const boostEntryById = async (
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
        // dangle open on failure (the applyBoost path closes its own).
        endBoostOperation(challenge, 'boost apply to entry failed');
    }
    return boostResult;
};

const logBoostTarget = (challenge: Challenge, message: string) => {
    logger.withCategory('boost').info(`${logger.challengeTag(challenge)} ${message}`, null);
};

/**
 * The photo pinned for Boost when it is usable. It beats a pending fill-new
 * photo and both fill-new modes, so it is the first thing a target resolves to.
 */
const pinnedBoostTarget = (challenge: Challenge): BoostTarget | null => {
    const pin = votingLogic.resolvePin(challenge, challenge.id.toString(), 'boost');
    return pin.state === 'hit' ? { imageId: String(pin.entry.id), explicit: false, pinned: true } : null;
};

/** The photo an earlier fill-new submitted that its boost is still waiting on. */
const pendingBoostTarget = ({ challenge, entryAges }: ActionContext): BoostTarget | null => {
    const pending = entryAges?.pending(challenge.id.toString());
    return pending ? { imageId: pending, explicit: true } : null;
};

/**
 * The configured Boost Entry, or null when no entry can take a boost (none yet,
 * or every entry has Turbo or is pinned for Turbo).
 */
const existingBoostTarget = (challenge: Challenge, now: number): BoostTarget | null => {
    const imageId = votingLogic.pickBoostEntry(challenge, challenge.id.toString(), now)?.id;
    return imageId ? { imageId, explicit: false } : null;
};

const hasEntries = (challenge: Challenge): boolean => {
    const entries = challenge?.member?.ranking?.entries;
    return Array.isArray(entries) && entries.length > 0;
};

/** Log why no entry can take the boost, so it is skipped rather than sent to fail. */
const logNoBoostEntry = (challenge: Challenge) => {
    logBoostTarget(
        challenge,
        hasEntries(challenge)
            ? 'no entry can take the boost (every entry has Turbo or is pinned for Turbo) — boost skipped'
            : 'no entry to boost yet — boost skipped',
    );
};

/**
 * A boost the photo pinned for Turbo blocks waits for that pin to give way: record the instant in
 * the field a fresh-entry hold uses, so the next cycle lands on it (nothing for a block that never does).
 */
const wakeAtPinRelease = ({ challenge, now }: ActionContext) => {
    const releaseAt = votingLogic.pinReleaseAt(challenge, challenge.id.toString(), 'turbo', now);
    if (releaseAt !== null) challenge.boostHoldUntil = releaseAt;
};

/**
 * The entry a due boost lands on: the photo pinned for Boost; else the photo an earlier
 * fill-new submitted and the boost is still waiting on; else, with fill-new on, a fresh photo
 * submitted now (remembered as pending, so a held boost reuses it instead of submitting
 * another); else the configured Boost Entry.
 *
 * @returns null when no valid target exists — fill-new found none, or no entry can take
 *   the boost (every entry has Turbo or is pinned for Turbo) — and the boost is skipped (already logged)
 */
const resolveBoostTarget = async (ctx: ActionContext): Promise<BoostTarget | null> => {
    const { challenge, token, now, fillDeps, entryAges } = ctx;
    const cid = challenge.id.toString();
    const named = pinnedBoostTarget(challenge) ?? pendingBoostTarget(ctx);
    if (named) return named;
    const existing = () => existingBoostTarget(challenge, now);
    // 'always' = boostNewSubmit; 'conflict' = boostNewSubmitOnConflict when every
    // entry has Turbo or is pinned for Turbo; 'no' = boost an existing entry.
    const fillMode = votingLogic.resolveBoostFillNewMode(challenge, cid);
    if (fillMode === 'no') {
        const target = existing();
        if (!target) {
            logNoBoostEntry(challenge);
            wakeAtPinRelease(ctx);
        }
        return target;
    }
    const filled = await autoFill.submitNewEntryForAction(challenge, token, fillDeps);
    if (filled.ok) {
        // An ok fill always carries the submitted imageId.
        const imageId = String(filled.imageId);
        autoFill.reflectNewEntry(challenge, imageId);
        entryAges?.markPending(challenge, imageId, now);
        return { imageId, explicit: true };
    }
    if (filled.reason === 'challenge-gone') {
        // The live re-check confirmed the challenge left the active list —
        // boosting an existing entry on it would just be a second failing call.
        logBoostTarget(challenge, 'challenge left the active list — boost skipped');
        return null;
    }
    // 'always' mode falls back to the configured Boost Entry when no fresh photo can be submitted
    // (full / none / failed); with none that can take the boost either, it is skipped, not sent to fail.
    const fallback = existing();
    if (!fallback) {
        logBoostTarget(
            challenge,
            `boost fill-new unavailable (${filled.reason}); no entry can take the boost — boost skipped`,
        );
        wakeAtPinRelease(ctx);
        return null;
    }
    logBoostTarget(challenge, `boost fill-new unavailable (${filled.reason}); boosting existing entry`);
    return fallback;
};

/**
 * @param target - from resolveBoostTarget
 * @param timeUntilDisplayBase - seconds to the boost timeout (timer-based) or challenge end
 * @returns whether the boost landed
 */
const applyAvailableBoost = async (
    ctx: ActionContext,
    target: BoostTarget,
    isTimerBasedAvailable: boolean,
    timeUntilDisplayBase: number,
): Promise<boolean> => {
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

    // The pin's fallback reason is logged here, on the pass that spends, so a held boost doesn't repeat it.
    const pinFallback = target.pinned ? null : votingLogic.pinFallbackOf(challenge, challenge.id.toString(), 'boost');
    const applyingMsg =
        (isTimerBasedAvailable
            ? `Applying boost to challenge ${logger.challengeTag(challenge)}`
            : `Applying boost to challenge ${logger.challengeTag(challenge)} (key-unlocked)`) +
        (pinFallback ? ` — ${votingLogic.describePinFallback('boost', pinFallback)}` : '');
    logger.withCategory('boost').startOperation(`boost-${challenge.id}`, applyingMsg);

    try {
        const boostResult = target.explicit
            ? await boostEntryById(ctx, challenge.id.toString(), target.imageId)
            : await api.applyBoost(challenge, token);
        if (boostResult) {
            ctx.entryAges?.clearPending(challenge.id, ctx.now);
            const successSuffix = isTimerBasedAvailable
                ? `${timeDisplay} remaining`
                : `${timeDisplay} until challenge ends`;
            logger
                .withCategory('boost')
                .endOperation(`boost-${challenge.id}`, `Boost applied successfully (${successSuffix})`);
            return true;
        }
        // On null/falsy result the operation is already closed with the failure
        // reason (by applyBoost itself, or by boostEntryById) — no caller-side
        // fallback log needed (mirrors the turbo handling shape).
    } catch (error) {
        endBoostOperation(challenge, failureText(error));
    }
    return false;
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
 * When a due boost on `imageId` would still be held for `boostFreshEntryWait`
 * (VotingLogic.getBoostHoldUntil).
 *
 * @param imageId - the entry the boost would land on
 * @returns the release instant, or null when the boost is not held
 */
const freshEntryHoldUntil = ({ challenge, now, entryAges }: ActionContext, imageId: string): number | null => {
    if (!entryAges) return null;
    return votingLogic.getBoostHoldUntil(challenge, entryAges.enteredAt(challenge.id, imageId), now);
};

/**
 * Hold a due boost while its target photo is newer than `boostFreshEntryWait`.
 * The release instant goes on the challenge so the cadence decision lands the
 * next cycle on it.
 *
 * @param imageId - the entry the boost would land on
 * @returns true when the boost waits this pass
 */
const holdBoostForFreshEntry = (ctx: ActionContext, imageId: string): boolean => {
    const holdUntil = freshEntryHoldUntil(ctx, imageId);
    if (holdUntil === null) return false;
    const { challenge, now } = ctx;
    challenge.boostHoldUntil = holdUntil;
    logBoostTarget(
        challenge,
        `Boost held ${formatDuration(holdUntil - now)} — photo ${imageId} entered the challenge too recently to be boosted yet`,
    );
    return true;
};

/**
 * Skip a key-unlocked boost (outside the emergency window) that would land on an
 * auto-submitted photo whose standing is still uncertain. A pinned photo is never
 * skipped: pinning it is the user's confirmation. A photo taken at its pin's release
 * is never skipped either: a release happens inside the blocked spend's own emergency window.
 *
 * @returns true when the boost is skipped (already logged)
 */
const skipForUncertainPhoto = (ctx: ActionContext, target: BoostTarget, isTimerBasedAvailable: boolean): boolean => {
    const { challenge, now } = ctx;
    if (
        target.pinned ||
        target.atRelease ||
        isTimerBasedAvailable ||
        votingLogic.isWithinEmergencyWindow(challenge, now) ||
        !settings.getEffectiveSetting('protectUncertainAutoSubmits', challenge.id.toString()) ||
        !ctx.entryAges?.isUncertain(challenge.id, target.imageId)
    ) {
        return false;
    }
    logBoostTarget(challenge, `auto-Boost skipped for uncertain auto-submitted photo ${oneLine(target.imageId)}`);
    return true;
};

export const runBoost = async (ctx: ActionContext) => {
    const { challenge, now } = ctx;
    // Every pass, so an entry's first-seen time is as close to its real entry
    // time as the cadence allows — including entries this pass just reflected.
    ctx.entryAges?.observe(challenge, now);
    const { isTimerBasedAvailable, isKeyUnlockedAvailable } = readBoostAvailability(challenge);
    if (!isTimerBasedAvailable && !isKeyUnlockedAvailable) return;

    logger.withCategory('voting').info(`${logger.challengeTag(challenge)} Boost available`, null);

    // Use the centralized voting logic service for boost decisions.
    // emergency:true lets shouldApplyBoost apply an available boost
    // near the deadline even if autoBoost is off for this challenge.
    const shouldApplyBoost = votingLogic.shouldApplyBoost(challenge, now, { emergency: true });
    const effectiveBoostTime = votingLogic.getEffectiveBoostTime(challenge.id.toString());
    const timeUntilDisplayBase = secondsToBoostDeadline(challenge, now);

    if (!shouldApplyBoost) {
        // A "Use a boost" mission still needing one pulls an already-free boost forward.
        const boostNeed = ctx.missions?.boost ?? 0;
        if (!votingLogic.isBoostDueForMission(challenge, now, boostNeed)) {
            logBoostNotReady(challenge, isTimerBasedAvailable, timeUntilDisplayBase, effectiveBoostTime);
            return;
        }
        logger
            .withCategory('boost')
            .info(`${logger.challengeTag(challenge)} Boost due early for the boost mission (${boostNeed} to go)`, null);
    }
    const target = await resolveBoostTarget(ctx);
    if (
        !target ||
        skipForUncertainPhoto(ctx, target, isTimerBasedAvailable) ||
        holdBoostForFreshEntry(ctx, target.imageId)
    )
        return;
    if (await applyAvailableBoost(ctx, target, isTimerBasedAvailable, timeUntilDisplayBase)) {
        consumeMission(ctx.missions, 'boost');
    }
};

/**
 * The entry a boost sent on device sleep lands on. Same rule as
 * resolveBoostTarget, except a new photo is never submitted — a submit cannot
 * finish before the device sleeps — so a boost fill-new would have put on a
 * fresh photo goes to the existing entry instead, and a photo pinned for Turbo that
 * would give way to the boost before its deadline is taken as already given way.
 *
 * @returns null when no entry can take the boost (already logged)
 */
const resolveSuspendBoostTarget = (ctx: ActionContext): BoostTarget | null => {
    const { challenge } = ctx;
    const named = pinnedBoostTarget(challenge) ?? pendingBoostTarget(ctx);
    if (named) return named;
    const cid = challenge.id.toString();
    // The device cannot come back for a Turbo pin's release, so a boost that pin blocks now takes the
    // pick the release gives it — sent by id, since applyBoost would pick at the clock and find none.
    // Only a boost the deadline view holds at the release (same rule) is due then; any other is due now.
    const blocked = votingLogic.isBoostBlocked(challenge, cid, ctx.now);
    const releaseAt = blocked ? votingLogic.pinReleaseAt(challenge, cid, 'turbo', ctx.now) : null;
    const released = releaseAt === null ? null : existingBoostTarget(challenge, releaseAt);
    const existing =
        existingBoostTarget(challenge, ctx.now) ?? (released && { ...released, explicit: true, atRelease: true });
    if (!existing) {
        if (!blocked && hasEntries(challenge) && votingLogic.resolveBoostFillNewMode(challenge, cid) !== 'no') {
            // Fill-new would have put the boost on a fresh photo, and the pin keeps the existing one.
            logBoostTarget(
                challenge,
                'every entry has Turbo or is pinned for Turbo, and a new photo cannot be submitted before sleep — boost skipped',
            );
        } else {
            // No entry yet, or every entry turboed or pinned for Turbo with the pin never giving way
            // (the conflict row describeDeadlineActions keeps); applyBoost would only fail.
            logNoBoostEntry(challenge);
        }
        return null;
    }
    if (votingLogic.resolveBoostFillNewMode(challenge, challenge.id.toString()) !== 'no') {
        logBoostTarget(
            challenge,
            'boost fill-new is on, but a new photo cannot be submitted before sleep; boosting existing entry',
        );
    }
    if (existing.atRelease) {
        logBoostTarget(
            challenge,
            `photo ${oneLine(existing.imageId)} is pinned for Turbo, which gives way at its release time after the device sleeps — boosting it now`,
        );
    }
    return existing;
};

/**
 * Apply a boost that auto-vote would apply soon, because the device is going to
 * sleep. The caller selected the challenge, so Boost Time is not re-checked; the
 * target rule and the uncertain-photo skip are runBoost's own.
 *
 * The fresh-entry hold does not apply: a hold means "retry later", and at sleep
 * the device cannot come back to finish it — but the hold never keeps a Boost
 * past its deadline, so a sleep that outlasts the window must boost now. The hold
 * is neither recorded nor retried here; a log line says it was overridden.
 *
 * Scenario phase overlays are read as they are now: a later phase that would
 * retarget or disable the boost is not anticipated. The pass runs auto-swap before
 * its deadline actions and this path does not, so a swap that would have replaced
 * the Boost Entry can land after wake on the boosted photo. Accepted.
 */
export const runSuspendBoost = async (ctx: ActionContext): Promise<SuspendBoostOutcome> => {
    const { challenge, now } = ctx;
    const { isTimerBasedAvailable, isKeyUnlockedAvailable } = readBoostAvailability(challenge);
    if (!isTimerBasedAvailable && !isKeyUnlockedAvailable) {
        logBoostTarget(challenge, 'boost no longer available — nothing to send before sleep');
        return 'skipped';
    }
    const target = resolveSuspendBoostTarget(ctx);
    if (!target || skipForUncertainPhoto(ctx, target, isTimerBasedAvailable)) return 'skipped';
    if (freshEntryHoldUntil(ctx, target.imageId) !== null) {
        logBoostTarget(
            challenge,
            `photo ${oneLine(target.imageId)} has not finished "Wait Before Boosting a New Photo", but the device is going to sleep — boosting it now`,
        );
    }
    const landed = await applyAvailableBoost(
        ctx,
        target,
        isTimerBasedAvailable,
        secondsToBoostDeadline(challenge, now),
    );
    return landed ? 'applied' : 'unconfirmed';
};

/**
 * runSuspendBoost for every selected challenge, over the deps a voting pass
 * would use.
 *
 * All challenges run at once — a deliberate exception to the voting pass's
 * "per-challenge runners are sequential" invariant: these are separate challenge
 * objects with no shared mutation, and the ledger's read-modify-write is
 * synchronous. Skipping the 2–5 s inter-challenge delay is deliberate too, because
 * time is short. In mock mode the remembered list is the live mock session cache
 * (by reference), so a concurrent mock pass can see these mutations; mock-only and
 * harmless.
 *
 * @returns one settled outcome per challenge, in order
 */
export const runSuspendBoosts = (
    challenges: readonly Challenge[],
    token: string,
    { api, entryAges }: { api: VotingPassApi; entryAges: EntryAgeLedger | null },
): Promise<PromiseSettledResult<SuspendBoostOutcome>[]> => {
    const now = Math.floor(Date.now() / 1000);
    const fillDeps = buildFillDeps(api, entryAges);
    return Promise.allSettled(
        challenges.map((challenge) => runSuspendBoost({ challenge, token, now, api, fillDeps, entryAges })),
    );
};
