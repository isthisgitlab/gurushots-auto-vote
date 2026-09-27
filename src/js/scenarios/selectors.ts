import type { Challenge, RankingEntry } from '../types/gurushots';
import type { RankingSelectorName, ScenarioSelector } from '../types/scenario';
import type { VoteHistory } from './speed';
/**
 * Entry selectors: which of the member's entries a scenario condition or
 * action means. Entries are matched by id (as strings), never by where they
 * sit in the list, except for the explicit `slot` selector, which uses the
 * same 1-4 / 0 = last addressing as the boost/turbo/swap slot settings.
 *
 * Ties go to the entry listed first. Ranks of 0 or below mean "unranked" and
 * never win a rank comparison.
 */

import { resolveEntryIndex } from '../voting/entrySlot';
import { isProtectedEntry } from '../voting/currencyAuto';
import { parseDuration } from './duration';
import { votesPerHour, DEFAULT_WINDOW_SEC } from './speed';

const entriesOf = (challenge: Challenge): RankingEntry[] =>
    Array.isArray(challenge?.member?.ranking?.entries) ? challenge.member.ranking.entries.filter(Boolean) : [];

const votesOf = (entry: RankingEntry) => (Number.isFinite(Number(entry?.votes)) ? Number(entry.votes) : 0);

/** Positive rank, or null when unranked. */
const rankOf = (entry: RankingEntry) => {
    const rank = Number(entry?.rank);
    return Number.isFinite(rank) && rank > 0 ? rank : null;
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
 * The entry a selector picks, or null when none qualifies.
 */
const selectEntry = (
    selector: ScenarioSelector,
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

export { selectEntry, entriesOf, rankOf, votesOf, windowOf };
