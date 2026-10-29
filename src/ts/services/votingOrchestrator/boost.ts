import * as logger from '../../logger';
import * as settings from '../../settings';
import * as votingLogic from '../VotingLogic';
import * as autoFill from '../autoFill';
import { formatDuration } from '../../format/duration';
import { failureText, oneLine } from '../../format/logSafe';
import { boostDeadline, secondsToBoostDeadline, isKeyUnlockedBoost } from '../../voting/boostWindow';
import { consumeMission } from '../missions';

import type { Challenge, MemberBoost } from '../../types/gurushots';
import type { ActionContext } from './context';

// `explicit`: sent by id (boostEntryById), not left to applyBoost's own pick.
// `pinned`: the photo the user pinned for Boost, which counts as their confirmation of it.
// `atRelease`: a photo pinned for Turbo, boosted at the instant its pin gives way (sleep boost only).
export type BoostTarget = { imageId: string; explicit: boolean; pinned?: boolean; atRelease?: boolean };

/**
 * Which kind of boost the challenge currently offers. Optional-chained to match
 * shouldApplyBoost/shouldApplyTurbo, which guard the same tree, so a payload
 * without `member` reads as "no boost" instead of throwing out of the
 * per-action loop.
 */
export const readBoostAvailability = (
    challenge: Challenge,
): { boost: MemberBoost; isTimerBasedAvailable: boolean; isKeyUnlockedAvailable: boolean } => {
    const boost: MemberBoost = challenge?.member?.boost || {};
    const hasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;
    return {
        boost,
        isTimerBasedAvailable: boost.state === 'AVAILABLE' && hasTimeout,
        isKeyUnlockedAvailable: isKeyUnlockedBoost(boost),
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

export const logBoostTarget = (challenge: Challenge, key: string, params: unknown[]) => {
    logger.withCategory('boost').infoT(key, [logger.challengeTag(challenge), ...params], null);
};

// The fill submits the photo in its boundary pass; +60 s puts the next cycle just after it. The
// same 60 s clamps the wake to `boostDeadline − 60`, mirroring BOOST_HOLD_MARGIN_SEC in
// getBoostHoldUntil, so one last poll still happens before the boost dies.
const PIN_WAIT_WAKE_GAP_SEC = 60;

/**
 * While a Boost pin waits for its photo (the photo is not in the challenge yet), arm a wake just
 * after the fill boundary that should submit it — but only when a fill will plausibly run: the
 * autoSubmit toggle on for the challenge and a schedule threshold still ahead of now. Without the
 * toggle, a configured-but-disabled schedule would re-arm `now + 60` every pass: a per-minute
 * wake/log loop. A boundary already overdue sets no hold either (the fill's window opened but the
 * photo did not land); normal cadence re-checks, and the per-pass skip log stays.
 */
const armPinWaitWake = ({ challenge, now }: ActionContext) => {
    const cid = challenge.id.toString();
    if (settings.getEffectiveSetting('autoSubmit', cid) !== true) return;
    const fillThresholdSec = votingLogic.getAutoFillThresholdSec(challenge, cid);
    const closeTime = Number(challenge.close_time);
    // A malformed close_time would pass NaN through both `<=` guards below and set a NaN hold;
    // every sibling fill-instant computation guards the same way.
    if (fillThresholdSec <= 0 || !Number.isFinite(closeTime)) return;
    const fillBoundary = closeTime - fillThresholdSec;
    if (fillBoundary <= now) return;
    const wakeAt = Math.min(fillBoundary + PIN_WAIT_WAKE_GAP_SEC, boostDeadline(challenge) - PIN_WAIT_WAKE_GAP_SEC);
    if (wakeAt <= now) return;
    challenge.boostHoldUntil = wakeAt;
};

/**
 * The photo pinned for Boost when it is usable. It beats a pending fill-new
 * photo and both fill-new modes, so it is the first thing a target resolves to.
 */
export const pinnedBoostTarget = (challenge: Challenge): BoostTarget | null => {
    const pin = votingLogic.resolvePin(challenge, challenge.id.toString(), 'boost');
    return pin.state === 'hit' ? { imageId: String(pin.entry.id), explicit: false, pinned: true } : null;
};

/** The photo an earlier fill-new submitted that its boost is still waiting on. */
export const pendingBoostTarget = ({ challenge, entryAges }: ActionContext): BoostTarget | null => {
    const pending = entryAges?.pending(challenge.id.toString());
    return pending ? { imageId: pending, explicit: true } : null;
};

/**
 * The configured Boost Entry, or null when no entry can take a boost (none yet,
 * or every entry has Turbo or is pinned for Turbo).
 */
export const existingBoostTarget = (challenge: Challenge, now: number): BoostTarget | null => {
    const imageId = votingLogic.pickBoostEntry(challenge, challenge.id.toString(), now)?.id;
    return imageId ? { imageId, explicit: false } : null;
};

export const hasEntries = (challenge: Challenge): boolean => {
    const entries = challenge?.member?.ranking?.entries;
    return Array.isArray(entries) && entries.length > 0;
};

/** Log why no entry can take the boost, so it is skipped rather than sent to fail. */
export const logNoBoostEntry = (challenge: Challenge) => {
    logBoostTarget(challenge, hasEntries(challenge) ? 'maa2d3401e212' : 'md99c0b138489', []);
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
 * The entry a due boost lands on: the photo pinned for Boost; else — the pin being absolute —
 * nothing while that photo is not an entry (the boost waits for it) or while it carries Turbo
 * (the boost never fires); else the photo an earlier fill-new submitted and the boost is still
 * waiting on; else, with fill-new on, a fresh photo submitted now (remembered as pending, so a
 * held boost reuses it instead of submitting another); else the configured Boost Entry.
 *
 * @returns null when no valid target exists — the pin is waiting or conflicted, fill-new found
 *   none, or no entry can take the boost (every entry has Turbo or is pinned for Turbo) — and the
 *   boost is skipped (already logged)
 */
const resolveBoostTarget = async (ctx: ActionContext): Promise<BoostTarget | null> => {
    const { challenge, token, now, fillDeps, entryAges } = ctx;
    const cid = challenge.id.toString();
    const named = pinnedBoostTarget(challenge);
    if (named) return named;
    // The pin is absolute: while the pinned photo is not an entry the boost waits for it (no
    // slot pick, no fill-new substitute, no pending-photo substitute), and while it carries
    // Turbo the boost never fires.
    const pin = votingLogic.resolvePin(challenge, cid, 'boost');
    if (pin.state === 'gone' || pin.state === 'conflict') {
        logBoostTarget(challenge, pin.state === 'gone' ? 'm3e7a92c4b518' : 'm6b04d81f7c23', []);
        if (pin.state === 'gone') armPinWaitWake(ctx);
        return null;
    }
    const pending = pendingBoostTarget(ctx);
    if (pending) return pending;
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
        logBoostTarget(challenge, 'm68af6d2b3623', []);
        return null;
    }
    // 'always' mode falls back to the configured Boost Entry when no fresh photo can be submitted
    // (full / none / failed); with none that can take the boost either, it is skipped, not sent to fail.
    const fallback = existing();
    if (!fallback) {
        logBoostTarget(challenge, 'm7c8a6b6fc65b', [filled.reason]);
        wakeAtPinRelease(ctx);
        return null;
    }
    logBoostTarget(challenge, 'm6c65118e63fa', [filled.reason]);
    return fallback;
};

/**
 * @param target - from resolveBoostTarget
 * @param timeUntilDisplayBase - seconds to the boost timeout (timer-based) or challenge end
 * @returns whether the boost landed
 */
export const applyAvailableBoost = async (
    ctx: ActionContext,
    target: BoostTarget,
    isTimerBasedAvailable: boolean,
    timeUntilDisplayBase: number,
): Promise<boolean> => {
    const { challenge, token, api } = ctx;
    // Surface the override so an applied boost on a challenge with
    // Auto-Apply Boost off is explained rather than looking like a bug.
    if (!settings.getEffectiveSetting('autoBoost', challenge.id.toString())) {
        logger.withCategory('boost').infoT('m1dd20ed44833', [logger.challengeTag(challenge)], null);
    }
    const timeDisplay = formatDuration(timeUntilDisplayBase);
    logger
        .withCategory('boost')
        .startOperation(
            `boost-${challenge.id}`,
            isTimerBasedAvailable
                ? `Applying boost to challenge ${logger.challengeTag(challenge)}`
                : `Applying boost to challenge ${logger.challengeTag(challenge)} (key-unlocked)`,
        );

    try {
        const boostResult = target.explicit
            ? await boostEntryById(ctx, challenge.id.toString(), target.imageId)
            : await api.applyBoost(challenge, token);
        if (boostResult) {
            // Whichever photo the boost was waiting on; the clear names it, so it is only that one that goes.
            const waiting = ctx.entryAges?.pending(challenge.id.toString());
            if (waiting) ctx.entryAges?.clearPending(challenge.id, waiting, ctx.now);
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
    if (isTimerBasedAvailable) {
        logger
            .withCategory('voting')
            .infoT('m9c4743591d36', [logger.challengeTag(challenge), timeDisplay, effectiveBoostTime / 60], null);
    } else {
        logger
            .withCategory('voting')
            .infoT(
                'mf56a828d276b',
                [logger.challengeTag(challenge), timeDisplay, Math.round(keyUnlockedWindow / 60)],
                null,
            );
    }
};

/**
 * When a due boost on `imageId` would still be held for `boostFreshEntryWait`
 * (VotingLogic.getBoostHoldUntil).
 *
 * @param imageId - the entry the boost would land on
 * @returns the release instant, or null when the boost is not held
 */
export const freshEntryHoldUntil = ({ challenge, now, entryAges }: ActionContext, imageId: string): number | null => {
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
    logBoostTarget(challenge, 'mcf9ca1fdf16b', [formatDuration(holdUntil - now), imageId]);
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
export const skipForUncertainPhoto = (
    ctx: ActionContext,
    target: BoostTarget,
    isTimerBasedAvailable: boolean,
): boolean => {
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
    logBoostTarget(challenge, 'mefe4e859a5ca', [oneLine(target.imageId)]);
    return true;
};

export const runBoost = async (ctx: ActionContext) => {
    const { challenge, now } = ctx;
    // Every pass, so an entry's first-seen time is as close to its real entry
    // time as the cadence allows — including entries this pass just reflected.
    ctx.entryAges?.observe(challenge, now);
    const { isTimerBasedAvailable, isKeyUnlockedAvailable } = readBoostAvailability(challenge);
    if (!isTimerBasedAvailable && !isKeyUnlockedAvailable) return;

    logger.withCategory('voting').infoT('mf275019cebb9', [logger.challengeTag(challenge)], null);

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
        logger.withCategory('boost').infoT('m5ad141b74f8c', [logger.challengeTag(challenge), boostNeed], null);
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
