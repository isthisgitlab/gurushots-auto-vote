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
import { log, nowSec } from './support';
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
        const prior = state.inFlight;
        const carried = prior?.ruleId === rule.id && prior.actionIndex === index ? prior : null;
        // `unclearAt`: when the spend got no answer, for the card to tell a later problem from it.
        const marker = result.unclear
            ? { unclear: result.unclear, unclearAt: at }
            : carried?.unclear
              ? { unclear: carried.unclear, unclearAt: carried.unclearAt }
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
    firstStep && start.inFlight?.ruleId === ruleId && start.inFlight.unclear === action.type;

/**
 * One action of a rule. A step whose spend got no answer is never spent again: its retry only looks at the live
 * challenge.
 */
const runAction = (
    ctx: RunnerContext,
    state: ScenarioState,
    retry: { start: ScenarioState; ruleId: string; firstStep: boolean },
    action: ScenarioAction,
) =>
    isUnclearRetry(retry.start, retry.ruleId, retry.firstStep, action)
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
        const result = await runAction(
            ctx,
            state,
            { start: startState, ruleId: rule.id, firstStep: index === startIndex },
            action,
        );
        const at = nowSec();
        if (result.status !== 'done') {
            const message = `${rule.label ?? rule.id} → ${action.type}: ${result.message}`;
            log().warning(`${tag} scenario "${ctx.scenario.name}": ${message}`, null);
            if (result.status === 'skipped' && committed) {
                // Committed rules pass over a skipped step and carry on.
                skippedStep = { at, message };
                state = { ...state, lastError: skippedStep, inFlight: { ruleId: rule.id, actionIndex: index + 1 } };
                if (!ctx.ledger.set(ctx.challengeId, state)) return { state, completed: false };
                continue;
            }
            state = stoppedAt(state, { rule, index, result, message, at, committed, timezone: ctx.timezone });
            ctx.ledger.set(ctx.challengeId, state);
            return { state, completed: false };
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
