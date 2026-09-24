/**
 * Edge paths of the thin IPC hooks in src/js/react/api/: the fallback error
 * labels, the rejection / malformed-response branches, and the late-resolve
 * cancellation guards. Each hook is driven through the window.api mock.
 */
import { renderHook, waitFor, act } from '@testing-library/preact';
import { useAsyncIpcAction } from '@/api/useAsyncIpcAction';
import { useAuth } from '@/api/useAuth';
import { useBoost } from '@/api/useBoost';
import { useTurbo } from '@/api/useTurbo';
import { useFillChallenge } from '@/api/useFillChallenge';
import { useDeadlineActions } from '@/api/useDeadlineActions';
import { useMemberChallenges } from '@/api/useMemberChallenges';
import { useSwapBacks } from '@/api/useSwapBacks';
import { useActiveChallenges } from '@/api/useActiveChallenges';
import { mockApi } from './helpers/setup';

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

beforeEach(() => {
    window.api = mockApi;
    jest.clearAllMocks();
});

describe('useAsyncIpcAction', () => {
    test('without labels, falls back to the generic failure and error messages', async () => {
        const invoker = jest
            .fn()
            .mockResolvedValueOnce({ success: false })
            .mockRejectedValueOnce(new Error(''))
            .mockResolvedValueOnce({ success: true });
        const { result } = renderHook(() => useAsyncIpcAction(invoker));

        await act(async () => {
            await result.current.run(1);
        });
        expect(result.current.error).toBe('Action failed');

        let ret;
        await act(async () => {
            ret = await result.current.run(2);
        });
        expect(ret).toEqual({ success: false, error: 'Action error' });
        expect(result.current.error).toBe('Action error');

        await act(async () => {
            ret = await result.current.run(3);
        });
        expect(ret).toEqual({ success: true });
        expect(result.current.error).toBeNull();
        expect(result.current.loading).toBe(false);
        expect(invoker.mock.calls).toEqual([[1], [2], [3]]);
    });

    test('an undefined result counts as failure; explicit labels win; clearError resets', async () => {
        const invoker = jest.fn().mockResolvedValue(undefined);
        const { result } = renderHook(() => useAsyncIpcAction(invoker, { failureMessage: 'nope' }));
        await act(async () => {
            await result.current.run();
        });
        expect(result.current.error).toBe('nope');
        act(() => result.current.clearError());
        expect(result.current.error).toBeNull();
    });
});

describe('useAuth transitions', () => {
    test('login and logout rejections without a message use their fallbacks', async () => {
        mockApi.login.mockRejectedValueOnce({});
        const { result } = renderHook(() => useAuth());
        await act(async () => {
            await result.current.login();
        });
        expect(result.current.error).toBe('Login transition failed');

        mockApi.logout.mockRejectedValueOnce({});
        await act(async () => {
            await result.current.logout();
        });
        expect(result.current.error).toBe('Logout failed');

        mockApi.logout.mockRejectedValueOnce(new Error('ipc gone'));
        await act(async () => {
            await result.current.logout();
        });
        expect(result.current.error).toBe('ipc gone');

        act(() => result.current.clearError());
        expect(result.current.error).toBeNull();
    });

    test('successful login/logout leave no error and authenticate forwards the mock flag', async () => {
        const { result } = renderHook(() => useAuth());
        await act(async () => {
            await result.current.login();
            await result.current.logout();
            await result.current.authenticate('u', 'p', true);
        });
        expect(mockApi.login).toHaveBeenCalledTimes(1);
        expect(mockApi.logout).toHaveBeenCalledTimes(1);
        expect(mockApi.authenticate).toHaveBeenCalledWith('u', 'p', true);
        expect(result.current.error).toBeNull();
    });
});

