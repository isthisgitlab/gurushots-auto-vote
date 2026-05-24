import { signal } from '@preact/signals';
import { useRef, useEffect, useMemo } from 'react';
import { formatTimeRemaining } from '@/utils/formatters';

/**
 * Hook that manages countdown timers for challenges.
 *
 * Returns a stable map of `challengeId → Signal<string>`. A single 1-second
 * interval mutates each signal's `.value` in place; because the map and the
 * individual signal identities persist across renders, the consuming component
 * does NOT re-render on every tick — only the DOM text nodes bound to each
 * signal update. (The previous implementation called setState every second,
 * which re-rendered the whole challenges section + its action buttons each
 * tick.) Each ChallengeCard reads its own signal's value, so a card that is
 * already re-rendering for other reasons still shows the live countdown.
 *
 * @param {Array} challenges - Array of challenge objects with close_time
 * @returns {Object<string, import('@preact/signals').Signal<string>>}
 */
export function useTimers(challenges) {
    // Per-challenge time signals, reused across renders so each card binds once.
    const signalsRef = useRef(new Map());

    // Build/prune the signal map for the current challenge set. Recomputed only
    // when the challenge identities change — not every second. New signals are
    // seeded with the current formatted time so a freshly-added card renders the
    // real countdown immediately (no loading flash); the periodic refresh lives
    // in the effect below to avoid writing signals during render.
    const times = useMemo(() => {
        const store = signalsRef.current;
        const present = new Set();
        const out = {};
        for (const challenge of challenges || []) {
            present.add(challenge.id);
            let sig = store.get(challenge.id);
            if (!sig) {
                sig = signal(formatTimeRemaining(challenge.close_time));
                store.set(challenge.id, sig);
            }
            out[challenge.id] = sig;
        }
        for (const id of [...store.keys()]) {
            if (!present.has(id)) store.delete(id);
        }
        return out;
    }, [challenges]);

    // Single interval drives every signal. tick() also runs immediately so the
    // displayed time refreshes the moment the challenge set changes rather than
    // waiting up to a second.
    useEffect(() => {
        if (!challenges || challenges.length === 0) return undefined;
        const tick = () => {
            for (const challenge of challenges) {
                const sig = signalsRef.current.get(challenge.id);
                if (sig) sig.value = formatTimeRemaining(challenge.close_time);
            }
        };
        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [challenges]);

    return times;
}
