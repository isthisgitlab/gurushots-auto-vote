/**
 * Pure wall-clock ↔ epoch math for the scheduled-fill feature.
 *
 * The scheduled-fill time-of-day form is interpreted in the app's `timezone`
 * setting (an IANA zone name), NOT the device's local clock, so the same
 * settings file produces the same fill instants on the GUI, CLI and Android
 * shells. All conversions go through Intl.DateTimeFormat (available on every
 * shell) — no timezone dependency.
 *
 * Failure posture (deliberate, mirrors the rest of the settings read path):
 *   - `parseTimeOfDay` type-guards its input and returns null for anything
 *     that is not a strict 'HH:MM' string — a hand-edited settings.json can
 *     hold null/numbers/objects, and the voting loop must never throw on it.
 *   - `occurrencesOf` catches the RangeError Intl throws for unknown zone
 *     names and retries with 'UTC'. The guard lives HERE (not in callers)
 *     because the `timezone` setting has no main-process schema validation —
 *     a CLI `settings:set timezone <bad>` writes unvalidated.
 *   - The numeric scheduled-fill keys (window minutes, before-end seconds)
 *     intentionally have no guards in this module: corrupt values coerce to
 *     NaN in the callers' arithmetic, every comparison goes false, and the
 *     feature no-ops. Only the string key needs explicit parsing.
 *
 * DST notes (documented behavior, both fine for a fill window >= 5 min):
 *   - Spring-forward: a configured time that does not exist that day (e.g.
 *     03:30 on the skip day) resolves via the fixed-point inversion to an
 *     instant within an hour of the intended wall time.
 *   - Fall-back: an ambiguous time resolves deterministically to one of the
 *     two instants (whichever the two-iteration fixed point lands on).
 */

// Intl.DateTimeFormat construction is comparatively expensive and the same
// zone is queried several times per voting cycle — cache one formatter per zone.
const formatterCache = new Map();

/**
 * @param {string} timeZone - IANA zone name. Throws RangeError for unknown zones.
 * @returns {Intl.DateTimeFormat}
 */
const getFormatter = (timeZone) => {
    let formatter = formatterCache.get(timeZone);
    if (!formatter) {
        // hourCycle 'h23' (not hour12:false): some ICU versions render midnight
        // as "24" under hour12:false, which would corrupt Date.UTC reassembly.
        formatter = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
        });
        formatterCache.set(timeZone, formatter);
    }
    return formatter;
};

/**
 * Strict 'HH:MM' 24-hour parser.
 *
 * @param {*} str - Candidate value; anything but a strict 'HH:MM' string yields null.
 * @returns {{hours: number, minutes: number}|null}
 */
const parseTimeOfDay = (str) => {
    if (typeof str !== 'string') {
        return null;
    }
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(str);
    if (!match) {
        return null;
    }
    return { hours: Number(match[1]), minutes: Number(match[2]) };
};

/**
 * Offset (seconds) of `timeZone` from UTC at a given instant. Positive east of
 * UTC (Europe/Riga winter → +7200, summer → +10800).
 *
 * @param {number} epochSec - Unix timestamp (seconds)
 * @param {string} timeZone - IANA zone name (throws RangeError if unknown)
 * @returns {number} Offset in seconds
 */
const tzOffsetSeconds = (epochSec, timeZone) => {
    const parts = getFormatter(timeZone).formatToParts(epochSec * 1000);
    const byType = {};
    for (const part of parts) {
        byType[part.type] = part.value;
    }
    const asUtc =
        Date.UTC(
            Number(byType.year),
            Number(byType.month) - 1,
            Number(byType.day),
            Number(byType.hour),
            Number(byType.minute),
            Number(byType.second),
        ) / 1000;
    return asUtc - epochSec;
};

/**
 * Epoch seconds of the wall-clock instant (y-m-d hh:mm) in `timeZone`.
 * Two-iteration fixed point: start from the naive UTC reading, correct by the
 * zone offset sampled at each successive guess. Converges everywhere except
 * exactly at a DST transition, where it lands deterministically within an
 * hour of the intended wall time (see module notes).
 *
 * @param {number} y - Full year
 * @param {number} m - Month 1-12
 * @param {number} d - Day of month
 * @param {number} hh - Hour 0-23
 * @param {number} mm - Minute 0-59
 * @param {string} timeZone - IANA zone name (throws RangeError if unknown)
 * @returns {number} Unix timestamp (seconds)
 */
const epochForWallTime = (y, m, d, hh, mm, timeZone) => {
    const naive = Date.UTC(y, m - 1, d, hh, mm) / 1000;
    let guess = naive;
    for (let i = 0; i < 2; i++) {
        guess = naive - tzOffsetSeconds(guess, timeZone);
    }
    return guess;
};

/**
 * Wall-clock date of an instant in `timeZone`.
 *
 * @param {number} epochSec - Unix timestamp (seconds)
 * @param {string} timeZone - IANA zone name (throws RangeError if unknown)
 * @returns {{y: number, m: number, d: number}}
 */
const wallDateOf = (epochSec, timeZone) => {
    const parts = getFormatter(timeZone).formatToParts(epochSec * 1000);
    const byType = {};
    for (const part of parts) {
        byType[part.type] = part.value;
    }
    return { y: Number(byType.year), m: Number(byType.month), d: Number(byType.day) };
};

/**
 * @param {{hours: number, minutes: number}} timeOfDay
 * @param {string} timeZone
 * @param {number} nowSec
 * @returns {{prev: number, next: number}}
 */
const computeOccurrences = (timeOfDay, timeZone, nowSec) => {
    // Candidate occurrences on yesterday / today / tomorrow (dates derived by
    // shifting the epoch ±24h and re-reading the wall date, so month and DST
    // edges are handled by Intl rather than naive date arithmetic).
    const candidates = [nowSec - 86400, nowSec, nowSec + 86400].map((sec) => {
        const { y, m, d } = wallDateOf(sec, timeZone);
        return epochForWallTime(y, m, d, timeOfDay.hours, timeOfDay.minutes, timeZone);
    });
    let prev = -Infinity;
    let next = Infinity;
    for (const candidate of candidates) {
        if (candidate <= nowSec && candidate > prev) {
            prev = candidate;
        }
        if (candidate > nowSec && candidate < next) {
            next = candidate;
        }
    }
    return { prev, next };
};

/**
 * The occurrences of a 'HH:MM' wall-clock time (in `timeZone`) bracketing
 * `nowSec`: `prev` is the latest occurrence <= now (today or yesterday),
 * `next` the earliest occurrence > now (today or tomorrow).
 *
 * @param {*} timeHHMM - 'HH:MM' string; anything unparsable yields null.
 * @param {string} timeZone - IANA zone name; unknown zones fall back to 'UTC'.
 * @param {number} nowSec - Unix timestamp (seconds)
 * @returns {{prev: number, next: number}|null}
 */
const occurrencesOf = (timeHHMM, timeZone, nowSec) => {
    const timeOfDay = parseTimeOfDay(timeHHMM);
    if (!timeOfDay) {
        return null;
    }
    try {
        return computeOccurrences(timeOfDay, timeZone, nowSec);
    } catch {
        // Intl throws RangeError for unknown zone names; the timezone setting
        // is not schema-validated, so degrade to UTC instead of throwing into
        // the voting loop.
        return computeOccurrences(timeOfDay, 'UTC', nowSec);
    }
};

module.exports = { parseTimeOfDay, tzOffsetSeconds, epochForWallTime, occurrencesOf };
