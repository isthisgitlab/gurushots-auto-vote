import { createContext, useContext, useEffect, useMemo } from 'react';
import { useActiveChallenges } from '@/api/useActiveChallenges';

/** @import { ComponentChildren } from 'preact' */
/** @import { Challenge } from '../../types/gurushots' */

/**
 * What useChallenges returns: the active challenges sorted by close time.
 *
 * @typedef {object} ChallengesContextValue
 * @property {Challenge[]} challenges
 * @property {boolean} loading
 * @property {Error | null} error
 * @property {(skipCleanup?: boolean) => Promise<void>} refetch
 */

const ChallengesContext = createContext(/** @type {ChallengesContextValue | null} */ (null));

/**
 * Provider that wraps useActiveChallenges and provides challenge data with auto-refresh
 *
 * @param {{ children?: ComponentChildren, autovoteRunning?: boolean }} props
 */
export function ChallengesProvider({ children, autovoteRunning }) {
    // The running flag is threaded into the hook so its cleanup pass can
    // skip stale-settings cleanup while autovote runs — prop wiring, not
    // a window-global side-channel.
    const { data, loading, error, refetch } = useActiveChallenges(autovoteRunning);

    // Auto-refresh every 60 seconds while autovote is NOT running (the
    // voting loop refreshes on its own cadence then). The effect's cleanup
    // clears the interval whenever the flag flips or the provider unmounts.
    useEffect(() => {
        if (autovoteRunning) return undefined;

        const autoRefresh = setInterval(() => {
            void refetch(true); // Skip cleanup during auto-refresh; failures land in `error`
        }, 60000);

        return () => clearInterval(autoRefresh);
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
 *
 * @returns {ChallengesContextValue}
 */
export function useChallenges() {
    const context = useContext(ChallengesContext);
    if (!context) {
        throw new Error('useChallenges must be used within a ChallengesProvider');
    }
    return context;
}
