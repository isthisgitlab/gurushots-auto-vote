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
import { isSpend, limitOf, log, nowSec } from './support';
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
 * and it counts toward the scenario's spend limit. The markers of the step's other spends (an edit of the scenario
 * can leave several) stay with it, so reverting the edit never spends one of them. When the retry cannot show the
 * spend landed (`halt`) the rule ends here and is recorded as fired with the action it stopped after, so its repeat
 * policy holds it (evaluate).
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
            [rule.id]: {
                ...firedRecord(state, at, timezone),
                unclearHalt: result.unclear,
                haltOrigin: result.origin,
            },
        };
    } else if (committed || result.spent) {
        // (The state's own marker is this step's: the one before a spend, or the one the step before it left. Its
        // `pending` is this step's own spend, which was made or refused: it is not carried.)
        const prior = state.inFlight;
        const unclear = [...(prior?.unclear ?? []), ...(result.unclear ? [result.unclear] : [])];
        // `unclearAt`: when the spend got no answer, for the card to tell a later problem from it.
        const marker = unclear.length ? { unclear, unclearAt: result.unclear ? at : prior?.unclearAt } : {};
        next.inFlight = { ruleId: rule.id, actionIndex: index, ...marker };
    }
    if (result.status !== 'deferred') next.lastError = { at, message };
    return applyEffects(next, { spent: result.spent }, at);
};

/**
 * Which marker the step about to run is the retry of: its spend got no answer (counted already), or it was written
 * down before it was made and nothing says it was (not counted yet). Null when it is not a retry.
 */
const retryOf = (
    start: ScenarioState,
    ruleId: string,
    firstStep: boolean,
    action: ScenarioAction,
): 'unclear' | 'pending' | null => {
    const marker = firstStep && start.inFlight?.ruleId === ruleId ? start.inFlight : null;
    if (marker?.unclear?.some((type) => type === action.type)) return 'unclear';
    return marker?.pending === action.type ? 'pending' : null;
};

/**
 * A `pending` marker the step now running is not for (the scenario was edited since) is a spend that may have gone
 * through, and nothing will look at: it becomes an `unclear` one, counted, so that reverting the edit does not spend
 * it again.
 */
const absorbLeftover = (state: ScenarioState, own: SpendAction | undefined): ScenarioState => {
    const { inFlight } = state;
    if (!inFlight?.pending || inFlight.pending === own) return state;
    const { pending, ...rest } = inFlight;
    return {
        ...state,
        spent: { ...state.spent, [limitOf(pending)]: (state.spent[limitOf(pending)] ?? 0) + 1 },
        inFlight: {
            ...rest,
            unclear: [...(inFlight.unclear ?? []), pending],
            unclearAt: inFlight.unclearAt ?? nowSec(),
        },
    };
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
    return ctx.ledger.set(ctx.challengeId, marked) ? marked : null;
};

/**
 * The write-ahead of the step now running, for it to call just before its request: it writes the marker onto the
 * state the rule holds and keeps what was written as that state.
 */
const spendWriter =
    (
        ctx: RunnerContext,
        at: { ruleId: string; index: number },
        held: { get: () => ScenarioState; set: (state: ScenarioState) => void },
    ) =>
    (spend: SpendAction): boolean => {
        const marked = markPending(ctx, held.get(), { ...at, spend });
        if (marked) held.set(marked);
        return marked !== null;
    };

/**
 * Writes down the state a step left, trying once more when the first write fails (a lock held for a moment after a
 * spend that is known to have landed must not turn into a rule that stops for want of a write).
 */
const saveResult = (ctx: RunnerContext, state: ScenarioState): boolean => {
    if (ctx.ledger.set(ctx.challengeId, state) || ctx.ledger.set(ctx.challengeId, state)) return true;
    log().warning(
        `${logger.challengeTag(ctx.challenge)} the result of the last step could not be written down: the next pass may stop this rule needlessly`,
        null,
    );
    return false;
};

/**
 * One action of a rule. A step whose spend got no answer is never spent again: its retry only looks at the live
 * challenge.
 */
const runAction = (
    ctx: RunnerContext,
    state: ScenarioState,
    action: ScenarioAction,
    retry: 'unclear' | 'pending' | null,
) =>
    retry && isSpend(action)
        ? settleUnclearSpend(action, ctx, state, retry)
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
    return { state, completed: saveResult(ctx, state) };
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
        return { state: next, stop: !saveResult(ctx, next), skippedStep };
    }
    const next = stoppedAt(state, { rule, index, result, message, at, committed, timezone: ctx.timezone });
    saveResult(ctx, next);
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
        const retry = retryOf(startState, rule.id, index === startIndex, action);
        state = absorbLeftover(state, isSpend(action) ? action.type : undefined);
        // A spend is written down by the step itself, just before its request (see lockedCurrencySpend); one that
        // could not be is not made. A retry makes no spend.
        ctx.beforeSpend = retry
            ? undefined
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
        state = {
            ...applyEffects(state, result, at),
            inFlight: { ruleId: rule.id, actionIndex: index + 1 },
            lastAction: { at, ruleId: rule.id, action: action.type, outcome: 'done' },
        };
        const saved = saveResult(ctx, state);
        log().info(`${tag} scenario "${ctx.scenario.name}": ${rule.label ?? rule.id} → ${action.type}`, null);
        // A step that landed and could not be written down is the last one this pass: the next step could spend too.
        if (!saved) return { state, completed: false };
    }
    return finishRule(ctx, rule, startState, state, { gotoPhase, skippedStep });
};

export { withNotice, runRule };
