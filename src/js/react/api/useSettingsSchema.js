import { useState, useEffect, useCallback } from 'react';

/**
 * Hook for fetching settings schema and defaults via IPC
 * @returns {{ schema: Object|null, defaults: Object|null, loading: boolean, error: Error|null, refetch: function }}
 */
export function useSettingsSchema() {
    const [schema, setSchema] = useState(null);
    const [defaults, setDefaults] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const refetch = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            const result = await window.api.getSettingsSchema();
            setSchema(result?.schema || null);
            setDefaults(result?.defaults || null);
        } catch (err) {
            setError(err);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refetch();
    }, [refetch]);

    useEffect(() => {
        if (!window.api?.onSettingsChanged) return undefined;
        return window.api.onSettingsChanged(() => {
            refetch();
        });
    }, [refetch]);

    return {
        schema,
        defaults,
        loading,
        error,
        refetch,
    };
}
