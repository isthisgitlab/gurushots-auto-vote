import { useState, useCallback, useEffect, useRef } from 'react';

/**
 * Hook for fetching active challenges via IPC
 * @returns {{ data: Array, loading: boolean, error: Error|null, refetch: function }}
 */
export function useActiveChallenges() {
    const [data, setData] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const lastKeyRef = useRef(null);
    const inFlightRef = useRef(false);

    const refetch = useCallback(async (skipCleanup = false) => {
        // Drop overlapping calls. Two refetches racing each other can
        // resolve out of order and leave lastKeyRef matching the wrong
        // payload. The first caller wins; subsequent callers fold in at
        // the next interval tick or user action.
        if (inFlightRef.current) return;
        inFlightRef.current = true;

        // Toggle the loading flag only for user-initiated refetches.
        // The 60s auto-refresh path passes skipCleanup=true; spinning
        // `loading` true→false there busts the ChallengesContext value
        // memo every interval even when the payload is unchanged.
        if (!skipCleanup) setLoading(true);
        setError(null);

        try {
            const settings = await window.api.getSettings();
            const result = await window.api.getActiveChallenges(settings.token);
            const challenges = result?.challenges || [];

            // Dedup against the previous payload. The 60s auto-refresh
            // almost always returns the same content; replacing the array
            // reference anyway cascades re-renders + new useMemo sorted
            // copy + new ChallengeCard JSX through every consumer, which
            // adds heap pressure over long-running sessions. JSON.stringify
            // can throw on circular refs / BigInts in pathological API
            // responses — treat that as "definitely changed" and fall
            // through so a single malformed payload does not freeze the
            // refresh cycle.
            let key;
            try {
                key = JSON.stringify(challenges);
            } catch {
                key = null;
            }
            if (key === null || key !== lastKeyRef.current) {
                lastKeyRef.current = key;
                setData(challenges);
            }

            // Cleanup stale settings and metadata unless skipped.
            // TODO: thread autovoteRunning through context instead of
            // reading window.autovoteRunning here — last side-channel
            // consumer of the global.
            if (!skipCleanup && challenges.length > 0) {
                const activeChallengeIds = challenges.map((c) => c.id.toString());

                if (!window.autovoteRunning) {
                    await window.api.cleanupStaleChallengeSetting(activeChallengeIds);
                }
                await window.api.cleanupStaleMetadata(activeChallengeIds);
            }
        } catch (err) {
            setError(err);
        } finally {
            if (!skipCleanup) setLoading(false);
            inFlightRef.current = false;
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
