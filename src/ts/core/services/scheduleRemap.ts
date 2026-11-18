/**
 * End-alignment remap for the autoSubmitSchedule rows.
 *
 * Schedule rows are keyed by absolute image number ("Image 2 ≤ 30m before
 * close"), which assumes a challenge that allows the schedule's full span of
 * images. When a challenge allows fewer (e.g. max_photo_submits = 2), the
 * whole schedule shifts toward the end so the last active row's time applies
 * to the challenge's final photo — a 2-image challenge fills its 2nd photo at
 * the Image-4 time, not the (much earlier) Image-2 time. Rows whose shifted
 * position lands below count 2 fall off: entry 1 always exists, because
 * joining a challenge IS submitting the first photo. The shift only ever
 * compresses — a challenge allowing more images than the schedule covers is
 * left untouched.
 *
 * Shared between the voting core (services/autoFill/schedule.ts) and the React
 * renderer (the per-challenge settings modal's hint), following the
 * randomDelay.ts precedent: pure functions — no logger, no settings I/O —
 * so the module stays bundle-friendly for both runtimes.
 */

import type { SettingValues } from '../settings/schema';

export type FillSchedule = SettingValues['autoSubmitSchedule'];

/**
 * The shift for a schedule whose highest active image number is `highestActive` (see getScheduleShift): the part of the
 * span the challenge's photo limit cannot hold, never negative.
 */
const shiftForSpan = (highestActive: number, maxPhotoSubmits: number | undefined): number =>
    Math.max(0, highestActive - (maxPhotoSubmits ?? 0));

/**
 * How far the schedule shifts toward the end for a given challenge: the
 * schedule's active span minus the challenge's photo limit, floored at 0
 * (never stretch, only compress). Span = highest image number with a real
 * (non-off) time; seconds === 0 is the GUI's "off" sentinel and must not
 * extend the span. For any real challenge (max ≥ 2) the shift is bounded to
 * ≤ 2 (rows count images 2–4); a missing max pushes it up to the whole span,
 * where every row shifts away and the schedule goes inert — fail-closed.
 *
 * @param maxPhotoSubmits - challenge.max_photo_submits
 */
const getScheduleShift = (rows: FillSchedule, maxPhotoSubmits: number | undefined): number =>
    shiftForSpan(
        rows.reduce((m, r) => (r.seconds > 0 ? Math.max(m, r.count) : m), 0),
        maxPhotoSubmits,
    );

/**
 * Rows moved `shift` toward the end, the rows that fall below count 2 dropped (a shift of 0 keeps every row as it is).
 * Works on any row that carries a count: the literal schedule's rows and the resolved rows of a dynamic one.
 */
const shiftRowCounts = <T extends { count: number }>(rows: readonly T[], shift: number): T[] =>
    shift === 0 ? [...rows] : rows.map((r) => ({ ...r, count: r.count - shift })).filter((r) => r.count >= 2);

/**
 * The schedule as it effectively applies to a challenge: its rows, shifted
 * toward the end when the challenge allows fewer images than the schedule's
 * active span. A uniform shift keeps counts unique, so no dedupe is needed.
 * Off rows (seconds: 0) shift positionally like the rest but stay inert.
 *
 * @param maxPhotoSubmits - challenge.max_photo_submits
 */
const remapScheduleRows = (
    rows: FillSchedule,
    maxPhotoSubmits: number | undefined,
): Array<{ count: number; seconds: number }> => shiftRowCounts(rows, getScheduleShift(rows, maxPhotoSubmits));

export { getScheduleShift, remapScheduleRows, shiftForSpan, shiftRowCounts };
