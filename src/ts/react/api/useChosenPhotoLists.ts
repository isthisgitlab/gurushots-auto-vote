import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';
import * as ipc from './ipc';

/**
 * What the Discover rows read per challenge id: `own` is the list saved for that
 * challenge alone (absent = none saved), `effective` the list that applies once
 * every layer is resolved.
 */
export type ChosenPhotoLists = {
    own: Record<string, string[]>;
    effective: Record<string, string[]>;
};

const NO_LISTS: ChosenPhotoLists = { own: {}, effective: {} };

const idsOf = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];

/**
 * The Chosen Photos lists of the given (not yet joined) challenges. A read that
 * fails leaves that challenge without a list rather than failing the others.
 * Revalidates on every settings-changed broadcast.
 *
 * @param ids - challenge ids as strings
 */
export function useChosenPhotoLists(ids: string[]): ChosenPhotoLists & { refetch: () => Promise<void> } {
    const key = ids.join(',');
    const query = useCallback(async (): Promise<ChosenPhotoLists> => {
        const lists: ChosenPhotoLists = { own: {}, effective: {} };
        await Promise.all(
            key
                .split(',')
                .filter((id) => id !== '')
                .map(async (id) => {
                    const [own, effective] = await Promise.all([
                        ipc.callOrNull(() => ipc.getChallengeOverride('chosenPhotos', id)),
                        ipc.callOrNull(() => ipc.getEffectiveSetting('chosenPhotos', id)),
                    ]);
                    if (Array.isArray(own)) lists.own[id] = idsOf(own);
                    lists.effective[id] = idsOf(effective);
                }),
        );
        return lists;
    }, [key]);
    const { data, refetch } = useIpcQuery(query, { initialData: NO_LISTS, subscribe: true, latestOnly: true });
    return { ...data, refetch };
}
