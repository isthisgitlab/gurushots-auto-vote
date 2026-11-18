import * as logger from '../../logger';
import * as votingLogic from '../VotingLogic';
import * as autoFill from '../autoFill';
import * as cancellation from '../../voting/cancellation';
import { oneLine } from '../../format/logSafe';
import { runBoost } from './boost';
import { submitBoostPinnedPhoto } from './boostPinSubmit';
import { runTurboApply } from './turbo';
import { cancelPass } from './context';

import type { Challenge } from '../../types/gurushots';
import type { OperationKind } from '../../scenarios/runtime';
import type { VotingPassResult } from '../../types/votingPass';
import type { ActionContext, PassContext } from './context';

/**
 * The Boost-pinned submit at Auto-Submit time: when an Auto-Submit is due and the
 * photo pinned for Boost will be submitted for the Boost (describeDeadlineActions'
 * boostPinSubmits), that photo takes the Auto-Submit's slot instead of the usual
 * pick. Boost time submits it only when no Auto-Submit comes first.
 *
 * @returns true when the Auto-Submit is done for this cycle (the pin went in, an
 *   earlier submit of it stands, its submit got no answer, or the last free slot
 *   is kept for it after a transient failure); false to go on with the usual pick
 */
const submitBoostPinAtAutoSubmit = async (ctx: ActionContext): Promise<boolean> => {
    const { challenge, token, now, fillDeps, entryAges } = ctx;
    const due = autoFill.resolveAutoSubmitDue(challenge, now, fillDeps);
    if (!due.due || !votingLogic.describeDeadlineActions(challenge, now, entryAges).boostPinSubmits) return false;

    const finalEligibility = autoFill.createFinalEligibility(
        challenge,
        String(challenge.id),
        token,
        fillDeps,
        due.authorization,
    );
    const pinned = await submitBoostPinnedPhoto(ctx, finalEligibility);
    if (pinned.kind === 'submitted') {
        logger
            .withCategory('autoSubmit')
            .success(
                `autoSubmit: submitted the photo pinned for Boost (${oneLine(pinned.target.imageId)}) for ${logger.challengeTag(challenge)}`,
                null,
            );
        return true;
    }
    if (pinned.kind === 'held') return true;
    if (pinned.kind !== 'skip') return false;
    // A submit that got no answer may have landed: no other photo goes in this cycle, whatever
    // the free slots.
    if (pinned.cause === 'unclear') {
        logger
            .withCategory('autoSubmit')
            .info(
                `autoSubmit: the photo pinned for Boost (${oneLine(pinned.imageId)}) may already be in ${logger.challengeTag(challenge)}; Auto-Submit submits no other photo this cycle`,
                null,
            );
        return true;
    }
    // A transient failure or a gone challenge with one free slot left: keep that slot for the
    // pin and try again next cycle. Everything else (definitive, 2+ slots) goes on.
    if ((pinned.cause === 'transient' || pinned.cause === 'gone') && autoFill.getSlotsRemaining(challenge) === 1) {
        logger
            .withCategory('autoSubmit')
            .info(
                `autoSubmit: keeping the last free slot of ${logger.challengeTag(challenge)} for the photo pinned for Boost (${oneLine(pinned.imageId)})`,
                null,
            );
        return true;
    }
    return false;
};

/**
 * @returns whether a photo was submitted (what the pass's operation record keeps)
 */
const runAutoFill = async (ctx: ActionContext): Promise<boolean> => {
    const { challenge, token, now, fillDeps } = ctx;
    if (await submitBoostPinAtAutoSubmit(ctx)) return true;
    // Auto-fill missing entries near deadline (one slot per cycle, staggered).
    // On submit it reflects the new entry locally, so a turbo/boost that runs
    // later this cycle (timer order) acts on it instead of waiting a cycle.
    const fillResult = await autoFill.maybeAutoFillChallenge(challenge, token, now, fillDeps);
    if (fillResult === 'submitted') {
        logger
            .withCategory('voting')
            .info(
                `${logger.challengeTag(challenge)} autoSubmit: entry submitted (available to later actions this cycle)`,
                null,
            );
    }
    return fillResult === 'submitted';
};

