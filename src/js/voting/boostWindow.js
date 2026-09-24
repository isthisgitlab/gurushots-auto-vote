/**
 * Boost-window predicate shared by the voting engine (services/VotingLogic)
 * and the renderer (react/utils/formatters). Pure — no Node, no services —
 * so it is safe in every host including the WebView bundle.
 *
 *   - AVAILABLE_KEY (key-unlocked) → open, no expiry
 *   - AVAILABLE → open while a positive timeout is still in the future;
 *     AVAILABLE without a timeout is treated as key-unlocked (open)
 *   - anything else → closed
 *
 * @param {object|null|undefined} boost - Boost object from the API (challenge.member.boost)
 * @param {number} now - Current time (Unix seconds)
 * @returns {boolean}
 */
const isBoostWindowOpen = (boost, now) => {
    if (!boost || !boost.state) return false;
    if (boost.state === 'AVAILABLE_KEY') return true;
    if (boost.state === 'AVAILABLE') {
        const hasTimeout = typeof boost.timeout === 'number' && boost.timeout > 0;
        return hasTimeout ? boost.timeout > now : true;
    }
    return false;
};

/**
 * Challenges whose boost window is open right now, as display entries sorted
 * soonest-expiring first. Shared by the CLI status view and the GUI banner.
 *
 * Only timed windows (state AVAILABLE with a future timeout) carry a
 * countdown; key-unlocked boosts (AVAILABLE_KEY) never expire, so their
 * `remaining` is null and they sort last.
 *
 * @param {Array} challenges - Active challenges from the API
 * @param {number} now - Current time (Unix seconds)
 * @returns {Array<{id: *, title: string, remaining: number|null}>}
 */
const openBoostWindows = (challenges, now) =>
    (challenges || [])
        .filter((c) => isBoostWindowOpen(c.member?.boost, now))
        .map((c) => {
            const boost = c.member?.boost;
            const remaining =
                boost?.state === 'AVAILABLE' && typeof boost.timeout === 'number' && boost.timeout > 0
                    ? boost.timeout - now
                    : null;
            return { id: c.id, title: c.title, remaining };
        })
        .sort((a, b) => {
            if (a.remaining == null) return b.remaining == null ? 0 : 1;
            if (b.remaining == null) return -1;
            return a.remaining - b.remaining;
        });

/**
 * Seconds-before-close at which an available boost is auto-applied, plus which
 * clock that figure came from.
 *
 * Pure and settings-free so the two callers that need the same instant can share
 * one formula instead of each carrying a copy: services/VotingLogic
 * (getBoostThresholdSec, resolving the windows from settings) and
 * scheduling/thresholdWindow (the pre-boost cadence cap, whose config arrives via
 * a platform resolver and which must stay free of settings I/O for the WebView
 * bundle).
 *
 * The two branches measure different clocks, exactly as shouldApplyBoost does:
 *   - key-unlocked (AVAILABLE_KEY, or AVAILABLE with no timeout) has no timer of
 *     its own, so the window is measured straight against close time;
 *   - timer-based (AVAILABLE with a positive timeout) converts the boost's own
 *     expiry into a seconds-before-close figure so it is comparable with every
 *     other deadline action. `boost.timeout` is an absolute Unix-epoch timestamp,
 *     NOT a countdown; the formula assumes the normal `closeTime > timeout` case
 *     and malformed data (expiry after close) merely yields a negative figure.
 *
 * The `0 = off` sentinel on both window settings is deliberately NOT applied
 * here. getBoostThresholdSec's contract is to stay a pure function of
 * the configured numbers so orderDeadlineActions sorts on settings rather than on
 * live state; the callers that care (describeDeadlineActions, the pre-boost fill)
 * re-check the sentinel themselves, which `branch` is returned for.
 *
 * @param {object|null|undefined} boost - challenge.member.boost
 * @param {number} closeTime - challenge close time (Unix seconds)
 * @param {{boostTimeSec: number, keyUnlockedBoostTimeSec: number}} windows - the
 *   two configured windows, already resolved by the caller
 * @returns {{thresholdSec: number, branch: 'timer'|'key'|null}} `-Infinity` /
 *   `null` when no boost is available to apply, so the action sorts last
 */
const boostApplyThreshold = (boost, closeTime, { boostTimeSec, keyUnlockedBoostTimeSec }) => {
    const b = boost || {};
    const hasTimeout = typeof b.timeout === 'number' && b.timeout > 0;
    if (b.state === 'AVAILABLE_KEY' || (b.state === 'AVAILABLE' && !hasTimeout)) {
        return { thresholdSec: keyUnlockedBoostTimeSec, branch: 'key' };
    }
    if (b.state === 'AVAILABLE' && hasTimeout) {
        return { thresholdSec: Number(closeTime) - b.timeout + boostTimeSec, branch: 'timer' };
    }
    return { thresholdSec: -Infinity, branch: null };
};

module.exports = { isBoostWindowOpen, openBoostWindows, boostApplyThreshold };