describe('useBoost / useTurbo / useFillChallenge', () => {
    test('useBoost forwards (challengeId, imageId) and surfaces its failure label', async () => {
        mockApi.applyBoost.mockResolvedValueOnce({ success: false });
        const { result } = renderHook(() => useBoost());
        await act(async () => {
            await result.current.applyBoost('c1', 'img1');
        });
        expect(mockApi.applyBoost).toHaveBeenCalledWith('c1', 'img1');
        expect(result.current.error).toBe('Boost failed');
        act(() => result.current.clearError());
        expect(result.current.error).toBeNull();
    });

    test('useTurbo runs both actions and merges their errors', async () => {
        mockApi.applyTurbo.mockRejectedValueOnce({});
        mockApi.playAutoTurbo.mockResolvedValueOnce({ success: false });
        const { result } = renderHook(() => useTurbo());

        await act(async () => {
            await result.current.playAutoTurbo('c1', 'Title');
        });
        expect(mockApi.playAutoTurbo).toHaveBeenCalledWith('c1', 'Title');
        expect(result.current.error).toBe('Auto-turbo run failed');

        await act(async () => {
            await result.current.applyTurbo('c1', 'img');
        });
        expect(mockApi.applyTurbo).toHaveBeenCalledWith('c1', 'img');
        // apply side wins when both hold an error
        expect(result.current.error).toBe('Turbo apply error');

        act(() => result.current.clearError());
        expect(result.current.error).toBeNull();
        expect(result.current.loading).toBe(false);
    });

    test('useFillChallenge forwards the mode and reports its error label', async () => {
        mockApi.fillChallengeNow.mockRejectedValueOnce({});
        const { result } = renderHook(() => useFillChallenge());
        await act(async () => {
            await result.current.fillNow('c9', 'fill');
        });
        expect(mockApi.fillChallengeNow).toHaveBeenCalledWith('c9', 'fill');
        expect(result.current.error).toBe('Photo submit error');
        act(() => result.current.clearError());
        expect(result.current.error).toBeNull();
    });
});

describe('useDeadlineActions', () => {
    const challenge = {
        id: 5,
        close_time: 100,
        member: { boost: { state: 'AVAILABLE' }, ranking: { entries: [{ id: 'a', turbo: true }, null] } },
    };

    test('a success with a non-array actions field yields an empty list', async () => {
        mockApi.getDeadlineActions.mockResolvedValueOnce({ success: true, actions: 'x', boostBlocked: true });
        const { result } = renderHook(() => useDeadlineActions(challenge));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current).toEqual({ actions: [], boostBlocked: true, loading: false, error: false });
    });

    test('an unsuccessful response sets error; a success passes actions through', async () => {
        mockApi.getDeadlineActions.mockResolvedValueOnce({ success: false });
        const { result, rerender } = renderHook(({ c }) => useDeadlineActions(c), { initialProps: { c: challenge } });
        await waitFor(() => expect(result.current.error).toBe(true));

        mockApi.getDeadlineActions.mockResolvedValueOnce({ success: true, actions: [{ action: 'turbo' }] });
        rerender({ c: { ...challenge, close_time: 200 } });
        await waitFor(() => expect(result.current.actions).toEqual([{ action: 'turbo' }]));
        expect(result.current.boostBlocked).toBe(false);
    });

    test('a new settingsVersion refetches with the same challenge content', async () => {
        mockApi.getDeadlineActions.mockResolvedValueOnce({ success: true, actions: [], boostBlocked: false });
        const { result, rerender } = renderHook(({ v }) => useDeadlineActions(challenge, v), {
            initialProps: { v: 0 },
        });
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(1);

        mockApi.getDeadlineActions.mockResolvedValueOnce({ success: true, actions: [], boostBlocked: true });
        rerender({ v: 1 });
        await waitFor(() => expect(result.current.boostBlocked).toBe(true));
        expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(2);

        // A re-render with the same version and content does not refetch.
        rerender({ v: 1 });
        expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(2);
    });

    test('a rejection sets error; a late rejection after unmount is ignored', async () => {
        mockApi.getDeadlineActions.mockRejectedValueOnce(new Error('boom'));
        const { result } = renderHook(() => useDeadlineActions(challenge));
        await waitFor(() => expect(result.current.error).toBe(true));

        const late = deferred();
        mockApi.getDeadlineActions.mockReturnValueOnce(late.promise);
        const second = renderHook(() => useDeadlineActions({ id: 6 }));
        second.unmount();
        await act(async () => {
            late.reject(new Error('late'));
            await late.promise.catch(() => {});
        });
        expect(second.result.current.loading).toBe(true);
    });

    test('a late success after unmount is ignored', async () => {
        const late = deferred();
        mockApi.getDeadlineActions.mockReturnValueOnce(late.promise);
        const { result, unmount } = renderHook(() => useDeadlineActions(null));
        unmount();
        await act(async () => {
            late.resolve({ success: true, actions: [{ action: 'boost' }] });
            await late.promise;
        });
        expect(result.current.actions).toEqual([]);
    });
});

