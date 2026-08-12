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
 * @param {boolean} [autovoteRunning=false] - whether the autovote loop is
 *   currently running; stale-settings cleanup is skipped while it is (the
 *   voting pass owns metadata cleanup then). Threaded down as a prop from
 *   ChallengesProvider — no window.* side-channel.
 * @returns {{ data: Array, loading: boolean, error: Error|null, refetch: function }}
 */
export function useActiveChallenges(autovoteRunning = false) {
    const lastKeyRef = useRef(null);

    // Ref mirror so the async apply() below reads the current flag at
    // cleanup time (post-await) instead of the value captured when the
    // refetch started.
    const autovoteRunningRef = useRef(autovoteRunning);
    autovoteRunningRef.current = autovoteRunning;

    const queryFn = useCallback(async () => {
        const settings = await window.api.getSettings();
        const result = await window.api.getActiveChallenges(settings.token);
        return { settings, result };
    }, []);

    const apply = useCallback(async ({ settings, result }, { setData, setError }, skipCleanup = false) => {
        // A transient network/5xx failure that outlived the api-client's retries is a fetch
        // failure, not an empty challenge list — surface it so the UI shows its "retrying"
        // banner, and keep the last-known challenges on screen rather than blanking them on
        // a blip.
        //
        // `result == null` alone never caught this: getActiveChallenges always resolves a
        // list shape, so the banner this hook exists to drive could not fire and an outage
        // rendered as a plain "no active challenges". The fetchFailed marker is what actually
        // distinguishes the two; the null check stays as a guard for a genuinely absent
        // response.
        if (settings.token && (result == null || result.fetchFailed)) {
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
        if (!skipCleanup && challenges.length > 0) {
            const activeChallengeIds = challenges.map((c) => c.id.toString());

            if (!autovoteRunningRef.current) {
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
