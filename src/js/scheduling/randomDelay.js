/**
 * Shared between the React renderer (`AutovoteContext.jsx`) and the
 * CLI scheduler (`cli/cli.js`) so the same min/max range produces the
 * same distribution on both surfaces. Pure function — no logger, no
 * settings I/O — so it stays bundle-friendly for both runtimes.
 *
 * Inputs are coerced defensively because the values originate from
 * user input + a settings file that may have been hand-edited. A bad
 * value silently falls back to the legacy 3-minute default rather
 * than throwing inside the timer callback.
 */

const DEFAULT_MINUTES = 3;
const MS_PER_MINUTE = 60_000;
// Floor for the wait between cycle starts when a previous cycle has overrun
// the rolled delay. Without this, an overrun would re-fire immediately and
// hammer the API; with a small pause we recover quickly without busy-looping.
const MIN_CYCLE_GAP_MS = 5_000;

const coerceMinutes = (raw, fallback) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) return fallback;
    return n;
};

const getRandomCheckFrequencyMs = (settings) => {
    const min = coerceMinutes(settings?.checkFrequencyMin, DEFAULT_MINUTES);
    const maxRaw = coerceMinutes(settings?.checkFrequencyMax, min);
    const max = Math.max(min, maxRaw);
    const minutes = min + Math.random() * (max - min);
    return Math.round(minutes * MS_PER_MINUTE);
};

/**
 * Normal-mode wait until the next cycle, anchored to the previous cycle's
 * START so the gap between cycle starts ≈ the rolled delay regardless of how
 * long the cycle itself took. The minGap floor handles an overrun (cycle ran
 * longer than the delay — recover after a short pause instead of re-firing
 * immediately); the delayMs ceiling handles a wall-clock jump backward that
 * would otherwise inflate the wait. Shared by the CLI scheduler
 * (runScheduler.js) and the GUI cadence chain (AutovoteContext.jsx) — this
 * formula drifting between the two is exactly the bug class the extraction
 * prevents.
 *
 * @param {number} delayMs - the rolled normal-mode delay
 * @param {number|null} previousCycleStartMs - anchor; null on a standalone (re)arm
 * @param {number} [nowMs]
 * @param {number} [minGapMs]
 * @returns {number}
 */
const anchoredWaitMs = (delayMs, previousCycleStartMs, nowMs = Date.now(), minGapMs = MIN_CYCLE_GAP_MS) => {
    const anchorMs = previousCycleStartMs ?? nowMs;
    const remainingMs = anchorMs + delayMs - nowMs;
    return Math.min(delayMs, Math.max(minGapMs, remainingMs));
};

module.exports = { getRandomCheckFrequencyMs, anchoredWaitMs, DEFAULT_MINUTES, MS_PER_MINUTE, MIN_CYCLE_GAP_MS };
