import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';
import * as ipc from './ipc';

/**
 * The stored scenarios and the example templates (get-scenarios). Revalidates
 * on every settings-changed broadcast, since scenarios live in the settings
 * blob.
 *
 * @param {boolean} [enabled]
 * @returns {{scenarios: Record<string, object>, templates: Array<{id: string, scenario: object}>, loading: boolean, error: any, refetch: Function}}
 */
export function useScenarios(enabled = true) {
    const apply = useCallback((result, { setData, setError }) => {
        if (result?.success) setData({ scenarios: result.scenarios ?? {}, templates: result.templates ?? [] });
        else setError(result?.error ?? 'failed');
    }, []);
    const { data, loading, error, refetch } = useIpcQuery(ipc.getScenarios, {
        initialData: { scenarios: {}, templates: [] },
        subscribe: true,
        enabled,
        apply,
    });
    return { scenarios: data.scenarios, templates: data.templates, loading, error, refetch };
}
