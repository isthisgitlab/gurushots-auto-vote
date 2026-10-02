import * as logger from '../../logger';
import * as votingLogic from '../VotingLogic';
import * as autoFill from '../autoFill';
import * as cancellation from '../../voting/cancellation';
import { runBoost } from './boost';
import { runTurboApply } from './turbo';
import { cancelPass } from './context';

import type { Challenge } from '../../types/gurushots';
import type { VotingPassResult } from '../../types/votingPass';
import type { ActionContext, PassContext } from './context';

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
