import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
    /** The Boost-pinned submit can place the boost on its gone pin right now (a banner and row change). */
    boostPinSubmits: boolean;
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
    boostPinSubmits: false,
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
    boostPinSubmits: res.boostPinSubmits === true,
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
 * A photo pinned for the other feature blocks a spend only until Emergency Submit takes
 * over, and no fingerprint field moves then, so the fetch that reports those instants
 * (`boostReleaseAt` / `turboReleaseAt`) also arms one refetch, for the sooner of them.
 * The Boost-pinned submit's latch is invisible to the fingerprint too (it lives on the
 * entry-age ledger), so while the last result said `boostPinSubmits: true` each
 * completed auto-vote cycle (`cycleKey`) arms one refetch — the pass that just ran may
 * have submitted the photo or set the latch.
 *
 * @param settingsVersion - bumped when settings change
 * @param cycleKey - the autovote context's lastRun; changes when a cycle completes
 */
export function useDeadlineActions(
    challenge: Challenge | null | undefined,
    settingsVersion: number = 0,
    cycleKey: string | null = null,
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
    // Bumped when a cycle completed while the last result said the Boost-pinned submit was
    // active, to refetch once then (the pass may have submitted the photo or set the latch).
    const [cycleTick, setCycleTick] = useState(0);
    // Whether the last settled result said `boostPinSubmits: true` — the cycle effect reads it.
    const pinSubmitsRef = useRef(false);

    useEffect(() => {
        if (cycleKey === null || !pinSubmitsRef.current) return;
        setCycleTick((tick) => tick + 1);
    }, [cycleKey]);

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
                    pinSubmitsRef.current = settled.boostPinSubmits;
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
                    pinSubmitsRef.current = false;
                    setState(settledEmpty(true));
                }
            } catch {
                if (!cancelled) {
                    pinSubmitsRef.current = false;
                    setState(settledEmpty(true));
                }
            }
        })();
        return () => {
            cancelled = true;
            clearTimeout(releaseTimer);
        };
    }, [fingerprint, settingsVersion, challengeRef, releaseTick, cycleTick]);

    return state;
}
