/**
 * The settings IPC hooks: useSettings (optimistic update + error refetch),
 * useEnvironmentInfo (optional garnish, tolerant of failure) and
 * useSettingsSchema (null-safe projection of the schema payload). All go
 * through the mocked window.api from helpers/setup.js; per-test resolved
 * values use the *Once variants so nothing leaks between tests.
 */

import { renderHook, waitFor, act } from '@testing-library/preact';
import { useSettings, useEnvironmentInfo } from '@/api/useSettings';
import { useSettingsSchema } from '@/api/useSettingsSchema';

describe('useSettings', () => {
    test('loads settings and exposes getSetting', async () => {
        window.api.getSettings.mockResolvedValueOnce({ theme: 'dark' });
        const { result } = renderHook(() => useSettings());

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.settings).toEqual({ theme: 'dark' });
        expect(result.current.getSetting('theme')).toBe('dark');
        expect(result.current.getSetting('missing')).toBeUndefined();
    });

    test('updateSetting persists over IPC and applies the value optimistically', async () => {
        window.api.getSettings.mockResolvedValueOnce({ theme: 'dark', language: 'en' });
        const { result } = renderHook(() => useSettings());
        await waitFor(() => expect(result.current.loading).toBe(false));

        await act(async () => {
            await result.current.updateSetting('language', 'lv');
        });

        expect(window.api.setSetting).toHaveBeenCalledWith('language', 'lv');
        expect(result.current.settings).toEqual({ theme: 'dark', language: 'lv' });
    });

    test('with nothing loaded, getSetting is undefined and an update keeps settings null', async () => {
        window.api.getSettings.mockResolvedValueOnce(null);
        const { result } = renderHook(() => useSettings());
        await waitFor(() => expect(result.current.loading).toBe(false));

        expect(result.current.getSetting('theme')).toBeUndefined();
        await act(async () => {
            await result.current.updateSetting('theme', 'light');
        });
        expect(window.api.setSetting).toHaveBeenCalledWith('theme', 'light');
        expect(result.current.settings).toBeNull();
    });

    test('a failed write refetches the real state and rethrows', async () => {
        window.api.getSettings.mockResolvedValueOnce({ theme: 'dark' }).mockResolvedValueOnce({ theme: 'from-disk' });
        const failure = new Error('disk full');
        window.api.setSetting.mockRejectedValueOnce(failure);
        const { result } = renderHook(() => useSettings());
        await waitFor(() => expect(result.current.loading).toBe(false));

        let thrown;
        await act(async () => {
            try {
                await result.current.updateSetting('theme', 'light');
            } catch (err) {
                thrown = err;
            }
        });

        expect(thrown).toBe(failure);
        expect(window.api.getSettings).toHaveBeenCalledTimes(2);
        // The refetch replaced the optimistic path with what is really on disk.
        expect(result.current.settings).toEqual({ theme: 'from-disk' });
    });
});

describe('useEnvironmentInfo', () => {
    test('exposes the environment payload once loaded', async () => {
        window.api.getEnvironmentInfo.mockResolvedValueOnce({ platform: 'linux', dev: false });
        const { result } = renderHook(() => useEnvironmentInfo());

        expect(result.current.loading).toBe(true);
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.envInfo).toEqual({ platform: 'linux', dev: false });
    });

    test('a failing IPC call leaves envInfo null and still stops loading', async () => {
        window.api.getEnvironmentInfo.mockRejectedValueOnce(new Error('no ipc'));
        const { result } = renderHook(() => useEnvironmentInfo());

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.envInfo).toBeNull();
    });
});

describe('useSettingsSchema', () => {
    test('projects every field of the schema payload', async () => {
        const payload = {
            schema: { exposure: { type: 'number' } },
            defaults: { exposure: 100 },
            groups: [{ id: 'general' }],
            tiers: [{ id: 'core' }],
            profileLimits: { maxProfiles: 5 },
        };
        window.api.getSettingsSchema.mockResolvedValueOnce(payload);
        const { result } = renderHook(() => useSettingsSchema());

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current).toMatchObject(payload);
        expect(result.current.error).toBeNull();
        expect(typeof result.current.refetch).toBe('function');
    });

    test('every field is null when the payload is missing', async () => {
        window.api.getSettingsSchema.mockResolvedValueOnce(undefined);
        const { result } = renderHook(() => useSettingsSchema());

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current).toMatchObject({
            schema: null,
            defaults: null,
            groups: null,
            tiers: null,
            profileLimits: null,
        });
    });
});
