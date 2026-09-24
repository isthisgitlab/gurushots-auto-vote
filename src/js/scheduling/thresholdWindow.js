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
const { boostApplyThreshold } = require('../voting/boostWindow');
const { ruleOpensAt } = require('../voting/currencyAuto');

/**
 * Resolve each challenge's per-challenge config in parallel, fail-soft: a
 * resolver that throws yields null for that challenge, which the caller skips.
 *
 * @template T
 * @param {Array} challenges
 * @param {(challengeId: string) => T|Promise<T>} resolve
 * @returns {Promise<Array<T|null>>}
 */
const resolveConfigsFailSoft = (challenges, resolve) =>
    Promise.all(
        challenges.map(async (challenge) => {
            try {
                return await resolve(challenge.id.toString());
            } catch {
                return null;
            }
        }),
    );

// Fall back to the id so a missing/empty title never logs as "undefined".
const challengeLabel = (challenge) => challenge.title || `challenge ${challenge.id}`;

// 60..3540s == 1..59 min; mirrors VotingLogic's lead-minute clamps (rawLeadMin,
// getBoostPrefillLeadSec) so a corrupt sub-minute/over-max override falls back
// to the schema default (15 min) identically here.
const clampLeadSec = (leadSec) => (Number.isFinite(leadSec) && leadSec >= 60 && leadSec <= 3540 ? leadSec : 900);

// Strictly after `now` and sooner than the best boundary found so far (none yet
// = Infinity, so a non-finite start never wins).
const isSoonerUpcomingStart = (startTime, now, best) =>
    startTime > now && startTime < (best ? best.startTime : Infinity);

/** @returns {{challengeId, challengeTitle, startTime:number, leadMin:number}} */
const leadWindowStart = (challenge, startTime, leadSec) => ({
    challengeId: challenge.id,
    challengeTitle: challengeLabel(challenge),
    startTime,
    leadMin: Math.round(leadSec / 60),
});

/**
 * Per-challenge pre-final-window-top-up config for the cadence cap.
 * @callback ResolveFinalWindowTopUp
 * @param {string} challengeId - Challenge id as a string.
 * @returns {{enabled: boolean, leadSec: number, durationSec: number}|Promise<{enabled: boolean, leadSec: number, durationSec: number}>}
 */

/**
 * Top-up window start for one challenge, or null when its config is off/unreadable.
 * @returns {{startTime:number, leadSec:number}|null}
 */
const finalWindowTopUpWindow = (challenge, config) => {
    if (!config || config.enabled !== true) return null;
    const leadSec = clampLeadSec(config.leadSec);
    // Mirrors VotingLogic's finalWindowSec clamp (>= 60s, else legacy hour).
    const durationSec = Number.isFinite(config.durationSec) && config.durationSec >= 60 ? config.durationSec : 3600;
    return { startTime: Number(challenge.close_time) - (durationSec + leadSec), leadSec };
};

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
    const configs = await resolveConfigsFailSoft(eligible, resolveFinalWindowTopUp);
    let best = null;
    for (let i = 0; i < eligible.length; i++) {
        const window = finalWindowTopUpWindow(eligible[i], configs[i]);
        if (window && isSoonerUpcomingStart(window.startTime, now, best)) {
            best = leadWindowStart(eligible[i], window.startTime, window.leadSec);
        }
    }
    return best;
}

/**
 * Per-challenge pre-boost-fill config for the cadence cap. The two boost windows
 * come through as already-resolved numbers so this module stays free of settings
 * I/O (it is bundled into the WebView); the apply instant itself is computed from
 * the challenge's own live boost state via the shared boostApplyThreshold.
 * @callback ResolveBoostPrefill
 * @param {string} challengeId - Challenge id as a string.
 * @returns {{enabled: boolean, leadSec: number, boostTimeSec: number, keyUnlockedBoostTimeSec: number}|Promise<{enabled: boolean, leadSec: number, boostTimeSec: number, keyUnlockedBoostTimeSec: number}>}
 */

/**
 * Pre-boost fill window start for one challenge, or null when it has none.
 * @returns {{startTime:number, leadSec:number}|null}
 */
