/**
 * When the scenario engine next needs to look at a challenge: the soonest
 * instant after `now` at which a time condition in the current phase can
 * change its answer (a daily window opens or closes, a before-end / after-
 * start / percent / in-phase bound is crossed, or a once-per-day rule becomes
 * eligible again at local midnight). Before the challenge closes; null when
 * nothing time-based is pending.
 *
 * Waking at an instant where nothing ends up firing is harmless; sleeping
 * past one is the bug the scheduler's boundary invariant exists to prevent —
 * so every bound yields a candidate, whichever way it flips.
 *
 * The resolved instants of the phase's dynamic submit, vote and pause schedules are candidates too (the rows its owner
 * published: a deadline, a window's start, the first second after its end), so the scheduler wakes at each of them. So are the
 * instants an expression of a rule condition stands for (comparisons, presence and list conditions, nested or negated), the
 * second a clock-driven duration reaches a number it is compared with, and the publication's own `validUntil`.
 *
 * A subject with no challenge (the installation) has no close time to bound its wakes: it passes an explicit `horizon`.
 *
 * `phaseClock: false` leaves the in-phase bounds out: a plan that has not started has no phase
 * clock (the real one starts on the first pass that runs it), so a synthetic `startState(now)`
 * must not pull every wake in to `now + min`. Every other bound is still used.
 */

import { occurrencesOf } from '../scheduling/wallClock';
import { scheduleInstants } from '../services/autoFill/schedule';
import { finite, durationBound } from './conditions';
import { evaluateExpression, expressionNodes } from './expressions';

import type { Challenge } from '../types/gurushots';
import type { ExpressionContext } from './expressions';
import type { ScenarioCondition, ScenarioEngineState, ScenarioExpr } from '../types/scenario';
import type { ScenarioDocument } from '../settings/scenarioSchema';

/**
 * The next occurrence of a validated HH:MM time (occurrencesOf only returns
 * null for an unparsable time).
 */
const nextOccurrence = (time: string, timezone: string, now: number) =>
    (occurrencesOf(time, timezone, now) as { next: number }).next;

/**
 * Instants at which `min <= f(t) <= max` can flip, for f(t) = t - origin
 * (reversed = f(t) = origin - t, i.e. time left until `origin`).
 */
const rangeInstants = (
    origin: number | null,
    min: number | null,
    max: number | null,
    reversed: boolean = false,
): number[] => {
    if (origin === null) return [];
    const instants = [];
    if (reversed) {
        if (max !== null) instants.push(origin - max);
        if (min !== null) instants.push(origin - min + 1);
    } else {
        if (min !== null) instants.push(origin + min);
        if (max !== null) instants.push(origin + max + 1);
    }
    return instants;
};

/**
 * The facts that change with the clock by themselves, and which way: a duration that grows (+1) or shrinks (-1) a second per
 * second. A comparison of one against a number flips at a predictable instant.
 */
const CLOCK_FACTS: Readonly<Record<string, 1 | -1>> = {
    'phase.elapsed': 1,
    'challenge.elapsed': 1,
    'challenge.timeLeft': -1,
    'boost.freeRemaining': -1,
};

/** What a wake is worked out from: the subject's challenge (none for the installation), its state, and the clock. */
type WakeContext = {
    challenge: Challenge | null;
    state: ScenarioEngineState;
    now: number;
    timezone: string;
    phaseClock: boolean;
    /** The facts an expression is evaluated on, as far as the scheduler can know them; an unknown one supplies no instant. */
    facts: ExpressionContext | null;
};

/**
 * The instants an expression stands for (a close time, a point offset from it, a Boost's free expiry, a Turbo's opening, a
 * mission's expiry), and the second after each (a comparison against an instant flips there, whichever side is inclusive).
 * Only what is known counts: unknown or absent evidence supplies no instant, and nothing worked out from the clock itself does.
 */
const expressionInstants = (exprs: readonly ScenarioExpr[], ctx: WakeContext): number[] => {
    const facts = ctx.facts;
    if (!facts) return [];
    const instants: number[] = [];
    for (const node of exprs.flatMap(expressionNodes)) {
        // What is worked out from the clock itself moves with it, and is never a boundary to wake at.
        if (expressionNodes(node).some((part) => part.kind === 'fact' && part.name === 'clock.now')) continue;
        const value = evaluateExpression(node, facts);
        if (value.state === 'known' && value.value.kind === 'number' && value.value.quantity === 'instant') {
            instants.push(value.value.value, value.value.value + 1);
        }
    }
    return instants;
};

/**
 * Where a comparison of a clock-driven duration fact against a known number flips: the second the duration reaches that
 * number, and the one after it.
 */
