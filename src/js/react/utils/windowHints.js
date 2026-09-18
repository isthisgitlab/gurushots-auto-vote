/**
 * Trigger-window derivation for the settings-modal hints.
 *
 * Two features are built on the same pair of trigger LISTS — scheduled fill
 * (vote inside the window) and the voting pause (refuse to vote inside it) —
 * so both hint blocks derive their state from here rather than each carrying
 * its own copy of the occurrence math.
 *
 * Mirrors `_triggerWindowState` in `services/VotingLogic.js`: same cap slice,
 * same "active needs at least one USABLE entry" rule, same corrupt-value
 * fallbacks. Keeping the two in step is the point — a hint must never promise
 * a window the decision path won't open, or stay silent about one it will.
 *
 * Pure renderer util (no Node/service deps), mirroring formatters.js /
 * challengeApplicability.js. Deliberately returns the next window's trigger as
 * DATA (`{kind: 'time'|'beforeEnd', ...}`) rather than a translated string, so
 * this module needs no translation function and the wording stays in the
 * component that renders it.
 */

import { occurrencesOf } from '../../scheduling/wallClock';
import { MAX_SCHEDULED_FILL_ENTRIES } from '../../settings/limits';

/**
 * @typedef {object} WindowHintState
 * @property {string[]} times - Parsed-shape daily entries, cap-sliced.
 * @property {number[]} beforeEnds - Positive seconds-before-close entries, cap-sliced.
 * @property {number} durationMin - Window length in minutes (schema default on corruption).
 * @property {number} durationSec - Same, in seconds.
 * @property {boolean} enabled - The master switch alone.
 * @property {{entry: string, occ: {prev: number, next: number}}[]} timeOccs
 * @property {boolean} timeSet - At least one PARSEABLE daily entry.
 * @property {boolean} active - Enabled AND at least one usable entry in either list.
 * @property {{start: number, source: {kind: 'time', value: string}|{kind: 'beforeEnd', seconds: number}}|null} next
 * @property {boolean} openNow - `next` is a window that has already started.
 */

/**
 * Derive one feature's window state for hint rendering.
 *
 * @param {object} params
 * @param {{enabled: string, times: string, beforeEnd: string, duration: string}} params.keys
 *   The four setting keys this feature stores its config under.
 * @param {number} params.defaultDurationMin - Fallback when the stored duration is corrupt.
 * @param {(key: string) => any} params.effectiveOf - Resolver for the challenge's effective value.
 * @param {string} params.timezone - App timezone; daily times are read in it, never device-local.
 * @param {number} params.nowSec
 * @param {number} params.closeTime - Challenge close time, or 0 when unknown.
 * @returns {WindowHintState}
 */