const boostPrefillWindow = (challenge, config) => {
    if (!config || config.enabled !== true) return null;
    const closeTime = Number(challenge.close_time);
    if (!Number.isFinite(closeTime)) return null;

    const boostTimeSec = Number(config.boostTimeSec);
    // Mirrors VotingLogic.getEffectiveKeyUnlockedBoostTime: an explicit 0 is the
    // off sentinel and must be honoured, but a missing/negative/NaN value falls
    // back to the schema default rather than skipping the challenge — otherwise
    // the rule would be armed at 900s for a boundary the scheduler never wakes for.
    const rawKeyUnlocked = Number(config.keyUnlockedBoostTimeSec);
    const keyUnlockedBoostTimeSec = Number.isFinite(rawKeyUnlocked) && rawKeyUnlocked >= 0 ? rawKeyUnlocked : 900;
    const { thresholdSec, branch } = boostApplyThreshold(challenge.member?.boost, closeTime, {
        boostTimeSec,
        keyUnlockedBoostTimeSec,
    });
    if (branch === null) return null;
    // `0 = off` on the window this branch actually measures against; mirrors
    // VotingLogic.getBoostPrefillState.
    const windowSec = branch === 'timer' ? boostTimeSec : keyUnlockedBoostTimeSec;
    if (!Number.isFinite(windowSec) || windowSec <= 0) return null;
    if (!Number.isFinite(thresholdSec) || thresholdSec <= 0) return null;

    const leadSec = clampLeadSec(config.leadSec);
    return { startTime: closeTime - (thresholdSec + leadSec), leadSec };
};

/**
 * Soonest upcoming pre-boost fill window START strictly after `now` across
 * still-open, non-flash challenges. The window opens `leadSec` before the boost
 * is auto-applied, i.e. at `close_time - (applyThresholdSec + leadSec)` — the
 * scheduler caps its sleep to this so a cycle lands there and can start voting
 * the challenge to 100% before the boost is spent on it.
 *
 * Unlike the other cadence boundaries this one depends on LIVE challenge state
 * (`member.boost`), not on close_time alone, so it can appear, move or vanish as
 * the boost's own timer is refreshed server-side. That is fine: it is recomputed
 * from scratch every cycle, and the vote rule re-checks the same window before
 * acting.
 *
 * Fail-soft like the other cadence helpers: a challenge whose resolver throws or
 * whose config is disabled is skipped. An out-of-range leadSec (sub-minute, over
 * 59 min, or NaN) falls back to the schema default (15 min) so a bad override
 * can't disable the cap — the valid range mirrors VotingLogic's
 * getBoostPrefillLeadSec so the two same-purpose guards can't drift. The
 * `0 = off` sentinel on whichever boost window the branch measures against is
 * honoured here exactly as the vote rule honours it, so the scheduler never wakes
 * for a fill the rule would then decline to perform.
 *
 * @param {Array} eligible - already-filtered still-open non-flash challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {ResolveBoostPrefill} resolveBoostPrefill
 * @returns {Promise<{challengeId, challengeTitle, startTime:number, leadMin:number}|null>}
 */
async function soonestBoostPrefillStart(eligible, now, resolveBoostPrefill) {
    const configs = await resolveConfigsFailSoft(eligible, resolveBoostPrefill);
    let best = null;
    for (let i = 0; i < eligible.length; i++) {
        const window = boostPrefillWindow(eligible[i], configs[i]);
        if (window && isSoonerUpcomingStart(window.startTime, now, best)) {
            best = leadWindowStart(eligible[i], window.startTime, window.leadSec);
        }
    }
    return best;
}

/**
 * @typedef {import('../voting/currencyAuto').RuleTiming} RuleTiming
 * @typedef {(challengeId: string) => ({key: RuleTiming|null, swap: RuleTiming|null, fill: RuleTiming|null}|Promise<{key: RuleTiming|null, swap: RuleTiming|null, fill: RuleTiming|null}>)} ResolveCurrencyAuto
 *   Per-challenge timing of each ENABLED currency-automation rule (null = rule off).
 */

// Whether the challenge could still take the action at all — waking for a rule
// whose action the challenge doesn't offer (or has already used) would no-op.
// Live state beyond this (balance, exposure, swap caps) is left to the runner.
const CURRENCY_ACTION_OFFERED = {
    key: (c) => c?.boost_enable === true && c?.member?.boost?.state === 'LOCKED',
    swap: (c) => c?.swap_enable === true && c?.swap_locked !== true,
    fill: (c) => c?.fill_enable === true && c?.fill_locked !== true,
};

/**
 * Soonest upcoming currency-automation rule opening (automatic key / swap /
 * fill, voting/currencyAuto.js ruleOpensAt) strictly after `now`, across every
 * still-open challenge — flash included, since a flash challenge running out of
 * vote photos is exactly where the exposure-fill rule matters. The scheduler
 * caps its sleep to it so an "11h after start" or "7h before end" rule fires on
 * time instead of up to one normal cadence late. Fail-soft: a challenge whose
 * resolver throws is skipped.
 *
 * @param {Array} challenges
 * @param {number} now - Unix timestamp (seconds)
 * @param {ResolveCurrencyAuto} resolveCurrencyAuto
 * @returns {Promise<{challengeId, challengeTitle, startTime:number, action:string}|null>}
 */
