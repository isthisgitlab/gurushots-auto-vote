// @ts-check
/**
 * Pure auto-join decision for one un-joined challenge: type/tag scope, the
 * join-timing window, and the coin caps. No I/O and no settings reads — the
 * caller resolves both. Part of the services/VotingLogic facade.
 */

// Mirrors MAX_JOIN_PERCENT_ELAPSED in settings/schema.js (which this
// renderer-bundle-safe module cannot import) — change both together.
const MAX_REACHABLE_PERCENT_ELAPSED = 99;

/**
 * Collapse the two join-timing settings into the ONE window that governs a
 * candidate.
 *
 * A candidate is never gated by both at once. `autoJoinAfterPercentElapsed`
 * wins whenever it is set, because it is the more specific instruction: it
 * names a point in the challenge's own life, while the hours window names a
 * distance from the end that means different things for a 2h flash and a 515h
 * exhibition. With percent off, the hours window applies unchanged, so every
 * pre-existing configuration keeps its exact behavior.
 *
 * @param {number} joinWithinSec seconds before close_time to start joining (0 = off)
 * @param {number} percentElapsed percent of the challenge's lifetime that must have run (0 = off)
 * @returns {{mode: 'percent'|'hours'|'off', value: number}}
 */
const resolveJoinWindow = (joinWithinSec, percentElapsed) => {
    const percent = Number(percentElapsed);
    if (Number.isFinite(percent) && percent > 0) {
        // Clamp to the latest REACHABLE fraction. 100% is only true once
        // close_time has passed, and joinWindowRefusal rejects an already-closed
        // candidate before it reads the fraction at all — so a corrupted 100 (or
        // 1000) must degrade to "as late as possible", never to "never join".
        return { mode: 'percent', value: Math.min(percent, MAX_REACHABLE_PERCENT_ELAPSED) };
    }
    const withinSec = Number(joinWithinSec);
    if (Number.isFinite(withinSec) && withinSec > 0) {
        return { mode: 'hours', value: withinSec };
    }
    return { mode: 'off', value: 0 };
};

/**
 * The join-window half of the auto-join decision, kept separate so the main
 * decision reads as one list of vetoes.
 *
 * Returns the refusal reason, or null when the window does not veto — either
 * because no window is set (both sentinels 0 = off: join as soon as seen) or
 * because the candidate is inside it.
 *
 * FAIL-CLOSED: a candidate that cannot prove it is inside the window (no
 * readable `close_time`, no readable clock, or already past its close) is
 * refused. "Join only near the end" must never degrade into "join now" on a
 * payload this could not read. Percent mode reads one field more —
 * `start_time`, to know how long the challenge runs — and is fail-closed on it
 * for the same reason: without a length, a percentage means nothing, and
 * guessing one would spend the entry at exactly the moment the setting exists
 * to avoid.
 *
 * @param {{close_time?: number, start_time?: number}} challenge
 * @param {number} joinWithinSec seconds before close_time to start joining (0 = off)
 * @param {number} nowSec current time in epoch SECONDS (close_time's unit)
 * @param {number} percentElapsed percent of the challenge's lifetime that must have run (0 = off)
 * @returns {string|null}
 */
const joinWindowRefusal = (challenge, joinWithinSec, nowSec, percentElapsed) => {
    const window = resolveJoinWindow(joinWithinSec, percentElapsed);
    if (window.mode === 'off') return null;

    const closeTime = Number(challenge?.close_time);
    const now = Number(nowSec);
    if (!Number.isFinite(closeTime) || closeTime <= 0 || !Number.isFinite(now) || now <= 0) {
        return 'close-time-unknown';
    }
    const secondsLeft = closeTime - now;
    // Already closed (a stale entry in the open list) — joining would burn a
    // submission on a dead challenge.
    if (secondsLeft <= 0) return 'already-closed';

    if (window.mode === 'percent') {
        const startTime = Number(challenge?.start_time);
        if (!Number.isFinite(startTime) || startTime <= 0) return 'start-time-unknown';
        const durationSec = closeTime - startTime;
        // A non-positive duration is a nonsensical payload (start at or after
        // close); there is no fraction to compute, so refuse rather than divide.
        if (durationSec <= 0) return 'start-time-unknown';
        // Clamp below at 0 so a challenge whose start_time is in the future
        // (clock skew) reads as 0% elapsed rather than negative.
        const elapsedPct = (Math.max(0, now - startTime) / durationSec) * 100;
        return elapsedPct < window.value ? 'too-early' : null;
    }

    return secondsLeft > window.value ? 'too-early' : null;
};

