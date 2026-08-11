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
 * @returns {{enabled: boolean, timesOfDay: *, beforeEndSecs: *}|Promise<{enabled: boolean, timesOfDay: *, beforeEndSecs: *}>}
 */

const { occurrencesOf } = require('./wallClock');
// From settings/limits (not settings/schema) — schema.js requires zod, and a
// CJS require of it cannot be tree-shaken out of app-bundle.js, which reaches
// this module through the cadence chain (AutovoteContext -> cadenceChain ->
// thresholdWindow) but never otherwise touches the validator.
const { MAX_SCHEDULED_FILL_ENTRIES } = require('../settings/limits');

// Non-flash challenges that are still open at `now`. Flash challenges never
// enter last-minute/scheduled-fill mode, and closed ones can't. Shared with
// thresholdWindow.js so the two cadence paths agree on eligibility.
const eligibleChallenges = (challenges, now) => challenges.filter((c) => c.type !== 'flash' && c.close_time > now);

/**
 * Soonest upcoming scheduled-fill window start strictly after `now` across
 * still-open, non-flash challenges. Both triggers are LISTS — per challenge:
 *   - each time-of-day entry contributes its next daily occurrence, counted
 *     only while it still falls before that challenge's close;
 *   - each before-end entry contributes close_time - entry, counted only
 *     while it is still ahead;
 *   - the challenge's candidate is the earliest (min) across all entries of
 *     both lists.
 *
 * Fail-soft like the decision path: a challenge whose config is corrupt or
 * whose resolver throws is skipped, a corrupt ENTRY inside a list is skipped,
 * and lists are sliced to MAX_SCHEDULED_FILL_ENTRIES — the scheduler must
 * keep running on its normal cadence regardless.
 *
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {ResolveScheduledFill} resolveScheduledFill
 * @param {string} timezone - IANA zone for the time-of-day form
 * @returns {Promise<{challengeId, challengeTitle, startTime: number, form: 'time-of-day'|'before-end'}|null>}
 */
async function soonestScheduledStart(challenges, now, resolveScheduledFill, timezone) {
    const eligible = eligibleChallenges(challenges, now);
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

        const times = (Array.isArray(config.timesOfDay) ? config.timesOfDay : []).slice(0, MAX_SCHEDULED_FILL_ENTRIES);
        for (const entry of times) {
            const occ = occurrencesOf(entry, timezone, now);
            if (occ && occ.next < close && occ.next < startTime) {
                startTime = occ.next;
                form = 'time-of-day';
            }
        }
        const befores = (Array.isArray(config.beforeEndSecs) ? config.beforeEndSecs : []).slice(
            0,
            MAX_SCHEDULED_FILL_ENTRIES,
        );
        for (const entry of befores) {
            const beforeEndSec = Number(entry);
            if (!(beforeEndSec > 0)) continue;
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

module.exports = { soonestScheduledStart, eligibleChallenges };
