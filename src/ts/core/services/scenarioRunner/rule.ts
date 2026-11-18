/**
 * Running one scenario rule and recording its effects.
 *
 * Contract: see the runner contract in the scenarioRunner.ts header (live re-read
 * before each action, persist after each, unreadable state halts).
 */

import { STAGE_ACTIONS } from '../../scenarios/vocabulary';
import {
    OPERATION_OF,
    absorbLeftover,
    finishScenarioRule,
    reduceScenarioOutcome,
    withNotice as appendNotice,
} from '../../scenarios/runtime';
import type { ReducerStep } from '../../scenarios/runtime';
import type { ScenarioState } from '../../types/stores';
import { consumeMission } from '../missions';
import type { MissionKind } from '../missions';
import type {
    ActionHandler,
    ActionOutcome,
    NotDoneOutcome,
    RunnerContext,
    ScenarioAction,
    SpendAction,
    ValidatedRule,
} from './types';
import { isSpend, limitOf, log, nowSec, skipped } from './support';
import type { Retry } from './support';
import { ACTIONS, settleUnclearSpend } from './actions';

// The mission each confirmed action counts toward, once (a join is counted by the join pass that made it).
const MISSION_OF: Readonly<Record<string, MissionKind | undefined>> = { fillExposure: 'fill', boost: 'boost' };

/** What makes a notice's id unique among those of the same second. */
const noticeToken = (): string => Math.random().toString(36).slice(2, 8);

/**
 * State with a notice appended to its outbox (services/scenarioNotifications.ts delivers it).
 *
 * @param at - unix seconds
 */
const withNotice = (state: ScenarioState, message: string, at: number): ScenarioState =>
    appendNotice(state, message, at, noticeToken());

/**
 * Which marker the step about to run is the retry of: its spend got no answer (counted already), or it was written
 * down before it was made and nothing says it was (not counted yet). Null when it is not a retry.
 */
const retryOf = (start: ScenarioState, ruleId: string, firstStep: boolean, action: ScenarioAction): Retry | null => {
    const marker = firstStep && start.inFlight?.ruleId === ruleId ? start.inFlight : null;
    if (marker?.unclear?.some((type) => type === action.type)) {
        // Counted already; the app, not GuruShots, did not know when it came from a marker the app absorbed.
        return { count: false, origin: marker.lost?.some((type) => type === action.type) ? 'pending' : 'unclear' };
    }
    return marker?.pending === action.type ? { count: true, origin: 'pending' } : null;
};

/**
 * Writes down, BEFORE it is made, the spend a step is about to make (`inFlight.pending`). If the result of the spend
 * is then never written (a crash, a lock held, a full disk), the next run finds the marker and looks at the live
 * challenge instead of spending again, in whatever process it runs.
 *
 * @returns the state as written, or null when it could not be written: then nothing is spent
 */
const markPending = (
    ctx: RunnerContext,
    state: ScenarioState,
    at: { ruleId: string; index: number; spend: SpendAction },
): ScenarioState | null => {
    const marked: ScenarioState = {
        ...state,
        inFlight: { ...state.inFlight, ruleId: at.ruleId, actionIndex: at.index, pending: at.spend },
    };
    return ctx.ledger.set(ctx.challengeId, marked) === 'saved' ? marked : null;
};

/**
 * The write-ahead of the step now running, for it to call just before its request: it makes sure the step lock is
 * still this process's (one that went stale while the machine slept may have been taken over: the step is then another
 * process's, and nothing is spent), then writes the marker onto the state the rule holds and keeps what was written
 * as that state.
 */
const spendWriter =
    (
        ctx: RunnerContext,
        at: { ruleId: string; index: number },
        held: { get: () => ScenarioState; set: (state: ScenarioState) => void },
    ) =>
    (spend: SpendAction): boolean => {
        if (ctx.stepLock?.held && !ctx.stepLock.held()) {
            log().warning(
                `${ctx.tag} the lock of this challenge's steps was lost to another process — not spending`,
                null,
            );
            return false;
        }
        const marked = markPending(ctx, held.get(), { ...at, spend });
        if (marked) held.set(marked);
        return marked !== null;
    };

/**
 * Writes down the state a step left, trying once more when the first write fails (a lock held for a moment after a
 * spend that is known to have landed must not turn into a rule that stops for want of a write).
 */
const saveResult = (ctx: RunnerContext, state: ScenarioState): boolean => {
    const first = ctx.ledger.set(ctx.challengeId, state);
    if (first === 'saved') return true;
    // Reset meanwhile (its progress is not to be brought back), or moved to another generation (a handoff, an owner change:
    // this step is a former one's): nothing to try again, and the step sends nothing further.
    if (first === 'refused' || first === 'stale') return false;
    const second = ctx.ledger.set(ctx.challengeId, state);
    if (second === 'saved') return true;
    if (second === 'refused' || second === 'stale') return false;
    log().warning(
        `${ctx.tag} the result of the last step could not be written down: the next pass may stop this rule needlessly`,
        null,
    );
    return false;
};

/**
 * One action of a rule. A step whose spend got no answer is never spent again: its retry only looks at the live
 * challenge. An action its stage does not offer is passed over (validation refuses the document that holds one; this keeps
 * a subject in another stage from running it all the same).
 */
const runAction = async (
    ctx: RunnerContext,
    state: ScenarioState,
    action: ScenarioAction,
    retry: Retry | null,
): Promise<ActionOutcome> => {
    const offered: readonly string[] = STAGE_ACTIONS[ctx.stage];
    if (!offered.includes(action.type)) return skipped(`${action.type} is not available in the ${ctx.stage} stage`);
    if (ctx.stage === 'active' && retry && isSpend(action)) return settleUnclearSpend(action, ctx, state, retry);
    // ACTIONS pairs each type with its handler and its stage's context; the union call needs the widened view.
    return (ACTIONS[action.type] as ActionHandler<ScenarioAction>)(action, ctx, state);
};