/**
 * Why a candidate's type/tag scope refuses the join, or null when it is in scope.
 *
 * Default is join everything; a non-empty include list narrows; the exclude list
 * always subtracts. Types and challenge tags are two independent axes and BOTH
 * must pass.
 *
 * @param {string} type normalized lowercase challenge type ('' = none)
 * @param {string[]} tags normalized lowercase challenge tags
 * @param {{includeTypes: string[], excludeTypes: string[], includeTags: string[], excludeTags: string[]}} filters
 * @returns {string|null}
 */
const joinScopeRefusal = (type, tags, { includeTypes, excludeTypes, includeTags, excludeTags }) => {
    if (Array.isArray(excludeTypes) && type !== '' && excludeTypes.includes(type)) {
        return 'excluded-type';
    }
    const hasIncludeFilter = Array.isArray(includeTypes) && includeTypes.length > 0;
    if (hasIncludeFilter && !(type !== '' && includeTypes.includes(type))) {
        return 'out-of-scope';
    }
    if (Array.isArray(excludeTags) && excludeTags.some((tag) => tags.includes(tag))) {
        return 'excluded-tag';
    }
    const hasTagFilter = Array.isArray(includeTags) && includeTags.length > 0;
    // A challenge with NO tags can never satisfy a require-list, the same
    // way a typeless one cannot satisfy an include-list.
    if (hasTagFilter && !includeTags.some((tag) => tags.includes(tag))) {
        return 'tag-out-of-scope';
    }
    return null;
};

/**
 * Why a PAID join (cost > 0) is refused, or null when it may spend.
 *
 * @param {number} needsCoins positive join cost
 * @param {{coins?: number}|null} bankroll live balance, or null if unread
 * @param {number} maxCoins per-challenge coin cap (0 = free only)
 * @param {number} remainingBudget coins still spendable this cycle
 * @returns {string|null}
 */
const paidJoinRefusal = (needsCoins, bankroll, maxCoins, remainingBudget) => {
    if (!Number.isFinite(maxCoins) || maxCoins <= 0) return 'paid-disabled';
    if (needsCoins > maxCoins) return 'over-per-challenge-cap';
    // Fail-safe: unknown balance never spends.
    const coins = Number(bankroll?.coins);
    if (bankroll == null || !Number.isFinite(coins)) return 'balance-unknown';
    if (coins < needsCoins) return 'insufficient-coins';
    if (!Number.isFinite(remainingBudget) || needsCoins > remainingBudget) return 'over-cycle-budget';
    return null;
};

/**
 * @param {{type?: string, tags?: string[]}|undefined} challenge
 * @returns {{type: string, tags: string[]}} lowercase-trimmed type ('' = none) and string tags
 */
const normalizeJoinFacets = (challenge) => ({
    type: typeof challenge?.type === 'string' ? challenge.type.trim().toLowerCase() : '',
    tags: Array.isArray(challenge?.tags)
        ? challenge.tags.filter((tag) => typeof tag === 'string').map((tag) => tag.trim().toLowerCase())
        : [],
});

