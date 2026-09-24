// @ts-check
/**
 * Trigger-window state for the two features built on the same pair of trigger
 * lists: scheduled fill (vote inside the window) and the voting pause (refuse
 * to vote inside it). Part of the services/VotingLogic facade.
 */

// Cast to any at the boundary: the settings facade isn't `// @ts-check`ed yet,
// and its `challengeId = null` defaults make TS infer param types too narrow
// (null) to accept the string IDs passed here. Drop the cast once settings.js
// is typed.
const settings = /** @type {any} */ (require('../../settings'));
// Pure wall-clock math for the scheduled-fill feature (no import cycle:
// wallClock.js imports nothing). Cast for the same boundary reason as
// settings above — wallClock.js isn't `// @ts-check`ed yet.
const { occurrencesOf } = /** @type {any} */ (require('../../scheduling/wallClock'));
const { DEFAULT_TIMEZONE } = require('../../settings/uiDefaults');
// From settings/limits (not settings/schema) — keeps zod out of any bundle
// that reaches this module. No `any` cast needed: limits.js exports a plain
// number literal, so inference is already exact.
const { MAX_SCHEDULED_FILL_ENTRIES, MAX_VOTING_PAUSE_MINUTES } = require('../../settings/limits');
// Cast at the boundary for the same reason as settings above — logger.js
// isn't `// @ts-check`ed yet. Used only on the corrupt-config paths below,
// which must not stay silent: the orchestrator's per-challenge catch logs its
// own errors, so a swallowed one here would be strictly less visible.
const logger = /** @type {any} */ (require('../../logger'));
// CR/LF-collapse API-sourced values before they reach a log message (CWE-117).
// Imported directly rather than off the logger, matching newEntryTracker.js —
// the logger is mocked across much of the test suite, and its own oneLine() on
// the finished message is a backstop, not the first line of defence.
const { oneLine: oneLineId } = require('../../format/logSafe');

/**
 * Shared trigger-window evaluation for the two features built on the same pair
 * of trigger LISTS: scheduled fill (vote inside the window) and the voting
 * pause (refuse to vote inside it). Only the setting KEYS and the fallback
 * duration differ, so both read this — a second copy of the entry loops would
 * let the two drift on corruption handling, which is where all the subtlety is.
 *
 * Every time entry opens its own daily window and every before-end entry its
 * own one-shot window, all sharing one duration, all OR'd — `inWindow` is true
 * when `now` sits inside ANY entry's `[start, start + duration]` interval.
 *
 * `active` is true only when the master switch is on AND at least one USABLE
 * entry exists across both lists (a parseable 'HH:MM', or an offset > 0). This
 * is what keeps "enabled with no times" a harmless no-op: an
 * `active = enabled` shortcut would let scheduled fill's replace mode block
 * all threshold voting with no window ever opening, and would make a pause
 * with no times readable as "paused forever". A corrupt entry inside a list is
 * skipped (contributing nothing, not even `active`); a whole value that isn't
 * an array turns that form off.
 *
 * Callers wrap this in the try/catch — see getScheduledFillState.
 *
 * Unlike isWithinFinalWindow/isWithinLastMinuteThreshold, the time-of-day form
 * doesn't compare against close_time — callers only iterate the API's active
 * (still-open) challenge list, so a stale in-window verdict for a closed
 * challenge can't occur there. A future caller feeding a broader list should
 * pre-filter on `close_time > now` (as soonestScheduledStart does).
 *
 * @param {any} challenge
 * @param {string} challengeId
 * @param {number} now - Current time (Unix timestamp, seconds)
 * @param {{enabledKey: string, timesKey: string, beforeEndKey: string,
 *          durationKey: string, defaultDurationMin: number,
 *          onCorruptDuration: 'default'|'off', maxDurationMin: number|null}} keys
 *   `onCorruptDuration` and `maxDurationMin` are the per-feature corruption
 *   policy — see the duration block below for why the two features must not
 *   share one. Both are required rather than optional so a future third caller
 *   has to state its direction explicitly instead of inheriting one silently.
 * @returns {{active: boolean, inWindow: boolean}}
 */
