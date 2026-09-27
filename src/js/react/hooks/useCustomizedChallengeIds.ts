import { useCallback, useMemo } from 'react';
import { useIpcQuery } from '@/api/useIpcQuery';
import * as ipc from '@/api/ipc';

// Stable empty result so consumers never see a changing identity while the
// first fetch is in flight (or after a failed one).
export type CustomizationKind = 'manual' | 'profile' | 'both';
const NONE: Map<string, CustomizationKind> = new Map();

/**
 * Ids of challenges with manual overrides or an unsuppressed automatic profile,
 * with their source so ChallengeNav can mark each kind distinctly.
 *
 * Reads both sources because a challenge can have manual overrides and an
 * automatic profile at the same time. Neither channel has a bulk reader.
 * Re-runs on settings-changed so the marker tracks both rule edits and
 * per-challenge settings changes.
 *
 * @param challenges - always an array (ChallengeNav normalizes)
 * @returns ids and their customization source
 */
export function useCustomizedChallengeIds(
    challenges: Array<{ id: string | number; title: string }>,
): Map<string, CustomizationKind> {
    // Key on ids and titles, not challenge objects: routine refreshes often
    // leave both unchanged. Re-read if a title changes for the same id.
    const entriesKey = useMemo(() => {
        const entries: Array<[string, string]> = [];
        const seen = new Set<string>();
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
        const entries = JSON.parse(entriesKey) as Array<[string, string]>;
        if (entries.length === 0) return NONE;
        const kinds: Array<CustomizationKind | null> = await Promise.all(
            entries.map(async ([id, title]) => {
                const overrides = await ipc.getChallengeOverrides(id);
                const profile = await ipc.getTitleProfile(title, id);
                const manual = overrides && Object.keys(overrides).length > 0;
                const automatic = profile != null && !profile.suppressed;
                return manual ? (automatic ? 'both' : 'manual') : automatic ? 'profile' : null;
            }),
        );
        const customized: Map<string, CustomizationKind> = new Map();
        entries.forEach(([id], i) => {
            if (kinds[i]) customized.set(id, kinds[i]);
        });
        return customized;
    }, [entriesKey]);

    // latestOnly: two reads racing each other can resolve out of order, and the
    // settings-changed subscription makes that the feature's main use case
    // (saving an override starts a read while the previous one may still be in
    // flight). Only the newest read applies its result, and no read is dropped,
    // so a save or a new challenge list arriving mid-read still gets its own
    // read instead of leaving the older set on screen.
    const { data } = useIpcQuery(queryFn, { initialData: NONE, subscribe: true, latestOnly: true });

    // queryFn only ever resolves a Map and a failed read keeps the previous
    // value, so `data` is always a Map here.
    return data;
}
