/**
 * End-alignment remap for the autoFillSchedule rows.
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
 * Shared between the voting core (services/autoFill.js) and the React
 * renderer (ChallengeSettingsModal's per-challenge hint), following the
 * randomDelay.js precedent: pure functions — no logger, no settings I/O —
 * so the module stays bundle-friendly for both runtimes.
 */

// Mirror of schema.js MAX_SCHEDULE_COUNT (GuruShots hard limit of 4 images).
// Not imported: schema.js isn't renderer-bundle-safe (zod) and doesn't export
// it. schema.js carries a back-reference comment; keep the two in sync.
const MAX_SCHEDULE_COUNT = 4;

// Mirror of autoFill.js MAX_SCHEDULE_ROWS_READ, applied here as well because
// the renderer calls this module directly on the raw settings value — without
// autoFill.js's getValidScheduleRows cap on the path — and re-runs it on every
// modal render. A corrupted, hand-edited blob with a pathologically long array
// must not walk in full per keystroke.
const MAX_ROWS_READ = 100;

const isSaneCount = (c) => Number.isInteger(c) && c >= 2 && c <= MAX_SCHEDULE_COUNT;

/**
 * Rows that participate in remapping: structurally valid AND count within the
 * schema's 2..MAX_SCHEDULE_COUNT band. Excluding out-of-band counts entirely
 * (not just from the span) is deliberate: a corrupted row (hand-edited
 * settings, e.g. count: 999999) must neither inflate the shift NOR survive
 * into the effective set, where the downstream Math.min clamp would let it
 * fire with its own seconds value — reproducing the too-early-fill bug this
 * module exists to fix. Dropping it is fail-closed (fewer fills; emergency
 * fill remains the safety net). Non-array input is tolerated because the
 * renderer calls these directly, without autoFill.js's getValidScheduleRows
 * guard on the path — settings still resolving during initial load must not
 * throw inside a React render.
 *
 * @param {*} rows
 * @returns {Array<{count: number, seconds: number}>}
 */
const getSaneScheduleRows = (rows) =>
    (Array.isArray(rows) ? rows : [])
        .slice(0, MAX_ROWS_READ)
        .filter((r) => r && typeof r === 'object' && isSaneCount(r.count) && Number.isFinite(r.seconds));

/**
 * How far the schedule shifts toward the end for a given challenge: the
 * schedule's active span minus the challenge's photo limit, floored at 0
 * (never stretch, only compress). Span = highest image number with a real
 * (non-off) time; seconds === 0 is the GUI's "off" sentinel and must not
 * extend the span. For any real challenge (max ≥ 2) the shift is bounded to
 * ≤ MAX_SCHEDULE_COUNT − 2; a smaller/garbage max can push it up to
 * MAX_SCHEDULE_COUNT, where every row shifts away and the schedule goes
 * inert — fail-closed either way.
 *
 * @param {*} rows - schedule rows (untrusted shape)
 * @param {*} maxPhotoSubmits - challenge.max_photo_submits (untrusted shape)
 * @returns {number}
 */
const getScheduleShift = (rows, maxPhotoSubmits) => {
    const max = Number.isFinite(maxPhotoSubmits) ? maxPhotoSubmits : 0;
    const highestActive = getSaneScheduleRows(rows).reduce((m, r) => (r.seconds > 0 ? Math.max(m, r.count) : m), 0);
    return Math.max(0, highestActive - max);
};

/**
 * The schedule as it effectively applies to a challenge: sane rows, shifted
 * toward the end when the challenge allows fewer images than the schedule's
 * active span. A uniform shift keeps counts unique, so no dedupe is needed.
 * Off rows (seconds: 0) shift positionally like the rest but stay inert.
 *
 * @param {*} rows - schedule rows (untrusted shape)
 * @param {*} maxPhotoSubmits - challenge.max_photo_submits (untrusted shape)
 * @returns {Array<{count: number, seconds: number}>}
 */
const remapScheduleRows = (rows, maxPhotoSubmits) => {
    const sane = getSaneScheduleRows(rows);
    const shift = getScheduleShift(rows, maxPhotoSubmits);
    if (shift === 0) return sane;
    return sane.map((r) => ({ count: r.count - shift, seconds: r.seconds })).filter((r) => r.count >= 2);
};

module.exports = { getScheduleShift, remapScheduleRows };