const _triggerWindowState = (challenge, challengeId, now, keys) => {
    if (settings.getEffectiveSetting(keys.enabledKey, challengeId) !== true) {
        return { active: false, inWindow: false };
    }

    // Corrupt duration handling is per-feature, because the two features must
    // fail in OPPOSITE directions and a shared fallback would get one of them
    // backwards:
    //   - scheduled fill (`onCorruptDuration: 'default'`) falls back to the
    //     schema default. Failing to "never in window" would, under replace
    //     mode, silently block all threshold voting.
    //   - the voting pause (`onCorruptDuration: 'off'`) turns the feature OFF.
    //     Substituting a default here would be fail-CLOSED: a user with a
    //     30-minute pause whose value got corrupted would silently get the
    //     4-hour default instead — a longer outage than they ever configured.
    // Deliberately no schema-FLOOR clamp either way: a finite positive value
    // below the schema's min(5) is honored as typed (out of range, not corrupt).
    const rawDuration = settings.getEffectiveSetting(keys.durationKey, challengeId);
    const durationMin = Number(rawDuration);
    let effectiveDurationMin;
    if (Number.isFinite(durationMin) && durationMin > 0) {
        effectiveDurationMin = durationMin;
    } else if (keys.onCorruptDuration === 'off') {
        logger
            .withCategory('voting')
            .warning(
                `${keys.durationKey} for challenge ${oneLineId(challengeId)} is not a positive number (${oneLineId(JSON.stringify(rawDuration))}) — treating the feature as off for this challenge`,
                null,
            );
        return { active: false, inWindow: false };
    } else {
        effectiveDurationMin = keys.defaultDurationMin;
    }
    // Ceiling clamp, opt-in per feature. The pause sets one because an
    // oversized hand-edited value there means "never vote again" — an
    // unbounded window swallows every comparison below. Scheduled fill passes
    // none: an oversized fill window just means "always fill", which is
    // harmless, and clamping it would change long-standing behavior.
    if (keys.maxDurationMin && effectiveDurationMin > keys.maxDurationMin) {
        logger
            .withCategory('voting')
            .warning(
                `${keys.durationKey} for challenge ${oneLineId(challengeId)} is ${effectiveDurationMin}m, above the ${keys.maxDurationMin}m maximum — clamping`,
                null,
            );
        effectiveDurationMin = keys.maxDurationMin;
    }
    const durationSec = effectiveDurationMin * 60;
    const timezone = settings.getSetting('timezone') || DEFAULT_TIMEZONE;
    // Both triggers are LISTS — every entry opens its own window, all OR'd.
    // Non-array corruption = form off; a corrupt ENTRY inside the array is
    // skipped (contributes nothing, not even `active`). The slice bounds
    // per-cycle Intl work against a post-migration hand-edited oversized
    // array (the write path and the load-time bounds pass both cap at
    // MAX_SCHEDULED_FILL_ENTRIES already).
    const rawTimes = settings.getEffectiveSetting(keys.timesKey, challengeId);
    const times = (Array.isArray(rawTimes) ? rawTimes : []).slice(0, MAX_SCHEDULED_FILL_ENTRIES);
    const rawBefores = settings.getEffectiveSetting(keys.beforeEndKey, challengeId);
    const befores = (Array.isArray(rawBefores) ? rawBefores : []).slice(0, MAX_SCHEDULED_FILL_ENTRIES);

    let active = false;
    let inWindow = false;

    // Time-of-day entries: unparseable values yield null → entry skipped.
    for (const entry of times) {
        const occ = occurrencesOf(entry, timezone, now);
        if (!occ) continue;
        active = true;
        if (now - occ.prev <= durationSec) inWindow = true;
    }
    // Before-end entries: NaN and non-positives fail the > 0 gate → skipped.
    for (const entry of befores) {
        const beforeEndSec = Number(entry);
        if (!(beforeEndSec > 0)) continue;
        active = true;
        const start = Number(challenge.close_time) - beforeEndSec;
        if (now >= start && now - start <= durationSec) inWindow = true;
    }

    // `inWindow` can only have been set inside a loop that already set
    // `active`, so it never needs a separate guard here.
    return { active, inWindow };
};

