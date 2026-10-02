import * as logger from '../../logger';
import * as settings from '../../settings';
import * as votingLogic from '../VotingLogic';
import * as autoFill from '../autoFill';
import { formatDuration } from '../../format/duration';
import { failureText, oneLine } from '../../format/logSafe';
import { finiteOr } from '../../numbers';

import type { Challenge, MemberBoost } from '../../types/gurushots';
import type { ActionContext } from './context';

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

export const runBoost = async (ctx: ActionContext) => {
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
