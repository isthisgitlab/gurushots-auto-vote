import { useState, useCallback, useEffect } from 'react';

/**
 * Hook for managing settings via IPC
 * Follows React Query-like pattern for consistent data fetching
 * @returns {{ settings: object|null, loading: boolean, error: Error|null, updateSetting: function, refetch: function }}
 */
export function useSettings() {
    const [settings, setSettings] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const refetch = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const data = await window.api.getSettings();
            setSettings(data);
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    }, []);

    const updateSetting = useCallback(async (key, value) => {
        try {
            await window.api.setSetting(key, value);
            // Optimistic update
            setSettings(prev => prev ? { ...prev, [key]: value } : null);
        } catch (err) {
            setError(err);
            // Refetch to get actual state on error
            await refetch();
            throw err;
        }
    }, [refetch]);

    const getSetting = useCallback((key) => {
        return settings ? settings[key] : undefined;
    }, [settings]);

    useEffect(() => {
        refetch();
    }, [refetch]);

    useEffect(() => {
        if (!window.api?.onSettingsChanged) return undefined;
        return window.api.onSettingsChanged(() => { refetch(); });
    }, [refetch]);

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
            } finally {
                setLoading(false);
            }
        }
        fetchEnvInfo();
    }, []);

    return { envInfo, loading };
}