/**
 * What a step that did not go through comes to: a committed rule passes over a skipped step and carries on, any
 * other stops the rule there (and so does a state that could not be written down).
 */
const notDone = (
    ctx: RunnerContext,
    rule: ValidatedRule,
    state: ScenarioState,
    step: { action: ScenarioAction; index: number; result: NotDoneOutcome; at: number; committed: boolean },
): { state: ScenarioState; stop: boolean; skippedStep: { at: number; message: string } | null } => {
    const { action, result, at, committed } = step;
    const message = `${rule.label ?? rule.id} → ${action.type}: ${result.message}`;
    log().warning(`${ctx.tag} scenario "${ctx.scenario.name}": ${message}`, null);
    const next = reduceScenarioOutcome(state, reducerStep(ctx, rule, step, message), result);
    if (result.status === 'skipped' && committed) {
        return { state: next, stop: !saveResult(ctx, next), skippedStep: { at, message } };
    }
    saveResult(ctx, next);
    return { state: next, stop: true, skippedStep: null };
};

const reducerStep = (
    ctx: RunnerContext,
    rule: ValidatedRule,
    step: { action: ScenarioAction; index: number; at: number; committed: boolean },
    message: string,
): ReducerStep => ({
    ruleId: rule.id,
    index: step.index,
    actionType: step.action.type,
    at: step.at,
    timezone: ctx.timezone,
    committed: step.committed,
    noticeToken: noticeToken(),
    message,
});

/**
 * The installation's published settings follow its progress: made again after each confirmed action and phase change. That
 * is a write behind the runner's own, so the runner goes on from the record as it now stands (a state it kept would be
 * refused as changed by another writer).
 */
const republished = async (ctx: RunnerContext, state: ScenarioState): Promise<ScenarioState> => {
    if (ctx.stage !== 'account') return state;
    await ctx.republish();
    return ctx.ledger.get(ctx.challengeId).state ?? state;
};

/**
 * What a confirmed action counts for beyond its own subject: the operation record the normal automation asks before it
 * repeats the work, and the mission it serves, once.
 */
const noteConfirmed = (ctx: RunnerContext, action: ScenarioAction): void => {
    const operation = OPERATION_OF[action.type];
    if (operation) {
        ctx.operations.mark(
            operation,
            action.type === 'claimMissionReward' ? `mission:${action.missionId}` : ctx.challengeId,
        );
    }
    const mission = MISSION_OF[action.type];
    if (mission && ctx.stage === 'active') consumeMission(ctx.pass.missions, mission);
};

/**
 * Execute one rule from `startIndex`. Returns the new state and whether the
 * rule finished (its actions all went through or were passed over).
 */
const runRule = async (
    fire: { ruleId: string; rule: ValidatedRule; startIndex: number },
    ctx: RunnerContext,
    startState: ScenarioState,
): Promise<{ state: ScenarioState; completed: boolean }> => {
    const { rule, startIndex } = fire;
    const tag = ctx.tag;
    let state = startState;
    // A rule that was interrupted after a step went through, or whose spend got no answer, is committed to its steps.
    let committed = startIndex > 0 || startState.inFlight?.ruleId === rule.id;
    let gotoPhase: string | null = null;
    let skippedStep: { at: number; message: string } | null = null;
    for (let index = startIndex; index < rule.do.length; index++) {
        const action = rule.do[index];
        const retry = retryOf(startState, rule.id, index === startIndex, action);
        state = absorbLeftover(state, isSpend(action) ? action.type : undefined, nowSec(), limitOf);
        // A spend is written down by the step itself, just before its request (see lockedCurrencySpend); one that
        // could not be is not made. A retry makes no spend.
        ctx.beforeSpend = retry
            ? null
            : spendWriter(ctx, { ruleId: rule.id, index }, { get: () => state, set: (next) => (state = next) });
        const result = await runAction(ctx, state, action, retry);
        const at = nowSec();
        if (result.status !== 'done') {
            const stopped = notDone(ctx, rule, state, { action, index, result, at, committed });
            state = stopped.state;
            if (stopped.stop) return { state, completed: false };
            skippedStep = stopped.skippedStep;
            continue;
        }
        committed = true;
        gotoPhase = result.goto ?? gotoPhase;
        state = reduceScenarioOutcome(state, reducerStep(ctx, rule, { action, index, at, committed }, ''), result);
        const saved = saveResult(ctx, state);
        noteConfirmed(ctx, action);
        log().info(`${tag} scenario "${ctx.scenario.name}": ${rule.label ?? rule.id} → ${action.type}`, null);
        // A step that landed and could not be written down is the last one this pass: the next step could spend too.
        if (!saved) return { state, completed: false };
        state = await republished(ctx, state);
    }
    const finishedAt = nowSec();
    const finished = finishScenarioRule(state, {
        ruleId: rule.id,
        startState,
        gotoPhase,
        skippedStep,
        at: finishedAt,
        timezone: ctx.timezone,
    });
    const changedPhase = finished.phase !== state.phase;
    if (changedPhase) {
        log().info(`${tag} scenario "${ctx.scenario.name}": phase ${state.phase} → ${finished.phase}`, null);
    }
    const completed = saveResult(ctx, finished);
    return { state: changedPhase && completed ? await republished(ctx, finished) : finished, completed };
};

export { withNotice, runRule };