describe('useMemberChallenges', () => {
    test('a failed response empties items and surfaces the server error', async () => {
        mockApi.getMemberChallenges.mockResolvedValueOnce({ success: false, error: 'rate_limited' });
        const { result } = renderHook(() => useMemberChallenges());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.items).toEqual([]);
        expect(result.current.error.message).toBe('rate_limited');
    });

    test('a missing response falls back to fetch_failed; a non-array success is empty', async () => {
        mockApi.getMemberChallenges.mockResolvedValueOnce(undefined);
        const { result } = renderHook(() => useMemberChallenges());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.error.message).toBe('fetch_failed');

        mockApi.getMemberChallenges.mockResolvedValueOnce({ success: true, items: null });
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.items).toEqual([]);
        expect(result.current.error).toBeNull();

        mockApi.getMemberChallenges.mockResolvedValueOnce({ success: true, items: [{ id: 1 }] });
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.items).toEqual([{ id: 1 }]);
    });
});

describe('useSwapBacks', () => {
    test('a rejected read is no offers', async () => {
        mockApi.getSwapBacks.mockResolvedValueOnce({ success: true, items: [{ currentId: 'x' }] });
        const challenge = { id: 3, member: { ranking: { entries: [{ id: 'e1' }] } } };
        const { result, rerender } = renderHook(({ c }) => useSwapBacks(c), { initialProps: { c: challenge } });
        await waitFor(() => expect(result.current).toEqual([{ currentId: 'x' }]));

        mockApi.getSwapBacks.mockRejectedValueOnce(new Error('ipc'));
        rerender({ c: { ...challenge, member: { ranking: { entries: [{ id: 'e2' }] } } } });
        await waitFor(() => expect(result.current).toEqual([]));
        expect(mockApi.getSwapBacks).toHaveBeenLastCalledWith('3');
    });

    test('no challenge id means no read; an unsuccessful read is no offers', async () => {
        const { result, rerender } = renderHook(({ c }) => useSwapBacks(c), { initialProps: { c: null } });
        expect(result.current).toEqual([]);
        expect(mockApi.getSwapBacks).not.toHaveBeenCalled();

        mockApi.getSwapBacks.mockResolvedValueOnce({ success: false, items: [{ currentId: 'z' }] });
        rerender({ c: { id: 8 } });
        await waitFor(() => expect(mockApi.getSwapBacks).toHaveBeenCalledWith('8'));
        expect(result.current).toEqual([]);

        mockApi.getSwapBacks.mockResolvedValueOnce(undefined);
        rerender({ c: { id: 9 } });
        await waitFor(() => expect(mockApi.getSwapBacks).toHaveBeenCalledWith('9'));
        expect(result.current).toEqual([]);
    });

    test('a late rejection after unmount is ignored', async () => {
        const late = deferred();
        mockApi.getSwapBacks.mockReturnValueOnce(late.promise);
        const { unmount } = renderHook(() => useSwapBacks({ id: 4 }));
        unmount();
        await act(async () => {
            late.reject(new Error('late'));
            await late.promise.catch(() => {});
        });
        expect(mockApi.getSwapBacks).toHaveBeenCalledWith('4');
    });
});

describe('useActiveChallenges unserialisable payload', () => {
    test('a payload JSON.stringify cannot encode is treated as changed and still applied', async () => {
        const weird = [{ id: 1, big: 10n }];
        mockApi.getSettings.mockResolvedValue({ token: 'tok' });
        mockApi.getActiveChallenges.mockResolvedValue({ challenges: weird });
        const { result } = renderHook(() => useActiveChallenges());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toBe(weird);

        // A second identical-but-unserialisable payload is applied again rather
        // than being deduped against a stale key.
        const weird2 = [{ id: 1, big: 10n }];
        mockApi.getActiveChallenges.mockResolvedValue({ challenges: weird2 });
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.data).toBe(weird2);
    });

    test('an identical payload is deduped: the data reference is kept', async () => {
        mockApi.getSettings.mockResolvedValue({ token: 'tok' });
        mockApi.getActiveChallenges.mockResolvedValueOnce({ challenges: [{ id: 1 }] });
        const { result } = renderHook(() => useActiveChallenges());
        await waitFor(() => expect(result.current.loading).toBe(false));
        const first = result.current.data;

        mockApi.getActiveChallenges.mockResolvedValueOnce({ challenges: [{ id: 1 }] });
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.data).toBe(first);
    });

    test('while autovote runs, stale-settings cleanup is skipped but metadata cleanup still runs', async () => {
        mockApi.getSettings.mockResolvedValue({ token: 'tok' });
        mockApi.getActiveChallenges.mockResolvedValue({ challenges: [{ id: 7 }] });
        const { result } = renderHook(() => useActiveChallenges(true));
        await waitFor(() => expect(mockApi.cleanupStaleMetadata).toHaveBeenCalledWith(['7']));
        expect(result.current.data).toEqual([{ id: 7 }]);
        expect(mockApi.cleanupStaleChallengeSetting).not.toHaveBeenCalled();
    });
});
