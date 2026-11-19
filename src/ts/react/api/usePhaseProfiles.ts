import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';
import * as ipc from './ipc';

import type { IpcQueryTools } from './useIpcQuery';

type ProfilesResult = Awaited<ReturnType<typeof ipc.getPhaseProfiles>>;

/**
 * The saved profiles a scenario phase may apply (get-phase-profiles): the names the host's own check accepts — the one phase
 * publication and the `useProfile` action make — so nothing is offered that the runner would refuse. A read that fails, or a
 * host that answers nothing usable, leaves the list empty rather than offering a profile that may not work.
 */
export function usePhaseProfiles(): string[] {
    const apply = useCallback((result: ProfilesResult, { setData }: IpcQueryTools<string[], Error | string>) => {
        setData(result?.success ? result.profiles : []);
    }, []);
    // A read that is rejected (a lost connection) clears the names as a failure reply does, and only the latest read counts: an
    // older, slower answer never brings back a profile a newer read dropped.
    const onRejected = useCallback(
        (_error: unknown, { setData }: Pick<IpcQueryTools<string[], unknown>, 'setData'>) => {
            setData([]);
        },
        [],
    );
    const { data } = useIpcQuery(ipc.getPhaseProfiles, {
        initialData: [] as string[],
        subscribe: true,
        apply,
        latestOnly: true,
        onRejected,
    });
    return data;
}
