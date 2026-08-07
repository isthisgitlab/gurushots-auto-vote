/**
 * Cadence-side scheduled-fill math (issue #26).
 *
 * The decision side (services/VotingLogic.js getScheduledFillState) answers
 * "is this challenge in a fill window right now?"; this module answers the
 * scheduler's question "when does the next fill window OPEN?", so
 * computeNextCycleDelayMs can cap the sleep and land a cycle exactly at the
 * window start instead of overshooting it by up to a whole random delay.
 *
 * Mirrors thresholdWindow.js's shape: pure math over an injected per-challenge
 * config resolver that may be sync (Node: settings facade) or async (WebView:
 * IPC), resolved once per decision in a single pass.
 *
 * @callback ResolveScheduledFill
 * @param {string} challengeId - Challenge id as a string.
 * @returns {{enabled: boolean, timeOfDay: *, beforeEndSec: *}|Promise<{enabled: boolean, timeOfDay: *, beforeEndSec: *}>}
 */

const { occurrencesOf } = require('./wallClock');

/**
 * Soonest upcoming scheduled-fill window start strictly after `now` across
 * still-open, non-flash challenges. Per challenge:
 *   - time-of-day form: the next daily occurrence, counted only while it still
 *     falls before that challenge's close;
 *   - before-end form: close_time - beforeEndSec, counted only while it is
 *     still ahead;
 *   - both forms configured → the earlier (min) of the two candidate starts.
 *
 * Fail-soft like the decision path: a challenge whose config is corrupt or
 * whose resolver throws is skipped, never thrown — the scheduler must keep
 * running on its normal cadence regardless.
 *
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {ResolveScheduledFill} resolveScheduledFill
 * @param {string} timezone - IANA zone for the time-of-day form
 * @returns {Promise<{challengeId, challengeTitle, startTime: number, form: 'time-of-day'|'before-end'}|null>}
 */
async function soonestScheduledStart(challenges, now, resolveScheduledFill, timezone) {
    const eligible = challenges.filter((c) => c.type !== 'flash' && c.close_time > now);
    // One resolution pass for the same reason resolveEligibleThresholds does it:
    // per-question resolution would double the IPC cost on the WebView.
    const configs = await Promise.all(
        eligible.map(async (challenge) => {
            try {
                return await resolveScheduledFill(challenge.id.toString());
            } catch {
                return null;
            }
        }),
    );

    let best = null;
    for (let i = 0; i < eligible.length; i++) {
        const config = configs[i];
        if (!config || config.enabled !== true) continue;
        const challenge = eligible[i];
        const close = Number(challenge.close_time);

        let startTime = Infinity;
        let form = null;

        const occ = occurrencesOf(config.timeOfDay, timezone, now);
        if (occ && occ.next < close) {
            startTime = occ.next;
            form = 'time-of-day';
        }
        const beforeEndSec = Number(config.beforeEndSec);
        if (beforeEndSec > 0) {
            const start = close - beforeEndSec;
            if (start > now && start < startTime) {
                startTime = start;
                form = 'before-end';
            }
        }

        if (form && startTime < (best?.startTime ?? Infinity)) {
            best = {
                challengeId: challenge.id,
                // Fall back to the id so a missing title never logs as "undefined".
                challengeTitle: challenge.title || `challenge ${challenge.id}`,
                startTime,
                form,
            };
        }
    }
    return best;
}

module.exports = { soonestScheduledStart };
