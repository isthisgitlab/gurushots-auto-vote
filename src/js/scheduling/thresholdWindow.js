/**
 * Shared last-minute threshold math for both voting schedulers.
 *
 * `runScheduler.js` (CLI/Android) and `autovoteScheduler.js` (React GUI) each
 * used to carry their own copy of "which challenge crosses its
 * lastMinuteThreshold next?" and "is any challenge in its window now?". The
 * only real difference was how a per-challenge threshold gets resolved:
 *   - Node:    settings.getEffectiveSetting('lastMinuteThreshold', id)  (sync)
 *   - WebView: window.api.getEffectiveSetting('lastMinuteThreshold', id) (async)
 *
 * So the math lives here once and takes a `resolveThreshold(idString)`
 * function that may return a number or a Promise<number>; both consumers wrap
 * it with their platform's resolver. This removes the "fix BOTH" duplication
 * for the part that actually drifts. `computeNextCycleDelayMs` builds on these
 * to make the whole per-cycle cadence decision in one place, so every host
 * (CLI `runScheduler.js`, GUI `AutovoteContext.jsx`, Android `headless/index.js`)
 * drives a single setTimeout/alarm chain off the same rule rather than each
 * carrying its own boundary-switch timer.
 *
 * @callback ResolveThreshold
 * @param {string} challengeId - Challenge id as a string.
 * @returns {number|Promise<number>} The effective lastMinuteThreshold (minutes).
 */

const { soonestScheduledStart, eligibleChallenges } = require('./scheduledFill');

/**
 * Per-challenge pre-final-window-top-up config for the cadence cap.
 * @callback ResolveFinalWindowTopUp
 * @param {string} challengeId - Challenge id as a string.
 * @returns {{enabled: boolean, leadSec: number, durationSec: number}|Promise<{enabled: boolean, leadSec: number, durationSec: number}>}
 */

/**
 * Soonest upcoming pre-final-window top-up window START strictly after `now`
 * across still-open, non-flash challenges. The window opens `leadSec` before the
 * final window, i.e. at `close_time - (durationSec + leadSec)` — the scheduler
 * caps its sleep to this so a cycle lands exactly there and tops the challenge up
 * to the standard target before the final-window rule's lower trigger takes over.
 *
 * Fail-soft like the other cadence helpers: a challenge whose resolver throws or
 * whose config is disabled/corrupt is skipped; an out-of-range leadSec (sub-minute,
 * over 59 min, or NaN) falls back to the schema default (15 min) so a bad override
 * can't disable the cap. The valid range mirrors VotingLogic's rule-engine guard
 * (1..59 min) so the two same-purpose guards can't drift on corrupt input. A
 * corrupt durationSec (sub-minute or NaN) falls back to the legacy fixed hour
 * (3600), mirroring VotingLogic's finalWindowSec clamp for the same input.
 *
 * @param {Array} eligible - already-filtered still-open non-flash challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {ResolveFinalWindowTopUp} resolveFinalWindowTopUp
 * @returns {Promise<{challengeId, challengeTitle, startTime:number, leadMin:number}|null>}
 */
async function soonestFinalWindowTopUpStart(eligible, now, resolveFinalWindowTopUp) {
    const configs = await Promise.all(
        eligible.map(async (challenge) => {
            try {
                return await resolveFinalWindowTopUp(challenge.id.toString());
            } catch {
                return null;
            }
        }),
    );

    let best = null;
    let earliest = Infinity;
    for (let i = 0; i < eligible.length; i++) {
        const config = configs[i];
        if (!config || config.enabled !== true) continue;
        // 60..3540s == 1..59 min; mirrors VotingLogic's rawLeadMin clamp so a
        // corrupt sub-minute/over-max override falls back identically here.
        const leadSec =
            Number.isFinite(config.leadSec) && config.leadSec >= 60 && config.leadSec <= 3540 ? config.leadSec : 900;
        // Mirrors VotingLogic's finalWindowSec clamp (>= 60s, else legacy hour).
        const durationSec = Number.isFinite(config.durationSec) && config.durationSec >= 60 ? config.durationSec : 3600;
        const challenge = eligible[i];
        const startTime = Number(challenge.close_time) - (durationSec + leadSec);
        if (startTime > now && startTime < earliest) {
            earliest = startTime;
            best = {
                challengeId: challenge.id,
                // Fall back to the id so a missing title never logs as "undefined".
                challengeTitle: challenge.title || `challenge ${challenge.id}`,
                startTime,
                leadMin: Math.round(leadSec / 60),
            };
        }
    }
    return best;
}

