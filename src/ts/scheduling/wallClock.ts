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
 *   - `timeOfDayIn` reads a challenge's close time as the card shows it. An
 *     unknown zone (and 'local') falls back to the DEVICE clock, not UTC: the
 *     rule condition must agree with `formatEndTime`, which does the same.
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
const formatterCache: Map<string, Intl.DateTimeFormat> = new Map();

/**
 * @param timeZone - IANA zone name. Throws RangeError for unknown zones.
 */
const getFormatter = (timeZone: string): Intl.DateTimeFormat => {
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
 * formatToParts → { type: value } accumulation for an instant in `timeZone`.
 * Shared by tzOffsetSeconds and wallDateOf.
 *
 * @param epochSec - Unix timestamp (seconds)
 * @param timeZone - IANA zone name (throws RangeError if unknown)
 */
const partsOf = (epochSec: number, timeZone: string): Record<string, string> => {
    const parts = getFormatter(timeZone).formatToParts(epochSec * 1000);
    const byType: Record<string, string> = {};
    for (const part of parts) {
        byType[part.type] = part.value;
    }
    return byType;
};

/**
 * Strict 'HH:MM' 24-hour parser.
 *
 * @param str - Candidate value; anything but a strict 'HH:MM' string yields null.
 */
const parseTimeOfDay = (str: unknown): { hours: number; minutes: number } | null => {
    if (typeof str !== 'string') {
        return null;
    }
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(str);
    if (!match) {
        return null;
    }
    return { hours: Number(match[1]), minutes: Number(match[2]) };
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Floored 'HH:MM' wall-clock reading of an instant in `timeZone`, the way a
 * challenge card shows its end time. 'local' and unknown zone names read the
 * device clock (card parity — see module notes), so this never throws.
 *
 * @param epochSec - Unix timestamp (seconds)
 * @param timeZone - IANA zone name, or 'local' for the device clock
 */
const timeOfDayIn = (epochSec: number, timeZone: string): string => {
    if (timeZone !== 'local') {
        try {
            const { hour, minute } = partsOf(epochSec, timeZone);
            return `${hour}:${minute}`;
        } catch {
            // Unknown zone: fall through to the device clock, like formatEndTime.
        }
    }
    const date = new Date(epochSec * 1000);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
};

/**
 * Offset (seconds) of `timeZone` from UTC at a given instant. Positive east of
 * UTC (Europe/Riga winter → +7200, summer → +10800).
 *
 * @param epochSec - Unix timestamp (seconds)
 * @param timeZone - IANA zone name (throws RangeError if unknown)
 * @returns Offset in seconds
 */
const tzOffsetSeconds = (epochSec: number, timeZone: string): number => {
    const byType = partsOf(epochSec, timeZone);
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
 * @param y - Full year
 * @param m - Month 1-12
 * @param d - Day of month
 * @param hh - Hour 0-23
 * @param mm - Minute 0-59
 * @param timeZone - IANA zone name (throws RangeError if unknown)
 * @returns Unix timestamp (seconds)
 */
const epochForWallTime = (y: number, m: number, d: number, hh: number, mm: number, timeZone: string): number => {
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
 * @param epochSec - Unix timestamp (seconds)
 * @param timeZone - IANA zone name (throws RangeError if unknown)
 */
const wallDateOf = (epochSec: number, timeZone: string): { y: number; m: number; d: number } => {
    const byType = partsOf(epochSec, timeZone);
    return { y: Number(byType.year), m: Number(byType.month), d: Number(byType.day) };
};

const computeOccurrences = (
    timeOfDay: { hours: number; minutes: number },
    timeZone: string,
    nowSec: number,
): { prev: number; next: number } => {
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
 * @param timeHHMM - 'HH:MM' string; anything unparsable yields null.
 * @param timeZone - IANA zone name; unknown zones fall back to 'UTC'.
 * @param nowSec - Unix timestamp (seconds)
 */
const occurrencesOf = (timeHHMM: unknown, timeZone: string, nowSec: number): { prev: number; next: number } | null => {
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

export { parseTimeOfDay, timeOfDayIn, tzOffsetSeconds, epochForWallTime, occurrencesOf };
