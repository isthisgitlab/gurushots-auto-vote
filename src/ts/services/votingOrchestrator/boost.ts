import * as logger from '../../logger';
import * as settings from '../../settings';
import * as votingLogic from '../VotingLogic';
import * as autoFill from '../autoFill';
import { formatDuration } from '../../format/duration';
import { failureText, oneLine } from '../../format/logSafe';
import { finiteOr } from '../../numbers';
import { buildFillDeps } from './context';

import type { Challenge, MemberBoost } from '../../types/gurushots';
import type { ActionContext } from './context';
import type { VotingPassApi } from '../../types/votingPass';
import type { EntryAgeLedger } from '../../types/stores';

type BoostTarget = { imageId: string | null; fresh: boolean };
type SuspendBoostTarget = { imageId: string; fresh: boolean };
type BoostAvailability = ReturnType<typeof readBoostAvailability>;

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
 * The photo an earlier fill-new submitted that its boost is still waiting on.
 */
const pendingBoostTarget = ({ challenge, entryAges }: ActionContext): BoostTarget | null => {
    const pending = entryAges?.pending(challenge.id.toString());
    return pending ? { imageId: pending, fresh: true } : null;
};

/**
 * The configured Boost Entry; its imageId is null when no entry can take a boost.
 */
const existingBoostTarget = (challenge: Challenge): BoostTarget => ({
    imageId: votingLogic.pickBoostEntry(challenge, challenge.id.toString())?.id ?? null,
    fresh: false,
});

/**
 * The entry a due boost lands on: the photo an earlier fill-new submitted and the
 * boost is still waiting on; else, with fill-new on, a fresh photo submitted now
 * (remembered as pending, so a held boost reuses it instead of submitting
 * another); else the configured Boost Entry.
 *
 * @returns null when
 *   fill-new found no valid target and the boost is skipped (already logged)
 */
const resolveBoostTarget = async (ctx: ActionContext): Promise<BoostTarget | null> => {
    const { challenge, token, now, fillDeps, entryAges } = ctx;
    const cid = challenge.id.toString();
    const pending = pendingBoostTarget(ctx);
    if (pending) return pending;
    const existing = () => existingBoostTarget(challenge);
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

    const applyingMsg = isTimerBasedAvailable
        ? `Applying boost to challenge ${logger.challengeTag(challenge)}`
        : `Applying boost to challenge ${logger.challengeTag(challenge)} (key-unlocked)`;
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
            return true;
        }
        // On null/falsy result the operation is already closed with the failure
        // reason (by applyBoost itself, or by boostFreshEntry) — no caller-side
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
const freshEntryHoldUntil = ({ challenge, now, entryAges }: ActionContext, imageId: string | null): number | null => {
    if (!imageId || !entryAges) return null;
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
const holdBoostForFreshEntry = (ctx: ActionContext, imageId: string | null): boolean => {
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
 * auto-submitted photo whose standing is still uncertain.
 *
 * @returns true when the boost is skipped (already logged)
 */
const skipForUncertainPhoto = (ctx: ActionContext, target: BoostTarget, isTimerBasedAvailable: boolean): boolean => {
    const { challenge, now } = ctx;
    if (
        !target.imageId ||
        isTimerBasedAvailable ||
        votingLogic.isWithinEmergencyWindow(challenge, now) ||
        !settings.getEffectiveSetting('protectUncertainAutoFills', challenge.id.toString()) ||
        !ctx.entryAges?.isUncertain(challenge.id, target.imageId)
    ) {
        return false;
    }
    logBoostTarget(challenge, `auto-Boost skipped for uncertain auto-submitted photo ${oneLine(target.imageId)}`);
    return true;
};

/**
 * Seconds to the boost timeout (timer-based) or the challenge end (key-unlocked).
 */
const secondsToBoostDeadline = (challenge: Challenge, now: number, availability: BoostAvailability): number =>
    availability.isTimerBasedAvailable ? finiteOr(availability.boost.timeout, 0) - now : challenge.close_time - now;

export const runBoost = async (ctx: ActionContext) => {
    const { challenge, now } = ctx;
    // Every pass, so an entry's first-seen time is as close to its real entry
    // time as the cadence allows — including entries this pass just reflected.
    ctx.entryAges?.observe(challenge, now);
    const availability = readBoostAvailability(challenge);
    const { isTimerBasedAvailable, isKeyUnlockedAvailable } = availability;
    if (!isTimerBasedAvailable && !isKeyUnlockedAvailable) return;

    logger.withCategory('voting').info(`${logger.challengeTag(challenge)} Boost available`, null);

    // Use the centralized voting logic service for boost decisions.
    // emergency:true lets shouldApplyBoost apply an available boost
    // near the deadline even if autoBoost is off for this challenge.
    const shouldApplyBoost = votingLogic.shouldApplyBoost(challenge, now, { emergency: true });
    const effectiveBoostTime = votingLogic.getEffectiveBoostTime(challenge.id.toString());
    const timeUntilDisplayBase = secondsToBoostDeadline(challenge, now, availability);

    if (!shouldApplyBoost) {
        logBoostNotReady(challenge, isTimerBasedAvailable, timeUntilDisplayBase, effectiveBoostTime);
        return;
    }
    const target = await resolveBoostTarget(ctx);
    if (
        !target ||
        skipForUncertainPhoto(ctx, target, isTimerBasedAvailable) ||
        holdBoostForFreshEntry(ctx, target.imageId)
    )
        return;
    await applyAvailableBoost(ctx, target, isTimerBasedAvailable, timeUntilDisplayBase);
};

/**
 * The entry a boost sent on device sleep lands on. Same rule as
 * resolveBoostTarget, except a new photo is never submitted — a submit cannot
 * finish before the device sleeps — so a boost fill-new would have put on a
 * fresh photo goes to the existing entry instead.
 *
 * @returns null when no entry can take the boost (already logged)
 */
const resolveSuspendBoostTarget = (ctx: ActionContext): SuspendBoostTarget | null => {
    const { challenge } = ctx;
    const pending = pendingBoostTarget(ctx);
    if (pending?.imageId) return { imageId: pending.imageId, fresh: true };
    const { imageId, fresh } = existingBoostTarget(challenge);
    if (!imageId) {
        // Only reachable with no entry yet or every entry turboed (the conflict row
        // describeDeadlineActions keeps); applyBoost would only fail.
        const entries = challenge?.member?.ranking?.entries;
        logBoostTarget(
            challenge,
            Array.isArray(entries) && entries.length > 0
                ? 'no entry can take the boost (only entry already has Turbo) — boost skipped'
                : 'no entry to boost yet — boost skipped',
        );
        return null;
    }
    if (votingLogic.resolveBoostFillNewMode(challenge, challenge.id.toString()) !== 'no') {
        logBoostTarget(
            challenge,
            'boost fill-new is on, but a new photo cannot be submitted before sleep; boosting existing entry',
        );
    }
    return { imageId, fresh };
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
    const availability = readBoostAvailability(challenge);
    const { isTimerBasedAvailable, isKeyUnlockedAvailable } = availability;
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
        secondsToBoostDeadline(challenge, now, availability),
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