/**
 * Resolve each eligible challenge's per-challenge threshold ONCE. Every
 * threshold question (in-window? next entry? next delay?) is then answered from
 * this single resolved snapshot — important because on the WebView each
 * `resolveThreshold` call is an IPC round-trip, and on Node it re-reads the
 * settings file, so resolving per-question would double the cost and could even
 * read two different `now`s mid-decision.
 *
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {ResolveThreshold} resolveThreshold
 * @returns {Promise<{eligible:Array, thresholds:number[]}>}
 */
async function resolveEligibleThresholds(challenges, now, resolveThreshold) {
    const eligible = eligibleChallenges(challenges, now);
    const thresholds = await Promise.all(eligible.map((c) => resolveThreshold(c.id.toString())));
    return { eligible, thresholds };
}

// Pure decision helpers over an already-resolved (eligible, thresholds) snapshot.
const anyInWindow = (eligible, thresholds, now) => eligible.some((c, i) => c.close_time - now <= thresholds[i] * 60);

const soonestThresholdEntry = (eligible, thresholds, now) => {
    let nextEntry = null;
    let earliestEntryTime = Infinity;
    for (let i = 0; i < eligible.length; i++) {
        const challenge = eligible[i];
        const effectiveLastMinuteThreshold = thresholds[i];
        const thresholdEntryTime = challenge.close_time - effectiveLastMinuteThreshold * 60;
        if (thresholdEntryTime > now && thresholdEntryTime < earliestEntryTime) {
            earliestEntryTime = thresholdEntryTime;
            nextEntry = {
                challengeId: challenge.id,
                // Fall back to the id so a missing/empty title never logs as "undefined".
                challengeTitle: challenge.title || `challenge ${challenge.id}`,
                entryTime: thresholdEntryTime,
                lastMinuteThreshold: effectiveLastMinuteThreshold,
            };
        }
    }
    return nextEntry;
};

/**
 * Find the soonest challenge that will cross its per-challenge
 * `lastMinuteThreshold` boundary after `now`. Returns null when none will.
 *
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {ResolveThreshold} resolveThreshold
 * @returns {Promise<{challengeId, challengeTitle, entryTime, lastMinuteThreshold}|null>}
 */
async function calculateNextThresholdEntry(challenges, now, resolveThreshold) {
    const { eligible, thresholds } = await resolveEligibleThresholds(challenges, now, resolveThreshold);
    return soonestThresholdEntry(eligible, thresholds, now);
}

/**
 * True when at least one non-flash, still-open challenge is currently inside
 * its per-challenge `lastMinuteThreshold` window (inclusive boundary). Used to
 * decide when to leave the fixed last-minute cadence and revert to normal.
 *
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {ResolveThreshold} resolveThreshold
 * @returns {Promise<boolean>}
 */
async function isAnyChallengeInThresholdWindow(challenges, now, resolveThreshold) {
    const { eligible, thresholds } = await resolveEligibleThresholds(challenges, now, resolveThreshold);
    return anyInWindow(eligible, thresholds, now);
}

