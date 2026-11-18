import type { Challenge, RankingEntry } from '../types/gurushots';
import type { ComparisonOp, EntryPredicate, RankingSelectorName, ScenarioSelector } from '../types/scenario';
import type { VoteHistory } from './speed';
/**
 * Entry selectors: which of the member's entries a scenario condition or
 * action means. Entries are matched by id (as strings), never by where they
 * sit in the list, except for the explicit `slot` selector, which uses the
 * same 1-4 / 0 = last addressing as the boost/turbo/swap slot settings.
 *
 * The original selectors (slot, memory, fastest, the ranking ones) break ties toward the entry listed first. Ranks of 0 or
 * below mean "unranked" and never win a rank comparison. The newer ones (id, pinned, pendingBoostTarget, newest, oldest,
 * slowest, matching) break ties by entry id, the lowest in plain string order, so the choice never depends on list order,
 * and a potentially winning entry whose comparison data cannot be read makes the selection unknown (resolveEntry), never a
 * guess.
 */

import { resolveEntryIndex } from '../voting/entrySlot';
import { isProtectedEntry } from '../voting/currencyAuto';
import { parseDuration } from './duration';
import { votesPerHour, DEFAULT_WINDOW_SEC } from './speed';
import { absent, allTruth, known, pending, unknownOf } from './valueState';
import type { ValueState, Verdict } from './valueState';

/**
 * The member's entries, or null when the challenge carries no readable entry list (an empty list is a readable one).
 */
const readableEntries = (challenge: Challenge): RankingEntry[] | null =>
    Array.isArray(challenge?.member?.ranking?.entries) ? challenge.member.ranking.entries.filter(Boolean) : null;

const entriesOf = (challenge: Challenge): RankingEntry[] => readableEntries(challenge) ?? [];

const votesOf = (entry: RankingEntry) => (Number.isFinite(Number(entry?.votes)) ? Number(entry.votes) : 0);

/** Positive rank, or null when unranked. */
const rankOf = (entry: RankingEntry) => {
    const rank = Number(entry?.rank);
    return Number.isFinite(rank) && rank > 0 ? rank : null;
};

/**
 * The comparison of two values of one kind.
 */
