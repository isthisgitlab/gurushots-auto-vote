/**
 * Canonical "seconds → human duration" formatter, shared by every platform
 * shell (CLI status, the renderer boost-window banner + challenge countdown,
 * and api/main boost logging) so they all read identically.
 *
 * Authored as CommonJS with no React/Node-service dependency: the CLI (CJS)
 * `require`s it and the renderer (ESM, bundled by esbuild + @swc/jest) imports
 * it the same way it already imports the CJS `scheduling/*` and `settings`
 * core — see react/contexts/autovoteScheduler.js.
 *
 * Two shapes from one function:
 *   - default (largest two units, minute granularity, "<1m" under a minute) —
 *     keeps chips from churning every second on a long window. Negatives clamp
 *     to "<1m".
 *       86400→"1d 0h", 3700→"1h 1m", 630→"10m", 30→"<1m"
 *   - includeSeconds:true (down to seconds, no "<1m") — for live countdowns
 *     that should tick the final minute. Callers own any "Ended" guard.
 *       2d3h→"2d 3h 5m", 1h→"1h 0m", 90→"1m 30s", 30→"30s"
 *
 * @param {number} seconds - Duration in seconds (not an absolute timestamp).
 * @param {{ includeSeconds?: boolean }} [opts]
 * @returns {string}
 */
const formatDuration = (seconds, { includeSeconds = false } = {}) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    if (includeSeconds) {
        if (days > 0) return `${days}d ${hours}h ${minutes}m`;
        if (hours > 0) return `${hours}h ${minutes}m`;
        if (minutes > 0) return `${minutes}m ${secs}s`;
        return `${secs}s`;
    }

    if (total < 60) return '<1m';
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
};

module.exports = { formatDuration };
