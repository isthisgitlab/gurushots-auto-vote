// @ts-check
/**
 * Availability predicates for the three bankroll-currency actions a member can
 * spend on a challenge — KEYS (unlock a locked boost), SWAPS (replace an entered
 * photo) and FILLS (top exposure up to 100%). Shared by the renderer (which
 * buttons to show), the IPC handlers (main-side re-validation against the LIVE
 * challenge before anything is spent) and any future automation.
 *
 * Pure — no Node, no services — so it is safe in every host including the
 * WebView bundle. Every per-challenge read is optional-chained: these run on
 * every card render, and a partial payload must hide a button, never throw.
 */

/**
 * Outcome codes shared by service, IPC, CLI and renderer so every user-facing
 * message maps through one translated table.
 */
const CURRENCY_OUTCOME = Object.freeze({
    ok: 'ok',
    needsConfirm: 'needs-confirm',
    notAvailable: 'not-available',
    noBalance: 'no-balance',
    balanceUnknown: 'balance-unknown',
    noAlternative: 'no-alternative',
    staleCandidate: 'stale-candidate',
    busy: 'busy',
    invalidArgs: 'invalid-args',
    apiFailed: 'api-failed',
});

/** Bankroll field each action spends. */
const CURRENCY_FIELD = Object.freeze({ key: 'keys', swap: 'swaps', fill: 'fills' });

/**
 * @param {any} challenge
 * @param {number} nowSec - Unix seconds
 * @returns {boolean}
 */
const isRunning = (challenge, nowSec) => {
    const start = Number(challenge?.start_time);
    const close = Number(challenge?.close_time);
    if (!Number.isFinite(start) || !Number.isFinite(close)) return false;
    return start <= nowSec && close > nowSec;
};

/**
 * @param {any} bankroll
 * @param {'key'|'swap'|'fill'} action
 * @returns {boolean}
 */
const hasBalance = (bankroll, action) => Number(bankroll?.[CURRENCY_FIELD[action]]) > 0;

/**
 * Challenge-side conditions only (no balance) — the part the live re-check needs
 * to tell "state already changed" apart from "out of currency".
 *
 * @param {'key'|'swap'|'fill'} action
 * @param {any} challenge
 * @param {number} nowSec
 * @returns {boolean}
 */
const challengeAllows = (action, challenge, nowSec) => {
    if (!isRunning(challenge, nowSec)) return false;
    if (action === 'key') {
        return challenge?.boost_enable === true && challenge?.member?.boost?.state === 'LOCKED';
    }
    if (action === 'swap') {
        return challenge?.swap_enable === true && challenge?.swap_locked !== true;
    }
    const exposure = Number(challenge?.member?.ranking?.exposure?.exposure_factor ?? 100);
    return challenge?.fill_enable === true && challenge?.fill_locked !== true && exposure < 100;
};

/**
 * @param {any} challenge
 * @param {any} bankroll
 * @param {number} nowSec
 */
const canKeyUnlock = (challenge, bankroll, nowSec) =>
    hasBalance(bankroll, 'key') && challengeAllows('key', challenge, nowSec);

/**
 * @param {any} challenge
 * @param {any} bankroll
 * @param {number} nowSec
 */
const canSwapEntry = (challenge, bankroll, nowSec) =>
    hasBalance(bankroll, 'swap') && challengeAllows('swap', challenge, nowSec);

/**
 * @param {any} challenge
 * @param {any} bankroll
 * @param {number} nowSec
 */
const canFillExposure = (challenge, bankroll, nowSec) =>
    hasBalance(bankroll, 'fill') && challengeAllows('fill', challenge, nowSec);

/**
 * Image ids a swap must never pick: every photo currently entered (the photo
 * being replaced included), so a swap can't put a photo into the challenge
 * twice or swap a photo for itself. A photo swapped out earlier is NOT
 * excluded — it keeps its votes (and any boost/turbo) while out, and swapping
 * it back in is a legitimate move. Compared as a set of strings, never by
 * position.
 *
 * @param {any} challenge
 * @returns {Set<string>}
 */
const swapExcludedIds = (challenge) => {
    const ids = new Set();
    const entries = challenge?.member?.ranking?.entries;
    if (!Array.isArray(entries)) return ids;
    for (const item of entries) {
        if (item?.id !== undefined && item?.id !== null && item.id !== '') ids.add(String(item.id));
    }
    return ids;
};

/**
 * Maps a failed live re-check onto the outcome the user sees: unreadable
 * balance → balanceUnknown, empty balance → noBalance, anything else (state
 * already changed, flag locked, challenge closed) → notAvailable. Returns null
 * when the action is allowed.
 *
 * @param {'key'|'swap'|'fill'} action
 * @param {any} challenge
 * @param {any} bankroll
 * @param {number} nowSec
 * @returns {string|null}
 */
const blockedOutcome = (action, challenge, bankroll, nowSec) => {
    if (!bankroll) return CURRENCY_OUTCOME.balanceUnknown;
    if (!hasBalance(bankroll, action)) return CURRENCY_OUTCOME.noBalance;
    if (!challengeAllows(action, challenge, nowSec)) return CURRENCY_OUTCOME.notAvailable;
    return null;
};

module.exports = {
    CURRENCY_OUTCOME,
    CURRENCY_FIELD,
    isRunning,
    challengeAllows,
    canKeyUnlock,
    canSwapEntry,
    canFillExposure,
    swapExcludedIds,
    blockedOutcome,
};