const compare = <T extends number | boolean | string>(a: T, op: ComparisonOp, b: T): boolean => {
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

/**
 * The entry with the best `score` (strictly greater wins, so ties keep the
 * first). Entries scoring null are skipped.
 */
const bestBy = <T>(entries: readonly T[], score: (entry: T) => number | null): T | null => {
    let best = null;
    let bestScore = -Infinity;
    for (const entry of entries) {
        const value = score(entry);
        if (value !== null && value > bestScore) {
            best = entry;
            bestScore = value;
        }
    }
    return best;
};

const RANKING: Record<RankingSelectorName, (entries: RankingEntry[]) => RankingEntry | null> = {
    mostVotes: (entries) => bestBy(entries, votesOf),
    fewestVotes: (entries) => bestBy(entries, (entry) => -votesOf(entry)),
    bestRank: (entries) =>
        bestBy(entries, (entry) => {
            const rank = rankOf(entry);
            return rank === null ? null : -rank;
        }),
    worstRank: (entries) => bestBy(entries, rankOf),
    boosted: (entries) => entries.find((entry) => entry.boosted === true || entry.boosting === true) ?? null,
    turbo: (entries) => entries.find((entry) => entry.turbo === true) ?? null,
};

/** The selectors that need no evidence beyond the entries, the memory and the vote history. */
type LegacySelector = Extract<ScenarioSelector, { by: 'slot' | 'memory' | 'fastest' | RankingSelectorName }>;

/** When each entry went in, by entry id (the entry-age ledger). */
type EntryTimes = { times: Readonly<Record<string, { at: number; exact: boolean }>> };

/**
 * What the evidence-reading selectors read: the photos the powers are pinned to, when each entry went in, and the photo a
 * fill-new boost is waiting on. A field the caller did not load reads as unknown ("not loaded").
 */
interface SelectEvidence {
    pins?: ValueState<{ boost: string | null; turbo: string | null }>;
    entryTimes?: ValueState<EntryTimes>;
    pendingBoost?: ValueState<{ id: string | null }>;
}

interface SelectContext {
    /** the scenario's remembered photo ids */
    memory?: Record<string, string>;
    /** sampled vote counts, for `fastest` */
    history?: VoteHistory;
    /** unix seconds, for `fastest` */
    now?: number;
}

/**
 * A duration field's seconds, or the default window. Validated upstream.
 */
const windowOf = (value: string | number | undefined) =>
    value === undefined ? DEFAULT_WINDOW_SEC : (parseDuration(value) as number);

/**
 * The entry a legacy selector picks, or null when none qualifies.
 */
const selectEntry = (
    selector: LegacySelector,
    challenge: Challenge,
    context: SelectContext = {},
): RankingEntry | null => {
    const entries = entriesOf(challenge);
    if (selector.by === 'memory') {
        const id = context.memory?.[selector.slot];
        return typeof id === 'string' ? (entries.find((entry) => String(entry.id) === id) ?? null) : null;
    }
    if (selector.by === 'slot') {
        const index = resolveEntryIndex(entries, selector.index);
        return index === null ? null : entries[index];
    }
    const candidates = selector.skipProtected ? entries.filter((entry) => !isProtectedEntry(entry)) : entries;
    if (selector.by === 'fastest') {
        const window = windowOf(selector.window);
        return bestBy(candidates, (entry) => votesPerHour(context.history, entry, context.now as number, window));
    }
    return RANKING[selector.by](candidates);
};

// --- the selectors that read evidence ---------------------------------------------------------------------------------

const idOf = (entry: RankingEntry): string => String(entry.id);

const PINS = 'entry-pins';
const AGES = 'entry-ages';
const PENDING_BOOST = 'entry-pending-boost';

const notLoaded = (dependency: string): ValueState<never> => unknownOf('evidence-not-loaded', [dependency]);

/** The entry with this id (as text), known; absent when the entries show none. */
const entryWithId = (entries: readonly RankingEntry[], id: string | null): ValueState<RankingEntry> => {
    const found = id === null ? undefined : entries.find((entry) => idOf(entry) === id);
    return found ? known(found) : absent('not-present');
};

/**
 * The best of `scored` by `prefer` (a negative result prefers its first argument); equal scores go to the lowest entry id.
 */
const bestScored = <T extends { entry: RankingEntry; score: number }>(
    scored: readonly T[],
    prefer: (a: number, b: number) => number,
): T | null =>
    scored.reduce<T | null>((best, item) => {
        if (best === null) return item;
        const order = prefer(item.score, best.score);
        return order < 0 || (order === 0 && idOf(item.entry) < idOf(best.entry)) ? item : best;
    }, null);

/** The recorded time of an entry: a positive finite instant, or null when none (or a malformed one) is recorded. */
const recordedTime = (times: EntryTimes['times'], entry: RankingEntry): { at: number; exact: boolean } | null => {
    const time: unknown = typeof times === 'object' && times !== null ? times[idOf(entry)] : undefined;
    if (typeof time !== 'object' || time === null) return null;
    const { at, exact } = time as { at?: unknown; exact?: unknown };
    return typeof at === 'number' && Number.isFinite(at) && at > 0 && typeof exact === 'boolean' ? { at, exact } : null;
};

/**
 * `newest` / `oldest`: the entry that went in last / first. `exact` compares exact times only; `observed` compares every
 * recorded time, an observed one being the time the app first saw the entry (the entry went in at or before it). An entry
 * whose time is not usable for the comparison but that could still win blocks the answer: unknown. An observed time bounds
 * an entry's true time from above, so such an entry can still be the newest only when its bound reaches the best exact time,
 * and can always be the oldest.
 */
const byEntryTime = (
    selector: Extract<ScenarioSelector, { by: 'newest' | 'oldest' }>,
    entries: readonly RankingEntry[],
    evidence: SelectEvidence,
): ValueState<RankingEntry> => {
    if (entries.length === 0) return absent('not-present');
    const ages = evidence.entryTimes ?? notLoaded(AGES);
    if (ages.state !== 'known') return ages;
    const newest = selector.by === 'newest';
    const timed = entries.map((entry) => ({ entry, time: recordedTime(ages.value.times, entry) }));
    const usable = timed.flatMap(({ entry, time }) =>
        time !== null && (selector.time === 'observed' || time.exact) ? [{ entry, score: time.at }] : [],
    );
    const best = bestScored(usable, (a, b) => (newest ? b - a : a - b));
    const usableIds = new Set(usable.map(({ entry }) => idOf(entry)));
    const couldWin = timed.some(({ entry, time }) => {
        if (usableIds.has(idOf(entry))) return false;
        // Only an observed time bounds the entry, and only for `newest`: the entry is no newer than its bound.
        return !(newest && time !== null && best !== null && time.at < best.score);
    });
    if (couldWin) return unknownOf('entry-age-unusable', [AGES]);
    // No entry could win but the usable ones, and there is at least one entry: so a best one exists.
    return known((best as NonNullable<typeof best>).entry);
};

/**
 * `slowest`: the entry with the fewest votes per hour over the window. An entry with no measurable speed could be the
 * slowest, so any of them makes the selection unknown.
 */
const bySlowest = (
    selector: Extract<ScenarioSelector, { by: 'slowest' }>,
    entries: readonly RankingEntry[],
    context: SelectContext,
): ValueState<RankingEntry> => {
    const candidates = selector.skipProtected ? entries.filter((entry) => !isProtectedEntry(entry)) : entries;
    if (candidates.length === 0) return absent('not-present');
    const window = windowOf(selector.window);
    const scored = candidates.map((entry) => ({
        entry,
        score: votesPerHour(context.history, entry, context.now as number, window),
    }));
    const measured = scored.flatMap(({ entry, score }) => (score === null ? [] : [{ entry, score }]));
    if (measured.length !== scored.length) return unknownOf('insufficient-history', ['vote-history']);
    return known((bestScored(measured, (a, b) => a - b) as (typeof measured)[number]).entry);
};

/** Reads one field of one entry (the fact registry's reader, which the caller binds to its snapshot). */
type ReadField = (field: EntryPredicate['field'], entry: RankingEntry) => ValueState<number | boolean>;

/** Whether an entry meets every predicate: known false as soon as one is, known true when all are, else unknown. */
const meetsAll = (entry: RankingEntry, where: readonly EntryPredicate[], read: ReadField): Verdict =>
    allTruth(
        where.map((predicate): Verdict => {
            const value = read(predicate.field, entry);
            if (value.state === 'known') return known(compare(value.value, predicate.op, predicate.value));
            return pending([value]);
        }),
    );

/**
 * `matching`: among the entries that meet every predicate, the first by the order and direction. An entry whose predicates
 * cannot be judged, or whose order key cannot be read, blocks the answer when it could be the winner.
 */
const byMatching = (
    selector: Extract<ScenarioSelector, { by: 'matching' }>,
    entries: readonly RankingEntry[],
    evidence: SelectEvidence,
    read: ReadField,
): ValueState<RankingEntry> => {
    const verdicts = entries.map((entry) => ({ entry, verdict: meetsAll(entry, selector.where, read) }));
    const matched = verdicts.filter(({ verdict }) => verdict.state === 'known' && verdict.value).map((v) => v.entry);
    const undecided = verdicts.flatMap(({ entry, verdict }) =>
        verdict.state === 'unknown' ? [{ entry, dependencies: verdict.dependencies }] : [],
    );
    if (matched.length === 0 && undecided.length === 0) return absent('not-present');
    let keyOf: (entry: RankingEntry) => number | null;
    if (selector.order === 'age') {
        const ages = evidence.entryTimes ?? notLoaded(AGES);
        if (ages.state !== 'known') return ages;
        // Ascending age is the newest first: the key is the instant, negated.
        keyOf = (entry) => {
            const time = recordedTime(ages.value.times, entry);
            return time === null ? null : -time.at;
        };
    } else {
        keyOf = selector.order === 'votes' ? votesOf : rankOf;
    }
    const sign = selector.direction === 'asc' ? 1 : -1;
    const keyed = matched.flatMap((entry) => {
        const key = keyOf(entry);
        return key === null ? [] : [{ entry, score: key }];
    });
    const best = bestScored(keyed, (a, b) => sign * (a - b));
    const threatens = (entry: RankingEntry): boolean => {
        const key = keyOf(entry);
        return key === null || best === null || sign * (key - best.score) <= 0;
    };
    const blocked = keyed.length !== matched.length || undecided.some(({ entry }) => threatens(entry));
    // Nothing blocks and something matched or might have: with no undecided entry left a matched one is the best.
    if (!blocked) return known((best as NonNullable<typeof best>).entry);
    const dependencies = undecided.filter(({ entry }) => threatens(entry)).flatMap((item) => item.dependencies);
    return unknownOf('entry-data-unreadable', ['member.ranking.entries', ...dependencies]);
};

/** A pinned or pending id the evidence carries: a text or null, else the evidence is malformed. */
const idEvidence = (value: unknown, dependency: string): ValueState<string | null> =>
    value === null || typeof value === 'string' ? known(value) : unknownOf('evidence-malformed', [dependency]);

/**
 * The entry a selector picks, as a value state: known; absent when the selector shows there is none; unknown when the entry
 * list cannot be read, evidence it needs is not loaded or not usable, or a potentially winning entry cannot be compared.
 * The original selectors answer as they always did (a `fastest` with no history to rank by is unknown).
 *
 * @param readField - one field of one entry, for `matching`
 */
const resolveEntry = (
    selector: ScenarioSelector,
    challenge: Challenge,
    context: SelectContext & { evidence?: SelectEvidence },
    readField: ReadField,
): ValueState<RankingEntry> => {
    const entries = readableEntries(challenge);
    if (entries === null) return unknownOf('entries-unreadable', ['member.ranking.entries']);
    const evidence = context.evidence ?? {};
    switch (selector.by) {
        case 'id':
            return entryWithId(entries, selector.id);
        case 'pinned': {
            const pins = evidence.pins ?? notLoaded(PINS);
            if (pins.state !== 'known') return pins;
            const pinned = idEvidence(pins.value[selector.power], PINS);
            return pinned.state === 'known' ? entryWithId(entries, pinned.value) : pinned;
        }
        case 'pendingBoostTarget': {
            const waiting = evidence.pendingBoost ?? notLoaded(PENDING_BOOST);
            if (waiting.state !== 'known') return waiting;
            const pending = idEvidence(waiting.value.id, PENDING_BOOST);
            return pending.state === 'known' ? entryWithId(entries, pending.value) : pending;
        }
        case 'newest':
        case 'oldest':
            return byEntryTime(selector, entries, evidence);
        case 'slowest':
            return bySlowest(selector, entries, context);
        case 'matching':
            return byMatching(selector, entries, evidence, readField);
        default: {
            const entry = selectEntry(selector, challenge, context);
            if (entry) return known(entry);
            return selector.by === 'fastest' && entries.length > 0
                ? unknownOf('insufficient-history', ['vote-history'])
                : absent('not-present');
        }
    }
};

export { selectEntry, resolveEntry, compare, entriesOf, readableEntries, rankOf, votesOf, windowOf };
export type { LegacySelector, ReadField, SelectContext, SelectEvidence, EntryTimes };
