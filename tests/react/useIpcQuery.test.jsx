/**
 * Tests for the shared useIpcQuery envelope (api/useIpcQuery) that
 * useSettings / useSettingsSchema / useActiveChallenges are built on:
 * mount fetch, loading/error handling, the settings-changed
 * subscription, and the layering options (showLoading, apply,
 * clearErrorOnStart, singleFlight, enabled, latestOnly).
 */

import { renderHook, waitFor, act } from '@testing-library/preact';
import { useIpcQuery } from '@/api/useIpcQuery';

describe('useIpcQuery', () => {
    beforeEach(() => {
        window.api = { onSettingsChanged: undefined };
    });

    test('fetches on mount and stores the result', async () => {
        const queryFn = jest.fn().mockResolvedValue({ a: 1 });
        const { result } = renderHook(() => useIpcQuery(queryFn));

        expect(result.current.loading).toBe(true);
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toEqual({ a: 1 });
        expect(result.current.error).toBeNull();
        expect(queryFn).toHaveBeenCalledTimes(1);
    });

    test('a thrown error lands in error and refetch clears it by default', async () => {
        const queryFn = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
        const { result } = renderHook(() => useIpcQuery(queryFn, { initialData: 'seed' }));

        await waitFor(() => expect(result.current.error).not.toBeNull());
        expect(result.current.data).toBe('seed'); // untouched on error

        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.error).toBeNull();
        expect(result.current.data).toBe('ok');
    });

    test('subscribe: refetches when a settings-changed event fires', async () => {
        let listener;
        const unsubscribe = jest.fn();
        window.api = {
            onSettingsChanged: jest.fn((cb) => {
                listener = cb;
                return unsubscribe;
            }),
        };
        const queryFn = jest.fn().mockResolvedValue('x');
        const { unmount } = renderHook(() => useIpcQuery(queryFn, { subscribe: true }));

        await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
        await act(async () => {
            listener();
        });
        expect(queryFn).toHaveBeenCalledTimes(2);

        unmount();
        expect(unsubscribe).toHaveBeenCalled();
    });

    test('showLoading gates the loading toggle per call', async () => {
        const queryFn = jest.fn().mockResolvedValue('x');
        // Stable reference — like queryFn/apply, showLoading keys refetch's
        // identity, so an inline arrow would re-run the mount effect forever.
        const showLoading = (skip = false) => !skip;
        const { result } = renderHook(() => useIpcQuery(queryFn, { showLoading }));
        await waitFor(() => expect(result.current.loading).toBe(false));

        let pending;
        act(() => {
            pending = result.current.refetch(true); // background-style call
        });
        expect(result.current.loading).toBe(false); // never flipped
        await act(async () => {
            await pending;
        });
        expect(result.current.loading).toBe(false);
    });

    test('apply takes over result application and clearErrorOnStart:false keeps a prior error', async () => {
        const queryFn = jest.fn().mockResolvedValue('raw');
        const apply = jest.fn((result, { setData, setError }) => {
            setError(new Error('derived'));
            setData(`applied:${result}`);
        });
        const { result } = renderHook(() => useIpcQuery(queryFn, { apply, clearErrorOnStart: false }));

        await waitFor(() => expect(result.current.data).toBe('applied:raw'));
        expect(result.current.error?.message).toBe('derived');

        // A second refetch must not clear the derived error at start.
        await act(async () => {
            await result.current.refetch();
        });
        expect(result.current.error?.message).toBe('derived');
    });

    test('an apply that throws surfaces as the error', async () => {
        const apply = () => {
            throw new Error('apply failed');
        };
        const queryFn = jest.fn().mockResolvedValue('x');
        const { result } = renderHook(() => useIpcQuery(queryFn, { apply }));
        await waitFor(() => expect(result.current.error?.message).toBe('apply failed'));
        expect(result.current.loading).toBe(false);
    });

    test('singleFlight drops a refetch that overlaps an in-flight one', async () => {
        let resolve;
        const queryFn = jest.fn(() => new Promise((r) => (resolve = r)));
        const { result } = renderHook(() => useIpcQuery(queryFn, { singleFlight: true }));

        expect(queryFn).toHaveBeenCalledTimes(1); // mount call in flight
        await act(async () => {
            await result.current.refetch(); // overlaps → dropped
        });
        expect(queryFn).toHaveBeenCalledTimes(1);

        await act(async () => {
            resolve('done');
        });
        await waitFor(() => expect(result.current.data).toBe('done'));
    });
    test('enabled:false skips the automatic fetch and the subscription; re-enabling fetches again', async () => {
        const onSettingsChanged = jest.fn(() => () => {});
        window.api = { onSettingsChanged };
        const queryFn = jest.fn().mockResolvedValue('x');
        const { result, rerender } = renderHook(({ enabled }) => useIpcQuery(queryFn, { enabled, subscribe: true }), {
            initialProps: { enabled: false },
        });
        await act(async () => {});
        expect(queryFn).not.toHaveBeenCalled();
        expect(onSettingsChanged).not.toHaveBeenCalled();
        expect(result.current.loading).toBe(true);

        rerender({ enabled: true });
        await waitFor(() => expect(result.current.data).toBe('x'));
        expect(onSettingsChanged).toHaveBeenCalledTimes(1);

        rerender({ enabled: false });
        rerender({ enabled: true });
        await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    });

    describe('latestOnly', () => {
        test.each([
            ['singleFlight', { singleFlight: true }],
            ['showLoading', { showLoading: () => true }],
        ])('refuses to combine with %s, which could leave loading stuck', (_label, extra) => {
            expect(() => useIpcQuery(jest.fn(), { latestOnly: true, ...extra })).toThrow(
                'useIpcQuery: latestOnly cannot be combined with singleFlight or showLoading',
            );
        });

        const deferredQuery = () => {
            const calls = [];
            const queryFn = jest.fn(
                () =>
                    new Promise((resolve, reject) => {
                        calls.push({ resolve, reject });
                    }),
            );
            return { queryFn, calls };
        };

        test('a call superseded by a newer refetch drops its data, error and loading reset', async () => {
            const { queryFn, calls } = deferredQuery();
            const { result } = renderHook(() => useIpcQuery(queryFn, { latestOnly: true, initialData: 'seed' }));
            act(() => {
                void result.current.refetch();
            });
            expect(calls).toHaveLength(2);

            await act(async () => calls[0].resolve('stale'));
            expect(result.current.data).toBe('seed');
            expect(result.current.loading).toBe(true);
            await act(async () => calls[0].reject(new Error('ignored')));
            expect(result.current.error).toBeNull();

            await act(async () => calls[1].resolve('fresh'));
            expect(result.current.data).toBe('fresh');
            expect(result.current.loading).toBe(false);
        });

        test('disabling or unmounting supersedes the in-flight call', async () => {
            const { queryFn, calls } = deferredQuery();
            const { result, rerender, unmount } = renderHook(
                ({ enabled }) => useIpcQuery(queryFn, { latestOnly: true, enabled }),
                { initialProps: { enabled: true } },
            );
            rerender({ enabled: false });
            await act(async () => calls[0].reject(new Error('late')));
            expect(result.current.error).toBeNull();
            expect(result.current.loading).toBe(true);

            rerender({ enabled: true });
            unmount();
            await act(async () => calls[1].resolve('late'));
            expect(result.current.data).toBeNull();
        });

        test('a call that settled current keeps its outcome when superseded during apply', async () => {
            let finishApply;
            const apply = jest.fn(
                (value, { setData }) =>
                    new Promise((resolve) => {
                        finishApply = () => {
                            setData(value);
                            resolve();
                        };
                    }),
            );
            const queryFn = jest.fn().mockResolvedValue('kept');
            const { result, rerender } = renderHook(
                ({ enabled }) => useIpcQuery(queryFn, { latestOnly: true, enabled, apply }),
                { initialProps: { enabled: true } },
            );
            await waitFor(() => expect(apply).toHaveBeenCalled());
            rerender({ enabled: false });
            await act(async () => finishApply());
            expect(result.current.data).toBe('kept');
            expect(result.current.loading).toBe(false);
        });

        test('the current call still applies its failure', async () => {
            const queryFn = jest.fn().mockRejectedValue(new Error('boom'));
            const { result } = renderHook(() => useIpcQuery(queryFn, { latestOnly: true }));
            await waitFor(() => expect(result.current.error?.message).toBe('boom'));
            expect(result.current.loading).toBe(false);
        });
    });
});
