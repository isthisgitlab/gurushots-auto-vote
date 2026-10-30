/**
 * Pure auto-join decision for one un-joined challenge: type/tag scope, the
 * join-timing window, the capacity/price-readable guard for a fresh join, and
 * the coin caps. No I/O and no settings reads — the
 * caller resolves both. Part of the services/VotingLogic facade.
 */

// Mirrors MAX_JOIN_PERCENT_ELAPSED in settings/schema/validators.ts (which this
// renderer-bundle-safe module cannot import) — change both together.
const MAX_REACHABLE_PERCENT_ELAPSED = 99;

/**
 * The one clamp both after-start readers share: an offset at or beyond the
 * challenge's own length degrades to the latest REACHABLE point (99% of the
 * run — the seconds form of MAX_REACHABLE_PERCENT_ELAPSED), never to "never
 * join". `joinWindowRefusal` joins against it; `joinAfterStartClampSec`
 * reports it, so the join pass can note the reduction.
 */
const clampAfterStartOffsetSec = (offsetSec: number, durationSec: number): number =>
    Math.min(offsetSec, (MAX_REACHABLE_PERCENT_ELAPSED / 100) * durationSec);

/**
 * Collapse the three join-timing settings into the ONE window that governs a
 * candidate.
 *
 * A candidate is never gated by more than one at once. The settings are read in
 * a fixed order — after-start (seconds since the challenge's own `start_time`),
 * then percent elapsed, then hours before end — and the FIRST with a value
 * above 0 applies, each being the more specific instruction than the ones below
 * it. The settings schema resolves the three as one group upstream
 * (`resolveRuleSettingGroup` in settings/titleRules.ts), so no source can
 * contribute a second window on top of the winning one; each sentinel stays
 * `0 = off`.
 *
 * @param joinAfterSecFromStart seconds after start_time to wait before joining (0 = off)
 * @param joinWithinSec seconds before close_time to start joining (0 = off)
 * @param percentElapsed percent of the challenge's lifetime that must have run (0 = off)
 */
const resolveJoinWindow = (
    joinAfterSecFromStart: number,
    joinWithinSec: number,
    percentElapsed: number,
): { mode: 'afterStart' | 'percent' | 'hours' | 'off'; value: number } => {
    if (Number.isFinite(joinAfterSecFromStart) && joinAfterSecFromStart > 0) {
        return { mode: 'afterStart', value: joinAfterSecFromStart };
    }
    if (Number.isFinite(percentElapsed) && percentElapsed > 0) {
        // Clamp to the latest REACHABLE fraction. 100% is only true once
        // close_time has passed, and joinWindowRefusal rejects an already-closed
        // candidate before it reads the fraction at all — so a corrupted 100 (or
        // 1000) must degrade to "as late as possible", never to "never join".
        return { mode: 'percent', value: Math.min(percentElapsed, MAX_REACHABLE_PERCENT_ELAPSED) };
    }
    if (Number.isFinite(joinWithinSec) && joinWithinSec > 0) {
        return { mode: 'hours', value: joinWithinSec };
    }
    return { mode: 'off', value: 0 };
};

/**
 * The join-window half of the auto-join decision, kept separate so the main
 * decision reads as one list of vetoes.
 *
 * Returns the refusal reason, or null when the window does not veto — either
 * because no window is set (every sentinel 0 = off: join as soon as seen) or
 * because the candidate is inside it.
 *
 * FAIL-CLOSED: a candidate that cannot prove it is inside the window (no
 * readable `close_time`, no readable clock, or already past its close) is
 * refused. "Join only near the end" must never degrade into "join now" on a
 * payload this could not read. Percent mode reads one field more —
 * `start_time`, to know how long the challenge runs — and is fail-closed on it
 * for the same reason: without a length, a percentage means nothing, and
 * guessing one would spend the entry at exactly the moment the setting exists
 * to avoid. The after-start window anchors on that same `start_time` and is
 * fail-closed on it identically: without it there is nothing to measure the
 * wait against.
 *
 * @param joinWithinSec seconds before close_time to start joining (0 = off)
 * @param nowSec current time in epoch SECONDS (close_time's unit)
 * @param percentElapsed percent of the challenge's lifetime that must have run (0 = off)
 * @param joinAfterSecFromStart seconds after start_time to wait before joining (0 = off)
 */
