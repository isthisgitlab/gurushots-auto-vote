import { useIpcQuery } from './useIpcQuery';

/** @import { WindowApi } from '../../types/ipc' */
/** @import { RendererSchema } from '../../types/settingsEditor' */

/** @typedef {Awaited<ReturnType<WindowApi['getSettingsSchema']>>} SettingsSchemaPayload */
/** @typedef {Extract<SettingsSchemaPayload, { groups: unknown[] }>} FullSettingsSchema */

const fetchSettingsSchema = () => window.api.getSettingsSchema();

/**
 * Hook for fetching settings schema and defaults via IPC
 * @returns {{
 *   schema: RendererSchema | null,
 *   defaults: Record<string, unknown> | null,
 *   groups: FullSettingsSchema['groups'] | null,
 *   tiers: FullSettingsSchema['tiers'] | null,
 *   profileLimits: FullSettingsSchema['profileLimits'] | null,
 *   loading: boolean,
 *   error: Error | null,
 *   refetch: () => Promise<void>,
 * }}
 */
export function useSettingsSchema() {
    const { data, loading, error, refetch } = useIpcQuery(fetchSettingsSchema, { subscribe: true });

    return {
        schema: data?.schema || null,
        defaults: data?.defaults || null,
        groups: data?.groups || null,
        tiers: data?.tiers || null,
        profileLimits: data?.profileLimits || null,
        loading,
        error,
        refetch,
    };
}
