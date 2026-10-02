/**
 * How late a timer may fire before the chain calls it out.
 *
 * A `setTimeout` is a floor, not a promise: an OS suspend, macOS App Nap, or
 * Chromium's hidden-page throttling/freezing can hold a renderer timer for
 * tens of minutes. That is not cosmetic here — the entire "never sleep past a
 * boundary" guarantee is void for the duration, and the challenge whose
 * auto-fill or emergency window fell inside the stall closes with an empty
 * slot and NOTHING in the log to say why.
 *
 * So: report it. The floor is a minute — below that, ordinary event-loop and
 * scheduler jitter would spam the log. Above the floor a stall qualifies two
 * ways, and it needs only ONE of them:
 *
 *   - more than half the intended wait: catches a short cadence being badly
 *     overshot (1 minute late on a 1-minute last-minute cadence is the whole
 *     story), while a minute of slip on a 45-minute wait stays quiet;
 *   - OR more than OVERSLEEP_ALWAYS_MS outright, whatever the ratio. The
 *     ratio alone has a blind spot: `checkFrequencyMin/Max` are user-settable
 *     with no upper bound, so on a 30-minute cadence a 12-minute stall is only
 *     40% and would go unreported — yet 12 minutes is longer than the tightest
 *     schedule row and the whole emergency-fill window, i.e. exactly a stall
 *     that costs a deadline. Anything on that scale is worth a line no matter
 *     what it is a fraction of.
 */
export const OVERSLEEP_ABSOLUTE_MS = 60_000;
export const OVERSLEEP_RELATIVE = 0.5;
export const OVERSLEEP_ALWAYS_MS = 5 * 60_000;

/**
 * @param waitMs - the delay that was armed
 * @param actualMs - how long the timer actually took to fire
 * @returns how late it fired, or 0 when that is within tolerance
 */
export const oversleptBy = (waitMs: number, actualMs: number): number => {
    const lateMs = actualMs - waitMs;
    if (lateMs <= OVERSLEEP_ABSOLUTE_MS) return 0;
    return lateMs > waitMs * OVERSLEEP_RELATIVE || lateMs > OVERSLEEP_ALWAYS_MS ? lateMs : 0;
};

/**
 * The one wording for the overslept warning, shared by every host for the same
 * reason DECISION_ERROR_MESSAGE is: two hand-copied templates drift, and this
 * one is read by a user working out why a challenge closed with an empty slot.
 *
 * It follows what happened → why → what next, because it surfaces on the GUI's
 * Logs page, not just in a file. No emoji: `logger.warning` (and the GUI's
 * logWarning) already prefix one.
 *
 * @param lateMs - how far past its due time the timer fired
 * @param waitMs - the delay that was armed
 */
export const formatOversleptMessage = (lateMs: number, waitMs: number): string =>
    `Voting cycle ran ${(lateMs / 60_000).toFixed(1)} min later than scheduled ` +
    `(waited ${(waitMs / 60_000).toFixed(1)} min) — the app was suspended or its timers were throttled, ` +
    `so any auto-submit, boost, turbo or emergency submit due in that gap did not happen. ` +
    `Keep the app window open and the device awake while challenges are near their deadline, ` +
    `or run the CLI (\`cli:start\`), which is not affected.`;
