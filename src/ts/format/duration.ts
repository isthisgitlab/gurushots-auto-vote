/**
 * Canonical "seconds → human duration" formatter, shared by every platform
 * shell (CLI status, the renderer boost-window banner + challenge countdown,
 * and the voting pass's log lines in services/votingOrchestrator/boost.ts) so they
 * all read identically.
 *
 * No React or Node-service dependency, so the CLI, the main process and the
 * renderer bundle all import it.
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
 * @param seconds - Duration in seconds (not an absolute timestamp).
 */
const formatDuration = (seconds: number, { includeSeconds = false }: { includeSeconds?: boolean } = {}): string => {
    const total = Math.max(0, Math.floor(seconds || 0));
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

export { formatDuration };
