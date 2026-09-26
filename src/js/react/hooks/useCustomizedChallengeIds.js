import { useCallback, useMemo } from 'react';
import { useIpcQuery } from '@/api/useIpcQuery';
import * as ipc from '@/api/ipc';

// Stable empty result so consumers never see a changing identity while the
// first fetch is in flight (or after a failed one).
/** @type {Set<string>} */
const NONE = new Set();

/**
 * Ids of challenges with manual overrides or an unsuppressed automatic profile,
 * so ChallengeNav can mark either kind of customized challenge.
 *
 * Reads overrides first, then checks the automatic profile where no manual
 * override exists. Neither channel has a bulk reader.
 * Re-runs on settings-changed so the marker tracks both rule edits and
 * per-challenge settings changes.
 *
 * @param {Array<{id: string|number, title: string}>} challenges - always an array (ChallengeNav normalizes)
 * @returns {Set<string>} ids, as strings
 */
export function useCustomizedChallengeIds(challenges) {
    // Key on ids and titles, not challenge objects: routine refreshes often
    // leave both unchanged. Re-read if a title changes for the same id.
    const entriesKey = useMemo(() => {
        /** @type {Array<[string, string]>} */
        const entries = [];
        const seen = new Set();
        for (const challenge of challenges) {
            const id = challenge?.id;
            if (id === null || id === undefined) continue;
            const key = String(id);
            if (seen.has(key)) continue;
            seen.add(key);
            entries.push([key, challenge.title]);
        }
        return JSON.stringify(entries);
    }, [challenges]);

    const queryFn = useCallback(async () => {
        const entries = /** @type {Array<[string, string]>} */ (JSON.parse(entriesKey));
        if (entries.length === 0) return NONE;
        const customized = await Promise.all(
            entries.map(async ([id, title]) => {
                const overrides = await ipc.getChallengeOverrides(id);
                if (overrides && Object.keys(overrides).length > 0) return true;
                const profile = await ipc.getTitleProfile(title, id);
                return profile != null && !profile.suppressed;
            }),
        );
        return new Set(entries.filter((_, i) => customized[i]).map(([id]) => id));
    }, [entriesKey]);

    // latestOnly: two reads racing each other can resolve out of order, and the
    // settings-changed subscription makes that the feature's main use case
    // (saving an override starts a read while the previous one may still be in
    // flight). Only the newest read applies its result, and no read is dropped,
    // so a save or a new challenge list arriving mid-read still gets its own
    // read instead of leaving the older set on screen.
    const { data } = useIpcQuery(queryFn, { initialData: NONE, subscribe: true, latestOnly: true });

    // queryFn only ever resolves a Set and a failed read keeps the previous
    // value, so `data` is always a Set here.
    return data;
}
