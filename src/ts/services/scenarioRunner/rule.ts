/**
 * Running one scenario rule and recording its effects.
 */

import * as logger from '../../logger';
import { firedRecord } from '../../scenarios/evaluate';
import type { ScenarioState } from '../../types/stores';
import type { ActionEffects, ActionHandler, RunnerContext, ScenarioAction, ValidatedRule } from './types';
import { log, nowSec } from './support';
import { ACTIONS } from './actions';

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
    let committed = startIndex > 0;
    let gotoPhase: string | null = null;
    let skippedStep: { at: number; message: string } | null = null;
    for (let index = startIndex; index < rule.do.length; index++) {
        const action = rule.do[index];
        // ACTIONS pairs each type with its handler; the union call needs the widened view.
        const result = await (ACTIONS[action.type] as ActionHandler<ScenarioAction>)(action, ctx, state);
        const at = nowSec();
        if (result.status !== 'done') {
            const message = `${rule.label ?? rule.id} → ${action.type}: ${result.message}`;
            log().warning(`${tag} scenario "${ctx.scenario.name}": ${message}`, null);
            if (result.status === 'skipped' && committed) {
                // Committed rules pass over a skipped step and carry on.
                skippedStep = { at, message };
                state = { ...state, lastError: skippedStep, inFlight: { ruleId: rule.id, actionIndex: index + 1 } };
                ctx.ledger.set(ctx.challengeId, state);
                continue;
            }
            state = { ...state, inFlight: committed ? { ruleId: rule.id, actionIndex: index } : null };
            if (result.status !== 'deferred') state.lastError = { at, message };
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
        ctx.ledger.set(ctx.challengeId, state);
        log().info(`${tag} scenario "${ctx.scenario.name}": ${rule.label ?? rule.id} → ${action.type}`, null);
    }
    const at = nowSec();
    state = {
        ...state,
        inFlight: null,
        // A step passed over in this firing stays visible as the last problem.
        lastError: skippedStep,
        fired: { ...state.fired, [rule.id]: firedRecord(startState, at, ctx.timezone) },
    };
    // A phase change takes effect when the rule finishes, so an interrupted
    // rule always resumes in the phase it belongs to.
    if (gotoPhase !== null && gotoPhase !== state.phase) {
        log().info(`${tag} scenario "${ctx.scenario.name}": phase ${state.phase} → ${gotoPhase}`, null);
        state = { ...state, phase: gotoPhase, phaseEnteredAt: at };
    }
    ctx.ledger.set(ctx.challengeId, state);
    return { state, completed: true };
};

export { withNotice, runRule };
