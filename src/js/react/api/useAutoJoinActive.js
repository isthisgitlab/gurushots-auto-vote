// @ts-check
import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';

/** @import { WindowApi } from '../../types/ipc' */
/** @import { IpcQueryTools } from './useIpcQuery' */

/**
 * Whether auto-join is armed (master default on, or a title profile enables it).
 * Subscribes to settings changes so the header indicator updates the moment the
 * user toggles the setting or edits a profile.
 *
 * @returns {{ active: boolean, refetch: () => Promise<void> }}
 */
export function useAutoJoinActive() {
    const queryFn = useCallback(() => window.api.getAutoJoinActive(), []);
    const apply = useCallback(
        /**
         * @param {Awaited<ReturnType<WindowApi['getAutoJoinActive']>>} result
         * @param {IpcQueryTools<boolean, Error>} tools
         */
        (result, { setData }) => {
            setData(result?.success ? result.active === true : false);
        },
        [],
    );
    const { data, refetch } = useIpcQuery(queryFn, { initialData: false, subscribe: true, apply });
    return { active: data === true, refetch };
}
