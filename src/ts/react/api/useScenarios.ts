import { useCallback } from 'react';
import { useIpcQuery } from './useIpcQuery';
import * as ipc from './ipc';

import type { WindowApi } from '../../core/types/ipc';
import type { IpcQueryTools } from './useIpcQuery';

type ScenariosResult = Awaited<ReturnType<WindowApi['getScenarios']>>;
export type StoredScenarios = Extract<ScenariosResult, { success: true }>['scenarios'];
export type ScenarioTemplates = Extract<ScenariosResult, { success: true }>['templates'];
type ScenariosData = { scenarios: StoredScenarios; templates: ScenarioTemplates; revision: number | null };

/**
 * The stored scenarios and the example templates (get-scenarios). Revalidates
 * on every settings-changed broadcast, since scenarios live in the settings
 * blob.
 */
export function useScenarios(enabled: boolean = true): {
    scenarios: StoredScenarios;
    templates: ScenarioTemplates;
    /** The revision of the collection these were read at, which an overwrite states (null: unreadable, or not loaded). */
    revision: number | null;
    loading: boolean;
    error: Error | string | null;
    refetch: () => Promise<void>;
} {
    const apply = useCallback(
        (result: ScenariosResult, { setData, setError }: IpcQueryTools<ScenariosData, Error | string>) => {
            if (result?.success) {
                setData({
                    scenarios: result.scenarios ?? {},
                    templates: result.templates ?? [],
                    revision: result.revision,
                });
            } else setError(result?.error ?? 'failed');
        },
        [],
    );
    const { data, loading, error, refetch } = useIpcQuery(ipc.getScenarios, {
        initialData: { scenarios: {}, templates: [], revision: null } as ScenariosData,
        subscribe: true,
        enabled,
        apply,
    });
    return { scenarios: data.scenarios, templates: data.templates, revision: data.revision, loading, error, refetch };
}
