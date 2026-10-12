/**
 * Running one scenario rule and recording its effects.
 *
 * Contract: see the runner contract in the scenarioRunner.ts header (live re-read
 * before each action, persist after each, unreadable state halts).
 */

import * as logger from '../../logger';
import { firedRecord } from '../../scenarios/evaluate';
import type { ScenarioState } from '../../types/stores';
import type {
    ActionEffects,
    ActionHandler,
    NotDoneOutcome,
    RunnerContext,
    ScenarioAction,
    SpendAction,
    ValidatedRule,
} from './types';
import { isSpend, log, nowSec } from './support';
import { ACTIONS, settleUnclearSpend } from './actions';

/** Notices kept for the host notifiers: the newest, within a day. */
const OUTBOX_LIMIT = 20;
const OUTBOX_KEEP_SEC = 24 * 3600;

/**
 * State with a notice appended to its outbox (services/scenarioNotifications.ts delivers it).
 *
 * @param at - unix seconds
 */
const withNotice = (state: ScenarioState, message: string, at: number): ScenarioState => {
    const kept = (state.outbox ?? []).filter((item) => at - item.at <= OUTBOX_KEEP_SEC);
    const id = `${at}-${kept.length}-${Math.random().toString(36).slice(2, 8)}`;
    return { ...state, outbox: [...kept, { id, at, message }].slice(-OUTBOX_LIMIT) };
};

/**
 * State after one action's effects.
 *
 * @param at - unix seconds
 */
const applyEffects = (before: ScenarioState, effects: ActionEffects, at: number): ScenarioState => {
    const state = effects.notice ? withNotice(before, effects.notice, at) : before;
    const memory = { ...state.memory, ...effects.remember };
    if (effects.forget) delete memory[effects.forget];
    const spent = effects.spent
        ? { ...state.spent, [effects.spent]: (state.spent[effects.spent] ?? 0) + 1 }
        : state.spent;
    return { ...state, memory, spent };
};

/**
 * State when a step stops its rule. The rule resumes at that step when it was committed.
 *
 * A spend that got no answer may have gone through: it commits the rule from here, so the retry resumes at this step
 * (marked on `inFlight` itself, which survives anything that only changes `lastError`) and never spends it again,
 * and it counts toward the scenario's spend limit. When that retry cannot show the spend landed (`halt`) the rule
 * ends here and is recorded as fired with the action it stopped after, so its repeat policy holds it (evaluate).
 */
const stoppedAt = (
    state: ScenarioState,
    stop: {
        rule: ValidatedRule;
        index: number;
        result: NotDoneOutcome;
        message: string;
        at: number;
        committed: boolean;
        timezone: string;
    },
): ScenarioState => {
    const { rule, index, result, message, at, committed, timezone } = stop;
    const next: ScenarioState = { ...state, inFlight: null };
    if (result.halt) {
        next.fired = {
            ...state.fired,
            [rule.id]: { ...firedRecord(state, at, timezone), unclearHalt: result.unclear },
        };
    } else if (committed || result.spent) {
        // A step of another type at the marked one's place (the scenario was edited) must not lose the marker: it is
        // the only thing that keeps the step from being spent again once the edit is reverted.
        // (The state's own marker is this step's: the one before a spend, or the one the step before it left.)
        const prior = state.inFlight;
        // `unclearAt`: when the spend got no answer, for the card to tell a later problem from it.
        const marker = result.unclear
            ? { unclear: result.unclear, unclearAt: at }
            : prior?.unclear
              ? { unclear: prior.unclear, unclearAt: prior.unclearAt }
              : {};
        next.inFlight = { ruleId: rule.id, actionIndex: index, ...marker };
    }
    if (result.status !== 'deferred') next.lastError = { at, message };
    return applyEffects(next, { spent: result.spent }, at);
};

/**
 * Whether the step about to run is the retry of one whose spend got no answer (the state remembers which).
 */
const isUnclearRetry = (
    start: ScenarioState,
    ruleId: string,
    firstStep: boolean,
    action: ScenarioAction,
): action is ScenarioAction & { type: SpendAction } =>
    firstStep &&
    start.inFlight?.ruleId === ruleId &&
    (start.inFlight.unclear === action.type || start.inFlight.pending === action.type);

/**
 * Writes down, BEFORE it is made, the spend a step is about to make (`inFlight.pending`). If the result of the spend
 * is then never written (a crash, a lock held, a full disk), the next run finds the marker and looks at the live
 * challenge instead of spending again, in whatever process it runs. A marker left by an earlier spend of that step
 * that the scenario's edit has since changed (it may have landed) is kept as `unclear`.
 *
 * @returns the state as written, or null when it could not be written: then nothing is spent
 */