const runEmergencyFill = async (ctx: ActionContext): Promise<boolean> => {
    const { challenge, token, now, fillDeps } = ctx;
    // Emergency fill: net for slots that staggered auto-fill leaves
    // empty (auto-fill off, or tags set with no match) — fills all
    // remaining slots once the challenge is inside the emergency window.
    const emergencyResult = await autoFill.maybeEmergencyFillChallenge(challenge, token, now, fillDeps);
    if (emergencyResult === 'submitted') {
        logger
            .withCategory('voting')
            .info(`${logger.challengeTag(challenge)} emergencySubmit: entries submitted near deadline`, null);
    }
    return emergencyResult === 'submitted';
};

/**
 * Each deadline action's runner, and the operation it performs (for the pass's record of what was done). A runner answers
 * whether it did its operation: a photo submitted, a boost or a turbo landed.
 */
const actionRunners: Record<
    string,
    { kind: OperationKind; run: (ctx: ActionContext) => Promise<boolean> } | undefined
> = {
    boost: { kind: 'boost', run: runBoost },
    turbo: { kind: 'turbo', run: runTurboApply },
    autoSubmit: { kind: 'submit', run: runAutoFill },
    emergencySubmit: { kind: 'submit', run: runEmergencyFill },
};

const actionContextOf = (challenge: Challenge, now: number, pass: PassContext): ActionContext => ({
    challenge,
    token: pass.token,
    now,
    api: pass.api,
    fillDeps: pass.fillDeps,
    entryAges: pass.entryAges,
    missions: pass.missions,
});

/**
 * The normal Boost, Turbo or submit automation of a challenge, run once now under its own enable, timing and selection
 * policy (the `runAutomation` scenario action). `submit` is the staggered Auto-Submit, then the Emergency Submit net.
 *
 * @returns whether the operation was done (a photo submitted, a boost or a turbo landed); false: the policy said not now
 */
export const runDeadlineOperation = async (
    operation: 'boost' | 'turbo' | 'submit',
    challenge: Challenge,
    now: number,
    pass: PassContext,
): Promise<boolean> => {
    const ctx = actionContextOf(challenge, now, pass);
    if (operation === 'submit') return (await runAutoFill(ctx)) || (await runEmergencyFill(ctx));
    return operation === 'boost' ? runBoost(ctx) : runTurboApply(ctx);
};

/**
 * Deadline actions (boost / auto-fill / turbo apply / emergency fill) run in the
 * order their configured timers imply — largest seconds-before-close window
 * first — instead of a fixed code order, so e.g. auto-fill (15m) acts before
 * turbo (12m) when both are due. Each runner keeps its own full eligibility
 * check, so an action that isn't actually due just no-ops.
 *
 * Sequential by design — see the votingOrchestrator.ts header.
 *
 * @returns the cancelled-pass result, or null to continue
 */
export const runDeadlineActions = async (
    challenge: Challenge,
    now: number,
    pass: PassContext,
): Promise<VotingPassResult | null> => {
    const actionCtx = actionContextOf(challenge, now, pass);
    // What a scenario already did for this challenge this pass is not done again by the normal automation; what the runners
    // below do is recorded for whatever runs after them (a sibling runner of the same kind is not held by it: the record
    // is read once, before any of them runs).
    const subject = String(challenge.id);
    const doneBefore = new Set<OperationKind>(
        (['boost', 'turbo', 'submit'] as const).filter((kind) => pass.operations?.has(kind, subject)),
    );
    for (const { action } of votingLogic.orderDeadlineActions(challenge, now)) {
        // Honor cancellation between actions, same as the per-challenge guard.
        if (cancellation.isCancelled()) {
            return cancelPass(pass.allChallenges);
        }
        // Defensive: orderDeadlineActions only emits the four known keys, but
        // guard the dispatch so a future action added there without a matching
        // runner degrades to a skip instead of throwing and aborting the loop.
        const runner = actionRunners[action];
        if (!runner || doneBefore.has(runner.kind)) continue;
        if (await runner.run(actionCtx)) pass.operations?.mark(runner.kind, subject);
    }
    return null;
};