const joinWindowRefusal = (
    challenge: { close_time?: number; start_time?: number },
    joinWithinSec: number,
    nowSec: number,
    percentElapsed: number,
    joinAfterSecFromStart: number,
): string | null => {
    const window = resolveJoinWindow(joinAfterSecFromStart, joinWithinSec, percentElapsed);
    if (window.mode === 'off') return null;

    const closeTime = Number(challenge?.close_time);
    if (!Number.isFinite(closeTime) || closeTime <= 0 || !Number.isFinite(nowSec) || nowSec <= 0) {
        return 'close-time-unknown';
    }
    const secondsLeft = closeTime - nowSec;
    // Already closed (a stale entry in the open list) — joining would burn a
    // submission on a dead challenge.
    if (secondsLeft <= 0) return 'already-closed';

    if (window.mode === 'afterStart') {
        const startTime = Number(challenge?.start_time);
        if (!Number.isFinite(startTime) || startTime <= 0) return 'start-time-unknown';
        const durationSec = closeTime - startTime;
        // A non-positive duration is a nonsensical payload (start at or after
        // close); there is no anchor to measure the wait from, so refuse.
        if (durationSec <= 0) return 'start-time-unknown';
        // Clamp to the latest REACHABLE point — the same ceiling as percent
        // mode: a value at or beyond the challenge's own length must degrade
        // to "as late as possible", never to "never join".
        // Deliberately NO clamp at 0 on the elapsed side: a start_time in the
        // future (clock skew) gives negative elapsed, below any positive
        // offset — 'too-early', never a join.
        const elapsedSec = nowSec - startTime;
        return elapsedSec < clampAfterStartOffsetSec(window.value, durationSec) ? 'too-early' : null;
    }

    if (window.mode === 'percent') {
        const startTime = Number(challenge?.start_time);
        if (!Number.isFinite(startTime) || startTime <= 0) return 'start-time-unknown';
        const durationSec = closeTime - startTime;
        // A non-positive duration is a nonsensical payload (start at or after
        // close); there is no fraction to compute, so refuse rather than divide.
        if (durationSec <= 0) return 'start-time-unknown';
        // Clamp below at 0 so a challenge whose start_time is in the future
        // (clock skew) reads as 0% elapsed rather than negative.
        const elapsedPct = (Math.max(0, nowSec - startTime) / durationSec) * 100;
        return elapsedPct < window.value ? 'too-early' : null;
    }

    return secondsLeft > window.value ? 'too-early' : null;
};

/**
 * The after-start offset AFTER the clamp, but only when the clamp reduced it —
 * null otherwise. The join pass logs its clamp note only on a non-null result,
 * so this is a read over `joinWindowRefusal`'s exact math, never a second
 * implementation of it (both call `clampAfterStartOffsetSec`).
 *
 * Non-null requires the after-start window to be the active gate — a value
 * above 0 IS after-start mode, the first timing key above 0 winning — and the
 * candidate still open: every state where `joinWindowRefusal` refuses before
 * consulting the offset ('close-time-unknown', 'already-closed',
 * 'start-time-unknown') reads as null here, and so does a value the clamp
 * left alone.
 *
 * @param challenge the candidate, read for `close_time`/`start_time` only
 * @param nowSec current time in epoch SECONDS (close_time's unit)
 * @param joinAfterSecFromStart seconds after start_time to wait before joining (0 = off)
 * @returns the clamped offset in seconds, or null when nothing was reduced
 */
const joinAfterStartClampSec = (
    challenge: { close_time?: number; start_time?: number },
    nowSec: number,
    joinAfterSecFromStart: number,
): number | null => {
    if (!Number.isFinite(joinAfterSecFromStart) || joinAfterSecFromStart <= 0) return null;
    const closeTime = Number(challenge?.close_time);
    if (!Number.isFinite(closeTime) || closeTime <= 0 || !Number.isFinite(nowSec) || nowSec <= 0) return null;
    // Already closed: the gate reports 'already-closed' and never reads the offset.
    if (closeTime <= nowSec) return null;
    const startTime = Number(challenge?.start_time);
    if (!Number.isFinite(startTime) || startTime <= 0) return null;
    const durationSec = closeTime - startTime;
    if (durationSec <= 0) return null;
    const clamped = clampAfterStartOffsetSec(joinAfterSecFromStart, durationSec);
    return clamped < joinAfterSecFromStart ? clamped : null;
};

/**
 * Why a candidate's type/tag scope refuses the join, or null when it is in scope.
 *
 * Default is join everything; a non-empty include list narrows; the exclude list
 * always subtracts. Types and challenge tags are two independent axes and BOTH
 * must pass.
 *
 * @param type normalized lowercase challenge type ('' = none)
 * @param tags normalized lowercase challenge tags
 */
