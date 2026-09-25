// @ts-check
/**
 * Evaluates a scenario rule's conditions against the live challenge. Pure:
 * everything comes in through `ctx`.
 *
 * Unknown data fails closed — a missing close_time, an unreadable exposure,
 * an unranked entry, an unknown balance all make the condition FALSE, so a
 * rule never fires on data the app could not read.
 */

const { occurrencesOf } = require('../scheduling/wallClock');
const { parseDuration } = require('./duration');
const { selectEntry, entriesOf, rankOf, votesOf, windowOf } = require('./selectors');
const { votesPerHour, speedRatio } = require('./speed');

/**
 * @typedef {object} ConditionContext
 * @property {any} challenge
 * @property {{phaseEnteredAt: number, memory: Record<string, string>, history?: import('./speed').VoteHistory}} state
 * @property {number} now - unix seconds
 * @property {string} timezone - IANA zone for dailyWindow
 * @property {Record<string, number>|null} [bankroll] - {keys, swaps, fills, coins}
 */

/**
 * Numbers compare with every op; booleans (entry flags) only with = / !=,
 * which the validator enforces.
 *
 * @param {any} a
 * @param {string} op
 * @param {any} b
 * @returns {boolean}
 */
const compare = (a, op, b) => {
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

/** @param {unknown} value */
const finite = (value) =>
    value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * `min <= value <= max` over the bounds that are set; false for an unknown value.
 *
 * @param {number|null} value
 * @param {number|null} min
 * @param {number|null} max
 */
const within = (value, min, max) => value !== null && (min === null || value >= min) && (max === null || value <= max);

/** @param {unknown} bound */
const durationBound = (bound) => (bound === undefined ? null : parseDuration(bound));

/** @param {unknown} bound */
const numberBound = (bound) => (bound === undefined ? null : /** @type {number} */ (bound));

/**
 * The challenge-level numbers `{op, value}` conditions compare.
 *
 * @type {Record<string, (challenge: any) => number|null>}
 */
const CHALLENGE_NUMBERS = {
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
 *
 * @param {any} challenge
 * @param {number} now
 */
const secondsLeft = (challenge, now) => {
    const close = finite(challenge?.close_time);
    return close === null || now >= close ? null : close - now;
};

/** @param {any} challenge @param {number} now */
const secondsSinceStart = (challenge, now) => {
    const start = finite(challenge?.start_time);
    return start === null || now < start ? null : now - start;
};

/** @param {any} challenge @param {number} now */
const percentElapsed = (challenge, now) => {
    const start = finite(challenge?.start_time);
    const close = finite(challenge?.close_time);
    if (start === null || close === null || close <= start || now < start) return null;
    return ((now - start) / (close - start)) * 100;
};

/**
 * True while the wall clock is inside [from, to) — i.e. the latest `from`
 * occurrence is more recent than the latest `to` occurrence. Handles windows
 * that wrap past midnight and DST days without date arithmetic.
 *
 * @param {{from: string, to: string}} window
 * @param {string} timezone
 * @param {number} now
 */
const inDailyWindow = ({ from, to }, timezone, now) =>
    // Both times are validated HH:MM, so occurrencesOf never returns null here.
    /** @type {{prev: number}} */ (occurrencesOf(from, timezone, now)).prev >
    /** @type {{prev: number}} */ (occurrencesOf(to, timezone, now)).prev;

/**
 * @param {any} condition - a validated condition
 * @param {ConditionContext} ctx
 * @returns {boolean}
 */
const evaluateCondition = (condition, ctx) => {
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
            return condition.of.every((/** @type {any} */ item) => evaluateCondition(item, ctx));
        case 'any':
            return condition.of.some((/** @type {any} */ item) => evaluateCondition(item, ctx));
        case 'not':
            return !evaluateCondition(condition.condition, ctx);
        default: {
            const value = CHALLENGE_NUMBERS[condition.type](challenge);
            return value !== null && compare(value, condition.op, condition.value);
        }
    }
};

/**
 * @param {any} condition
 * @param {ConditionContext} ctx
 */
const evaluateEntryCondition = (condition, ctx) => {
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
 *
 * @param {any[]|undefined} conditions
 * @param {ConditionContext} ctx
 */
const allHold = (conditions, ctx) => (conditions ?? []).every((condition) => evaluateCondition(condition, ctx));

/**
 * Index of the first condition in the list that does not hold, or -1.
 *
 * @param {any[]|undefined} conditions
 * @param {ConditionContext} ctx
 */
const firstFailing = (conditions, ctx) =>
    (conditions ?? []).findIndex((condition) => !evaluateCondition(condition, ctx));

module.exports = { evaluateCondition, allHold, firstFailing, compare, finite, durationBound };
