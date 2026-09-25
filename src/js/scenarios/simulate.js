// @ts-check
/**
 * A what-if timeline of a scenario: from now until the challenge closes,
 * which rules would fire when, and which phase the plan would be in. It
 * jumps between the engine's own wake-up instants (nextWake.js) and asks the
 * engine (evaluate.js) at each, exactly like the scheduler and the runner —
 * so time-based plans ("each morning at 06:00", "4 minutes after the swap")
 * can be checked before they run.
 *
 * Two assumptions, which the result states: every action succeeds, and the
 * challenge's live data (entries, votes, boost state) stays as it is now. A
 * rule waiting on data that changes — a breakout, a rank — therefore shows
 * only if it already holds. Pure; spends and changes nothing.
 */

const { evaluateScenario, firedRecord } = require('./evaluate');
const { nextWakeAt } = require('./nextWake');

const MAX_EVENTS = 50;
const MAX_STEPS = 500;
/** A close far enough away to ask "is there any later step at all?". */
const FAR_FUTURE_SEC = 100 * 365 * 86400;

/**
 * @typedef {{at: number, phase: string, ruleId: string, label: string, actions: string[], toPhase: string|null}} SimulatedEvent
 * @typedef {'closed'|'idle'|'halted'|'limit'} StopReason
 */

/**
 * The state after a rule fired in the simulation: its fired marker, any
 * memory it would write (a placeholder id — the real photo is unknown), and
 * its goto.
 *
 * @param {any} state
 * @param {any} rule
 * @param {number} at
 * @param {string} timezone
 */
const afterFiring = (state, rule, at, timezone) => {
    const memory = { ...state.memory };
    let toPhase = null;
    for (const action of rule.do) {
        for (const slot of [action.remember, action.rememberRemoved, action.rememberAdded]) {
            if (typeof slot === 'string') memory[slot] = '(simulated)';
        }
        if (action.type === 'remember') memory[action.slot] = '(simulated)';
        if (action.type === 'forget') delete memory[action.slot];
        if (action.type === 'goto') toPhase = action.phase;
    }
    const next = {
        ...state,
        memory,
        inFlight: null,
        fired: { ...state.fired, [rule.id]: firedRecord(state, at, timezone) },
    };
    const moved = toPhase !== null && toPhase !== state.phase;
    return { state: moved ? { ...next, phase: toPhase, phaseEnteredAt: at } : next, toPhase: moved ? toPhase : null };
};

/**
 * @param {object} input
 * @param {any} input.scenario - a validated scenario document
 * @param {any} input.state - the challenge's runtime state (or a start state)
 * @param {any} input.challenge - the live challenge
 * @param {number} input.now - unix seconds
 * @param {string} input.timezone
 * @param {Record<string, number>|null} [input.bankroll]
 * @returns {{events: SimulatedEvent[], stoppedBecause: StopReason, stoppedAt: number, halted: string|null}}
 */
const simulateScenario = ({ scenario, state: startState, challenge, now, timezone, bankroll = null }) => {
    /** @type {SimulatedEvent[]} */
    const events = [];
    let state = { ...startState, inFlight: null };
    let at = now;
    for (let step = 0; step < MAX_STEPS; step++) {
        // One simulated pass at `at`: rules chain like in the runner — each
        // at most once, and a goto chain stops on a phase it already visited.
        const firedThisPass = new Set();
        const visited = new Set([state.phase]);
        for (;;) {
            const decision = evaluateScenario({
                scenario,
                state,
                challenge,
                now: at,
                timezone,
                bankroll,
                skipRuleIds: firedThisPass,
            });
            if (decision.halted) return { events, stoppedBecause: 'halted', stoppedAt: at, halted: decision.halted };
            if (!decision.fire) break;
            const { rule } = decision.fire;
            firedThisPass.add(rule.id);
            const fromPhase = state.phase;
            const fired = afterFiring(state, rule, at, timezone);
            state = fired.state;
            events.push({
                at,
                phase: fromPhase,
                ruleId: rule.id,
                label: rule.label ?? rule.id,
                actions: rule.do.map((/** @type {any} */ action) => action.type),
                toPhase: fired.toPhase,
            });
            if (events.length >= MAX_EVENTS) return { events, stoppedBecause: 'limit', stoppedAt: at, halted: null };
            if (fired.toPhase === null) continue;
            if (visited.has(fired.toPhase)) break;
            visited.add(fired.toPhase);
        }
        const wake = nextWakeAt({ scenario, state, challenge, now: at, timezone });
        if (wake === null) {
            const close = Number(challenge?.close_time);
            if (!Number.isFinite(close) || at >= close) {
                return { events, stoppedBecause: 'closed', stoppedAt: at, halted: null };
            }
            // Nothing more before the close: either the next step falls after
            // it, or the plan now only waits on live data held still here.
            const beyond = nextWakeAt({
                scenario,
                state,
                challenge: { ...challenge, close_time: at + FAR_FUTURE_SEC },
                now: at,
                timezone,
            });
            return beyond === null
                ? { events, stoppedBecause: 'idle', stoppedAt: at, halted: null }
                : { events, stoppedBecause: 'closed', stoppedAt: close, halted: null };
        }
        at = wake;
    }
    return { events, stoppedBecause: 'limit', stoppedAt: at, halted: null };
};

module.exports = { simulateScenario, MAX_EVENTS };
