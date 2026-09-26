// @ts-check
import { useState, useCallback, useEffect } from 'react';
import { useIpcQuery } from './useIpcQuery';

/** @import { WindowApi } from '../../types/ipc' */
/** @import { AppSettings, SettingValueOf } from '../../types/settings' */

/** @typedef {Awaited<ReturnType<WindowApi['getEnvironmentInfo']>>} EnvironmentInfo */

const fetchSettings = () => window.api.getSettings();

/**
 * Hook for managing settings via IPC
 * Follows React Query-like pattern for consistent data fetching
 * @returns {{
 *   settings: AppSettings | null,
 *   loading: boolean,
 *   error: Error | null,
 *   updateSetting: <K extends string>(key: K, value: SettingValueOf<K>) => Promise<void>,
 *   getSetting: (key: string) => unknown,
 *   refetch: () => Promise<void>,
 * }}
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
        /**
         * @template {string} K
         * @param {K} key
         * @param {SettingValueOf<K>} value
         */
        async (key, value) => {
            try {
                await window.api.setSetting(key, value);
                // Optimistic update
                setSettings((prev) => (prev ? { ...prev, [key]: value } : null));
            } catch (err) {
                setError(/** @type {Error} */ (err));
                // Refetch to get actual state on error
                await refetch();
                throw err;
            }
        },
        [setSettings, setError, refetch],
    );

    const getSetting = useCallback(
        (/** @type {string} */ key) => {
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
 * @returns {{ envInfo: EnvironmentInfo | null, loading: boolean }}
 */
export function useEnvironmentInfo() {
    const [envInfo, setEnvInfo] = useState(/** @type {EnvironmentInfo | null} */ (null));
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
