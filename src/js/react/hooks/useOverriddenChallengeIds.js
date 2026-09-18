import { useCallback, useMemo } from 'react';
import { useIpcQuery } from '@/api/useIpcQuery';

// Stable empty result so consumers never see a changing identity while the
// first fetch is in flight (or after a failed one).
const NONE = new Set();

/**
 * Ids of the challenges that carry at least one per-challenge override —
 * the same condition ChallengeCard shows its "⚙️ custom" badge for, but for
 * the whole list at once so ChallengeNav can mark its chips.
 *
 * One batched `getChallengeOverrides` read per challenge (the card walks the
 * schema key by key instead; this only needs the "any override?" answer).
 * Re-runs on settings-changed so the marker tracks edits made in the
 * per-challenge settings modal.
 *
 * @param {Array<{id: string|number}>} challenges
 * @returns {Set<string>} ids, as strings
 */
export function useOverriddenChallengeIds(challenges) {
    // Key on the id list, not the challenge objects: ChallengesSection hands
    // down a freshly fetched array on every refresh, and re-reading overrides
    // for an unchanged set of ids would be pure churn.
    const idsKey = useMemo(
        () =>
            (challenges || [])
                .map((c) => c?.id)
                .filter((id) => id !== null && id !== undefined)
                .map(String)
                .join(','),
        [challenges],
    );

    const queryFn = useCallback(async () => {
        const ids = idsKey ? idsKey.split(',') : [];
        if (ids.length === 0) return NONE;
        const maps = await Promise.all(ids.map((id) => window.api.getChallengeOverrides(id)));
        // The handler falls back to null on error — treat that as "no
        // overrides" rather than marking the chip on a failed read.
        return new Set(ids.filter((_, i) => maps[i] && Object.keys(maps[i]).length > 0));
    }, [idsKey]);

    const { data } = useIpcQuery(queryFn, { initialData: NONE, subscribe: true });

    return data instanceof Set ? data : NONE;
}