const joinScopeRefusal = (
    type: string,
    tags: string[],
    {
        includeTypes,
        excludeTypes,
        includeTags,
        excludeTags,
    }: { includeTypes: string[]; excludeTypes: string[]; includeTags: string[]; excludeTags: string[] },
): string | null => {
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
 * @param needsCoins positive join cost
 * @param bankroll live balance, or null if unread
 * @param maxCoins per-challenge coin cap (0 = free only)
 * @param remainingBudget coins still spendable this cycle
 */
const paidJoinRefusal = (
    needsCoins: number,
    bankroll: { coins?: number } | null,
    maxCoins: number,
    remainingBudget: number,
): string | null => {
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
 * Why a FRESH join of this challenge is refused on the listing itself, or null
 * when it may go ahead. Two facts about the challenge — independent of the
 * user's money settings — block a join that would otherwise burn a submit or
 * a spend:
 *
 *   full           — `max_players` is set (0 or absent = no cap) and `players`
 *                    has reached it.
 *   price-unknown  — the member still owes the unlock (`submit_state` is
 *                    'join_unlock') but `join_coins` is not a positive
 *                    integer, so there is no price to consent to; or the price
 *                    reads as a positive fraction (any `submit_state`), which
 *                    no unlock priced in whole coins can cost. A free 'join'
 *                    state is refused only at such a fractional price.
 *
 * This guards a join that would still SPEND something. A paid retry — coins
 * already spent, only the submit left — ALWAYS takes precedence and is never
 * blocked, so a paid unlock is never stranded: every caller gates this on its
 * own retry knowledge (`alreadyPaid`, `retryOnly`, or the claim check that
 * keeps `priceHolds` off retry submits).
 */
const joinFreshRefusal = (
    challenge:
        | {
              players?: number;
              max_players?: number;
              join_coins?: number;
              member?: { submit_state?: string };
          }
        | undefined,
): 'full' | 'price-unknown' | null => {
    const maxPlayers = Number(challenge?.max_players);
    const players = Number(challenge?.players);
    if (Number.isFinite(maxPlayers) && maxPlayers > 0 && Number.isFinite(players) && players >= maxPlayers) {
        return 'full';
    }
    const price = Number(challenge?.join_coins);
    // A positive fraction is no price to consent to, whatever the submit state.
    if (Number.isFinite(price) && price > 0 && !Number.isInteger(price)) return 'price-unknown';
    if (challenge?.member?.submit_state === 'join_unlock') {
        if (!Number.isInteger(price) || price <= 0) return 'price-unknown';
    }
    return null;
};

/**
 * The human-readable why for a `joinFreshRefusal` reason, so every site that
 * reports one (the auto pass's skip note, the manual join, the pre-unlock price
 * check) words it identically in the log and the CLI.
 *
 * @param refusal a `joinFreshRefusal` reason
 */
const joinFreshRefusalWhy = (refusal: 'full' | 'price-unknown'): string =>
    refusal === 'full' ? 'it is full (max players reached)' : 'its price could not be read as a usable price';

/**
 * @returns lowercase-trimmed type ('' = none) and string tags
 */
const normalizeJoinFacets = (
    challenge: { type?: string; tags?: string[] } | undefined,
): { type: string; tags: string[] } => ({
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
 * Timing comes from three `0 = off` settings that resolve to ONE window
 * (`resolveJoinWindow`), read in a fixed order — the first above 0 applies:
 * `joinAfterSecFromStart` joins a candidate once that many seconds have run
 * since its own `start_time`, `joinAfterPercentElapsed` once that percentage
 * of its own lifetime has run, and `joinWithinSec` once it is within that many
 * seconds of its own `close_time`. The settings schema resolves the three as
 * one group upstream (`resolveRuleSettingGroup` in settings/titleRules.ts), so
 * they never combine into the intersection of two windows. An offset at or
 * beyond the challenge's own length clamps to the latest reachable point (99%
 * of the run), never to "never join". Either way entries land late in a
 * challenge's life instead of the moment it appears. Unlike the
 * type filters, a title match does NOT bypass this — the window is itself a
 * deliberate per-title instruction, so bypassing it would invert the user's
 * intent. It is a pure gate on WHEN: it never looks at cost, and the coin caps
 * below still decide whether a paid join happens at all.
 *
 * Timing is FAIL-CLOSED. A candidate that cannot prove it is inside the window
 * (`close_time` missing, unparseable, or already past; for the percent and
 * after-start anchors also a `start_time` that cannot be read) is not joined
 * while a window is set. "Join only near the end" must never degrade into
 * "join now" on a payload the caller could not read — that is precisely the
 * spend the setting exists to prevent. With every timing sentinel 0 the fields
 * are not read at all, so a missing `close_time` never blocks a
 * join-as-soon-as-seen candidate.
 *
 * Fail-safe on money: a null `bankroll` (balance could not be read) blocks every
 * paid join but still allows free joins. Both coin caps use the `0 = off`
 * sentinel — paid joins require `maxCoins > 0` AND `remainingBudget >= cost`.
 *
 * Capacity and price readability are vetoes too, for a FRESH join only
 * (`joinFreshRefusal`): a full challenge, or one that still owes an unlock
 * (`submit_state` 'join_unlock') whose price is not a readable positive
 * integer — or whose price reads as a positive fraction on any state — is
 * never joined fresh; there is nothing to submit into, or no price to consent
 * to. A paid RETRY (`alreadyPaid`) always takes precedence and is never
 * blocked, so a paid unlock is never stranded.
 *
 * @param params.bankroll live balance, or null if unread
 * @param params.remainingBudget coins still spendable this cycle (0 = paid off)
 * @param params.includeTypes normalized lowercase types from `autoJoinTypes`; EMPTY = all types
 * @param params.excludeTypes normalized lowercase types from `autoJoinExcludeTypes`; a match vetoes the join (unless a title-profile matches)
 * @param params.maxCoins per-challenge coin cap (0 = free only)
 * @param params.hasProfileMatch a title rule/profile matched this title — a deliberate opt-in that bypasses the exclude veto and include narrowing
 * @param params.includeTags normalized lowercase CHALLENGE tags from `autoJoinChallengeTags`; EMPTY = any
 * @param params.excludeTags normalized lowercase CHALLENGE tags from `autoJoinExcludeChallengeTags`; any match vetoes the join
 * @param params.joinAfterSecFromStart join only once this many seconds have run since the candidate's `start_time` (0 = off); first in the timing order, ahead of the other two
 * @param params.joinWithinSec join only within this many seconds of `close_time` (0/absent = off)
 * @param params.nowSec current time in epoch SECONDS (matches `close_time`'s unit); required when any timing window is set
 * @param params.alreadyPaid this account already spent the coins (an unlock marker): the cost checks are skipped, the join only submits
 * @param params.joinAfterPercentElapsed join only once this percent of the candidate's lifetime (`close_time` - `start_time`) has elapsed (0/absent = off)
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
    joinAfterSecFromStart,
    joinWithinSec = 0,
    nowSec = 0,
    joinAfterPercentElapsed = 0,
    alreadyPaid = false,
}: {
    challenge: {
        id?: string | number;
        type?: string;
        join_coins?: number;
        close_time?: number;
        start_time?: number;
        tags?: string[];
        players?: number;
        max_players?: number;
        member?: { submit_state?: string };
    };
    bankroll: { coins?: number } | null;
    remainingBudget: number;
    includeTypes: string[];
    excludeTypes: string[];
    maxCoins: number;
    hasProfileMatch: boolean;
    includeTags?: string[];
    excludeTags?: string[];
    joinAfterSecFromStart: number;
    joinWithinSec?: number;
    nowSec?: number;
    joinAfterPercentElapsed?: number;
    alreadyPaid?: boolean;
}): { join: boolean; needsCoins: number; reason: string } => {
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
    const timingRefusal = joinWindowRefusal(
        challenge,
        joinWithinSec,
        nowSec,
        joinAfterPercentElapsed,
        joinAfterSecFromStart,
    );
    if (timingRefusal) {
        return { join: false, needsCoins, reason: timingRefusal };
    }

    // Capacity and price readability, after the timing window and before the
    // cost branch: a FRESH join of a full challenge — or of one whose unlock
    // price cannot be read — is refused, while a paid RETRY (alreadyPaid)
    // always takes precedence and is never blocked.
    if (!alreadyPaid) {
        const freshRefusal = joinFreshRefusal(challenge);
        if (freshRefusal) return { join: false, needsCoins, reason: freshRefusal };
    }

    if (needsCoins <= 0) {
        return { join: true, needsCoins: 0, reason: 'free' };
    }

    // Coins already spent on it: the join only submits, so the cost, the cap and the budget have no say.
    if (alreadyPaid) return { join: true, needsCoins, reason: 'already-paid' };

    const costRefusal = paidJoinRefusal(needsCoins, bankroll, maxCoins, remainingBudget);
    if (costRefusal) return { join: false, needsCoins, reason: costRefusal };
    return { join: true, needsCoins, reason: 'paid' };
};

export { shouldJoinChallenge, joinFreshRefusal, joinFreshRefusalWhy, joinAfterStartClampSec };
