/**
 * Auto-fill — the one resolved form of a submit schedule, and the math the staggered fill trigger, the deadline ordering and
 * the scheduler cadence share.
 *
 * Two sources lower into it: the literal `autoSubmitSchedule` setting (rows of "image N ≤ S seconds before close") and a
 * scenario phase's dynamic `schedules.submit` (rows of "image N due by this instant", worked out from the challenge's own
 * evidence when the phase is published). Each row is known (its instant), confirmed absent (inactive) or unknown (the
 * evidence could not tell). Everything that acts on a schedule reads these rows, so execution, ordering, the final live
 * recheck and the next wake cannot disagree.
 */

import { shiftForSpan, shiftRowCounts } from '../scheduleRemap';
import { evaluateExpression } from '../../scenarios/expressions';
import { known, pending, unknownOf } from '../../scenarios/valueState';
import { finiteOr } from '../../numbers';
import { MAX_VOTING_PAUSE_MINUTES } from '../../settings/limits';

import type { FillSchedule } from '../scheduleRemap';
import type { ExpressionContext } from '../../scenarios/expressions';
import type { ValueState } from '../../scenarios/valueState';
import type {
    ResolvedSchedules,
    ResolvedSubmitRow,
    ResolvedSubmitSchedule,
    ResolvedWindowRow,
} from '../../types/autoFill';
import type { ScenarioSchedules } from '../../types/scenario';

/** Why a literal row is inactive: its seconds are the "off" sentinel (0). */
const OFF = 'off';

const isOffRow = (row: ResolvedSubmitRow): boolean => row.state === 'absent' && row.reason === OFF;

/**
 * The literal schedule as resolved rows. An off row (seconds 0, the GUI's sentinel) is checked here, before anything
 * reads the schedule: it is an inactive row that does not extend the schedule's span. A close time that cannot be read
 * leaves no rows: nothing is due before it is known.
 *
 * @param closeTime - challenge.close_time (unix seconds); the rows' instants are measured back from it
 */
const lowerSubmitSchedule = (schedule: FillSchedule, closeTime: number): ResolvedSubmitSchedule => ({
    alignment: 'end',
    rows: Number.isFinite(closeTime)
        ? schedule.map(
              (row): ResolvedSubmitRow =>
                  row.seconds > 0
                      ? { count: row.count, state: 'known', at: closeTime - row.seconds }
                      : { count: row.count, state: 'absent', reason: OFF },
          )
        : [],
});

/**
 * How far an end-aligned schedule shifts toward the end for this challenge (0 for an absolute one): its span is the highest
 * count of a row that is not off, as for the literal schedule (scheduleRemap.ts). A confirmed-absent row of a dynamic
 * schedule still holds its place in the span: what the evidence says never moves another row's slot.
 */
const submitShift = (schedule: ResolvedSubmitSchedule, maxPhotoSubmits: number | undefined): number =>
    schedule.alignment === 'absolute'
        ? 0
        : shiftForSpan(
              schedule.rows.reduce((highest, row) => (isOffRow(row) ? highest : Math.max(highest, row.count)), 0),
              maxPhotoSubmits,
          );

/**
 * The schedule as it applies to one challenge: an end-aligned one shifted toward the end when the challenge allows fewer
 * photos than its span (the existing 2-4 count remapping), an absolute one left as written with the rows above the
 * challenge's capacity dropped (a count is never remapped into an earlier slot).
 */
const effectiveSubmitRows = (
    schedule: ResolvedSubmitSchedule,
    maxPhotoSubmits: number | undefined,
): ResolvedSubmitRow[] =>
    schedule.alignment === 'absolute'
        ? schedule.rows.filter((row) => row.count <= finiteOr(maxPhotoSubmits, 0))
        : shiftRowCounts(schedule.rows, submitShift(schedule, maxPhotoSubmits));

/** What a schedule authorizes at one instant, over the rows that still matter for the entries the challenge has. */
type SubmitAuthorization = {
    /** The largest count a known row that is due asks for: what the evidence proves must be reached now (0: none). */
    authorizedCount: number;
    /** The overall target when it is exactly known; null while an unsatisfied unknown row could still raise it. */
    exactTarget: number | null;
    /** Why the target is not exact (the first unsatisfied unknown row's reason), or null. */
    unknownReason: string | null;
};

