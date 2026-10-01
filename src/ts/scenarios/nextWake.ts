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
 */

import { occurrencesOf } from '../scheduling/wallClock';
import { finite, durationBound } from './conditions';

import type { Challenge } from '../types/gurushots';
import type { ScenarioCondition, ScenarioEngineState } from '../types/scenario';
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
 * Every instant a condition (and the conditions nested in it) can flip.
 */
const collectInstants = (
    condition: ScenarioCondition,
    ctx: { challenge: Challenge; state: ScenarioEngineState; now: number; timezone: string },
    into: number[],
) => {
    const start = finite(ctx.challenge.start_time);
    const close = finite(ctx.challenge.close_time);
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
            into.push(
                ...rangeInstants(ctx.state.phaseEnteredAt, durationBound(condition.min), durationBound(condition.max)),
            );
            break;
        case 'elapsedPercent':
            if (start !== null && close !== null && close > start) {
                const toSeconds = (pct: number | undefined) =>
                    pct === undefined ? null : Math.ceil(((close - start) * pct) / 100);
                into.push(...rangeInstants(start, toSeconds(condition.min), toSeconds(condition.max)));
            }
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
}: {
    scenario: ScenarioDocument;
    state: ScenarioEngineState;
    challenge: Challenge;
    now: number;
    timezone: string;
}): number | null => {
    const close = finite(challenge?.close_time);
    if (close === null || now >= close) return null;
    const rules = scenario.phases[state.phase]?.rules ?? [];
    const ctx = { challenge, state, now, timezone };
    const instants: number[] = [];
    for (const rule of rules) {
        for (const condition of rule.if ?? []) collectInstants(condition, ctx, instants);
        if (rule.repeat === 'oncePerDay' && state.fired?.[rule.id])
            instants.push(nextOccurrence('00:00', timezone, now));
    }
    const upcoming = instants.filter((instant) => instant > now && instant < close);
    return upcoming.length ? Math.min(...upcoming) : null;
};

export { nextWakeAt };
