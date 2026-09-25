// @ts-check
/**
 * Entry selectors: which of the member's entries a scenario condition or
 * action means. Entries are matched by id (as strings), never by where they
 * sit in the list, except for the explicit `slot` selector, which uses the
 * same 1-4 / 0 = last addressing as the boost/turbo/swap slot settings.
 *
 * Ties go to the entry listed first. Ranks of 0 or below mean "unranked" and
 * never win a rank comparison.
 */

const { resolveEntryIndex } = require('../voting/entrySlot');
const { isProtectedEntry } = require('../voting/currencyAuto');
const { parseDuration } = require('./duration');
const { votesPerHour, DEFAULT_WINDOW_SEC } = require('./speed');

/**
 * @param {any} challenge
 * @returns {any[]}
 */
const entriesOf = (challenge) =>
    Array.isArray(challenge?.member?.ranking?.entries) ? challenge.member.ranking.entries.filter(Boolean) : [];

/** @param {any} entry */
const votesOf = (entry) => (Number.isFinite(Number(entry?.votes)) ? Number(entry.votes) : 0);

/** Positive rank, or null when unranked. @param {any} entry */
const rankOf = (entry) => {
    const rank = Number(entry?.rank);
    return Number.isFinite(rank) && rank > 0 ? rank : null;
};

/**
 * The entry with the best `score` (strictly greater wins, so ties keep the
 * first). Entries scoring null are skipped.
 *
 * @param {any[]} entries
 * @param {(entry: any) => number|null} score
 */
const bestBy = (entries, score) => {
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

/** @type {Record<string, (entries: any[]) => any>} */
const RANKING = {
    mostVotes: (entries) => bestBy(entries, votesOf),
    fewestVotes: (entries) => bestBy(entries, (entry) => -votesOf(entry)),
    bestRank: (entries) =>
        bestBy(entries, (entry) => (rankOf(entry) === null ? null : -(/** @type {number} */ (rankOf(entry))))),
    worstRank: (entries) => bestBy(entries, rankOf),
    boosted: (entries) => entries.find((entry) => entry.boosted === true || entry.boosting === true) ?? null,
    turbo: (entries) => entries.find((entry) => entry.turbo === true) ?? null,
};

/**
 * @typedef {object} SelectContext
 * @property {Record<string, string>} [memory] - the scenario's remembered photo ids
 * @property {import('./speed').VoteHistory} [history] - sampled vote counts, for `fastest`
 * @property {number} [now] - unix seconds, for `fastest`
 */

/**
 * A duration field's seconds, or the default window. Validated upstream.
 *
 * @param {unknown} value
 */
const windowOf = (value) => (value === undefined ? DEFAULT_WINDOW_SEC : /** @type {number} */ (parseDuration(value)));

/**
 * The entry a selector picks, or null when none qualifies.
 *
 * @param {any} selector - a validated selector ({by, …})
 * @param {any} challenge
 * @param {SelectContext} [context]
 * @returns {any|null}
 */
const selectEntry = (selector, challenge, context = {}) => {
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
        return bestBy(candidates, (entry) =>
            votesPerHour(context.history, entry, /** @type {number} */ (context.now), window),
        );
    }
    return RANKING[selector.by](candidates);
};

module.exports = { selectEntry, entriesOf, rankOf, votesOf, windowOf };
