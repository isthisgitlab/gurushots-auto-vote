import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';

/**
 * Whether auto-join is armed (master default on, or a title profile enables it).
 * Subscribes to settings changes so the header indicator updates the moment the
 * user toggles the setting or edits a profile.
 *
 * @returns {{ active: boolean, refetch: function }}
 */
export function useAutoJoinActive() {
    const queryFn = useCallback(() => window.api.getAutoJoinActive(), []);
    const apply = useCallback((result, { setData }) => {
        setData(result?.success ? result.active === true : false);
    }, []);
    const { data, refetch } = useIpcQuery(queryFn, { initialData: false, subscribe: true, apply });
    return { active: data === true, refetch };
}
