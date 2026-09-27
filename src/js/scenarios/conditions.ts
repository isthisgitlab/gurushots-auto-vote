import type { Bankroll, Challenge } from '../types/gurushots';
import type { ComparisonOp, EntryCondition, NumericConditionType, ScenarioCondition } from '../types/scenario';
import type { VoteHistory } from './speed';
/**
 * Evaluates a scenario rule's conditions against the live challenge. Pure:
 * everything comes in through `ctx`.
 *
 * Unknown data fails closed — a missing close_time, an unreadable exposure,
 * an unranked entry, an unknown balance all make the condition FALSE, so a
 * rule never fires on data the app could not read.
 */

import { occurrencesOf } from '../scheduling/wallClock';
import { parseDuration } from './duration';
import { selectEntry, entriesOf, rankOf, votesOf, windowOf } from './selectors';
import { votesPerHour, speedRatio } from './speed';

interface ConditionContext {
    challenge: Challenge;
    state: { phaseEnteredAt: number; memory: Record<string, string>; history?: VoteHistory };
    /** unix seconds */
    now: number;
    /** IANA zone for dailyWindow */
    timezone: string;
    bankroll?: Bankroll | null;
}

/**
 * Numbers compare with every op; booleans (entry flags) only with = / !=,
 * which the validator enforces.
 */
const compare = (a: number | boolean, op: ComparisonOp, b: number | boolean): boolean => {
    switch (op) {
        case '<':
            return a < b;
        case '<=':
            return a <= b;
        case '>':
            return a > b;
        case '>=':
            return a >= b;
        case '!=':
            return a !== b;
        default:
            return a === b;
    }
};

const finite = (value: number | null | undefined) =>
    value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * `min <= value <= max` over the bounds that are set; false for an unknown value.
 */
const within = (value: number | null, min: number | null, max: number | null) =>
    value !== null && (min === null || value >= min) && (max === null || value <= max);

const durationBound = (bound: string | number | undefined) => (bound === undefined ? null : parseDuration(bound));

const numberBound = (bound: number | undefined) => (bound === undefined ? null : bound);

/**
 * The challenge-level numbers `{op, value}` conditions compare.
 */
const CHALLENGE_NUMBERS: Record<NumericConditionType, (challenge: Challenge) => number | null> = {
    entries: (challenge) => entriesOf(challenge).length,
    freeSlots: (challenge) => {
        const max = finite(challenge?.max_photo_submits);
        return max === null ? null : Math.max(0, max - entriesOf(challenge).length);
    },
    exposure: (challenge) => finite(challenge?.member?.ranking?.exposure?.exposure_factor),
    challengeRank: (challenge) => {
        const rank = finite(challenge?.member?.ranking?.total?.rank);
        return rank !== null && rank > 0 ? rank : null;
    },
    challengeVotes: (challenge) => finite(challenge?.member?.ranking?.total?.votes),
};

/**
 * Seconds left until close, or null when the challenge has no readable
 * close_time or has already closed.
 */
const secondsLeft = (challenge: Challenge, now: number) => {
    const close = finite(challenge?.close_time);
    return close === null || now >= close ? null : close - now;
};

const secondsSinceStart = (challenge: Challenge, now: number) => {
    const start = finite(challenge?.start_time);
    return start === null || now < start ? null : now - start;
};

const percentElapsed = (challenge: Challenge, now: number) => {
    const start = finite(challenge?.start_time);
    const close = finite(challenge?.close_time);
    if (start === null || close === null || close <= start || now < start) return null;
    return ((now - start) / (close - start)) * 100;
};

/**
 * True while the wall clock is inside [from, to) — i.e. the latest `from`
 * occurrence is more recent than the latest `to` occurrence. Handles windows
 * that wrap past midnight and DST days without date arithmetic.
 */
const inDailyWindow = ({ from, to }: { from: string; to: string }, timezone: string, now: number) =>
    // Both times are validated HH:MM, so occurrencesOf never returns null here.
    (occurrencesOf(from, timezone, now) as { prev: number }).prev >
    (occurrencesOf(to, timezone, now) as { prev: number }).prev;

const evaluateCondition = (condition: ScenarioCondition, ctx: ConditionContext): boolean => {
    const { challenge, state, now } = ctx;
    switch (condition.type) {
        case 'dailyWindow':
            return inDailyWindow(condition, ctx.timezone, now);
        case 'beforeEnd':
            return within(secondsLeft(challenge, now), durationBound(condition.min), durationBound(condition.max));
        case 'afterStart':
            return within(
                secondsSinceStart(challenge, now),
                durationBound(condition.min),
                durationBound(condition.max),
            );
        case 'inPhaseFor':
            return within(now - state.phaseEnteredAt, durationBound(condition.min), durationBound(condition.max));
        case 'elapsedPercent':
            return within(percentElapsed(challenge, now), numberBound(condition.min), numberBound(condition.max));
        case 'boostState':
        case 'turboState': {
            const holder = condition.type === 'boostState' ? challenge?.member?.boost : challenge?.member?.turbo;
            return typeof holder?.state === 'string' && condition.in.includes(holder.state);
        }
        case 'balance': {
            const balance = finite(ctx.bankroll?.[condition.currency]);
            return balance !== null && compare(balance, condition.op, condition.value);
        }
        case 'memorySet':
            return typeof state.memory?.[condition.slot] === 'string';
        case 'entry':
            return evaluateEntryCondition(condition, ctx);
        case 'all':
            return condition.of.every((item) => evaluateCondition(item, ctx));
        case 'any':
            return condition.of.some((item) => evaluateCondition(item, ctx));
        case 'not':
            return !evaluateCondition(condition.condition, ctx);
        default: {
            const value = CHALLENGE_NUMBERS[condition.type](challenge);
            return value !== null && compare(value, condition.op, condition.value);
        }
    }
};

const evaluateEntryCondition = (condition: EntryCondition, ctx: ConditionContext) => {
    const { history, memory } = ctx.state;
    const entry = selectEntry(condition.select, ctx.challenge, { memory, history, now: ctx.now });
    if (!entry) return false;
    if (condition.field === 'votes') return compare(votesOf(entry), condition.op, condition.value);
    if (condition.field === 'votesPerHour' || condition.field === 'speedRatio') {
        const window = windowOf(condition.window);
        const speed =
            condition.field === 'votesPerHour'
                ? votesPerHour(history, entry, ctx.now, window)
                : speedRatio(history, entriesOf(ctx.challenge), entry, ctx.now, window);
        return speed !== null && compare(speed, condition.op, condition.value);
    }
    if (condition.field === 'rank') {
        const rank = rankOf(entry);
        return rank !== null && compare(rank, condition.op, condition.value);
    }
    return compare(entry[condition.field] === true, condition.op, condition.value);
};

/**
 * True when every condition in the list holds (an empty list always holds).
 */
const allHold = (conditions: readonly ScenarioCondition[] | undefined, ctx: ConditionContext) =>
    (conditions ?? []).every((condition) => evaluateCondition(condition, ctx));

/**
 * Index of the first condition in the list that does not hold, or -1.
 */
const firstFailing = (conditions: readonly ScenarioCondition[] | undefined, ctx: ConditionContext) =>
    (conditions ?? []).findIndex((condition) => !evaluateCondition(condition, ctx));

export { evaluateCondition, allHold, firstFailing, compare, finite, durationBound };
