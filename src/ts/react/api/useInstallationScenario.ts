import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';
import { useAsyncIpcAction } from './useAsyncIpcAction';
import * as ipc from './ipc';

import type { IpcQueryTools } from './useIpcQuery';
import type { AsyncIpcAction, IpcActionCallbacks } from './useAsyncIpcAction';
import type { InstallationExecutor } from '../../core/types/config';

/** What get-installation-scenario answers: the assignment with its owner and generation, or none. */
export type InstallationAssignment = {
    scenario: string;
    executor: InstallationExecutor;
    generation: number;
} | null;

type ReadResult = Awaited<ReturnType<typeof ipc.getInstallationScenario>>;
type SetResult = Awaited<ReturnType<typeof ipc.setInstallationScenario>>;
type TransferResult = Awaited<ReturnType<typeof ipc.transferInstallationScenarioOwner>>;

/**
 * The installation's selected scenario and its owner (get-installation-scenario), revalidating on every
 * settings-changed broadcast.
 */
export function useInstallationScenario(enabled: boolean = true): {
    installation: InstallationAssignment;
    /** The generation a change must state it was made under: null until the latest read succeeded (and after one that did not). */
    generation: number | null;
    /** Reads again. The generation is dropped first, so no change can be sent under the one read before until this read succeeds. */
    refetch: () => Promise<void>;
} {
    type Held = { installation: InstallationAssignment; generation: number | null };
    const apply = useCallback((result: ReadResult, { setData }: IpcQueryTools<Held, Error | string>) => {
        if (result !== undefined && 'success' in result && result.success) {
            setData({ installation: result.installation ?? null, generation: result.generation });
        } else {
            // A read that failed says nothing of the generation: what was read before is no longer one a change may state.
            setData((held) => ({ ...held, generation: null }));
        }
    }, []);
    // A read that is rejected (a lost connection) says the same as one that failed.
    const onRejected = useCallback((_error: unknown, { setData }: Pick<IpcQueryTools<Held, unknown>, 'setData'>) => {
        setData((held) => ({ ...held, generation: null }));
    }, []);
    const { data, setData, refetch } = useIpcQuery(ipc.getInstallationScenario, {
        initialData: { installation: null, generation: null } as Held,
        subscribe: true,
        enabled,
        apply,
        // Only the latest read counts: a slower, older answer never replaces a newer one.
        latestOnly: true,
        onRejected,
    });
    const reread = useCallback(async () => {
        setData((held) => ({ ...held, generation: null }));
        await refetch();
    }, [setData, refetch]);
    return { installation: data.installation, generation: data.generation, refetch: reread };
}

/**
 * Selects the installation scenario and its owner, under the generation the read saw (set-installation-scenario).
 * Reuse the P11a notice for the answer that is not final.
 */
export function useSetInstallationScenario(
    callbacks?: IpcActionCallbacks<[name: string | null, executor: InstallationExecutor, expectedGeneration: number]>,
): AsyncIpcAction<[name: string | null, executor: InstallationExecutor, expectedGeneration: number], SetResult> {
    return useAsyncIpcAction(ipc.setInstallationScenario, { failureMessage: 'not-saved' }, callbacks);
}

/**
 * Moves the installation scenario to another owner of this host (transfer-installation-scenario-owner): a local
 * operation a paired phone cannot make.
 */
export function useTransferInstallationOwner(
    callbacks?: IpcActionCallbacks<[executor: InstallationExecutor, expectedGeneration: number]>,
): AsyncIpcAction<[executor: InstallationExecutor, expectedGeneration: number], TransferResult> {
    return useAsyncIpcAction(ipc.transferInstallationScenarioOwner, { failureMessage: 'not-saved' }, callbacks);
}