/**
 * Scheduled-fill state for a challenge at `now`.
 *
 * Both triggers are LISTS (issue #26 follow-up): every scheduledFillTime
 * entry opens its own daily window and every scheduledFillBeforeEnd entry its
 * own one-shot window, all sharing scheduledFillWindowMinutes, all OR'd. See
 * _triggerWindowState for the entry semantics.
 *
 * The whole body is wrapped in try/catch returning the inactive state — the
 * same posture (and reason) as getExposureResolver in settings.js: a corrupt
 * hand-edited override must degrade this one challenge's scheduled fill to
 * "off" rather than take the whole evaluation down. The `replaces` read is
 * INSIDE the try for that same reason. The catch LOGS: the orchestrator's
 * per-challenge catch reports the errors it sees, so swallowing one silently
 * here would make this the least visible failure in the pass.
 *
 * @param {any} challenge
 * @param {string} challengeId
 * @param {number} now - Current time (Unix timestamp, seconds)
 * @returns {{active: boolean, inWindow: boolean, replaces: boolean}}
 */
const getScheduledFillState = (challenge, challengeId, now) => {
    const inactive = { active: false, inWindow: false, replaces: false };
    try {
        const state = _triggerWindowState(challenge, challengeId, now, {
            enabledKey: 'useScheduledFill',
            timesKey: 'scheduledFillTime',
            beforeEndKey: 'scheduledFillBeforeEnd',
            durationKey: 'scheduledFillWindowMinutes',
            defaultDurationMin: 60,
            onCorruptDuration: 'default',
            maxDurationMin: null,
        });
        if (!state.active) return inactive;
        return {
            ...state,
            replaces: settings.getEffectiveSetting('scheduledFillReplaces', challengeId) === true,
        };
    } catch (error) {
        logger
            .withCategory('voting')
            .warning(
                `Scheduled-fill evaluation failed for challenge ${oneLineId(challengeId)} — treating it as off`,
                error,
            );
        return inactive;
    }
};

/**
 * Voting-pause state for a challenge at `now` — the inverse of scheduled fill.
 *
 * Motivation: between the overnight match rounds almost nobody is voting, so
 * exposure filled at 03:00 buys far fewer votes than the same swipes spent
 * after the morning round opens. Each votingPauseTime entry opens a daily
 * pause and each votingPauseBeforeEnd entry a one-shot pause, both lasting
 * votingPauseDurationMinutes, all OR'd.
 *
 * Everything here fails OPEN — every degraded path returns "not paused", i.e.
 * keep voting. That direction is the whole safety argument: a broken pause
 * costs some votes at a bad hour, while a pause that failed CLOSED would
 * silently stop voting altogether, which looks exactly like the app being
 * broken. Hence the differences from getScheduledFillState:
 *   - a corrupt duration turns the pause OFF rather than substituting a
 *     default (`onCorruptDuration: 'off'`),
 *   - an over-range duration is CLAMPED, so no hand-edited value can open a
 *     window wide enough to swallow every future cycle (`maxDurationMin`),
 *   - a challenge with no usable close_time is never paused, because the
 *     last-minute rule that would otherwise rescue it also needs that value.
 * Every one of those paths logs; a silent pause is indistinguishable from a bug.
 *
 * @param {any} challenge
 * @param {string} challengeId
 * @param {number} now - Current time (Unix timestamp, seconds)
 * @returns {{active: boolean, inWindow: boolean}}
 */
const getVotingPauseState = (challenge, challengeId, now) => {
    const notPaused = { active: false, inWindow: false };
    try {
        // A non-finite close_time defeats the deadline rules (last-minute and
        // final-window both compare against it), so a pause must not apply
        // either — the time-of-day form doesn't read close_time at all and
        // would otherwise pause such a challenge with nothing left to rescue it.
        if (!Number.isFinite(Number(challenge?.close_time))) return notPaused;
        return _triggerWindowState(challenge, challengeId, now, {
            enabledKey: 'useVotingPause',
            timesKey: 'votingPauseTime',
            beforeEndKey: 'votingPauseBeforeEnd',
            durationKey: 'votingPauseDurationMinutes',
            defaultDurationMin: 240,
            onCorruptDuration: 'off',
            maxDurationMin: MAX_VOTING_PAUSE_MINUTES,
        });
    } catch (error) {
        logger
            .withCategory('voting')
            .warning(
                `Voting-pause evaluation failed for challenge ${oneLineId(challengeId)} — treating it as not paused`,
                error,
            );
        return notPaused;
    }
};

module.exports = {
    getScheduledFillState,
    getVotingPauseState,
};
