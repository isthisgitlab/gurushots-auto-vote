import { useState, useEffect } from 'react';

/**
 * Per-second (or per-interval) wall-clock tick. Returns the current Unix
 * time in seconds and re-renders the caller every `intervalMs` while
 * `enabled` is true. When disabled, no interval runs and the returned
 * value stays at whatever it last was.
 *
 * @param {number} [intervalMs]
 * @param {boolean} [enabled]
 * @returns {number} current Unix time (seconds)
 */
export function useTick(intervalMs = 1000, enabled = true) {
    const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

    useEffect(() => {
        if (!enabled) return undefined;
        const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
        return () => clearInterval(id);
    }, [intervalMs, enabled]);

    return now;
}
