import { deriveWindowHints } from '@/utils/windowHints';
import { formatSecondsAsHoursMinutes } from '@/utils/timeFieldUnits';
import { MAX_VOTING_PAUSE_MINUTES } from '../../../settings/limits';
import { DEFAULT_TIMEZONE } from '../../../settings/uiDefaults';

/**
 * Conditional inline hints shown under a setting in the global and
 * per-challenge settings modals. A hint is `{ tone, text }`: `tone` is the
 * DaisyUI text-colour class list, `text` the translated sentence. Each modal
 * builds a `hintsFor(key)` resolver once per render (the window state is
 * derived from the live form values) and renders it with SettingHintList.
 *
 * Every hint table is keyed by the setting the warning belongs UNDER — add an
 * entry there rather than a second hint list at the render site.
 */

const SCHEDULED_FILL_KEYS = {
    enabled: 'useScheduledFill',
    times: 'scheduledFillTime',
    beforeEnd: 'scheduledFillBeforeEnd',
    duration: 'scheduledFillWindowMinutes',
};

const VOTING_PAUSE_KEYS = {
    enabled: 'useVotingPause',
    times: 'votingPauseTime',
    beforeEnd: 'votingPauseBeforeEnd',
    duration: 'votingPauseDurationMinutes',
};

// Voting pause's corruption policy. Must match getVotingPauseState's, or a
// hint would advertise a pause the decision path refuses to open.
const VOTING_PAUSE_POLICY = {
    defaultDurationMin: 240,
    onCorruptDuration: 'off',
    maxDurationMin: MAX_VOTING_PAUSE_MINUTES,
};

// Scheduled fill's own policy, stated explicitly: substitute the default on
// corruption, no ceiling (an oversized fill window just means "always fill",
// which is harmless).
const SCHEDULED_FILL_POLICY = { defaultDurationMin: 60, onCorruptDuration: 'default', maxDurationMin: null };

const lookupHints = (table, key, ctx) => table.get(key)?.(ctx) ?? [];

/**
 * 'HH:MM' of an epoch-seconds instant in `timezone`. Range-guarded BEFORE
 * formatting: the toISOString fallback throws RangeError past ±8.64e15 ms, so
 * an out-of-range input would take the whole modal into the ErrorBoundary
 * rather than degrade to a label.
 */