export function deriveWindowHints({
    keys,
    defaultDurationMin,
    effectiveOf,
    timezone,
    nowSec,
    closeTime,
    // Required, not defaulted — same guardrail as _triggerWindowState's: a
    // future third caller must state its corruption direction explicitly
    // rather than silently inherit scheduled fill's.
    onCorruptDuration,
    maxDurationMin,
}) {
    const rawTimes = effectiveOf(keys.times);
    const times = (Array.isArray(rawTimes) ? rawTimes : []).slice(0, MAX_SCHEDULED_FILL_ENTRIES);
    const rawBeforeEnds = effectiveOf(keys.beforeEnd);
    const beforeEnds = (Array.isArray(rawBeforeEnds) ? rawBeforeEnds : [])
        .slice(0, MAX_SCHEDULED_FILL_ENTRIES)
        .map(Number)
        .filter((sec) => sec > 0);
    // Duration resolution mirrors _triggerWindowState exactly, INCLUDING the
    // per-feature corruption policy — a `Number(x) || default` shortcut here
    // would silently honour a negative hand-edited value the engine rejects,
    // and would show a scheduled-fill-style fallback for a pause the engine
    // turns off. Diverging on this is precisely how a hint starts promising a
    // window that never opens.
    const rawDuration = Number(effectiveOf(keys.duration));
    const durationValid = Number.isFinite(rawDuration) && rawDuration > 0;
    const durationCorruptDisables = !durationValid && onCorruptDuration === 'off';
    let durationMin = durationValid ? rawDuration : defaultDurationMin;
    if (maxDurationMin && durationMin > maxDurationMin) durationMin = maxDurationMin;
    const durationSec = durationMin * 60;
    const enabled = effectiveOf(keys.enabled) === true && !durationCorruptDisables;

    // Explicit arrow (never `map(occurrencesOf)`): map's (element, index,
    // array) signature would bind the index to the timeZone parameter. Each
    // occurrence stays PAIRED with its source entry before the invalid ones are
    // filtered out — a filter-then-reindex against `times` would mislabel every
    // hint source after the first unparseable entry.
    let timeOccs;
    try {
        timeOccs = times.map((entry) => ({ entry, occ: occurrencesOf(entry, timezone, nowSec) })).filter((p) => p.occ);
    } catch {
        timeOccs = [];
    }
    const timeSet = timeOccs.length > 0;
    const active = enabled && (timeSet || beforeEnds.length > 0);

    // Next-window candidates from BOTH lists: per time entry the open-or-next
    // occurrence, per before-end entry its one-shot start while the window is
    // still at least partly ahead. Each carries its producing trigger so the
    // hint can name whose window is shown.
    const candidates = [];
    for (const { entry, occ } of timeOccs) {
        const start = nowSec - occ.prev <= durationSec ? occ.prev : occ.next;
        candidates.push({ start, source: { kind: 'time', value: entry } });
    }
    for (const sec of beforeEnds) {
        if (closeTime <= nowSec) continue;
        const start = closeTime - sec;
        if (nowSec <= start + durationSec) {
            candidates.push({ start, source: { kind: 'beforeEnd', seconds: sec } });
        }
    }
    const next = candidates.reduce((best, c) => (best === null || c.start < best.start ? c : best), null);

    return {
        times,
        beforeEnds,
        durationMin,
        durationSec,
        enabled,
        timeOccs,
        timeSet,
        active,
        next,
        openNow: active && next !== null && next.start <= nowSec,
        coversWholeDay: active && coversWholeDay(timeOccs, durationSec),
    };
}

/**
 * Do the recurring daily windows leave NO uncovered moment in a 24h day?
 *
 * Exact rather than `entries × duration >= 24h`, which over-reports whenever
 * windows overlap (two 12h windows an hour apart cover 13h, not 24h). Sorts the
 * daily start offsets and checks every circular gap: full coverage means each
 * window reaches the next start. One window can never cover a day on its own,
 * since the schema caps a duration at 720 minutes.
 *
 * Only the daily entries count — before-end offsets are one-shot and can't
 * recur, so they cannot close the loop. DST is ignored: a changeover day can
 * shift a window by an hour, which does not change the advice this drives.
 *
 * @param {{entry: string}[]} timeOccs - Entries already known to be parseable.
 * @param {number} durationSec
 * @returns {boolean}
 */
function coversWholeDay(timeOccs, durationSec) {
    // Deduped first: two identical starts would each see a zero gap to the
    // other and report full coverage off a single window. The validator's
    // dedupe makes that unreachable through the save path, but a hand-edited
    // file must not produce a bogus warning.
    const starts = [
        ...new Set(
            timeOccs.map(({ entry }) => {
                const [h, m] = entry.split(':');
                return Number(h) * 3600 + Number(m) * 60;
            }),
        ),
    ].sort((a, b) => a - b);
    if (starts.length < 2) return durationSec >= 86400;
    return starts.every((start, i) => {
        const nextStart = starts[(i + 1) % starts.length];
        // Circular distance to the next start; 0 for a duplicate entry, which
        // is trivially covered.
        const gap = (nextStart - start + 86400) % 86400;
        return gap <= durationSec;
    });
}
