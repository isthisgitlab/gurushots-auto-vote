/**
 * Shared between the React renderer (`AutovoteContext.jsx`) and the
 * CLI scheduler (`cli/cli.js`) so the same min/max range produces the
 * same distribution on both surfaces. Pure function — no logger, no
 * settings I/O — so it stays bundle-friendly for both runtimes.
 *
 * Inputs are coerced defensively because the values originate from
 * user input + a settings file that may have been hand-edited. A bad
 * value silently falls back to the 3-minute default rather
 * than throwing inside the timer callback.
 */

const DEFAULT_MINUTES = 3;
const MS_PER_MINUTE = 60_000;
// Floor for the wait between cycle starts when a previous cycle has overrun
// the rolled delay. Without this, an overrun would re-fire immediately and
// hammer the API; with a small pause we recover quickly without busy-looping.
const MIN_CYCLE_GAP_MS = 5_000;
// Normal-mode wait ceiling applied while the API is unreachable — i.e. when a
// cycle's challenge fetch returned `fetchFailed` (makePostRequest resolved null
// after exhausting retries, typically a network outage). Without it the loop
// re-arms at the full normal cadence (`checkFrequencyMin/Max`, user-settable
// with no upper bound) after every failed cycle, so recovery — resuming voting
// AND, on the GUI, flipping the status badge off 'Error' via the next
// successful cycle — is gated on that whole interval: reconnect at second 5 of
// a 30-minute cadence and the app sits idle-but-online for ~30 minutes. Capping
// the wait to a short retry makes the next cycle re-probe within seconds of
// connectivity returning, so recovery tracks the reconnection, not the cadence.
// Comfortably above MIN_CYCLE_GAP_MS so a persistent outage re-probes on a calm
// 30s beat, not a tight loop; makePostRequest's own retry/backoff adds spacing
// on top. Shared by the cadence chain (GUI/CLI) and the Android headless loop,
// which schedules its own alarms but must recover on the same beat.
const OFFLINE_RETRY_MS = 30_000;

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
 * (runScheduler.js) and the GUI cadence chain (AutovoteContext.jsx) so the
 * formula cannot drift between the two.
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

module.exports = {
    getRandomCheckFrequencyMs,
    anchoredWaitMs,
    DEFAULT_MINUTES,
    MS_PER_MINUTE,
    MIN_CYCLE_GAP_MS,
    OFFLINE_RETRY_MS,
};