/**
 * Single source of cadence truth for every host. Decide how long to wait before
 * the next voting cycle so we never sleep past an upcoming last-minute boundary:
 *
 *   - any challenge already inside its window → fixed fast cadence
 *     (`lastMinuteCheckMinutes`), because deadline timing matters more than the
 *     anti-metronome randomness once we're in the final stretch;
 *   - otherwise the rolled random delay, but capped to the soonest *upcoming*
 *     threshold entry so the next cycle lands on the boundary instead of
 *     overshooting it;
 *   - a far-off boundary (further than one random delay) doesn't shorten the
 *     wait — we just poll at the normal cadence and re-evaluate next cycle, by
 *     which point the boundary is within a random delay and the cap kicks in.
 *
 * Every result is floored at `minGapMs` so an overrun / boundary-already-here
 * case can't busy-loop. Keeping this here (taking already-resolved scalars +
 * the same `resolveThreshold` callback the other helpers use) means the module
 * stays free of settings I/O and the decision is identical on all platforms.
 * Thresholds are resolved in a single pass and both questions (in-window? next
 * entry?) are answered from that one snapshot — no double resolution.
 *
 * When the host opts in (both `resolveScheduledFill` and `timezone` passed),
 * the delay is additionally capped to the soonest upcoming scheduled-fill
 * window start (scheduling/scheduledFill.js) — whichever boundary is sooner
 * wins. Hosts that don't pass the new opts get byte-identical behavior.
 * The in-window last-minute branch above takes priority over this cap on
 * purpose: while any challenge is in its final stretch the fixed fast
 * cadence (default 1 min) already re-checks far more often than the
 * scheduled-fill window floor (5 min), so a window start can slip by at
 * most one fast tick — never be missed.
 *
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {object} opts
 * @param {ResolveThreshold} opts.resolveThreshold
 * @param {number} opts.normalDelayMs - the random delay already rolled by the host
 * @param {number} opts.lastMinuteCheckMinutes - fixed last-minute cadence (minutes)
 * @param {number} opts.minGapMs - hard floor on the returned delay
 * @param {import('./scheduledFill').ResolveScheduledFill|null} [opts.resolveScheduledFill] - per-challenge scheduled-fill config resolver (sync or async)
 * @param {string|null} [opts.timezone] - IANA zone for the time-of-day form
 * @param {ResolveFinalWindowTopUp|null} [opts.resolveFinalWindowTopUp] - per-challenge pre-final-window top-up config resolver (sync or async); when passed, the delay is also capped to the soonest upcoming top-up window start
 * @returns {Promise<{delayMs:number, mode:'last-minute'|'approaching'|'scheduled'|'pre-final-window'|'normal', nextEntry:(object|null), nextScheduled:(object|null), nextFinalWindowTopUp:(object|null)}>}
 */
async function computeNextCycleDelayMs(
    challenges,
    now,
    {
        resolveThreshold,
        normalDelayMs,
        lastMinuteCheckMinutes,
        minGapMs,
        resolveScheduledFill = null,
        timezone = null,
        resolveFinalWindowTopUp = null,
    },
) {
    const { eligible, thresholds } = await resolveEligibleThresholds(challenges, now, resolveThreshold);

    if (anyInWindow(eligible, thresholds, now)) {
        return {
            delayMs: Math.max(minGapMs, lastMinuteCheckMinutes * 60_000),
            mode: 'last-minute',
            nextEntry: null,
            nextScheduled: null,
            nextFinalWindowTopUp: null,
        };
    }

    const nextEntry = soonestThresholdEntry(eligible, thresholds, now);
    let delayMs = normalDelayMs;
    let mode = 'normal';
    if (nextEntry) {
        const msUntilEntry = (nextEntry.entryTime - now) * 1000;
        if (msUntilEntry < delayMs) {
            delayMs = Math.max(minGapMs, msUntilEntry);
            mode = 'approaching';
        }
    }

    let nextScheduled = null;
    if (resolveScheduledFill && timezone) {
        nextScheduled = await soonestScheduledStart(eligible, now, resolveScheduledFill, timezone);
        if (nextScheduled) {
            const msUntilStart = (nextScheduled.startTime - now) * 1000;
            if (msUntilStart < delayMs) {
                delayMs = Math.max(minGapMs, msUntilStart);
                mode = 'scheduled';
            }
        }
    }

    // Pre-final-window top-up boundary — same "cap to the soonest upcoming window
    // start" shape as scheduled fill above; whichever boundary is sooner wins.
    let nextFinalWindowTopUp = null;
    if (resolveFinalWindowTopUp) {
        nextFinalWindowTopUp = await soonestFinalWindowTopUpStart(eligible, now, resolveFinalWindowTopUp);
        if (nextFinalWindowTopUp) {
            const msUntilStart = (nextFinalWindowTopUp.startTime - now) * 1000;
            if (msUntilStart < delayMs) {
                delayMs = Math.max(minGapMs, msUntilStart);
                mode = 'pre-final-window';
            }
        }
    }

    return { delayMs, mode, nextEntry, nextScheduled, nextFinalWindowTopUp };
}

module.exports = {
    calculateNextThresholdEntry,
    isAnyChallengeInThresholdWindow,
    computeNextCycleDelayMs,
    soonestFinalWindowTopUpStart,
};
