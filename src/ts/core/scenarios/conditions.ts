import type { RankingEntry } from '../types/gurushots';
import type {
    ComparisonOp,
    EntryCondition,
    EntryPredicate,
    FactName,
    NumericConditionType,
    ScenarioCondition,
} from '../types/scenario';
/**
 * Evaluates a scenario rule's conditions against the live challenge. Pure:
 * everything comes in through `ctx`.
 *
 * Every condition answers known true, known false, or unknown. Data the app
 * could not read — a missing close_time, an unreadable exposure, an unranked
 * entry, an unknown balance — makes the condition unknown, never false, and a
 * rule fires only on a known true result. The values are read through the same
 * registry readers (facts.ts) the expressions use, so one rule decides each.
 */

import { occurrencesOf } from '../scheduling/wallClock';
import { parseDuration } from './duration';
import {
    compare,
    compareValues,
    evaluateExpression,
    listTruth,
    presentTruth,
    absentTruth,
    allTruth,
    anyTruth,
    notTruth,
    known,
    unknownOf,
} from './expressions';
import { finite, readEntryFact, readEntryField, readNumericFact, readScenarioFact } from './facts';
import { readableEntries } from './selectors';
import { pending } from './valueState';

import type { ExpressionContext } from './expressions';
import type { ValueState, Verdict } from './valueState';

/** What a condition reads: the fact snapshot, and the settings reader when the snapshot owner supplies one. */
export type ConditionContext = ExpressionContext;

/**
 * A decided value as a verdict: known stays known, unknown stays unknown, absent (the value is confirmed not there)
 * leaves the condition unknown.
 */
const settle = <T>(state: ValueState<T>, decide: (value: T) => boolean): Verdict => {
    if (state.state === 'known') return known(decide(state.value));
    return state.state === 'absent' ? pending([state]) : state;
};

/**
 * `min <= value <= max` over the bounds that are set; unknown for an unknown value.
 */
const within = (state: ValueState<number>, min: number | null, max: number | null): Verdict =>
    settle(state, (value) => (min === null || value >= min) && (max === null || value <= max));

const durationBound = (bound: string | number | undefined) => (bound === undefined ? null : parseDuration(bound));

const numberBound = (bound: number | undefined) => (bound === undefined ? null : bound);

/**
 * The challenge-level numbers `{op, value}` conditions compare, and the facts that read them.
 */
const CHALLENGE_NUMBER_FACTS: Record<NumericConditionType, FactName> = {
    entries: 'challenge.entries',
    freeSlots: 'challenge.freeSlots',
    exposure: 'challenge.exposure',
    challengeRank: 'challenge.rank',
    challengeVotes: 'challenge.votes',
};

