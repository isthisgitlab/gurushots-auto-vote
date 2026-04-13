import { useState, useCallback, useEffect } from 'react';

/**
 * Hook for fetching active challenges via IPC
 * @returns {{ data: Array, loading: boolean, error: Error|null, refetch: function }}
 */
export function useActiveChallenges() {
    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const refetch = useCallback(async (skipCleanup = false) => {
        setLoading(true);
        setError(null);

        try {
            const settings = await window.api.getSettings();
            const result = await window.api.getActiveChallenges(settings.token);
            const challenges = result?.challenges || [];
            setData(challenges);

            // Cleanup stale settings and metadata unless skipped
            if (!skipCleanup && challenges.length > 0) {
                const activeChallengeIds = challenges.map(c => c.id.toString());

                // Only cleanup when autovote is not running
                if (!window.autovoteRunning) {
                    await window.api.cleanupStaleChallengeSetting(activeChallengeIds);
                }
                await window.api.cleanupStaleMetadata(activeChallengeIds);
            }
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refetch();
    }, [refetch]);

    return {
        data,
        loading,
        error,
        refetch,
    };
}
