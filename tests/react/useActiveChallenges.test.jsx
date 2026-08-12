/**
 * useActiveChallenges — the fetch-failure handling that drives the transient
 * error banner. The api-client returns null after exhausting retries; with a
 * token present that's a failure (not an empty list), so the hook must surface
 * an error, keep the last-known challenges on screen, and clear the error on
 * the next success. Not-logged-in (no token) must NOT raise an error.
 */
import { renderHook, waitFor, act } from '@testing-library/preact';
import { useActiveChallenges } from '@/api/useActiveChallenges';
import { mockApi } from './helpers/setup';

describe('useActiveChallenges', () => {
    beforeEach(() => {
        window.api = mockApi;
        mockApi.getSettings.mockReset().mockResolvedValue({ token: 'tok' });
        mockApi.getActiveChallenges.mockReset().mockResolvedValue({ challenges: [] });
    });

    test('a null result with a token sets fetch_failed and preserves prior data', async () => {
        mockApi.getActiveChallenges.mockResolvedValueOnce({ challenges: [{ id: 1 }] });

        const { result } = renderHook(() => useActiveChallenges());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toEqual([{ id: 1 }]);
        expect(result.current.error).toBeNull();

        mockApi.getActiveChallenges.mockResolvedValueOnce(null);
        await act(async () => {
            await result.current.refetch();
        });

        expect(result.current.error).not.toBeNull();
        expect(result.current.error.message).toBe('fetch_failed');
        expect(result.current.data).toEqual([{ id: 1 }]); // last-known kept, not blanked
    });

    test('a fetchFailed result with a token sets fetch_failed and preserves prior data', async () => {
        // getActiveChallenges always resolves a list shape, so the `result == null` check the
        // test above covers could never actually fire for it — a real outage arrived here as
        // a plain empty list and rendered as "no active challenges", leaving the banner this
        // hook exists to drive permanently dead. The fetchFailed marker is what distinguishes
        // an outage from an account that genuinely has nothing active.
        mockApi.getActiveChallenges.mockResolvedValueOnce({ challenges: [{ id: 1 }] });

        const { result } = renderHook(() => useActiveChallenges());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toEqual([{ id: 1 }]);

        mockApi.getActiveChallenges.mockResolvedValueOnce({ challenges: [], fetchFailed: true });
        await act(async () => {
            await result.current.refetch();
        });

        expect(result.current.error?.message).toBe('fetch_failed');
        expect(result.current.data).toEqual([{ id: 1 }]); // last-known kept, not blanked
    });

    test('a genuinely empty list is not treated as a failure', async () => {
        // The other half of the distinction: having no active challenges is a valid state,
        // and must still clear the list rather than showing a stale one behind an error.
        mockApi.getActiveChallenges.mockResolvedValueOnce({ challenges: [{ id: 1 }] });

        const { result } = renderHook(() => useActiveChallenges());
        await waitFor(() => expect(result.current.loading).toBe(false));

        mockApi.getActiveChallenges.mockResolvedValueOnce({ challenges: [] });
        await act(async () => {
            await result.current.refetch();
        });

        expect(result.current.error).toBeNull();
        expect(result.current.data).toEqual([]);
    });

    test('a fetchFailed result without a token does NOT raise an error', async () => {
        mockApi.getSettings.mockResolvedValue({ token: '' });
        mockApi.getActiveChallenges.mockResolvedValue({ challenges: [], fetchFailed: true });

        const { result } = renderHook(() => useActiveChallenges());
        await waitFor(() => expect(result.current.loading).toBe(false));

        expect(result.current.error).toBeNull();
    });

    test('a null result without a token does NOT raise an error', async () => {
        mockApi.getSettings.mockResolvedValue({ token: '' });
        mockApi.getActiveChallenges.mockResolvedValue(null);

        const { result } = renderHook(() => useActiveChallenges());
        await waitFor(() => expect(result.current.loading).toBe(false));

        expect(result.current.error).toBeNull();
        expect(result.current.data).toEqual([]);
    });

    test('a prior error clears on the next successful fetch', async () => {
        mockApi.getActiveChallenges.mockResolvedValueOnce(null);

        const { result } = renderHook(() => useActiveChallenges());
        await waitFor(() => expect(result.current.error).not.toBeNull());

        mockApi.getActiveChallenges.mockResolvedValueOnce({ challenges: [{ id: 2 }] });
        await act(async () => {
            await result.current.refetch();
        });

        expect(result.current.error).toBeNull();
        expect(result.current.data).toEqual([{ id: 2 }]);
    });
});