/**
 * Pure decision for whether to auto-join ONE un-joined challenge.
 *
 * No I/O: the caller resolves settings (by title-profile) and the live bankroll
 * first, then passes the results in. `join_coins` is read from the candidate
 * itself. COINS is the only join currency handled; a candidate whose cost is
 * non-positive is treated as free.
 *
 * Scope (once auto-join is enabled): the DEFAULT is join everything. An
 * `includeTypes` list, when non-empty, narrows to just those types.
 * `excludeTypes` subtracts. A title-profile match is a deliberate per-title
 * opt-in that bypasses both the exclude veto and any include narrowing, so a
 * profiled title still joins even if its type is excluded or not in the include
 * list. So "join all EXCEPT flash and exhibition" = exclude `flash,exhibition`
 * with no include list.
 *
 * Timing comes from two `0 = off` settings that resolve to ONE window
 * (`resolveJoinWindow`): `joinWithinSec` joins a candidate once it is within
 * that many seconds of its own `close_time`, while `joinAfterPercentElapsed`
 * joins it once that percentage of its own lifetime has run. Percent wins when
 * both are set. Either way entries land late in a challenge's life instead of
 * the moment it appears. Unlike the
 * type filters, a title match does NOT bypass this — the window is itself a
 * deliberate per-title instruction, so bypassing it would invert the user's
 * intent. It is a pure gate on WHEN: it never looks at cost, and the coin caps
 * below still decide whether a paid join happens at all.
 *
 * Timing is FAIL-CLOSED. A candidate that cannot prove it is inside the window
 * (`close_time` missing, unparseable, or already past) is not joined while a
 * window is set. "Join only near the end" must never degrade into "join now" on
 * a payload the caller could not read — that is precisely the spend the setting
 * exists to prevent. With `joinWithinSec` 0 the field is not read at all, so a
 * missing `close_time` never blocks a join-as-soon-as-seen candidate.
 *
 * Fail-safe on money: a null `bankroll` (balance could not be read) blocks every
 * paid join but still allows free joins. Both coin caps use the `0 = off`
 * sentinel — paid joins require `maxCoins > 0` AND `remainingBudget >= cost`.
 *
 * @param {object} params
 * @param {{id?: string|number, type?: string, join_coins?: number, close_time?: number, tags?: string[]}} params.challenge
 * @param {{coins?: number}|null} params.bankroll live balance, or null if unread
 * @param {number} params.remainingBudget coins still spendable this cycle (0 = paid off)
 * @param {string[]} params.includeTypes normalized lowercase types from `autoJoinTypes`; EMPTY = all types
 * @param {string[]} params.excludeTypes normalized lowercase types from `autoJoinExcludeTypes`; a match vetoes the join (unless a title-profile matches)
 * @param {number} params.maxCoins per-challenge coin cap (0 = free only)
 * @param {boolean} params.hasProfileMatch a title rule/profile matched this title — a deliberate opt-in that bypasses the exclude veto and include narrowing
 * @param {string[]} [params.includeTags] normalized lowercase CHALLENGE tags from `autoJoinChallengeTags`; EMPTY = any
 * @param {string[]} [params.excludeTags] normalized lowercase CHALLENGE tags from `autoJoinExcludeChallengeTags`; any match vetoes the join
 * @param {number} [params.joinWithinSec] join only within this many seconds of `close_time` (0/absent = off)
 * @param {number} [params.nowSec] current time in epoch SECONDS (matches `close_time`'s unit); required when `joinWithinSec` > 0
 * @param {number} [params.joinAfterPercentElapsed] join only once this percent of the candidate's lifetime (`close_time` - `start_time`) has elapsed (0/absent = off); wins over `joinWithinSec` when both are set
 * @returns {{join: boolean, needsCoins: number, reason: string}}
 */
const shouldJoinChallenge = ({
    challenge,
    bankroll,
    remainingBudget,
    includeTypes,
    excludeTypes,
    maxCoins,
    hasProfileMatch,
    includeTags = [],
    excludeTags = [],
    joinWithinSec = 0,
    nowSec = 0,
    joinAfterPercentElapsed = 0,
}) => {
    const rawCost = Number(challenge?.join_coins);
    const needsCoins = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : 0;

    // A saved title profile is a deliberate per-title opt-in and wins over the
    // general type/tag filters (bypasses exclude + include narrowing).
    if (hasProfileMatch !== true) {
        const { type, tags } = normalizeJoinFacets(challenge);
        const scopeRefusal = joinScopeRefusal(type, tags, { includeTypes, excludeTypes, includeTags, excludeTags });
        if (scopeRefusal) return { join: false, needsCoins, reason: scopeRefusal };
    }

    // Timing window, after the scope filters (so an out-of-scope candidate still
    // reports WHY it is out of scope) and before the cost branch (timing gates
    // free and paid candidates identically). Deliberately NOT bypassed by
    // hasProfileMatch — see the header.
    const timingRefusal = joinWindowRefusal(challenge, joinWithinSec, nowSec, joinAfterPercentElapsed);
    if (timingRefusal) {
        return { join: false, needsCoins, reason: timingRefusal };
    }

    if (needsCoins <= 0) {
        return { join: true, needsCoins: 0, reason: 'free' };
    }

    const costRefusal = paidJoinRefusal(needsCoins, bankroll, maxCoins, remainingBudget);
    if (costRefusal) return { join: false, needsCoins, reason: costRefusal };
    return { join: true, needsCoins, reason: 'paid' };
};

module.exports = {
    shouldJoinChallenge,
    resolveJoinWindow,
};
