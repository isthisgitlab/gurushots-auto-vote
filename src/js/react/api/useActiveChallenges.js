import { useCallback, useRef } from 'react';
import { useIpcQuery } from './useIpcQuery';

/**
 * Hook for fetching active challenges via IPC.
 *
 * Built on the shared useIpcQuery envelope with its extra behaviors
 * layered on through the options:
 *   - singleFlight: two refetches racing each other can resolve out of
 *     order and leave lastKeyRef matching the wrong payload — the first
 *     caller wins; subsequent callers fold in at the next interval tick
 *     or user action.
 *   - showLoading: the 60s auto-refresh path passes skipCleanup=true;
 *     spinning `loading` true→false there busts the ChallengesContext
 *     value memo every interval even when the payload is unchanged.
 *   - clearErrorOnStart:false + apply(): a valid response clears any
 *     prior transient error mid-way (not at the top of refetch) so a
 *     repeatedly-failing 60s background refresh doesn't clear-then-
 *     re-raise the banner on every tick.
 *
 * @returns {{ data: Array, loading: boolean, error: Error|null, refetch: function }}
 */
export function useActiveChallenges() {
    const lastKeyRef = useRef(null);

    const queryFn = useCallback(async () => {
        const settings = await window.api.getSettings();
        const result = await window.api.getActiveChallenges(settings.token);
        return { settings, result };
    }, []);

    const apply = useCallback(async ({ settings, result }, { setData, setError }, skipCleanup = false) => {
        // The api-client returns null after exhausting retries on a
        // transient network/5xx failure. With a token present that's a
        // fetch failure, not an empty challenge list — surface it (so the
        // UI can show a "retrying" banner) and keep the last-known
        // challenges on screen rather than blanking them on a blip.
        if (settings.token && result == null) {
            setError(new Error('fetch_failed'));
            return;
        }

        // Reached a valid response — clear any prior transient error.
        setError(null);

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
    }, []);

    const showLoading = useCallback((skipCleanup = false) => !skipCleanup, []);

    const { data, loading, error, refetch } = useIpcQuery(queryFn, {
        initialData: [],
        singleFlight: true,
        clearErrorOnStart: false,
        showLoading,
        apply,
    });

    return {
        data,
        loading,
        error,
        refetch,
    };
}
