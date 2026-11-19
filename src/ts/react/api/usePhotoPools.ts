import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';
import * as ipc from './ipc';

import type { IpcQueryTools } from './useIpcQuery';

type PoolsResult = Awaited<ReturnType<typeof ipc.getPhotoPools>>;

/**
 * The account's named photo pools: pool name to its photo ids, in order. `confirm` puts a pool that is known to exist (a create
 * that landed) into the list at once, and drops every older read still on its way, so none replaces it; the next read is the truth.
 */
export function usePhotoPools(enabled: boolean = true): {
    pools: Record<string, string[]>;
    refetch: () => Promise<void>;
    confirm: (name: string, ids: string[]) => void;
} {
    const apply = useCallback(
        (result: PoolsResult, { setData }: IpcQueryTools<Record<string, string[]>, Error | string>) => {
            if (result?.success) setData(result.pools ?? {});
        },
        [],
    );
    const { data, setData, refetch, supersede } = useIpcQuery(ipc.getPhotoPools, {
        initialData: {},
        subscribe: true,
        enabled,
        apply,
        latestOnly: true,
    });
    const confirm = useCallback(
        (name: string, ids: string[]) => {
            supersede();
            setData((held) => ({ ...held, [name]: [...ids] }));
        },
        [supersede, setData],
    );
    return { pools: data, refetch, confirm };
}
