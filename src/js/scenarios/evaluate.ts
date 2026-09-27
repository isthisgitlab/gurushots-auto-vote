/**
 * The scenario decision: given a validated scenario, a challenge's runtime
 * state and the live challenge, which rule (if any) fires now, from which
 * action, and when the engine next needs to look. Pure — the runner
 * (services/scenarioRunner.ts) executes the result and persists state.
 *
 * Rules are tried in phase order; the first whose `repeat` mode allows it
 * and whose conditions all hold fires. A rule interrupted mid-way (an action
 * failed, or the app stopped) resumes from that action before anything else.
 */

import { occurrencesOf } from '../scheduling/wallClock';

import type { Bankroll, Challenge } from '../types/gurushots';
import type { ScenarioEngineState } from '../types/scenario';
import type { ScenarioDocument, ScenarioRule } from '../settings/scenarioSchema';
import { firstFailing } from './conditions';
import { nextWakeAt } from './nextWake';

export interface EvaluateInput {
    scenario: ScenarioDocument;
    state: ScenarioEngineState;
    challenge: Challenge;
    /** unix seconds */
    now: number;
    timezone: string;
    bankroll?: Bankroll | null;
    /** rules already fired in this pass */
    skipRuleIds?: Set<string>;
}

/**
 * Identity of the local calendar day `now` falls in: the instant of its
 * midnight in `timezone`.
 */
const localDayOf = (now: number, timezone: string) => (occurrencesOf('00:00', timezone, now) as { prev: number }).prev;

/**
 * Why a rule's `repeat` mode keeps it from firing now, or null when it may.
 */
const repeatBlock = (rule: ScenarioRule, state: ScenarioEngineState, now: number, timezone: string) => {
    const fired = state.fired?.[rule.id];
    if (!fired) return null;
    switch (rule.repeat) {
        case 'once':
            return 'already fired';
        case 'oncePerPhase':
            return fired.phaseEnteredAt === state.phaseEnteredAt ? 'already fired in this phase' : null;
        case 'oncePerDay':
            return fired.day === localDayOf(now, timezone) ? 'already fired today' : null;
        default:
            return null;
    }
};

/**
 * The record kept when a rule finishes firing.
 */
const firedRecord = (state: ScenarioEngineState, now: number, timezone: string) => ({
    at: now,
    day: localDayOf(now, timezone),
    phaseEnteredAt: state.phaseEnteredAt,
});

const evaluateScenario = (
    input: EvaluateInput,
): {
    phase: string;
    halted: string | null;
    fire: { ruleId: string; rule: ScenarioRule; startIndex: number } | null;
    explain: Array<{ ruleId: string; label: string; status: 'ready' | 'blocked' | 'waiting'; reason: string }>;
    nextWakeAt: number | null;
} => {
    const { scenario, state, now, timezone } = input;
    const skip = input.skipRuleIds ?? new Set();
    const phase = scenario.phases[state.phase];
    const base = { phase: state.phase, fire: null, explain: [], nextWakeAt: null };
    if (!phase) {
        return { ...base, halted: `Phase "${state.phase}" no longer exists in scenario "${scenario.name}"` };
    }
    const rules = phase.rules ?? [];

    if (state.inFlight) {
        const rule = rules.find((candidate) => candidate.id === state.inFlight?.ruleId);
        if (!rule || state.inFlight.actionIndex >= rule.do.length) {
            return {
                ...base,
                halted: `The interrupted rule "${state.inFlight.ruleId}" no longer matches the scenario`,
            };
        }
        const resume = { ruleId: rule.id, rule, startIndex: state.inFlight.actionIndex };
        return {
            ...base,
            halted: null,
            fire: skip.has(rule.id) ? null : resume,
            explain: [
                {
                    ruleId: rule.id,
                    label: rule.label ?? rule.id,
                    status: 'ready',
                    reason: 'resuming an interrupted rule',
                },
            ],
            nextWakeAt: nextWakeAt(input),
        };
    }

    const ctx = { challenge: input.challenge, state, now, timezone, bankroll: input.bankroll ?? null };
    let fire: { ruleId: string; rule: ScenarioRule; startIndex: number } | null = null;
    const explain = [];
    for (const rule of rules) {
        const label = rule.label ?? rule.id;
        const blocked = skip.has(rule.id) ? 'already fired in this pass' : repeatBlock(rule, state, now, timezone);
        if (blocked) {
            explain.push({ ruleId: rule.id, label, status: 'blocked' as const, reason: blocked });
            continue;
        }
        const conditions = rule.if ?? [];
        const failing = firstFailing(conditions, ctx);
        if (failing !== -1) {
            const reason = `condition ${failing + 1} (${conditions[failing].type}) does not hold`;
            explain.push({ ruleId: rule.id, label, status: 'waiting' as const, reason });
            continue;
        }
        explain.push({
            ruleId: rule.id,
            label,
            status: 'ready' as const,
            reason: fire ? 'ready, after an earlier rule' : 'all conditions hold',
        });
        fire ??= { ruleId: rule.id, rule, startIndex: 0 };
    }
    return { ...base, halted: null, fire, explain, nextWakeAt: nextWakeAt(input) };
};

/**
 * The state a challenge has before its scenario starts: at the start phase,
 * entered now, nothing remembered or fired.
 *
 * @param now - unix seconds
 */
const startState = (scenario: ScenarioDocument, now: number): ScenarioEngineState => ({
    phase: scenario.start,
    phaseEnteredAt: now,
    memory: {},
    fired: {},
    inFlight: null,
});

export { evaluateScenario, firedRecord, localDayOf, startState };
