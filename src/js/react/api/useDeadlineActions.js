import { useEffect, useState } from 'react';

/**
 * Fetches the read-only deadline-action preview + boost/turbo conflict flag for
 * one challenge via the get-deadline-actions IPC channel (main-side because the
 * settings-facade math is renderer-unreachable). Passes the challenge object the
 * renderer already holds — the handler does NOT re-fetch the challenge list.
 *
 * Keyed on a content fingerprint, NOT on `challenge` (a fresh reference each
 * render) and NOT on a 1s tick, so it refetches only when a field that changes
 * the result changes. Per-challenge / global setting edits arrive via the card
 * remount ChallengesSection triggers on settings-changed, so one settings change
 * coalesces into a single refetch per card rather than a fan-out.
 *
 * @param {any} challenge
 * @returns {{actions: Array<{action:string, thresholdSec:number, dueAt:number|null}>, boostBlocked: boolean, loading: boolean, error: boolean}}
 */
export function useDeadlineActions(challenge) {
    const [state, setState] = useState({ actions: [], boostBlocked: false, loading: true, error: false });

    const boost = challenge?.member?.boost;
    const turbo = challenge?.member?.turbo;
    const fingerprint = [
        challenge?.id,
        challenge?.close_time,
        boost?.state,
        boost?.timeout,
        turbo?.state,
        challenge?.member?.ranking?.entries?.length,
        challenge?.max_photo_submits,
    ].join('|');

    useEffect(() => {
        let cancelled = false;
        setState((s) => ({ ...s, loading: true }));
        void (async () => {
            try {
                const res = await window.api.getDeadlineActions(challenge);
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
        // fingerprint fully captures the challenge fields the result depends on;
        // depending on `challenge` (a fresh ref each render) would refetch every
        // render. Same fingerprint pattern as SettingInput's draft-sync effect.
    }, [fingerprint]);

    return state;
}
