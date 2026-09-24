import { useCallback, useMemo } from 'react';
import { useIpcQuery } from '@/api/useIpcQuery';
import * as ipc from '@/api/ipc';

// Stable empty result so consumers never see a changing identity while the
// first fetch is in flight (or after a failed one).
const NONE = new Set();

/**
 * Ids of the challenges that carry at least one per-challenge override —
 * the same condition ChallengeCard shows its "⚙️ custom" badge for, but for
 * the whole list at once so ChallengeNav can mark its chips.
 *
 * Issues one `getChallengeOverrides` call per challenge (there is no bulk
 * reader on that channel, and the card's alternative — walking the schema
 * key by key — costs more; this only needs the "any override?" answer).
 * Re-runs on settings-changed so the marker tracks edits made in the
 * per-challenge settings modal.
 *
 * @param {Array<{id: string|number}>} challenges - always an array (ChallengeNav normalizes)
 * @returns {Set<string>} ids, as strings
 */
export function useOverriddenChallengeIds(challenges) {
    // Key on the id list, not the challenge objects: ChallengesSection hands
    // down a freshly fetched array on every refresh, and re-reading overrides
    // for an unchanged set of ids would be pure churn. Ids are deduplicated
    // (a repeat would only buy a redundant round trip) and the key is JSON, so
    // an id that ever contained the separator character cannot smear two ids
    // into one the way a plain join/split would.
    const idsKey = useMemo(() => {
        const ids = [];
        for (const challenge of challenges) {
            const id = challenge?.id;
            if (id === null || id === undefined) continue;
            const key = String(id);
            if (!ids.includes(key)) ids.push(key);
        }
        return JSON.stringify(ids);
    }, [challenges]);

    const queryFn = useCallback(async () => {
        const ids = JSON.parse(idsKey);
        if (ids.length === 0) return NONE;
        const maps = await Promise.all(ids.map((id) => ipc.getChallengeOverrides(id)));
        // The handler falls back to null on error — treat that as "no
        // overrides" rather than marking the chip on a failed read.
        return new Set(ids.filter((_, i) => maps[i] && Object.keys(maps[i]).length > 0));
    }, [idsKey]);

    // singleFlight: two refetches racing each other can resolve out of order
    // and leave the older payload on screen — the settings-changed subscription
    // makes that reachable by the feature's own main use case (saving an
    // override fires a refetch while the previous one may still be in flight).
    // Same guard, for the same reason, as useActiveChallenges.
    const { data } = useIpcQuery(queryFn, { initialData: NONE, subscribe: true, singleFlight: true });

    // queryFn only ever resolves a Set and a failed read keeps the previous
    // value, so `data` is always a Set here.
    return data;
}