/**
 * Each known due row authorizes its cumulative count, clamped to the challenge's photo limit; the authorized count is the
 * largest. An unknown row cannot raise it and does not cancel another row's authorization; a row the entries already
 * satisfy needs no evidence at all; an absent row is inactive. Row order is irrelevant.
 *
 * @param now - unix seconds
 * @param entryCount - the trusted live entry count
 */
const authorizeSubmit = (
    schedule: ResolvedSubmitSchedule,
    now: number,
    entryCount: number,
    maxPhotoSubmits: number | undefined,
): SubmitAuthorization => {
    const max = finiteOr(maxPhotoSubmits, 0);
    const entries = finiteOr(entryCount, 0);
    let authorizedCount = 0;
    let unknownReason: string | null = null;
    for (const row of effectiveSubmitRows(schedule, maxPhotoSubmits)) {
        const count = Math.min(row.count, max);
        if (row.state === 'known' && row.at <= now) authorizedCount = Math.max(authorizedCount, count);
        if (row.state === 'unknown' && count > entries) unknownReason ??= row.reason;
    }
    return { authorizedCount, exactTarget: unknownReason === null ? authorizedCount : null, unknownReason };
};

/**
 * The highest count the schedule can ever ask for on this challenge: the largest clamped count of a row that is not
 * confirmed absent (an off literal row counts: the schedule the user wrote reaches that slot). Used to tell a schedule that
 * tops out below the challenge's capacity from one that is simply not due yet.
 */
const submitCeiling = (schedule: ResolvedSubmitSchedule, maxPhotoSubmits: number | undefined): number => {
    const max = finiteOr(maxPhotoSubmits, 0);
    let ceiling = 0;
    for (const row of effectiveSubmitRows(schedule, maxPhotoSubmits)) {
        if (row.state === 'known' || isOffRow(row)) ceiling = Math.max(ceiling, Math.min(row.count, max));
    }
    return ceiling;
};

/**
 * Seconds before close at which the next fill becomes due: the largest threshold among the known rows whose clamped count
 * exceeds the entries. 0 when none can apply (every row satisfied, shifted away, absent or unknown: an unknown row supplies
 * no deadline). Used by deadline ordering so fills sort against boost/turbo/emergency correctly.
 *
 * @param closeTime - challenge.close_time (unix seconds)
 */
const nextSubmitThresholdSec = (
    schedule: ResolvedSubmitSchedule,
    entryCount: number,
    maxPhotoSubmits: number | undefined,
    closeTime: number,
): number => {
    const max = finiteOr(maxPhotoSubmits, 0);
    const entries = finiteOr(entryCount, 0);
    let threshold = 0;
    for (const row of effectiveSubmitRows(schedule, maxPhotoSubmits)) {
        if (row.state === 'known' && Math.min(row.count, max) > entries) {
            threshold = Math.max(threshold, closeTime - row.at);
        }
    }
    return threshold;
};

/**
 * Target entry count implied by the literal schedule for the time remaining: the largest row count whose threshold has
 * been reached, over the END-ALIGNED effective rows, each clamped to max_photo_submits. Row order is irrelevant. Returns 0
 * for an empty/invalid schedule, a non-finite secondsRemaining, or a non-finite max (never NaN — a NaN would poison
 * orderDeadlineActions' sort downstream).
 *
 * @param schedule - the challenge's effective autoSubmitSchedule
 * @param maxPhotoSubmits - challenge.max_photo_submits
 */
const resolveScheduleTarget = (
    schedule: FillSchedule,
    secondsRemaining: number,
    maxPhotoSubmits: number | undefined,
): number =>
    Number.isFinite(secondsRemaining)
        ? authorizeSubmit(lowerSubmitSchedule(schedule, 0), -secondsRemaining, 0, maxPhotoSubmits).authorizedCount
        : 0;

/**
 * Seconds-before-close at which the next auto-fill becomes due for the literal schedule: the largest threshold among
 * END-ALIGNED effective rows whose clamped count exceeds the current entry count. 0 when no further row can ever apply
 * (schedule empty/invalid, or every remaining row is already satisfied / shifted away).
 *
 * @param schedule - the challenge's effective autoSubmitSchedule
 * @param entryCount - current number of entries
 * @param maxPhotoSubmits - challenge.max_photo_submits
 */
