import { useEffect, useState } from 'react';
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
    loading: boolean;
    error: boolean;
};

/**
 * Fetches the read-only deadline-action preview + boost/turbo conflict flag for
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
 *
 * @param settingsVersion - bumped when settings change
 */
export function useDeadlineActions(
    challenge: Challenge | null | undefined,
    settingsVersion: number = 0,
): DeadlineActionsState {
    const [state, setState] = useState({
        actions: [],
        boostBlocked: false,
        loading: true,
        error: false,
    } as DeadlineActionsState);

    const boost = challenge?.member?.boost;
    const turbo = challenge?.member?.turbo;
    const entries = challenge?.member?.ranking?.entries;
    // boostBlocked depends on WHICH physical entry sits at the configured index
    // and its turbo flag (pickBoostEntry resolves boostImageIndex positionally),
    // so the server reordering entries between polls with no membership change
    // must still refetch. Fingerprint each entry's id + turbo flag, not just the
    // count — a resort-only poll changes this string, an unrelated re-render
    // doesn't.
    const entriesFingerprint = Array.isArray(entries)
        ? entries.map((e) => `${e?.id}:${e?.turbo ? 1 : 0}`).join(',')
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

    useEffect(() => {
        let cancelled = false;
        setState((s) => ({ ...s, loading: true }));
        void (async () => {
            try {
                const res = await window.api.getDeadlineActions(challengeRef.current);
                if (cancelled) return;
                if (res && res.success) {
                    setState({
                        actions: Array.isArray(res.actions) ? res.actions : [],
                        boostBlocked: res.boostBlocked === true,
                        loading: false,
                        error: false,
                    });
                } else {
                    setState({ actions: [], boostBlocked: false, loading: false, error: true });
                }
            } catch {
                if (!cancelled) setState({ actions: [], boostBlocked: false, loading: false, error: true });
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [fingerprint, settingsVersion, challengeRef]);

    return state;
}
