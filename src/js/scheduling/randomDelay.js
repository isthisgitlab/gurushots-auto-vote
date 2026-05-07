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

module.exports = {getRandomCheckFrequencyMs, DEFAULT_MINUTES, MS_PER_MINUTE};
