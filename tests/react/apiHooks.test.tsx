/**
 * Edge paths of the thin IPC hooks in src/ts/react/api/: the fallback error
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
import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const deferred = () => {
    let resolve!: (value: unknown) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

beforeEach(() => {
    window.api = invalid(mockApi);
    jest.clearAllMocks();
});

describe('useAsyncIpcAction', () => {
    test('without labels, falls back to the generic failure and error codes, and logs the raw detail', async () => {
        const invoker = jest
            .fn()
            .mockResolvedValueOnce({ success: false })
            .mockRejectedValueOnce(new Error(''))
            .mockResolvedValueOnce({ success: true });
        const { result } = renderHook(() => useAsyncIpcAction(invoker));

        await act(async () => {
            await result.current.run(1);
        });
        expect(result.current.error).toBe('action-failed');
        expect(mockApi.logWarning).toHaveBeenCalledWith('IPC action failed: action-failed');

        let ret;
        await act(async () => {
            ret = await result.current.run(2);
        });
        expect(ret).toEqual({ success: false, error: 'action-error' });
        expect(result.current.error).toBe('action-error');
        expect(mockApi.logError).toHaveBeenCalledWith('IPC action threw: action-error');

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
    test('login and logout rejections are stored as codes', async () => {
        mockApi.login.mockRejectedValueOnce({});
        const { result } = renderHook(() => useAuth());
        await act(async () => {
            await result.current.login();
        });
        expect(result.current.error).toBe('login-transition-failed');

        mockApi.logout.mockRejectedValueOnce({});
        await act(async () => {
            await result.current.logout();
        });
        expect(result.current.error).toBe('logout-failed');

        mockApi.login.mockRejectedValueOnce(null);
        await act(async () => {
            await result.current.login();
        });
        expect(result.current.error).toBe('login-transition-failed');

        mockApi.logout.mockRejectedValueOnce(null);
        await act(async () => {
            await result.current.logout();
        });
        expect(result.current.error).toBe('logout-failed');

        mockApi.logout.mockRejectedValueOnce(new Error('ipc gone'));
        await act(async () => {
            await result.current.logout();
        });
        expect(result.current.error).toBe('logout-failed');

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
    test('useBoost forwards (challengeId, imageId) and surfaces the generic failure code', async () => {
        mockApi.applyBoost.mockResolvedValueOnce(invalid({ success: false }));
        const { result } = renderHook(() => useBoost());
        await act(async () => {
            await result.current.applyBoost('c1', 'img1');
        });
        expect(mockApi.applyBoost).toHaveBeenCalledWith('c1', 'img1');
        expect(result.current.error).toBe('action-failed');
        act(() => result.current.clearError());
        expect(result.current.error).toBeNull();
    });

    test('useTurbo runs both actions and merges their errors', async () => {
        mockApi.applyTurbo.mockRejectedValueOnce({});
        mockApi.playAutoTurbo.mockResolvedValueOnce(invalid({ success: false }));
        const { result } = renderHook(() => useTurbo());

        await act(async () => {
            await result.current.playAutoTurbo('c1', 'Title');
        });
        expect(mockApi.playAutoTurbo).toHaveBeenCalledWith('c1', 'Title');
        expect(result.current.error).toBe('action-failed');

        await act(async () => {
            await result.current.applyTurbo('c1', 'img');
        });
        expect(mockApi.applyTurbo).toHaveBeenCalledWith('c1', 'img');
        // apply side wins when both hold an error
        expect(result.current.error).toBe('action-error');

        act(() => result.current.clearError());
        expect(result.current.error).toBeNull();
        expect(result.current.loading).toBe(false);
    });

    test.each([[{}], [null]])(
        'useFillChallenge forwards the mode and reports the generic error code (%p)',
        async (thrown) => {
            mockApi.fillChallengeNow.mockRejectedValueOnce(thrown);
            const { result } = renderHook(() => useFillChallenge());
            await act(async () => {
                await result.current.fillNow('c9', invalid('fill'));
            });
            expect(mockApi.fillChallengeNow).toHaveBeenCalledWith('c9', 'fill');
            expect(result.current.error).toBe('action-error');
            act(() => result.current.clearError());
            expect(result.current.error).toBeNull();
        },
    );
});

describe('useDeadlineActions', () => {
    const challenge = invalid<Challenge>({
        id: 5,
        close_time: 100,
        member: { boost: { state: 'AVAILABLE' }, ranking: { entries: [{ id: 'a', turbo: true }, null] } },
    });

    // The block fields of an answer with nothing blocked.
    const calm = { boostBlockedBy: null, turboBlockedBy: null, boostReleaseAt: null, turboReleaseAt: null };

    test('a success with a non-array actions field yields an empty list', async () => {
        mockApi.getDeadlineActions.mockResolvedValueOnce(invalid({ success: true, actions: 'x', boostBlocked: true }));
        const { result } = renderHook(() => useDeadlineActions(challenge));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current).toEqual({
            actions: [],
            boostBlocked: true,
            turboBlocked: false,
            ...calm,
            loading: false,
            error: false,
        });
    });

    test('an unsuccessful response sets error; a success passes actions through', async () => {
        mockApi.getDeadlineActions.mockResolvedValueOnce(invalid({ success: false }));
        const { result, rerender } = renderHook(({ c }) => useDeadlineActions(c), { initialProps: { c: challenge } });
        await waitFor(() => expect(result.current.error).toBe(true));

        mockApi.getDeadlineActions.mockResolvedValueOnce(invalid({ success: true, actions: [{ action: 'turbo' }] }));
        rerender({ c: { ...challenge, close_time: 200 } });
        await waitFor(() => expect(result.current.actions).toEqual([{ action: 'turbo' }]));
        expect(result.current.boostBlocked).toBe(false);
    });

    test('a new settingsVersion refetches with the same challenge content', async () => {
        mockApi.getDeadlineActions.mockResolvedValueOnce({
            success: true,
            actions: [],
            boostBlocked: false,
            turboBlocked: false,
            ...calm,
        });
        const { result, rerender } = renderHook(({ v }) => useDeadlineActions(challenge, v), {
            initialProps: { v: 0 },
        });
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(1);

        mockApi.getDeadlineActions.mockResolvedValueOnce({
            success: true,
            actions: [],
            boostBlocked: true,
            turboBlocked: false,
            ...calm,
        });
        rerender({ v: 1 });
        await waitFor(() => expect(result.current.boostBlocked).toBe(true));
        expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(2);

        // A re-render with the same version and content does not refetch.
        rerender({ v: 1 });
        expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(2);
    });

    test('turboBlocked passes through from the response', async () => {
        mockApi.getDeadlineActions.mockResolvedValueOnce({
            success: true,
            actions: [],
            boostBlocked: false,
            turboBlocked: true,
            ...calm,
        });
        const { result } = renderHook(() => useDeadlineActions(challenge));
        await waitFor(() => expect(result.current.turboBlocked).toBe(true));
    });

    test('refetches once when a blocking pin is due to give way, then stops', async () => {
        jest.useFakeTimers();
        try {
            const releaseAt = Math.floor(Date.now() / 1000) + 60;
            mockApi.getDeadlineActions.mockClear();
            mockApi.getDeadlineActions.mockResolvedValueOnce({
                success: true,
                actions: [],
                boostBlocked: true,
                turboBlocked: false,
                ...calm,
                boostBlockedBy: 'pin',
                boostReleaseAt: releaseAt,
            });
            mockApi.getDeadlineActions.mockResolvedValueOnce({
                success: true,
                actions: [],
                boostBlocked: false,
                turboBlocked: false,
                ...calm,
            });
            const { result } = renderHook(() => useDeadlineActions(challenge));
            await waitFor(() => expect(result.current.boostBlocked).toBe(true));
            expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(1);

            await act(async () => {
                await jest.advanceTimersByTimeAsync(30_000);
            });
            expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(1);

            await act(async () => {
                await jest.advanceTimersByTimeAsync(32_000);
            });
            await waitFor(() => expect(result.current.boostBlocked).toBe(false));
            expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(2);

            await act(async () => {
                await jest.advanceTimersByTimeAsync(600_000);
            });
            expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    test('after the first release refetch, the later release instant is armed again', async () => {
        jest.useFakeTimers();
        try {
            const first = Math.floor(Date.now() / 1000) + 60;
            mockApi.getDeadlineActions.mockClear();
            const blocked = (boostReleaseAt: number) => ({
                success: true as const,
                actions: [],
                boostBlocked: true,
                turboBlocked: false,
                ...calm,
                boostBlockedBy: 'pin' as const,
                boostReleaseAt,
            });
            mockApi.getDeadlineActions.mockResolvedValueOnce(blocked(first));
            mockApi.getDeadlineActions.mockResolvedValueOnce(blocked(first + 600));
            mockApi.getDeadlineActions.mockResolvedValueOnce({
                success: true,
                actions: [],
                boostBlocked: false,
                turboBlocked: false,
                ...calm,
            });
            const { result } = renderHook(() => useDeadlineActions(challenge));
            await waitFor(() => expect(result.current.boostBlocked).toBe(true));
            await act(async () => {
                await jest.advanceTimersByTimeAsync(62_000);
            });
            await waitFor(() => expect(result.current.boostReleaseAt).toBe(first + 600));
            expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(2);

            // Not yet at the later instant: still blocked, no third fetch.
            await act(async () => {
                await jest.advanceTimersByTimeAsync(300_000);
            });
            expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(2);

            await act(async () => {
                await jest.advanceTimersByTimeAsync(302_000);
            });
            await waitFor(() => expect(result.current.boostBlocked).toBe(false));
            expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(3);
        } finally {
            jest.useRealTimers();
        }
    });

    test('a release instant already past, or too far for one timer, still arms a valid refetch', async () => {
        jest.useFakeTimers();
        try {
            mockApi.getDeadlineActions.mockClear();
            const answer = (boostReleaseAt: number | null) => ({
                success: true as const,
                actions: [],
                boostBlocked: true,
                turboBlocked: false,
                ...calm,
                boostBlockedBy: 'pin' as const,
                boostReleaseAt,
            });
            mockApi.getDeadlineActions.mockResolvedValueOnce(answer(1));
            mockApi.getDeadlineActions.mockResolvedValueOnce(answer(2 ** 40));
            const { result } = renderHook(() => useDeadlineActions(challenge));
            await waitFor(() => expect(result.current.boostBlocked).toBe(true));
            await act(async () => {
                await jest.advanceTimersByTimeAsync(1500);
            });
            expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(2);
            // The far instant waits out the longest single timer instead of firing at once.
            await act(async () => {
                await jest.advanceTimersByTimeAsync(60_000);
            });
            expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    test('the one refetch waits for the sooner of the two release instants, and the state carries both causes', async () => {
        jest.useFakeTimers();
        try {
            const soon = Math.floor(Date.now() / 1000) + 60;
            mockApi.getDeadlineActions.mockClear();
            mockApi.getDeadlineActions.mockResolvedValueOnce({
                success: true,
                actions: [],
                boostBlocked: true,
                turboBlocked: true,
                boostBlockedBy: 'pin',
                turboBlockedBy: 'pin',
                boostReleaseAt: soon + 600,
                turboReleaseAt: soon,
            });
            mockApi.getDeadlineActions.mockResolvedValueOnce({
                success: true,
                actions: [],
                boostBlocked: false,
                turboBlocked: false,
                ...calm,
            });
            const { result } = renderHook(() => useDeadlineActions(challenge));
            await waitFor(() => expect(result.current.boostBlocked).toBe(true));
            expect(result.current).toMatchObject({
                boostBlockedBy: 'pin',
                turboBlockedBy: 'pin',
                boostReleaseAt: soon + 600,
                turboReleaseAt: soon,
            });
            await act(async () => {
                await jest.advanceTimersByTimeAsync(62_000);
            });
            await waitFor(() => expect(result.current.boostBlocked).toBe(false));
            expect(mockApi.getDeadlineActions).toHaveBeenCalledTimes(2);
        } finally {
            jest.useRealTimers();
        }
    });

    test('a rejection sets error; a late rejection after unmount is ignored', async () => {
        mockApi.getDeadlineActions.mockRejectedValueOnce(new Error('boom'));
        const { result } = renderHook(() => useDeadlineActions(challenge));
        await waitFor(() => expect(result.current.error).toBe(true));

        const late = deferred();
        mockApi.getDeadlineActions.mockReturnValueOnce(invalid(late.promise));
        const second = renderHook(() => useDeadlineActions(invalid({ id: 6 })));
        second.unmount();
        await act(async () => {
            late.reject(new Error('late'));
            await late.promise.catch(() => {});
        });
        expect(second.result.current.loading).toBe(true);
    });

    test('no challenge settles empty without calling the handler', async () => {
        mockApi.getDeadlineActions.mockClear();
        const { result, rerender } = renderHook(({ c }) => useDeadlineActions(c), {
            initialProps: { c: null as Challenge | null | undefined },
        });
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current).toEqual({
            actions: [],
            boostBlocked: false,
            turboBlocked: false,
            ...calm,
            loading: false,
            error: false,
        });
        rerender({ c: undefined });
        expect(mockApi.getDeadlineActions).not.toHaveBeenCalled();
    });

    test('a late success after unmount is ignored', async () => {
        const late = deferred();
        mockApi.getDeadlineActions.mockReturnValueOnce(invalid(late.promise));
        const { result, unmount } = renderHook(() => useDeadlineActions(challenge));
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
        expect(result.current.error!.message).toBe('rate_limited');
    });

    test('a missing response falls back to fetch_failed; a non-array success is empty', async () => {
        mockApi.getMemberChallenges.mockResolvedValueOnce(invalid(undefined));
        const { result } = renderHook(() => useMemberChallenges());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.error!.message).toBe('fetch_failed');

        mockApi.getMemberChallenges.mockResolvedValueOnce(invalid({ success: true, items: null }));
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.items).toEqual([]);
        expect(result.current.error).toBeNull();

        mockApi.getMemberChallenges.mockResolvedValueOnce(invalid({ success: true, items: [{ id: 1 }] }));
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.items).toEqual([{ id: 1 }]);
    });
});

describe('useSwapBacks', () => {
    test('a rejected read is no offers', async () => {
        mockApi.getSwapBacks.mockResolvedValueOnce(invalid({ success: true, items: [{ currentId: 'x' }] }));
        const challenge = invalid<Challenge>({ id: 3, member: { ranking: { entries: [{ id: 'e1' }] } } });
        const { result, rerender } = renderHook(({ c }) => useSwapBacks(c), { initialProps: { c: challenge } });
        await waitFor(() => expect(result.current).toEqual([{ currentId: 'x' }]));

        mockApi.getSwapBacks.mockRejectedValueOnce(new Error('ipc'));
        rerender({ c: { ...challenge, member: { ranking: { entries: [{ id: 'e2' }] } } } });
        await waitFor(() => expect(result.current).toEqual([]));
        expect(mockApi.getSwapBacks).toHaveBeenLastCalledWith('3');
    });

    test('no challenge id means no read; an unsuccessful read is no offers', async () => {
        const { result, rerender } = renderHook(({ c }: { c: Challenge | null }) => useSwapBacks(c), {
            initialProps: { c: null },
        });
        expect(result.current).toEqual([]);
        expect(mockApi.getSwapBacks).not.toHaveBeenCalled();

        mockApi.getSwapBacks.mockResolvedValueOnce(invalid({ success: false, items: [{ currentId: 'z' }] }));
        rerender({ c: invalid({ id: 8 }) });
        await waitFor(() => expect(mockApi.getSwapBacks).toHaveBeenCalledWith('8'));
        expect(result.current).toEqual([]);

        mockApi.getSwapBacks.mockResolvedValueOnce(invalid(undefined));
        rerender({ c: invalid({ id: 9 }) });
        await waitFor(() => expect(mockApi.getSwapBacks).toHaveBeenCalledWith('9'));
        expect(result.current).toEqual([]);
    });

    test('a late rejection after unmount is ignored', async () => {
        const late = deferred();
        mockApi.getSwapBacks.mockReturnValueOnce(invalid(late.promise));
        const { unmount } = renderHook(() => useSwapBacks(invalid({ id: 4 })));
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
        mockApi.getSettings.mockResolvedValue(invalid({ token: 'tok' }));
        mockApi.getActiveChallenges.mockResolvedValue(invalid({ challenges: weird }));
        const { result } = renderHook(() => useActiveChallenges());
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toBe(weird);

        // A second identical-but-unserialisable payload is applied again rather
        // than being deduped against a stale key.
        const weird2 = [{ id: 1, big: 10n }];
        mockApi.getActiveChallenges.mockResolvedValue(invalid({ challenges: weird2 }));
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.data).toBe(weird2);
    });

    test('an identical payload is deduped: the data reference is kept', async () => {
        mockApi.getSettings.mockResolvedValue(invalid({ token: 'tok' }));
        mockApi.getActiveChallenges.mockResolvedValueOnce(invalid({ challenges: [{ id: 1 }] }));
        const { result } = renderHook(() => useActiveChallenges());
        await waitFor(() => expect(result.current.loading).toBe(false));
        const first = result.current.data;

        mockApi.getActiveChallenges.mockResolvedValueOnce(invalid({ challenges: [{ id: 1 }] }));
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.data).toBe(first);
    });
});

describe('useActiveChallenges stale cleanup', () => {
    test('a refetch with skipCleanup applies the data without any cleanup', async () => {
        mockApi.getSettings.mockResolvedValue(invalid({ token: 'tok' }));
        mockApi.getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 7 }] }));
        const { result } = renderHook(() => useActiveChallenges());
        await waitFor(() => expect(mockApi.cleanupStaleMetadata).toHaveBeenCalledTimes(1));
        // With autovote stopped, a normal load prunes both stale settings and metadata.
        expect(mockApi.cleanupStaleChallengeSetting).toHaveBeenCalledWith(['7']);
        expect(mockApi.cleanupStaleMetadata).toHaveBeenCalledWith(['7']);
        mockApi.cleanupStaleChallengeSetting.mockClear();
        mockApi.cleanupStaleMetadata.mockClear();

        mockApi.getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 8 }] }));
        await act(async () => {
            await result.current.refetch(true);
        });
        expect(result.current.data).toEqual([{ id: 8 }]);
        expect(mockApi.cleanupStaleChallengeSetting).not.toHaveBeenCalled();
        expect(mockApi.cleanupStaleMetadata).not.toHaveBeenCalled();
    });

    test('while autovote runs, stale-settings cleanup is skipped but metadata cleanup still runs', async () => {
        mockApi.getSettings.mockResolvedValue(invalid({ token: 'tok' }));
        mockApi.getActiveChallenges.mockResolvedValue(invalid({ challenges: [{ id: 7 }] }));
        const { result } = renderHook(() => useActiveChallenges(true));
        await waitFor(() => expect(mockApi.cleanupStaleMetadata).toHaveBeenCalledWith(['7']));
        expect(result.current.data).toEqual([{ id: 7 }]);
        expect(mockApi.cleanupStaleChallengeSetting).not.toHaveBeenCalled();
    });
});
