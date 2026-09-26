import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';
import * as ipc from './ipc';

/** @import { WindowApi } from '../../types/ipc' */
/** @import { IpcQueryTools } from './useIpcQuery' */

/** @typedef {Awaited<ReturnType<WindowApi['getScenarios']>>} ScenariosResult */
/** @typedef {Extract<ScenariosResult, { success: true }>['scenarios']} StoredScenarios */
/** @typedef {Extract<ScenariosResult, { success: true }>['templates']} ScenarioTemplates */
/** @typedef {{ scenarios: StoredScenarios, templates: ScenarioTemplates }} ScenariosData */

/**
 * The stored scenarios and the example templates (get-scenarios). Revalidates
 * on every settings-changed broadcast, since scenarios live in the settings
 * blob.
 *
 * @param {boolean} [enabled]
 * @returns {{scenarios: StoredScenarios, templates: ScenarioTemplates, loading: boolean, error: Error | string | null, refetch: () => Promise<void>}}
 */
export function useScenarios(enabled = true) {
    const apply = useCallback(
        /**
         * @param {ScenariosResult} result
         * @param {IpcQueryTools<ScenariosData, Error | string>} tools
         */
        (result, { setData, setError }) => {
            if (result?.success) setData({ scenarios: result.scenarios ?? {}, templates: result.templates ?? [] });
            else setError(result?.error ?? 'failed');
        },
        [],
    );
    const { data, loading, error, refetch } = useIpcQuery(ipc.getScenarios, {
        initialData: /** @type {ScenariosData} */ ({ scenarios: {}, templates: [] }),
        subscribe: true,
        enabled,
        apply,
    });
    return { scenarios: data.scenarios, templates: data.templates, loading, error, refetch };
}