const BALANCE_FACTS: Record<'keys' | 'swaps' | 'fills' | 'coins', FactName> = {
    keys: 'balance.keys',
    swaps: 'balance.swaps',
    fills: 'balance.fills',
    coins: 'balance.coins',
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

const evaluateCondition = (condition: ScenarioCondition, ctx: ConditionContext): Verdict => {
    const { state, now } = ctx;
    switch (condition.type) {
        case 'dailyWindow':
            return known(inDailyWindow(condition, ctx.timezone, now));
        case 'beforeEnd':
            return within(
                readNumericFact('challenge.timeLeft', ctx),
                durationBound(condition.min),
                durationBound(condition.max),
            );
        case 'afterStart':
            return within(
                readNumericFact('challenge.elapsed', ctx),
                durationBound(condition.min),
                durationBound(condition.max),
            );
        case 'inPhaseFor':
            return within(
                readNumericFact('phase.elapsed', ctx),
                durationBound(condition.min),
                durationBound(condition.max),
            );
        case 'elapsedPercent':
            return within(
                readNumericFact('challenge.elapsedPercent', ctx),
                numberBound(condition.min),
                numberBound(condition.max),
            );
        case 'boostState':
        case 'turboState':
            return settle(
                readScenarioFact(condition.type === 'boostState' ? 'boost.state' : 'turbo.state', ctx),
                (value) => condition.in.includes(String(value)),
            );
        case 'balance':
            return settle(readNumericFact(BALANCE_FACTS[condition.currency], ctx), (value) =>
                compare(value, condition.op, condition.value),
            );
        case 'memorySet':
            return known(typeof state.memory?.[condition.slot] === 'string');
        case 'entry':
            return evaluateEntryCondition(condition, ctx);
        case 'compare':
            return compareValues(
                evaluateExpression(condition.left, ctx),
                condition.op,
                evaluateExpression(condition.right, ctx),
            );
        case 'present':
            return presentTruth(evaluateExpression(condition.value, ctx));
        case 'absent':
            return absentTruth(evaluateExpression(condition.value, ctx));
        case 'contains':
        case 'containsAny':
        case 'containsAll':
            return listTruth(
                condition.type,
                evaluateExpression(condition.list, ctx),
                evaluateExpression(condition.value, ctx),
            );
        case 'entriesWhere':
            return evaluateEntriesWhere(condition, ctx);
        case 'entryCount':
            return evaluateEntryCount(condition, ctx);
        case 'all':
            return allTruth(condition.of.map((item) => evaluateCondition(item, ctx)));
        case 'any':
            return anyTruth(condition.of.map((item) => evaluateCondition(item, ctx)));
        case 'not':
            return notTruth(evaluateCondition(condition.condition, ctx));
        default:
            return settle(readNumericFact(CHALLENGE_NUMBER_FACTS[condition.type], ctx), (value) =>
                compare(value, condition.op, condition.value),
            );
    }
};

const evaluateEntryCondition = (condition: EntryCondition, ctx: ConditionContext): Verdict =>
    settle(readEntryFact(condition.field, ctx, condition.select, condition.window), (value) =>
        compare(value, condition.op, condition.value),
    );

/**
 * Whether `count`, known only to lie in [low, high], satisfies `count op value` for every count in the range (true),
 * for none (false), or for some (null).
 */
const rangeHolds = (low: number, high: number, op: ComparisonOp, value: number): boolean | null => {
    switch (op) {
        case '<':
            return high < value ? true : low >= value ? false : null;
        case '<=':
            return high <= value ? true : low > value ? false : null;
        case '>':
            return low > value ? true : high <= value ? false : null;
        case '>=':
            return low >= value ? true : high < value ? false : null;
        default: {
            const equal = low === high ? low === value : value < low || value > high ? false : null;
            return op === '=' || equal === null ? equal : !equal;
        }
    }
};

/**
 * Whether one entry meets every predicate: known false as soon as one predicate is known false, known true when all are.
 */
const entryMeets = (entry: RankingEntry, where: readonly EntryPredicate[], ctx: ConditionContext) =>
    allTruth(
        where.map((predicate) =>
            settle(readEntryField(predicate.field, entry, ctx), (value) =>
                compare(value, predicate.op, predicate.value),
            ),
        ),
    );

/**
 * `entriesWhere`: whether any (or every) entry meets every predicate. An unreadable entry list is unknown; with no
 * entries, `any` is false and `all` is true. A known entry decides, as in any / all conditions.
 */
const evaluateEntriesWhere = (
    condition: Extract<ScenarioCondition, { type: 'entriesWhere' }>,
    ctx: ConditionContext,
): Verdict => {
    const entries = readableEntries(ctx.challenge);
    if (entries === null) return unknownOf('entries-unreadable', ['member.ranking.entries']);
    const verdicts = entries.map((entry) => entryMeets(entry, condition.where, ctx));
    return condition.quantifier === 'any' ? anyTruth(verdicts) : allTruth(verdicts);
};

/**
 * `entryCount`: how many of the member's entries meet every predicate. An unreadable entry list is unknown; entries that
 * cannot be judged leave the count a range, and the comparison is known only when every count in that range agrees.
 */
const evaluateEntryCount = (
    condition: Extract<ScenarioCondition, { type: 'entryCount' }>,
    ctx: ConditionContext,
): Verdict => {
    const entries = readableEntries(ctx.challenge);
    if (entries === null) return unknownOf('entries-unreadable', ['member.ranking.entries']);
    const verdicts = entries.map((entry) => entryMeets(entry, condition.where, ctx));
    const low = verdicts.filter((verdict) => verdict.state === 'known' && verdict.value).length;
    const undecided = verdicts.filter((verdict) => verdict.state === 'unknown');
    const holds = rangeHolds(low, low + undecided.length, condition.op, condition.value);
    return holds === null ? pending(undecided) : known(holds);
};

/**
 * The verdict of a rule's whole list: every condition must hold (an empty list holds).
 */
const conditionsTruth = (conditions: readonly ScenarioCondition[] | undefined, ctx: ConditionContext): Verdict =>
    allTruth((conditions ?? []).map((condition) => evaluateCondition(condition, ctx)));

/**
 * The first condition in the list that is not known true, with its verdict (known false or unknown), or null when
 * every one holds.
 */
const firstFailing = (
    conditions: readonly ScenarioCondition[] | undefined,
    ctx: ConditionContext,
): { index: number; truth: Verdict } | null => {
    for (const [index, condition] of (conditions ?? []).entries()) {
        const truth = evaluateCondition(condition, ctx);
        if (!(truth.state === 'known' && truth.value)) return { index, truth };
    }
    return null;
};

export { evaluateCondition, conditionsTruth, firstFailing, compare, finite, durationBound };
