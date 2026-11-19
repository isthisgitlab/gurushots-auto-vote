/**
 * The scenario actions that run the app's own automation: `earnTurbo` (the Turbo mini-game producer) and `runAutomation`
 * (one normal operation of the subject, run once under its normal enable, timing and selection policy by the operation's
 * existing runner). Nothing here decides for the runner what is due: when the normal policy says no, the step completes with
 * the reason and does nothing (it is not an error, it spends nothing, and it marks no operation as done).
 *
 * The three currency operations (unlockBoost, swap, fillExposure) reach their spend through the normal runner's own endpoint
 * call. That one request is the step's spend: the runner's endpoint is wrapped so the write-ahead marker (`pending`) is
 * written down just before it is sent, exactly once, and what comes back (confirmed, refused, no answer) is the step's
 * outcome. A step whose spend got no answer is retried by the runner's retry protocol (it only looks, it never sends).
 */

import * as logger from '../../logger';
import * as votingLogic from '../VotingLogic';
import { runAutoKey, runAutoSwap, runAutoExposureFill } from '../currencyAuto';
import type { CurrencyPassDeps } from '../currencyAuto';
import { runDeadlineOperation } from '../votingOrchestrator/actionRunners';
import { playAutoTurbo } from '../votingOrchestrator/turbo';
import { voteOnChallenge } from '../votingOrchestrator/vote';
import type { ActionResult } from '../../types/gurushots';
import type { ActionOutcome, ActiveContext, ActionHandler, ContextOf, ScenarioAction, SpendAction } from './types';
import {
    deferred,
    done,
    failed,
    joinOutcome,
    limitOf,
    noAnswer,
    nowSec,
    skipped,
    spendAllowed,
    spendOf,
} from './support';
import type { ScenarioState } from '../../types/stores';

type AutomationType = 'earnTurbo' | 'runAutomation';

type Operation = Extract<ScenarioAction, { type: 'runAutomation' }>['operation'];

const notDue = (operation: Operation): ActionOutcome =>
    done({ notDue: `the ${operation} is not due under its normal policy` });

/**
 * The strategy's spend endpoints, each wrapped to be the step's one request: it is written down first (`beforeSpend`), sent
 * once, and what came back is kept in `record`. A request whose marker could not be written is not sent.
 */
type SpendRecord = { sent: boolean; refused: boolean; result: ActionResult | null };

const guardedCurrency = (ctx: ActiveContext, spend: SpendAction, record: SpendRecord): CurrencyPassDeps => {
    const { strategy } = ctx.pass.currency;
    const once =
        <A extends unknown[]>(send: (...args: A) => Promise<ActionResult>) =>
        async (...args: A): Promise<ActionResult> => {
            if (record.sent || !ctx.beforeSpend?.(spend)) {
                record.refused = true;
                return { ok: false, raw: null };
            }
            record.sent = true;
            record.result = await send(...args);
            return record.result;
        };
    return {
        ...ctx.pass.currency,
        strategy: {
            ...strategy,
            keyUnlock: once(strategy.keyUnlock),
            swapPhoto: once(strategy.swapPhoto),
            exposureAutofill: once(strategy.exposureAutofill),
        },
    };
};

/**
 * One normal currency spend (key unlock, swap, exposure fill) through its runner, as the step's outcome. The scenario's own
 * limit and the user's reserve come first, as for the direct actions.
 */
const runCurrencyOperation = async (
    action: Extract<ScenarioAction, { type: 'runAutomation' }>,
    ctx: ActiveContext,
    state: ScenarioState,
): Promise<ActionOutcome> => {
    const spend = spendOf(action) as SpendAction;
    const blocked = await spendAllowed(spend, ctx, state);
    if (blocked) return skipped(blocked);
    const record: SpendRecord = { sent: false, refused: false, result: null };
    const currencyCtx = {
        challenge: ctx.challenge,
        token: ctx.pass.token,
        now: nowSec(),
        currency: guardedCurrency(ctx, spend, record),
    };
    if (spend === 'unlockBoost') await runAutoKey(currencyCtx);
    else if (spend === 'swap') await runAutoSwap({ ...currencyCtx, swapHistorySent: ctx.swapHistorySent });
    else await runAutoExposureFill(currencyCtx, undefined);
    // (A request the runner made a second time is refused; what was sent first stands.)
    if (!record.sent && record.refused) {
        return deferred(`the ${action.operation} could not be written down first, so it was not made`);
    }
    if (!record.sent) return notDue(action.operation);
    // The request was made: a confirmed one is spent, one with no answer may have been (counted, never repeated), a
    // refused one was not.
    if (record.result?.unclear) return noAnswer(spend, true);
    if (record.result?.ok) return done({ spent: limitOf(spend) });
    return failed(`the ${action.operation} was refused`);
};

/**
 * One normal vote of the challenge, when the voting rules call for one.
 */
const runVote = async (ctx: ActiveContext): Promise<ActionOutcome> => {
    const { challenge, pass } = ctx;
    const decision = votingLogic.evaluateVotingDecision(challenge, nowSec(), { hasNewEntry: false });
    if (!decision.shouldVote) return done({ notDue: decision.voteReason });
    const outcome = await voteOnChallenge(challenge, decision, pass, () => {});
    if (outcome.cancelled) return deferred('the pass was cancelled');
    return outcome.voteThrew ? failed('the vote could not be completed') : done();
};

const AUTOMATION_ACTIONS: {
    [K in AutomationType]: ActionHandler<Extract<ScenarioAction, { type: K }>, ContextOf<K>>;
} = {
    earnTurbo: async (action, ctx) => {
        // The pass plays the game once for a challenge: a game already played does not come round again.
        if (ctx.operations.has('earn', ctx.challengeId))
            return done({ notDue: 'the turbo game was already played this pass' });
        const outcome = await playAutoTurbo(ctx.challenge, nowSec(), ctx.pass, { direct: true });
        if (outcome.kind === 'refused') return deferred(`the turbo game was not played (${outcome.reason})`);
        return outcome.kind === 'failed' ? failed('the turbo game could not be completed') : done();
    },

    runAutomation: async (action, ctx, state) => {
        if (action.operation === 'join') {
            if (ctx.stage !== 'preJoin') return skipped('join runs before the challenge is joined');
            return joinOutcome(await ctx.join(null, 'normal'), 'normal');
        }
        if (ctx.stage !== 'active') return skipped(`${action.operation} runs while the challenge is active`);
        if (action.operation === 'unlockBoost' || action.operation === 'swap' || action.operation === 'fillExposure') {
            return runCurrencyOperation(action, ctx, state);
        }
        if (action.operation === 'vote') return runVote(ctx);
        // submit, boost, turbo: the deadline runners.
        const performed = await runDeadlineOperation(action.operation, ctx.challenge, nowSec(), ctx.pass);
        logger
            .withCategory('scenario')
            .debug(`${ctx.tag} runAutomation ${action.operation}: ${performed ? 'done' : 'not due'}`, null);
        return performed ? done() : notDue(action.operation);
    },
};

export { AUTOMATION_ACTIONS };
