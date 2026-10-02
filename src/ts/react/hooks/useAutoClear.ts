import { useEffect } from 'react';

/**
 * Auto-clears a transient value (typically an error message) a fixed
 * delay after it becomes truthy, so a stuck red button doesn't block
 * the user from retrying without a page-state reset. The timer resets
 * whenever the value (or the clear callback) changes; falsy values
 * schedule nothing.
 *
 * @param value - when truthy, schedules the clear
 * @param clear - called after `delayMs`
 */
export function useAutoClear(value: unknown, clear: () => void, delayMs: number) {
    useEffect(() => {
        if (!value) return undefined;
        const id = setTimeout(clear, delayMs);
        return () => clearTimeout(id);
    }, [value, clear, delayMs]);
}
