/**
 * Auto-fill — schedule-row validation and the end-aligned threshold math that
 * the staggered fill trigger and the scheduler cadence share.
 */

const { remapScheduleRows } = require('../scheduleRemap');

/**
 * Rows of an autoFillSchedule value that are actually usable. The value comes
 * straight off the persisted settings blob via getEffectiveSetting — no zod
 * re-validation happens on read — and these helpers run for every challenge on
 * every voting pass, so a throw here would skip that challenge's remaining
 * actions on every pass for as long as the blob stays corrupted. Anything that
 * isn't an array of { count, seconds } objects with finite numbers is silently
 * dropped (mirrors getSlotsRemaining's Number.isFinite convention). Length is
 * capped as defense-in-depth: the write path (zod) allows at most
 * MAX_SCHEDULE_ROWS = 3 rows (see settings/schema.js), so anything past a
 * generous read cap can only come from a corrupted blob and would otherwise
 * be iterated every scheduler cycle per challenge.
 *
 * @param {*} schedule
 * @returns {Array<{count: number, seconds: number}>}
 */
const MAX_SCHEDULE_ROWS_READ = 100;
const getValidScheduleRows = (schedule) =>
    Array.isArray(schedule)
        ? schedule
              .slice(0, MAX_SCHEDULE_ROWS_READ)
              .filter(
                  (row) => row && typeof row === 'object' && Number.isFinite(row.count) && Number.isFinite(row.seconds),
              )
        : [];

/**
 * The schedule as it effectively applies to one challenge: valid rows,
 * end-aligned to the challenge's photo limit by scheduleRemap (a 2-image
 * challenge fills its 2nd photo at the Image-4 row's time — see that module's
 * header for the rule). Both threshold computations below MUST go through
 * this so the fill trigger and the scheduler cadence always agree.
 *
 * @param {*} schedule - persisted autoFillSchedule value (untrusted shape)
 * @param {*} maxPhotoSubmits - challenge.max_photo_submits (untrusted shape)
 * @returns {Array<{count: number, seconds: number}>}
 */
const getEffectiveScheduleRows = (schedule, maxPhotoSubmits) =>
    remapScheduleRows(getValidScheduleRows(schedule), maxPhotoSubmits);

/**
 * Target entry count implied by the schedule for the time remaining: the
 * largest row count whose threshold has been reached, over the END-ALIGNED
 * effective rows (getEffectiveScheduleRows — a 2-image challenge's 2nd photo
 * follows the Image-4 row's time), each row clamped to the challenge's
 * max_photo_submits as a residual safety net. Row order is irrelevant.
 * Returns 0 for an empty/invalid schedule, a non-finite secondsRemaining, or
 * a non-finite max (never NaN — a NaN would poison orderDeadlineActions'
 * sort downstream).
 *
 * @param {*} schedule - persisted autoFillSchedule value (untrusted shape)
 * @param {number} secondsRemaining
 * @param {*} maxPhotoSubmits - challenge.max_photo_submits (untrusted shape)
 * @returns {number}
 */
const resolveScheduleTarget = (schedule, secondsRemaining, maxPhotoSubmits) => {
    const max = Number.isFinite(maxPhotoSubmits) ? maxPhotoSubmits : 0;
    if (!Number.isFinite(secondsRemaining)) return 0;
    let target = 0;
    for (const row of getEffectiveScheduleRows(schedule, maxPhotoSubmits)) {
        if (secondsRemaining <= row.seconds) {
            target = Math.max(target, Math.min(row.count, max));
        }
    }
    return target;
};

/**
 * Seconds-before-close at which the next auto-fill becomes due: the largest
 * threshold among END-ALIGNED effective rows (getEffectiveScheduleRows) whose
 * clamped count exceeds the current entry count. 0 when no further row can
 * ever apply (schedule empty/invalid, or every remaining row is already
 * satisfied / shifted away). Used by VotingLogic's orderDeadlineActions so
 * fills sort against boost/turbo/emergency correctly; the same defensive
 * rules as resolveScheduleTarget apply.
 *
 * @param {*} schedule - persisted autoFillSchedule value (untrusted shape)
 * @param {*} entryCount - current number of entries (untrusted shape)
 * @param {*} maxPhotoSubmits - challenge.max_photo_submits (untrusted shape)
 * @returns {number}
 */
const getNextScheduleThresholdSec = (schedule, entryCount, maxPhotoSubmits) => {
    const max = Number.isFinite(maxPhotoSubmits) ? maxPhotoSubmits : 0;
    const count = Number.isFinite(entryCount) ? entryCount : 0;
    let threshold = 0;
    for (const row of getEffectiveScheduleRows(schedule, maxPhotoSubmits)) {
        if (Math.min(row.count, max) > count) {
            threshold = Math.max(threshold, row.seconds);
        }
    }
    return threshold;
};

module.exports = {
    getValidScheduleRows,
    getEffectiveScheduleRows,
    resolveScheduleTarget,
    getNextScheduleThresholdSec,
};
