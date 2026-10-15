import { useLayoutEffect, useState } from 'react';
import { useLatestRef } from '../hooks/useLatestRef';

import type { Challenge } from '../../types/gurushots';

/**
 * One previewed deadline action.
 */
type DeadlineAction = { action: string; thresholdSec: number; dueAt: number | null };

/**
 * useDeadlineActions' state.
 */
export type DeadlineActionsState = {
    actions: DeadlineAction[];
    boostBlocked: boolean;
    turboBlocked: boolean;
    /** What blocks the spend: every entry carrying the other feature (`flag`) or the photo pinned for it (`pin`). */
    boostBlockedBy: 'flag' | 'pin' | null;
    turboBlockedBy: 'flag' | 'pin' | null;
    /** Unix seconds the blocking pin gives way; null when the block never does. */
    boostReleaseAt: number | null;
    turboReleaseAt: number | null;
    loading: boolean;
    error: boolean;
};

// setTimeout's longest delay (a larger one fires at once); a pin release further out is re-armed on each refetch.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Nothing to preview: no blocks, settled, `error` when the fetch failed.
 */
const settledEmpty = (error: boolean): DeadlineActionsState => ({
    actions: [],
    boostBlocked: false,
    turboBlocked: false,
    boostBlockedBy: null,
    turboBlockedBy: null,
    boostReleaseAt: null,
    turboReleaseAt: null,
    loading: false,
    error,
});

/**
 * The state a successful get-deadline-actions response settles to.
 */
const settledFrom = (
    res: Extract<Awaited<ReturnType<typeof window.api.getDeadlineActions>>, { success: true }>,
): DeadlineActionsState => ({
    actions: Array.isArray(res.actions) ? res.actions : [],
    boostBlocked: res.boostBlocked === true,
    turboBlocked: res.turboBlocked === true,
    boostBlockedBy: res.boostBlockedBy ?? null,
    turboBlockedBy: res.turboBlockedBy ?? null,
    boostReleaseAt: res.boostReleaseAt ?? null,
    turboReleaseAt: res.turboReleaseAt ?? null,
    loading: false,
    error: false,
});

/**
 * How long until a refetch after a pin's release instant (Unix seconds): +1 s so it lands after
 * the release second, never just before it, and no more than one timer can wait.
 */
const releaseDelayMs = (releaseAt: number): number =>
    Math.min(Math.max(releaseAt * 1000 - Date.now(), 0) + 1000, MAX_TIMER_MS);

/**
 * Fetches the read-only deadline-action preview + boost/turbo conflict flags for
 * one challenge via the get-deadline-actions IPC channel (main-side because the
 * settings-facade math is renderer-unreachable). Passes the challenge object the
 * renderer already holds — the handler does NOT re-fetch the challenge list.
 *
 * Keyed on a content fingerprint, NOT on `challenge` (a fresh reference each
 * render) and NOT on a 1s tick, so it refetches only when a field that changes
 * the result changes. Per-challenge / global setting edits (boostTime,
 * keyUnlockedBoostTime, boostImageIndex, currency rules, …) arrive as a new
 * `settingsVersion`, which ChallengesSection bumps once per settings-changed
 * broadcast — one refetch per card per settings change, without a remount.
 * A photo pinned for the other feature blocks a spend only until Emergency Fill takes
 * over, and no fingerprint field moves then, so the fetch that reports those instants
 * (`boostReleaseAt` / `turboReleaseAt`) also arms one refetch, for the sooner of them.
 *
 * @param settingsVersion - bumped when settings change
 */
export function useDeadlineActions(
    challenge: Challenge | null | undefined,
    settingsVersion: number = 0,
): DeadlineActionsState {
    const [state, setState] = useState<DeadlineActionsState>({ ...settledEmpty(false), loading: true });

    const boost = challenge?.member?.boost;
    const turbo = challenge?.member?.turbo;
    const entries = challenge?.member?.ranking?.entries;
    // boostBlocked / turboBlocked depend on WHICH physical entry sits at the configured index
    // and its turbo / boosted flags (pickBoostEntry and pickTurboEntry resolve the image index
    // positionally), so the server reordering entries between polls with no membership change
    // must still refetch. Fingerprint each entry's id + flags, not just the
    // count — a resort-only poll changes this string, an unrelated re-render
    // doesn't.
    const entriesFingerprint = Array.isArray(entries)
        ? entries.map((e) => `${e?.id}:${e?.turbo ? 1 : 0}${e?.boosted ? 1 : 0}`).join(',')
        : '';
    const fingerprint = [
        challenge?.id,
        challenge?.close_time,
        boost?.state,
        boost?.timeout,
        turbo?.state,
        entriesFingerprint,
        challenge?.max_photo_submits,
    ].join('|');

    // Read through a ref: the effect is keyed on the fingerprint, which fully
    // captures the challenge fields the result depends on, while `challenge`
    // itself is a fresh reference each render (depending on it would refetch
    // every render).
    const challengeRef = useLatestRef(challenge);
    // Bumped when a blocking pin is due to give way, to refetch once at that instant.
    const [releaseTick, setReleaseTick] = useState(0);

    useLayoutEffect(() => {
        const current = challengeRef.current;
        // Nothing to preview without a challenge: settled and empty, not an error, and no call to make.
        if (!current) {
            setState(settledEmpty(false));
            return undefined;
        }
        let cancelled = false;
        let releaseTimer: ReturnType<typeof setTimeout> | undefined;
        setState((s) => ({ ...s, loading: true }));
        void (async () => {
            try {
                const res = await window.api.getDeadlineActions(current);
                if (cancelled) return;
                if (res && res.success) {
                    const settled = settledFrom(res);
                    setState(settled);
                    const releases = [settled.boostReleaseAt, settled.turboReleaseAt].filter(
                        (at): at is number => typeof at === 'number',
                    );
                    if (releases.length > 0) {
                        releaseTimer = setTimeout(
                            () => setReleaseTick((tick) => tick + 1),
                            releaseDelayMs(Math.min(...releases)),
                        );
                    }
                } else {
                    setState(settledEmpty(true));
                }
            } catch {
                if (!cancelled) {
                    setState(settledEmpty(true));
                }
            }
        })();
        return () => {
            cancelled = true;
            clearTimeout(releaseTimer);
        };
    }, [fingerprint, settingsVersion, challengeRef, releaseTick]);

    return state;
}
