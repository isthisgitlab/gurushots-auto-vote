import { useIpcQuery } from './useIpcQuery';

const fetchSettingsSchema = () => window.api.getSettingsSchema();

/**
 * Hook for fetching settings schema and defaults via IPC
 * @returns {{ schema: Object|null, defaults: Object|null, groups: Array|null, profileLimits: Object|null, loading: boolean, error: Error|null, refetch: function }}
 */
export function useSettingsSchema() {
    const { data, loading, error, refetch } = useIpcQuery(fetchSettingsSchema, { subscribe: true });

    return {
        schema: data?.schema || null,
        defaults: data?.defaults || null,
        groups: data?.groups || null,
        profileLimits: data?.profileLimits || null,
        loading,
        error,
        refetch,
    };
}