function formatClockInTz(epochSec, timezone) {
    const ms = Number(epochSec) * 1000;
    if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return '—';
    try {
        return new Intl.DateTimeFormat(undefined, {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).format(ms);
    } catch {
        return new Date(ms).toISOString().slice(11, 16);
    }
}

const formatOffset = (seconds, t) => formatSecondsAsHoursMinutes(seconds, t('app.hours'), t('app.minutes'));

/**
 * Render a window's producing trigger: a daily 'HH:MM' or an offset label.
 * Only called with a derived `next.source`, which always carries its kind
 * plus `value` (time) or `seconds` (beforeEnd) — see utils/windowHints.
 */
const sourceLabel = (source, t) =>
    source.kind === 'beforeEnd'
        ? t('app.scheduledFillSourceBeforeEnd').replace('{0}', formatOffset(source.seconds, t))
        : source.value;

/**
 * The "next window" status line shared by scheduled fill and the voting pause:
 * start–end in the app timezone plus the trigger that opens it.
 */
const nextWindowText = (template, { next, durationSec }, { timezone, t }) =>
    template
        .replace('{0}', formatClockInTz(next.start, timezone))
        .replace('{1}', formatClockInTz(next.start + durationSec, timezone))
        .replace('{2}', timezone)
        .replace('{3}', sourceLabel(next.source, t));

/**
 * Pre-boost fill: the fill spends votes, so any setting that blocks voting
 * above the pre-boost branch in _runVotingRules cancels it silently — onlyBoost
 * ("never vote, only boost") sits at the very top of the rule engine, and
 * voteOnlyInLastMinute blocks above it too. Two settings that each look
 * correct alone silently cancelling out is exactly what an inline warning is
 * for; a per-challenge override is where that pairing typically gets made.
 */
function boostPrefillHints({ effectiveOf, t }) {
    const hints = [];
    if (effectiveOf('voteBeforeBoost') !== true) return hints;
    if (effectiveOf('onlyBoost') === true) {
        hints.push({ tone: 'text-warning font-medium', text: t('app.voteBeforeBoostOnlyBoostHint') });
    }
    if (effectiveOf('autoBoost') !== true) {
        hints.push({ tone: 'text-warning', text: t('app.voteBeforeBoostNoAutoBoostHint') });
    }
    if (effectiveOf('voteOnlyInLastMinute') === true) {
        hints.push({ tone: 'text-warning', text: t('app.voteBeforeBoostLastMinuteOnlyHint') });
    }
    // Both boost clocks off (0 = off on each) means no boost is ever
    // auto-applied, so there is no instant to fill ahead of.
    if (Number(effectiveOf('boostTime')) === 0 && Number(effectiveOf('keyUnlockedBoostTime')) === 0) {
        hints.push({ tone: 'text-warning', text: t('app.voteBeforeBoostNoBoostTimeHint') });
    }
    return hints;
}

const allDayPauseHint = (t) => ({ tone: 'text-warning font-medium', text: t('app.votingPauseAllDayHint') });

// ---- Global defaults ------------------------------------------------------

const GLOBAL_HINTS = new Map([
    [
        'useVotingPause',
        ({ formValues, votingPause, t }) => {
            const hints = [];
            const noTriggers =
                (formValues.votingPauseTime ?? []).length === 0 && (formValues.votingPauseBeforeEnd ?? []).length === 0;
            if (formValues.useVotingPause === true && noTriggers) {
                hints.push({ tone: 'text-warning', text: t('app.votingPauseNoTimesHint') });
            }
            if (votingPause.coversWholeDay) hints.push(allDayPauseHint(t));
            return hints;
        },
    ],
    ['voteBeforeBoost', boostPrefillHints],
]);

/**
 * `hintsFor(key)` for the GLOBAL defaults form. A nightly pause is most
 * naturally configured here rather than per challenge, so without these the
 * typical user would never see "enabled but no time set" or "this covers the
 * whole day". Only the daily entries can be judged globally — before-end
 * offsets are relative to a specific challenge's deadline, hence closeTime 0,
 * which yields no before-end candidates.
 */
export function globalSettingHints({ formValues, schema, timezone, t }) {
    const effectiveOf = (key) => formValues[key] ?? schema?.[key]?.default;
    const votingPause = deriveWindowHints({
        keys: VOTING_PAUSE_KEYS,
        ...VOTING_PAUSE_POLICY,
        effectiveOf,
        // Never empty: useSettingsForm's string fallback treats '' as unset.
        timezone,
        nowSec: Math.floor(Date.now() / 1000),
        closeTime: 0,
    });
    const ctx = { formValues, effectiveOf, votingPause, t };
    return (key) => lookupHints(GLOBAL_HINTS, key, ctx);
}

// ---- Per-challenge overrides ----------------------------------------------

/**
 * With replace mode on, is any fill window still reachable for THIS
 * challenge? Unreachable means replace mode keeps blocking threshold voting
 * with no fill ever coming (e.g. a "5h before end" profile applied to a
 * challenge with 2h left).
 */
function isScheduledFillUnreachable(fill, { nowSec, closeTime }) {
    const beforeEndReachable = fill.beforeEnds.some((sec) => nowSec <= closeTime - sec + fill.durationSec);
    const timeOfDayReachable = fill.timeOccs.some(
        ({ occ }) => nowSec - occ.prev <= fill.durationSec || occ.next < closeTime,
    );
    return !beforeEndReachable && !timeOfDayReachable;
}

/**
 * A window shorter than the longest gap between voting cycles can be stepped
 * straight over. Gated on the window being active, and on a known cadence.
 */
const shortWindowHints = (win, templateKey, { checkFrequencyMax, t }) =>
    win.active && checkFrequencyMax > 0 && win.durationMin < checkFrequencyMax
        ? [{ tone: 'text-warning', text: t(templateKey).replace('{0}', String(checkFrequencyMax)) }]
        : [];

// ---- Per-challenge: scheduled fill -----------------------------------------

/**
 * On the master-toggle row (feature-level status): a before-end-only config
 * would never see the next-window hint on the daily-times row. It gates on
 * `enabled` like every value-derived hint: a time typed in while the toggle is
 * off must not render an "active schedule" status.
 */
function scheduledFillStatusHints(ctx) {
    const { fill, t } = ctx;
    const hints = [];
    if (fill.enabled && !fill.timeSet && fill.beforeEnds.length === 0) {
        hints.push({ tone: 'text-warning', text: t('app.scheduledFillNoTimesHint') });
    }
    if (fill.enabled && fill.next) {
        hints.push({ tone: 'text-info', text: nextWindowText(t('app.scheduledFillNextHint'), fill, ctx) });
    }
    return hints;
}

/** Before-end offsets shorter than the fill window waste part of it. */
function wastedFillWindowHints({ fill, t }) {
    if (!fill.enabled) return [];
    const wasted = fill.beforeEnds.filter((sec) => sec < fill.durationSec);
    if (wasted.length === 0) return [];
    const offsets = wasted.map((sec) => formatOffset(sec, t)).join(', ');
    return [{ tone: 'text-warning', text: t('app.scheduledFillWastedWindowHint').replace('{0}', offsets) }];
}

function fillReplacesHints({ profileReplacesWarning, fillUnreachable, t }) {
    const hints = [];
    if (profileReplacesWarning) {
        hints.push({ tone: 'text-warning font-medium', text: t('app.scheduledFillProfileReplacesWarning') });
    }
    if (fillUnreachable) hints.push({ tone: 'text-warning', text: t('app.scheduledFillUnreachableHint') });
    return hints;
}

// ---- Per-challenge: voting pause -------------------------------------------

/**
 * All pause status sits on the master-toggle row for the same reason
 * scheduled fill's does: a before-end-only config would never see a hint
 * rendered on the daily-times row.
 */
function votingPauseStatusHints(ctx) {
    const { pause, timezone, t } = ctx;
    const hints = [];
    if (pause.enabled && !pause.timeSet && pause.beforeEnds.length === 0) {
        hints.push({ tone: 'text-warning', text: t('app.votingPauseNoTimesHint') });
    }
    // A pause open RIGHT NOW is reported as an END time — "voting
    // resumes at …" is what the user actually wants to know.
    if (pause.openNow) {
        const until = formatClockInTz(pause.next.start + pause.durationSec, timezone);
        hints.push({
            tone: 'text-warning',
            text: t('app.votingPauseActiveHint').replace('{0}', until).replace('{1}', timezone),
        });
    } else if (pause.active && pause.next) {
        hints.push({ tone: 'text-info', text: nextWindowText(t('app.votingPauseNextHint'), pause, ctx) });
    }
    // Daily pauses that leave no uncovered moment — outside the
    // last-minute rules such a challenge would never vote automatically.
    if (pause.coversWholeDay) hints.push(allDayPauseHint(t));
    return hints;
}

const CHALLENGE_HINTS = new Map([
    ['useScheduledFill', scheduledFillStatusHints],
    ['scheduledFillBeforeEnd', wastedFillWindowHints],
    ['scheduledFillWindowMinutes', (ctx) => shortWindowHints(ctx.fill, 'app.scheduledFillShortWindowHint', ctx)],
    ['scheduledFillReplaces', fillReplacesHints],
    ['useVotingPause', votingPauseStatusHints],
    // The pause's counterpart to the fill's short-window hint, and it matters
    // MORE here: the pause is deliberately not a cadence input (see
    // docs/scheduling.md), so the scheduler never wakes for a pause boundary.
    // A pause shorter than the longest gap between cycles can therefore be
    // stepped straight over, and voting proceeds as if it were never set.
    ['votingPauseDurationMinutes', (ctx) => shortWindowHints(ctx.pause, 'app.votingPauseShortWindowHint', ctx)],
    ['voteBeforeBoost', boostPrefillHints],
]);

/**
 * `hintsFor(key)` for the per-challenge overrides form, derived fresh per
 * render from the effective (override-or-inherited) values. Both triggers are
 * LISTS; every entry opens its own window. The trigger-window derivation
 * lives in utils/windowHints.js, which mirrors _triggerWindowState in
 * services/decisions/triggerWindows.js so a hint can never claim a window the decision
 * path won't open.
 */
export function challengeSettingHints({ effectiveOf, appSettings, challenge, profileReplacesWarning, t }) {
    const timezone = appSettings?.timezone || DEFAULT_TIMEZONE;
    const nowSec = Math.floor(Date.now() / 1000);
    const closeTime = Number(challenge?.close_time) || 0;
    const derive = (keys, policy) => deriveWindowHints({ keys, ...policy, effectiveOf, timezone, nowSec, closeTime });
    const fill = derive(SCHEDULED_FILL_KEYS, SCHEDULED_FILL_POLICY);
    const pause = derive(VOTING_PAUSE_KEYS, VOTING_PAUSE_POLICY);
    const fillUnreachable =
        fill.active &&
        effectiveOf('scheduledFillReplaces') === true &&
        closeTime > nowSec &&
        isScheduledFillUnreachable(fill, { nowSec, closeTime });
    const ctx = {
        effectiveOf,
        fill,
        pause,
        fillUnreachable,
        profileReplacesWarning,
        timezone,
        checkFrequencyMax: Number(appSettings?.checkFrequencyMax) || 0,
        t,
    };
    return (key) => lookupHints(CHALLENGE_HINTS, key, ctx);
}

/** Renders a `hintsFor(key)` result under a setting. */
export function SettingHintList({ hints }) {
    return hints.map((hint) => (
        <p key={hint.text} className={`text-xs mt-1 ${hint.tone}`}>
            {hint.text}
        </p>
    ));
}
