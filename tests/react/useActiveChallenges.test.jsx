/**
 * useActiveChallenges — the fetch-failure handling that drives the transient
 * error banner. The api-client returns null after exhausting retries; with a
 * token present that's a failure (not an empty list), so the hook must surface
 * an error, keep the last-known challenges on screen, and clear the error on
 * the next success. Not-logged-in (no token) must NOT raise an error.
 */
import { renderHook, waitFor, act } from '@testing-library/preact';
import { useActiveChallenges } from '@/api/useActiveChallenges';
import { mockApi } from '../../src/js/react/test/setup';

describe('useActiveChallenges', () => {
    beforeEach(() => {
        window.api = mockApi;
        window.autovoteRunning = false;
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