async function soonestCurrencyRuleStart(challenges, now, resolveCurrencyAuto) {
    const open = (Array.isArray(challenges) ? challenges : []).filter((c) => Number(c?.close_time) > now);
    const configs = await resolveConfigsFailSoft(open, resolveCurrencyAuto);

    let best = null;
    for (let i = 0; i < open.length; i++) {
        const challenge = open[i];
        for (const action of ['key', 'swap', 'fill']) {
            const timing = configs[i]?.[action];
            if (!timing || !CURRENCY_ACTION_OFFERED[action](challenge)) continue;
            const startTime = ruleOpensAt(challenge, timing);
            if (startTime === null || startTime <= now || startTime >= Number(challenge.close_time)) continue;
            if (best === null || startTime < best.startTime) {
                best = {
                    challengeId: challenge.id,
                    challengeTitle: challengeLabel(challenge),
                    startTime,
                    action,
                };
            }
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
                challengeTitle: challengeLabel(challenge),
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
 * Cap the cadence so the next cycle lands on `boundarySec` instead of sleeping
 * past it — only when the boundary is sooner than the current delay. Floored at
 * `minGapMs` so a boundary that is already here can't busy-loop. Mutates `cadence`.
 *
 * @param {{delayMs:number, mode:string}} cadence
 * @param {number} boundarySec - Unix timestamp (seconds) of the boundary
 * @param {number} now - Unix timestamp (seconds)
 * @param {number} minGapMs
 * @param {string} mode - the mode to report when this boundary wins
 */
const capCadenceToBoundary = (cadence, boundarySec, now, minGapMs, mode) => {
    const msUntilBoundary = (boundarySec - now) * 1000;
    if (msUntilBoundary < cadence.delayMs) {
        cadence.delayMs = Math.max(minGapMs, msUntilBoundary);
        cadence.mode = mode;
    }
};

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
 * @param {ResolveBoostPrefill|null} [opts.resolveBoostPrefill] - per-challenge pre-boost fill config resolver (sync or async); when passed, the delay is also capped to the soonest upcoming pre-boost window start
 * @param {ResolveCurrencyAuto|null} [opts.resolveCurrencyAuto] - per-challenge currency-automation timing resolver (sync or async); when passed, the delay is also capped to the soonest upcoming key / swap / fill rule opening
 * @returns {Promise<{delayMs:number, mode:'last-minute'|'approaching'|'scheduled'|'pre-final-window'|'pre-boost'|'currency-rule'|'normal', nextEntry:(object|null), nextScheduled:(object|null), nextFinalWindowTopUp:(object|null), nextBoostPrefill:(object|null), nextCurrencyRule:(object|null)}>}
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
        resolveBoostPrefill = null,
        resolveCurrencyAuto = null,
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
            nextBoostPrefill: null,
            nextCurrencyRule: null,
        };
    }

    // Every boundary below is the same "cap to the soonest upcoming boundary"
    // shape, applied in this fixed order; whichever boundary is sooner wins, and
    // an exact tie keeps the earlier-applied mode.
    const cadence = { delayMs: normalDelayMs, mode: 'normal' };
    const capTo = (boundarySec, mode) => capCadenceToBoundary(cadence, boundarySec, now, minGapMs, mode);

    const nextEntry = soonestThresholdEntry(eligible, thresholds, now);
    if (nextEntry) capTo(nextEntry.entryTime, 'approaching');

    const nextScheduled =
        resolveScheduledFill && timezone
            ? await soonestScheduledStart(eligible, now, resolveScheduledFill, timezone)
            : null;
    if (nextScheduled) capTo(nextScheduled.startTime, 'scheduled');

    const nextFinalWindowTopUp = resolveFinalWindowTopUp
        ? await soonestFinalWindowTopUpStart(eligible, now, resolveFinalWindowTopUp)
        : null;
    if (nextFinalWindowTopUp) capTo(nextFinalWindowTopUp.startTime, 'pre-final-window');

    const nextBoostPrefill = resolveBoostPrefill
        ? await soonestBoostPrefillStart(eligible, now, resolveBoostPrefill)
        : null;
    if (nextBoostPrefill) capTo(nextBoostPrefill.startTime, 'pre-boost');

    // Currency rules consider every still-open challenge (flash included), not
    // just the threshold-eligible set.
    const nextCurrencyRule = resolveCurrencyAuto
        ? await soonestCurrencyRuleStart(challenges, now, resolveCurrencyAuto)
        : null;
    if (nextCurrencyRule) capTo(nextCurrencyRule.startTime, 'currency-rule');

    return {
        delayMs: cadence.delayMs,
        mode: cadence.mode,
        nextEntry,
        nextScheduled,
        nextFinalWindowTopUp,
        nextBoostPrefill,
        nextCurrencyRule,
    };
}

module.exports = {
    calculateNextThresholdEntry,
    isAnyChallengeInThresholdWindow,
    computeNextCycleDelayMs,
    soonestFinalWindowTopUpStart,
    soonestBoostPrefillStart,
    soonestCurrencyRuleStart,
};
