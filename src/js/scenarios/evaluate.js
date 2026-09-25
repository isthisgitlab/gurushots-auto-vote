// @ts-check
/**
 * The scenario decision: given a validated scenario, a challenge's runtime
 * state and the live challenge, which rule (if any) fires now, from which
 * action, and when the engine next needs to look. Pure — the runner
 * (services/scenarioRunner.js) executes the result and persists state.
 *
 * Rules are tried in phase order; the first whose `repeat` mode allows it
 * and whose conditions all hold fires. A rule interrupted mid-way (an action
 * failed, or the app stopped) resumes from that action before anything else.
 */

const { occurrencesOf } = require('../scheduling/wallClock');
const { firstFailing } = require('./conditions');
const { nextWakeAt } = require('./nextWake');

/**
 * @typedef {object} EvaluateInput
 * @property {any} scenario - a validated scenario document
 * @property {any} state - the challenge's runtime state (scenarioStateStore record)
 * @property {any} challenge
 * @property {number} now - unix seconds
 * @property {string} timezone
 * @property {Record<string, number>|null} [bankroll]
 * @property {Set<string>} [skipRuleIds] - rules already fired in this pass
 */

/**
 * Identity of the local calendar day `now` falls in: the instant of its
 * midnight in `timezone`.
 *
 * @param {number} now
 * @param {string} timezone
 */
const localDayOf = (now, timezone) => /** @type {{prev: number}} */ (occurrencesOf('00:00', timezone, now)).prev;

/**
 * Why a rule's `repeat` mode keeps it from firing now, or null when it may.
 *
 * @param {any} rule
 * @param {any} state
 * @param {number} now
 * @param {string} timezone
 */
const repeatBlock = (rule, state, now, timezone) => {
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
 *
 * @param {any} state
 * @param {number} now
 * @param {string} timezone
 */
const firedRecord = (state, now, timezone) => ({
    at: now,
    day: localDayOf(now, timezone),
    phaseEnteredAt: state.phaseEnteredAt,
});

/**
 * @param {EvaluateInput} input
 * @returns {{
 *   phase: string,
 *   halted: string|null,
 *   fire: {ruleId: string, rule: any, startIndex: number}|null,
 *   explain: Array<{ruleId: string, label: string, status: 'ready'|'blocked'|'waiting', reason: string}>,
 *   nextWakeAt: number|null,
 * }}
 */
const evaluateScenario = (input) => {
    const { scenario, state, now, timezone } = input;
    const skip = input.skipRuleIds ?? new Set();
    const phase = scenario.phases[state.phase];
    const base = { phase: state.phase, fire: null, explain: [], nextWakeAt: null };
    if (!phase) {
        return { ...base, halted: `Phase "${state.phase}" no longer exists in scenario "${scenario.name}"` };
    }
    const rules = phase.rules ?? [];

    if (state.inFlight) {
        const rule = rules.find((/** @type {any} */ candidate) => candidate.id === state.inFlight.ruleId);
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
    /** @type {{ruleId: string, rule: any, startIndex: number}|null} */
    let fire = null;
    const explain = [];
    for (const rule of rules) {
        const label = rule.label ?? rule.id;
        const blocked = skip.has(rule.id) ? 'already fired in this pass' : repeatBlock(rule, state, now, timezone);
        if (blocked) {
            explain.push({ ruleId: rule.id, label, status: /** @type {const} */ ('blocked'), reason: blocked });
            continue;
        }
        const failing = firstFailing(rule.if, ctx);
        if (failing !== -1) {
            const reason = `condition ${failing + 1} (${rule.if[failing].type}) does not hold`;
            explain.push({ ruleId: rule.id, label, status: /** @type {const} */ ('waiting'), reason });
            continue;
        }
        explain.push({
            ruleId: rule.id,
            label,
            status: /** @type {const} */ ('ready'),
            reason: fire ? 'ready, after an earlier rule' : 'all conditions hold',
        });
        fire ??= { ruleId: rule.id, rule, startIndex: 0 };
    }
    return { ...base, halted: null, fire, explain, nextWakeAt: nextWakeAt(input) };
};

module.exports = { evaluateScenario, firedRecord, localDayOf };