const writeAhead = (
    ctx: RunnerContext,
    state: ScenarioState,
    at: { ruleId: string; index: number; action: ScenarioAction },
): ScenarioState | null => {
    if (!isSpend(at.action)) return state;
    const prior =
        state.inFlight?.ruleId === at.ruleId && state.inFlight.actionIndex === at.index ? state.inFlight : null;
    const left = prior?.unclear ?? prior?.pending;
    const marked: ScenarioState = {
        ...state,
        inFlight: {
            ruleId: at.ruleId,
            actionIndex: at.index,
            ...(left ? { unclear: left, unclearAt: prior?.unclearAt ?? nowSec() } : {}),
            pending: at.action.type,
        },
    };
    return ctx.ledger.set(ctx.challengeId, marked) ? marked : null;
};

/**
 * One action of a rule. A step whose spend got no answer is never spent again: its retry only looks at the live
 * challenge.
 */
const runAction = (ctx: RunnerContext, state: ScenarioState, action: ScenarioAction, retry: boolean) =>
    retry && isSpend(action)
        ? settleUnclearSpend(action, ctx, state)
        : // ACTIONS pairs each type with its handler; the union call needs the widened view.
          (ACTIONS[action.type] as ActionHandler<ScenarioAction>)(action, ctx, state);

/**
 * The state when a rule has gone through all its steps: recorded as fired, with the phase change that was waiting
 * for it. A phase change takes effect when the rule finishes, so an interrupted rule always resumes in the phase it
 * belongs to. A step passed over in this firing stays visible as the last problem.
 */
const finishRule = (
    ctx: RunnerContext,
    rule: ValidatedRule,
    startState: ScenarioState,
    before: ScenarioState,
    { gotoPhase, skippedStep }: { gotoPhase: string | null; skippedStep: { at: number; message: string } | null },
): { state: ScenarioState; completed: boolean } => {
    const at = nowSec();
    let state: ScenarioState = {
        ...before,
        inFlight: null,
        lastError: skippedStep,
        fired: { ...before.fired, [rule.id]: firedRecord(startState, at, ctx.timezone) },
    };
    if (gotoPhase !== null && gotoPhase !== state.phase) {
        log().info(
            `${logger.challengeTag(ctx.challenge)} scenario "${ctx.scenario.name}": phase ${state.phase} → ${gotoPhase}`,
            null,
        );
        state = { ...state, phase: gotoPhase, phaseEnteredAt: at };
    }
    return { state, completed: ctx.ledger.set(ctx.challengeId, state) };
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
    const { action, index, result, at, committed } = step;
    const message = `${rule.label ?? rule.id} → ${action.type}: ${result.message}`;
    log().warning(`${logger.challengeTag(ctx.challenge)} scenario "${ctx.scenario.name}": ${message}`, null);
    if (result.status === 'skipped' && committed) {
        const skippedStep = { at, message };
        const next = { ...state, lastError: skippedStep, inFlight: { ruleId: rule.id, actionIndex: index + 1 } };
        return { state: next, stop: !ctx.ledger.set(ctx.challengeId, next), skippedStep };
    }
    const next = stoppedAt(state, { rule, index, result, message, at, committed, timezone: ctx.timezone });
    ctx.ledger.set(ctx.challengeId, next);
    return { state: next, stop: true, skippedStep: null };
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
    const tag = logger.challengeTag(ctx.challenge);
    let state = startState;
    // A rule that was interrupted after a step went through, or whose spend got no answer, is committed to its steps.
    let committed = startIndex > 0 || startState.inFlight?.ruleId === rule.id;
    let gotoPhase: string | null = null;
    let skippedStep: { at: number; message: string } | null = null;
    for (let index = startIndex; index < rule.do.length; index++) {
        const action = rule.do[index];
        const retry = isUnclearRetry(startState, rule.id, index === startIndex, action);
        const marked = retry ? state : writeAhead(ctx, state, { ruleId: rule.id, index, action });
        // A spend that could not be written down first is not made.
        if (!marked) return { state, completed: false };
        state = marked;
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
        state = {
            ...applyEffects(state, result, at),
            inFlight: { ruleId: rule.id, actionIndex: index + 1 },
            lastAction: { at, ruleId: rule.id, action: action.type, outcome: 'done' },
        };
        const saved = ctx.ledger.set(ctx.challengeId, state);
        log().info(`${tag} scenario "${ctx.scenario.name}": ${rule.label ?? rule.id} → ${action.type}`, null);
        // A step that landed and could not be written down is the last one this pass: the next step could spend too.
        if (!saved) return { state, completed: false };
    }
    return finishRule(ctx, rule, startState, state, { gotoPhase, skippedStep });
};

export { withNotice, runRule };
