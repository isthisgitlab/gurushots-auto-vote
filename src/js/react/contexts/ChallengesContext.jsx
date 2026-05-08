import { createContext, useContext, useCallback, useEffect, useRef } from 'react';
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

    // Sort challenges by ending time (shortest time remaining first)
    const sortedChallenges = useCallback(() => {
        if (!data || data.length === 0) return [];
        const now = Math.floor(Date.now() / 1000);
        return [...data].sort((a, b) => {
            const timeA = a.close_time - now;
            const timeB = b.close_time - now;
            return timeA - timeB;
        });
    }, [data]);

    const value = {
        challenges: sortedChallenges(),
        loading,
        error,
        refetch,
    };

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
