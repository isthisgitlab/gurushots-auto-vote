import { useState, useEffect } from 'react';

/**
 * Per-second (or per-interval) wall-clock tick. Returns the current Unix
 * time in seconds and re-renders the caller every `intervalMs` while
 * `enabled` is true. When disabled, no interval runs and the returned
 * value stays at whatever it last was.
 *
 * @returns current Unix time (seconds)
 */
export function useTick(intervalMs: number, enabled: boolean = true): number {
    const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

    useEffect(() => {
        if (!enabled) return undefined;
        const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), intervalMs);
        return () => clearInterval(id);
    }, [intervalMs, enabled]);

    return now;
}

// The longest delay setTimeout honours (a larger one fires at once).
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Re-renders the caller once the wall clock reaches `at` (Unix seconds), for a gate that reads the clock at render
 * time and flips at a known moment. A moment further away than one timer can wait is waited for in steps. `null`
 * (or a moment already past) schedules nothing: the caller passes the next moment it computes at each render.
 */
export function useRerenderAt(at: number | null): void {
    const [woken, setWoken] = useState(0);

    useEffect(() => {
        const wait = at === null ? 0 : at * 1000 - Date.now();
        if (wait <= 0) return undefined;
        const id = setTimeout(() => setWoken((count) => count + 1), Math.min(wait, MAX_TIMEOUT_MS));
        return () => clearTimeout(id);
    }, [at, woken]);
}
