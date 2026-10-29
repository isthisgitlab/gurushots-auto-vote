import { oneLine } from '../../format/logSafe';
import { secondsToBoostDeadline } from '../../voting/boostWindow';
import * as votingLogic from '../VotingLogic';
import { buildFillDeps } from './context';
import {
    applyAvailableBoost,
    existingBoostTarget,
    freshEntryHoldUntil,
    hasEntries,
    logBoostTarget,
    logNoBoostEntry,
    pendingBoostTarget,
    pinnedBoostTarget,
    readBoostAvailability,
    skipForUncertainPhoto,
} from './boost';

import type { Challenge } from '../../types/gurushots';
import type { ActionContext } from './context';
import type { VotingPassApi } from '../../types/votingPass';
import type { EntryAgeLedger } from '../../types/stores';
import type { BoostTarget } from './boost';

/**
 * The sleep-boost half of boost.ts: which entry a boost sent on device sleep
 * lands on (resolveSuspendBoostTarget) and the runners windows/suspendBoost
 * calls — runSuspendBoost for one selected challenge, runSuspendBoosts over
 * all of them. The boost helpers both halves share stay in boost.ts.
 */

/** What a boost sent on device sleep came to. */
export type SuspendBoostOutcome = 'applied' | 'unconfirmed' | 'skipped';

/**
 * The entry a boost sent on device sleep lands on. Same rule as
 * resolveBoostTarget, except a new photo is never submitted — a submit cannot
 * finish before the device sleeps — so a boost fill-new would have put on a
 * fresh photo goes to the existing entry instead, and a photo pinned for Turbo that
 * would give way to the boost before its deadline is taken as already given way.
 * The Boost pin is absolute here too: while its photo is missing or carries Turbo
 * the sleep boost skips (no wake is armed — the device cannot come back for one).
 *
 * @returns null when no entry can take the boost (already logged)
 */
const resolveSuspendBoostTarget = (ctx: ActionContext): BoostTarget | null => {
    const { challenge } = ctx;
    const named = pinnedBoostTarget(challenge);
    if (named) return named;
    const cid = challenge.id.toString();
    // The same absolute-pin rule as the awake pass, before any other target: a boost pin whose
    // photo is missing waits (nothing can land before the sleep anyway), and one carrying Turbo
    // never fires. No wake is armed — the device cannot come back for one.
    const boostPin = votingLogic.resolvePin(challenge, cid, 'boost');
    if (boostPin.state === 'gone' || boostPin.state === 'conflict') {
        logBoostTarget(challenge, boostPin.state === 'gone' ? 'm3e7a92c4b518' : 'm6b04d81f7c23', []);
        return null;
    }
    const pending = pendingBoostTarget(ctx);
    if (pending) return pending;
    // The device cannot come back for a Turbo pin's release, so a boost that pin blocks now takes the
    // pick the release gives it — sent by id, since applyBoost would pick at the clock and find none.
    // Only a boost the deadline view holds at the release (same rule) is due then; any other is due now.
    const blocked = votingLogic.isBoostBlocked(challenge, cid, ctx.now, ctx.entryAges);
    const releaseAt = blocked ? votingLogic.pinReleaseAt(challenge, cid, 'turbo', ctx.now) : null;
    const released = releaseAt === null ? null : existingBoostTarget(challenge, releaseAt);
    const existing =
        existingBoostTarget(challenge, ctx.now) ?? (released && { ...released, explicit: true, atRelease: true });
    if (!existing) {
        if (!blocked && hasEntries(challenge) && votingLogic.resolveBoostFillNewMode(challenge, cid) !== 'no') {
            // Fill-new would have put the boost on a fresh photo, and the pin keeps the existing one.
            logBoostTarget(challenge, 'mc37905687d16', []);
        } else {
            // No entry yet, or every entry turboed or pinned for Turbo with the pin never giving way
            // (the conflict row describeDeadlineActions keeps); applyBoost would only fail.
            logNoBoostEntry(challenge);
        }
        return null;
    }
    if (votingLogic.resolveBoostFillNewMode(challenge, challenge.id.toString()) !== 'no') {
        logBoostTarget(challenge, 'm21b1261f69f8', []);
    }
    if (existing.atRelease) {
        logBoostTarget(challenge, 'mc93c515e28d4', [oneLine(existing.imageId)]);
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
        logBoostTarget(challenge, 'm94322a7a4ec8', []);
        return 'skipped';
    }
    const target = resolveSuspendBoostTarget(ctx);
    if (!target || skipForUncertainPhoto(ctx, target, isTimerBasedAvailable)) return 'skipped';
    if (freshEntryHoldUntil(ctx, target.imageId) !== null) {
        logBoostTarget(challenge, 'm9c0719be2c97', [oneLine(target.imageId)]);
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
 * @param now - Unix seconds; the instant the caller selected the challenges at
 * @returns one settled outcome per challenge, in order
 */
export const runSuspendBoosts = (
    challenges: readonly Challenge[],
    token: string,
    { api, entryAges }: { api: VotingPassApi; entryAges: EntryAgeLedger | null },
    now: number = Math.floor(Date.now() / 1000),
): Promise<PromiseSettledResult<SuspendBoostOutcome>[]> => {
    const fillDeps = buildFillDeps(api, entryAges);
    return Promise.allSettled(
        challenges.map((challenge) => runSuspendBoost({ challenge, token, now, api, fillDeps, entryAges })),
    );
};
