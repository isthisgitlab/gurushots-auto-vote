import { useIpcQuery } from './useIpcQuery';

import type { WindowApi } from '../../types/ipc';
import type { RendererSchema } from '../../types/settingsEditor';

type SettingsSchemaPayload = Awaited<ReturnType<WindowApi['getSettingsSchema']>>;
export type FullSettingsSchema = Extract<SettingsSchemaPayload, { groups: unknown[] }>;

const fetchSettingsSchema = () => window.api.getSettingsSchema();

/**
 * Hook for fetching settings schema and defaults via IPC
 */
export function useSettingsSchema(): {
    schema: RendererSchema | null;
    defaults: Record<string, unknown> | null;
    groups: FullSettingsSchema['groups'] | null;
    tiers: FullSettingsSchema['tiers'] | null;
    profileLimits: FullSettingsSchema['profileLimits'] | null;
    loading: boolean;
    error: Error | null;
    refetch: () => Promise<void>;
} {
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
