import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';
import * as ipc from './ipc';
import { MAX_ANNOTATED_IDS } from '../../settings/limits';

import type { ChosenAnnotation } from '../../types/gurushots';

const NO_ANNOTATIONS: Record<string, ChosenAnnotation> = {};

/**
 * What the Chosen Photos settings say about the given open challenges, read from
 * the settings (plus the cached identity lookup) and re-read on every settings change — so a Discover row
 * follows an edit without asking GuruShots for the list again. A failed read
 * leaves the data empty, and the rows keep what the list itself carried.
 *
 * @param ids - the open challenges' ids as strings
 */
export function useOpenChosenAnnotations(ids: string[]) {
    const key = ids.join(',');
    const query = useCallback(async (): Promise<Record<string, ChosenAnnotation>> => {
        const wanted = key.split(',').filter((id) => id !== '');
        if (wanted.length === 0) return NO_ANNOTATIONS;
        // The handler refuses a request of more than MAX_ANNOTATED_IDS ids whole, so a long list is asked in parts;
        // a part that fails leaves its rows with what the list carried.
        const parts: string[][] = [];
        for (let from = 0; from < wanted.length; from += MAX_ANNOTATED_IDS) {
            parts.push(wanted.slice(from, from + MAX_ANNOTATED_IDS));
        }
        const results = await Promise.all(
            parts.map((part) => ipc.callOrNull(() => ipc.getOpenChosenAnnotations(part))),
        );
        const answered = results.flatMap((result) => (result?.success ? [result.annotations] : []));
        if (answered.length === 0) return NO_ANNOTATIONS;
        return answered.length === 1 ? answered[0] : Object.fromEntries(answered.flatMap((a) => Object.entries(a)));
    }, [key]);
    const { data, refetch } = useIpcQuery(query, { initialData: NO_ANNOTATIONS, subscribe: true, latestOnly: true });
    return { annotations: data, refetch };
}