const clockCrossings = (left: ScenarioExpr, right: ScenarioExpr, ctx: WakeContext): number[] => {
    const facts = ctx.facts;
    if (!facts) return [];
    const crossings: number[] = [];
    for (const [side, other] of [
        [left, right],
        [right, left],
    ]) {
        if (side.kind !== 'fact') continue;
        const slope = CLOCK_FACTS[side.name];
        if (slope === undefined) continue;
        const current = evaluateExpression(side, facts);
        const target = evaluateExpression(other, facts);
        if (current.state !== 'known' || current.value.kind !== 'number') continue;
        if (target.state !== 'known' || target.value.kind !== 'number') continue;
        const at = ctx.now + Math.ceil((target.value.value - current.value.value) / slope);
        crossings.push(at, at + 1);
    }
    return crossings;
};

/**
 * Every instant a condition (and the conditions nested in it, negated or not) can flip.
 */
const collectInstants = (condition: ScenarioCondition, ctx: WakeContext, into: number[]) => {
    const start = finite(ctx.challenge?.start_time);
    const close = finite(ctx.challenge?.close_time);
    switch (condition.type) {
        case 'dailyWindow':
            into.push(nextOccurrence(condition.from, ctx.timezone, ctx.now));
            into.push(nextOccurrence(condition.to, ctx.timezone, ctx.now));
            break;
        case 'beforeEnd':
            into.push(...rangeInstants(close, durationBound(condition.min), durationBound(condition.max), true));
            break;
        case 'afterStart':
            into.push(...rangeInstants(start, durationBound(condition.min), durationBound(condition.max)));
            break;
        case 'inPhaseFor':
            if (ctx.phaseClock) {
                into.push(
                    ...rangeInstants(
                        ctx.state.phaseEnteredAt,
                        durationBound(condition.min),
                        durationBound(condition.max),
                    ),
                );
            }
            break;
        case 'elapsedPercent':
            if (start !== null && close !== null && close > start) {
                const toSeconds = (pct: number | undefined) =>
                    pct === undefined ? null : Math.ceil(((close - start) * pct) / 100);
                into.push(...rangeInstants(start, toSeconds(condition.min), toSeconds(condition.max)));
            }
            break;
        case 'compare':
            into.push(...expressionInstants([condition.left, condition.right], ctx));
            into.push(...clockCrossings(condition.left, condition.right, ctx));
            break;
        case 'present':
        case 'absent':
            into.push(...expressionInstants([condition.value], ctx));
            break;
        case 'contains':
        case 'containsAny':
        case 'containsAll':
            into.push(...expressionInstants([condition.list, condition.value], ctx));
            break;
        case 'all':
        case 'any':
            for (const item of condition.of) collectInstants(item, ctx, into);
            break;
        case 'not':
            collectInstants(condition.condition, ctx, into);
            break;
        default:
            break;
    }
};

const nextWakeAt = ({
    scenario,
    state,
    challenge,
    now,
    timezone,
    phaseClock = true,
    facts = null,
    horizon = null,
}: {
    scenario: ScenarioDocument;
    state: ScenarioEngineState;
    /** The subject's challenge; null for the installation, which has none (its bound is `horizon`). */
    challenge: Challenge | null;
    now: number;
    timezone: string;
    phaseClock?: boolean;
    /** The facts the expressions of conditions are evaluated on (what the scheduler can know: the challenge's own state, cached evidence). */
    facts?: ExpressionContext | null;
    /** Where a subject with no challenge stops looking ahead (unix seconds): never a challenge's close time. */
    horizon?: number | null;
}): number | null => {
    // A challenge's wakes end at its close; the installation has none and looks ahead to an explicit horizon.
    const limit = challenge ? finite(challenge.close_time) : horizon;
    if (limit === null || now >= limit) return null;
    const rules = scenario.phases[state.phase]?.rules ?? [];
    const ctx: WakeContext = { challenge, state, now, timezone, phaseClock, facts };
    const instants: number[] = [];
    for (const rule of rules) {
        for (const condition of rule.if ?? []) collectInstants(condition, ctx, instants);
        if (rule.repeat === 'oncePerDay' && state.fired?.[rule.id])
            instants.push(nextOccurrence('00:00', timezone, now));
    }
    // The resolved instants of the phase's dynamic schedules (known rows only), as its owner published them.
    if (state.published?.phase === state.phase) {
        instants.push(...scheduleInstants(state.published.schedules));
        // The publication stops being valid at its own boundary: it is made again then.
        if (state.published.validUntil !== null) instants.push(state.published.validUntil);
    }
    const upcoming = instants.filter((instant) => instant > now && instant < limit);
    return upcoming.length ? Math.min(...upcoming) : null;
};

export { nextWakeAt };