const getNextScheduleThresholdSec = (
    schedule: FillSchedule,
    entryCount: number,
    maxPhotoSubmits: number | undefined,
): number => nextSubmitThresholdSec(lowerSubmitSchedule(schedule, 0), entryCount, maxPhotoSubmits, 0);

// --- dynamic schedules: resolving a phase's expressions ----------------------------------------------------------------

/** An expression's value as a number of the given quantity, or why it is not one. */
const quantityOf = (
    expr: Parameters<typeof evaluateExpression>[0],
    ctx: ExpressionContext,
    quantity: 'instant' | 'duration',
): ValueState<number> => {
    const value = evaluateExpression(expr, ctx);
    if (value.state !== 'known') return value;
    return value.value.kind === 'number' && value.value.quantity === quantity
        ? known(value.value.value)
        : unknownOf(quantity === 'instant' ? 'not-an-instant' : 'not-a-duration', []);
};

/** A submit row from its instant: known with it, or absent/unknown with the reason the evidence gave. */
const submitRow = (count: number, at: ValueState<number>): ResolvedSubmitRow =>
    at.state === 'known' ? { count, state: 'known', at: at.value } : { count, state: at.state, reason: at.reason };

/**
 * One vote or pause row from its two expressions: known only when both are; unknown when either is (unknown wins over
 * absent); absent when one is confirmed absent and none unknown. A zero-length window is off. `maxSeconds` caps a
 * window's length (a pause must never swallow every cycle).
 */
const windowRow = (
    at: ValueState<number>,
    duration: ValueState<number>,
    maxSeconds: number | null,
): ResolvedWindowRow => {
    if (at.state === 'known' && duration.state === 'known') {
        if (!(duration.value > 0)) return { state: 'absent', reason: OFF };
        const length = maxSeconds === null ? duration.value : Math.min(duration.value, maxSeconds);
        return { state: 'known', start: at.value, end: at.value + length };
    }
    const undecided = pending([at, duration]);
    return at.state === 'unknown' || duration.state === 'unknown'
        ? { state: 'unknown', reason: undecided.reason }
        : { state: 'absent', reason: undecided.reason };
};

/**
 * The phase's dynamic schedules, worked out from the evidence in `ctx` (what a binding may read: base settings and raw
 * facts). A kind the phase does not carry is left out. Never throws: an expression that cannot be worked out is an unknown
 * row.
 */
const evaluateSchedules = (schedules: ScenarioSchedules, ctx: ExpressionContext): ResolvedSchedules => {
    const resolved: ResolvedSchedules = {};
    if (schedules.submit) {
        resolved.submit = {
            alignment: schedules.submit.alignment,
            rows: schedules.submit.rows.map((row) => submitRow(row.count, quantityOf(row.at, ctx, 'instant'))),
        };
    }
    for (const kind of ['vote', 'pause'] as const) {
        const schedule = schedules[kind];
        if (!schedule) continue;
        const maxSeconds = kind === 'pause' ? MAX_VOTING_PAUSE_MINUTES * 60 : null;
        resolved[kind] = {
            rows: schedule.rows.map((row) =>
                windowRow(quantityOf(row.at, ctx, 'instant'), quantityOf(row.duration, ctx, 'duration'), maxSeconds),
            ),
        };
    }
    return resolved;
};

/**
 * Every instant a published schedule's answer can change at: a known submit row's deadline, a known window's start and the
 * first second after its inclusive end. Unknown and absent rows supply none (no deadline is invented for them). The
 * scheduler collects these so it never sleeps past one.
 */
const scheduleInstants = (schedules: ResolvedSchedules | undefined): number[] => {
    const instants: number[] = [];
    for (const row of schedules?.submit?.rows ?? []) if (row.state === 'known') instants.push(row.at);
    for (const kind of ['vote', 'pause'] as const) {
        for (const row of schedules?.[kind]?.rows ?? []) {
            if (row.state === 'known') instants.push(row.start, row.end + 1);
        }
    }
    return instants;
};

export {
    authorizeSubmit,
    effectiveSubmitRows,
    evaluateSchedules,
    getNextScheduleThresholdSec,
    lowerSubmitSchedule,
    nextSubmitThresholdSec,
    resolveScheduleTarget,
    scheduleInstants,
    submitCeiling,
    submitShift,
    windowRow,
};
export type { SubmitAuthorization };
