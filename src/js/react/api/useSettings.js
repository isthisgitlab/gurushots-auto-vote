import { useState, useCallback, useEffect } from 'react';
import { useIpcQuery } from './useIpcQuery';

const fetchSettings = () => window.api.getSettings();

/**
 * Hook for managing settings via IPC
 * Follows React Query-like pattern for consistent data fetching
 * @returns {{ settings: object|null, loading: boolean, error: Error|null, updateSetting: function, refetch: function }}
 */
export function useSettings() {
    const {
        data: settings,
        setData: setSettings,
        loading,
        error,
        setError,
        refetch,
    } = useIpcQuery(fetchSettings, { subscribe: true });

    const updateSetting = useCallback(
        async (key, value) => {
            try {
                await window.api.setSetting(key, value);
                // Optimistic update
                setSettings((prev) => (prev ? { ...prev, [key]: value } : null));
            } catch (err) {
                setError(err);
                // Refetch to get actual state on error
                await refetch();
                throw err;
            }
        },
        [setSettings, setError, refetch],
    );

    const getSetting = useCallback(
        (key) => {
            return settings ? settings[key] : undefined;
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
 * @returns {{ envInfo: object|null, loading: boolean }}
 */
export function useEnvironmentInfo() {
    const [envInfo, setEnvInfo] = useState(null);
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
