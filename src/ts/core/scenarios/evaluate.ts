/**
 * The scenario decision: given a validated scenario, a challenge's runtime
 * state and the live challenge, which rule (if any) fires now, from which
 * action, and when the engine next needs to look. Pure — the runner
 * (services/scenarioRunner.ts) executes the result and persists state.
 *
 * Rules are tried in phase order; the first whose `repeat` mode allows it
 * and whose conditions are all known true fires. A rule interrupted mid-way (an action
 * failed, or the app stopped) resumes from that action before anything else.
 */

import { occurrencesOf } from '../scheduling/wallClock';

import type { Bankroll, Challenge } from '../types/gurushots';
import type { ScenarioEngineState, ScenarioStage } from '../types/scenario';
import { DEFAULT_STAGES } from './vocabulary';
import type { ScenarioDocument, ScenarioRule } from '../settings/scenarioSchema';
import { firstFailing } from './conditions';
import type { ExpressionContext } from './expressions';
import type { FactEvidence, FactSubject } from './facts';
import { nextWakeAt } from './nextWake';

export interface EvaluateInput {
    scenario: ScenarioDocument;
    state: ScenarioEngineState;
    /** The challenge a candidate or an active subject is; absent for an installation and a completed subject. */
    challenge?: Challenge;
    /** What the facts are read on (absent: the active challenge). */
    subject?: FactSubject;
    /** The stage being evaluated: only the rules that run in it are tried (absent: the scenario's default stage). */
    stage?: ScenarioStage;
    /** unix seconds */
    now: number;
    timezone: string;
    bankroll?: Bankroll | null;
    /** The evidence a loader fetched for the facts the rules read (a field it did not fetch reads as not loaded). */
    evidence?: FactEvidence;
    /** Where a setting reference reads (the snapshot owner's prepared settings); without it every one is unknown. */
    readSetting?: ExpressionContext['readSetting'];
    /** rules already fired in this pass */
    skipRuleIds?: Set<string>;
    /** false for a plan that has not started: it has no phase clock, so no in-phase bound is a wake (nextWake.ts) */
    phaseClock?: boolean;
}

/**
 * The stage a scenario's rules run in when the caller names none: a challenge scenario's active stage, an installation's
 * account stage.
 */
const defaultStage = (scenario: ScenarioDocument): ScenarioStage =>
    scenario.scope === 'installation' ? 'account' : 'active';

/**
 * Whether a rule runs in a stage: the stages it declares, else its scenario's default.
 */
const runsIn = (rule: ScenarioRule, scenario: ScenarioDocument, stage: ScenarioStage): boolean => {
    const stages: readonly ScenarioStage[] = rule.stages ?? DEFAULT_STAGES[scenario.scope ?? 'challenge'];
    return stages.includes(stage);
};

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
    // A rule stopped after a spend that got no answer is not run again where nothing else holds it: one that fires
    // every pass waits for the phase to be entered again (once, once per phase and once per day hold it by their own
    // windows). Resetting the scenario's state clears it.
    const everyPass = rule.repeat === undefined || rule.repeat === 'always';
    if (fired.unclearHalt && everyPass && fired.phaseEnteredAt === state.phaseEnteredAt) {
        return 'stopped after a spend that got no answer, until the phase is entered again';
    }
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

/**
 * When the engine next needs to look: only a subject with a challenge has clock boundaries to predict.
 */
const wakeOf = (input: EvaluateInput): number | null =>
    input.challenge === undefined ? null : nextWakeAt({ ...input, challenge: input.challenge });

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
    const stage = input.stage ?? defaultStage(scenario);
    const allRules = phase.rules ?? [];
    const rules = allRules.filter((candidate) => runsIn(candidate, scenario, stage));

    if (state.inFlight) {
        const rule = allRules.find((candidate) => candidate.id === state.inFlight?.ruleId);
        if (!rule || state.inFlight.actionIndex >= rule.do.length) {
            return {
                ...base,
                halted: `The interrupted rule "${state.inFlight.ruleId}" no longer matches the scenario`,
            };
        }
        const resume = { ruleId: rule.id, rule, startIndex: state.inFlight.actionIndex };
        // An interrupted rule resumes in its own stage: another stage's evaluation leaves it as it is.
        const own = runsIn(rule, scenario, stage);
        return {
            ...base,
            halted: null,
            fire: skip.has(rule.id) || !own ? null : resume,
            explain: [
                {
                    ruleId: rule.id,
                    label: rule.label ?? rule.id,
                    status: 'ready',
                    reason: own ? 'resuming an interrupted rule' : 'an interrupted rule of another stage',
                },
            ],
            nextWakeAt: wakeOf(input),
        };
    }

    const ctx = {
        challenge: input.challenge,
        subject: input.subject,
        state,
        now,
        timezone,
        bankroll: input.bankroll ?? null,
        ...input.evidence,
        readSetting: input.readSetting,
    };
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
        if (failing) {
            // A rule fires only on a known true result: a false condition and one the data could not decide both wait,
            // and the reason says which.
            const subject = `condition ${failing.index + 1} (${conditions[failing.index].type})`;
            const reason =
                failing.truth.state === 'unknown'
                    ? `${subject} cannot be decided: ${failing.truth.reason}`
                    : `${subject} does not hold`;
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
    return { ...base, halted: null, fire, explain, nextWakeAt: wakeOf(input) };
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

export { evaluateScenario, firedRecord, localDayOf, runsIn, startState };
