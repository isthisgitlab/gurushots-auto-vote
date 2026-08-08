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

module.exports = { isBoostWindowOpen, openBoostWindows };
