import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';
import * as ipc from './ipc';

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
        const result = await ipc.callOrNull(() => ipc.getOpenChosenAnnotations(wanted));
        return result?.success ? result.annotations : NO_ANNOTATIONS;
    }, [key]);
    const { data, refetch } = useIpcQuery(query, { initialData: NO_ANNOTATIONS, subscribe: true, latestOnly: true });
    return { annotations: data, refetch };
}
