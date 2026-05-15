import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { useActiveChallenges } from '@/api/useActiveChallenges';

const ChallengesContext = createContext(null);

/**
 * Provider that wraps useActiveChallenges and provides challenge data with auto-refresh
 */
export function ChallengesProvider({ children, autovoteRunning }) {
    const { data, loading, error, refetch } = useActiveChallenges();
    const autoRefreshRef = useRef(null);

    // Start auto-refresh when autovote is not running (every 60 seconds)
    useEffect(() => {
        if (autovoteRunning) {
            // Stop auto-refresh during autovote
            if (autoRefreshRef.current) {
                clearInterval(autoRefreshRef.current);
                autoRefreshRef.current = null;
            }
            return;
        }

        // Start auto-refresh when autovote is not running
        autoRefreshRef.current = setInterval(() => {
            refetch(true); // Skip cleanup during auto-refresh
        }, 60000);

        return () => {
            if (autoRefreshRef.current) {
                clearInterval(autoRefreshRef.current);
                autoRefreshRef.current = null;
            }
        };
    }, [autovoteRunning, refetch]);

    // Memoize so consumers don't re-render every time the provider re-renders;
    // useActiveChallenges already dedups identical payloads, so `data` only
    // changes when the underlying challenge content changes.
    const challenges = useMemo(() => {
        if (!data || data.length === 0) return [];
        return [...data].sort((a, b) => a.close_time - b.close_time);
    }, [data]);

    const value = useMemo(() => ({ challenges, loading, error, refetch }), [challenges, loading, error, refetch]);

    return <ChallengesContext.Provider value={value}>{children}</ChallengesContext.Provider>;
}

/**
 * Hook to access challenges data
 */
export function useChallenges() {
    const context = useContext(ChallengesContext);
    if (!context) {
        throw new Error('useChallenges must be used within a ChallengesProvider');
    }
    return context;
}
