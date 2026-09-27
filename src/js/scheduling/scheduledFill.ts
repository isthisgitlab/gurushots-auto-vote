/**
 * Cadence-side scheduled-fill math (issue #26).
 *
 * The decision side (services/decisions/triggerWindows.js getScheduledFillState) answers
 * "is this challenge in a fill window right now?"; this module answers the
 * scheduler's question "when does the next fill window OPEN?", so
 * computeNextCycleDelayMs can cap the sleep and land a cycle exactly at the
 * window start instead of overshooting it by up to a whole random delay.
 *
 * Mirrors thresholdWindow.ts's shape: pure math over an injected per-challenge
 * config resolver that may be sync (Node: settings facade) or async (WebView:
 * IPC), resolved once per decision in a single pass.
 */

import type { Challenge } from '../types/gurushots';

import { occurrencesOf } from './wallClock';
// From settings/limits (not settings/schema) — schema.ts requires zod, and a
// CJS require of it cannot be tree-shaken out of app-bundle.js, which reaches
// this module through the cadence chain (AutovoteContext -> cadenceChain ->
// thresholdWindow) but never otherwise touches the validator.
import { MAX_SCHEDULED_FILL_ENTRIES } from '../settings/limits';

/**
 * @param challengeId - Challenge id as a string.
 */
export type ResolveScheduledFill = (challengeId: string) => ScheduledFillConfig | Promise<ScheduledFillConfig>;

/**
 * Per-challenge scheduled-fill config. Both trigger lists arrive RAW (straight
 * from settings) and are guarded here.
 */
type ScheduledFillConfig = { enabled: boolean; timesOfDay: unknown; beforeEndSecs: unknown };

/**
 * The soonest upcoming scheduled-fill window start.
 */
export type ScheduledStart = {
    challengeId: Challenge['id'];
    challengeTitle: string;
    startTime: number;
    form: 'time-of-day' | 'before-end';
};

// Non-flash challenges that are still open at `now`. Flash challenges never
// enter last-minute/scheduled-fill mode, and closed ones can't. Shared with
// thresholdWindow.ts so the two cadence paths agree on eligibility.
/**
 * @param now - Unix timestamp (seconds)
 */
const eligibleChallenges = (challenges: Challenge[], now: number): Challenge[] =>
    challenges.filter((c) => c.type !== 'flash' && c.close_time > now);

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
 * @param now - Unix timestamp (seconds)
 * @param timezone - IANA zone for the time-of-day form
 */
async function soonestScheduledStart(
    challenges: Challenge[],
    now: number,
    resolveScheduledFill: ResolveScheduledFill,
    timezone: string,
): Promise<ScheduledStart | null> {
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

    let best: ScheduledStart | null = null;
    for (let i = 0; i < eligible.length; i++) {
        const config = configs[i];
        if (!config || config.enabled !== true) continue;
        const challenge = eligible[i];
        const close = Number(challenge.close_time);

        let startTime = Infinity;
        let form: ScheduledStart['form'] | null = null;

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

export { soonestScheduledStart, eligibleChallenges };
