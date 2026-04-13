import { useCallback } from 'react';
import { useAutovote as useAutovoteContext } from '@/contexts/AutovoteContext';

/**
 * Hook that provides autovote functionality
 * This is a thin wrapper around AutovoteContext for convenient access
 */
export function useAutovote() {
    const context = useAutovoteContext();

    const toggleAutovote = useCallback(async () => {
        await context.toggle();
    }, [context]);

    return {
        running: context.running,
        cycles: context.cycles,
        lastRun: context.lastRun,
        status: context.status,
        statusClass: context.statusClass,
        error: context.error,
        start: context.start,
        stop: context.stop,
        toggle: toggleAutovote,
    };
}
