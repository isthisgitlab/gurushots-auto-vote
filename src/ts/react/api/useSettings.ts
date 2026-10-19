import { useState, useCallback, useEffect } from 'react';
import { useIpcQuery } from './useIpcQuery';

import type { WindowApi } from '../../types/ipc';
import type { RendererSettings, SettingValueOf } from '../../types/settings';

export type EnvironmentInfo = Awaited<ReturnType<WindowApi['getEnvironmentInfo']>>;

const fetchSettings = () => window.api.getSettings();

/**
 * Hook for managing settings via IPC
 * Follows React Query-like pattern for consistent data fetching. `updateSetting`
 * resolves `false` when the handler refused the write (it answers `false` rather
 * than throwing), `true` once it landed; a throw is still a throw.
 */
export function useSettings(): {
    settings: RendererSettings | null;
    loading: boolean;
    error: Error | null;
    updateSetting: <K extends string>(key: K, value: SettingValueOf<K>) => Promise<boolean>;
    getSetting: (key: string) => unknown;
    refetch: () => Promise<void>;
} {
    const {
        data: settings,
        setData: setSettings,
        loading,
        error,
        setError,
        refetch,
    } = useIpcQuery(fetchSettings, { subscribe: true });

    const updateSetting = useCallback(
        async <K extends string>(key: K, value: SettingValueOf<K>) => {
            try {
                // `=== false`, not `!result`: only an explicit refusal fails the write.
                if ((await window.api.setSetting(key, value)) === false) return false;
                // Optimistic update
                setSettings((prev) => (prev ? { ...prev, app: { ...prev.app, [key]: value } } : null));
                return true;
            } catch (err) {
                setError(err as Error);
                // Refetch to get actual state on error
                await refetch();
                throw err;
            }
        },
        [setSettings, setError, refetch],
    );

    const getSetting = useCallback(
        (key: string) => {
            return settings ? settings.app[key] : undefined;
        },
        [settings],
    );

    return {
        settings,
        loading,
        error,
        updateSetting,
        getSetting,
        refetch,
    };
}

/**
 * Hook for fetching environment info
 */
export function useEnvironmentInfo(): { envInfo: EnvironmentInfo | null; loading: boolean } {
    const [envInfo, setEnvInfo] = useState<EnvironmentInfo | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        async function fetchEnvInfo() {
            try {
                const data = await window.api.getEnvironmentInfo();
                setEnvInfo(data);
            } catch {
                // Env info is optional UI garnish — leave envInfo null on failure.
            } finally {
                setLoading(false);
            }
        }
        void fetchEnvInfo();
    }, []);

    return { envInfo, loading };
}
