import { useCallback, useRef } from 'react';
import { useIpcQuery } from './useIpcQuery';

import type { ActiveChallengesResponse, Challenge } from '../../types/gurushots';
import type { AppSettings } from '../../types/settings';
import type { IpcQueryTools } from './useIpcQuery';

/**
 * The payload's identity for dedup against the previous one. The 60s
 * auto-refresh almost always returns the same content; replacing the array
 * reference anyway cascades re-renders + new useMemo sorted copy + new
 * ChallengeCard JSX through every consumer, which adds heap pressure over
 * long-running sessions. JSON.stringify can throw on circular refs / BigInts
 * in pathological API responses — `null` means "definitely changed", so a
 * single malformed payload does not freeze the refresh cycle.
 */
const payloadKey = (challenges: Challenge[]): string | null => {
    try {
        return JSON.stringify(challenges);
    } catch {
        return null;
    }
};

/**
 * Prunes stale per-challenge data against the challenges now on screen:
 * stale challenge settings only while autovote is stopped, stale metadata on
 * every call.
 */
const cleanupStale = async (challenges: Challenge[], autovoteRunning: boolean): Promise<void> => {
    if (challenges.length === 0) return;
    const activeChallengeIds = challenges.map((c) => c.id.toString());
    if (!autovoteRunning) {
        await window.api.cleanupStaleChallengeSetting(activeChallengeIds);
    }
    await window.api.cleanupStaleMetadata(activeChallengeIds);
};

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
 * A transient network/5xx failure that outlived the api-client's retries is a
 * fetch failure, not an empty challenge list: it sets the 'fetch_failed' error
 * (the UI's "retrying" banner) and keeps the last-known challenges on screen.
 * getActiveChallenges always resolves a list shape, so the `fetchFailed` marker
 * is what tells the two apart; the null check guards a genuinely absent response.
 *
 * @param autovoteRunning - whether the autovote loop is
 *   currently running; stale challenge settings are not pruned while it is
 *   (stale metadata still is). Threaded down as a prop from
 *   ChallengesProvider — no window.* side-channel.
 */
export function useActiveChallenges(autovoteRunning: boolean = false): {
    data: Challenge[];
    loading: boolean;
    error: Error | null;
    refetch: (skipCleanup?: boolean) => Promise<void>;
} {
    const lastKeyRef = useRef<string | null>(null);

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

    const apply = useCallback(
        async (
            { settings, result }: { settings: AppSettings; result: ActiveChallengesResponse },
            { setData, setError }: IpcQueryTools<Challenge[], Error>,
            skipCleanup: boolean = false,
        ) => {
            if (settings.token && (result == null || result.fetchFailed)) {
                setError(new Error('fetch_failed'));
                return;
            }

            // Reached a valid response — clear any prior transient error.
            setError(null);

            const challenges = result?.challenges || [];

            const key = payloadKey(challenges);
            if (key === null || key !== lastKeyRef.current) {
                lastKeyRef.current = key;
                setData(challenges);
            }

            if (!skipCleanup) await cleanupStale(challenges, autovoteRunningRef.current);
        },
        [],
    );

    const showLoading = useCallback((skipCleanup = false) => !skipCleanup, []);

    const { data, loading, error, refetch } = useIpcQuery(queryFn, {
        initialData: [] as Challenge[],
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
