/**
 * useLogStream — subscribes to live log messages, seeds from the backlog
 * (newest-first), merges live messages that raced the backlog fetch
 * (de-duped by `seq`), caps the list, and tears the stream down on unmount.
 * window.api's log-stream methods are swapped for per-test fakes so a live
 * `emit` can be driven directly.
 */
import { renderHook, act, waitFor } from '@testing-library/preact';
import { useLogStream } from '@/hooks/useLogStream';

const LOG_METHODS = ['startLogStream', 'stopLogStream', 'onLogMessage', 'getLogBacklog'];

describe('useLogStream', () => {
    let originals;
    let emit;
    let unsubscribe;
    let resolveBacklog;

    beforeEach(() => {
        originals = Object.fromEntries(LOG_METHODS.map((m) => [m, window.api[m]]));
        emit = null;
        unsubscribe = jest.fn();
        window.api.startLogStream = jest.fn().mockResolvedValue({ success: true });
        window.api.stopLogStream = jest.fn();
        window.api.onLogMessage = jest.fn((cb) => {
            emit = cb;
            return unsubscribe;
        });
        // Backlog resolves only when the test says so, so live messages can
        // land during the await.
        window.api.getLogBacklog = jest.fn(
            () =>
                new Promise((resolve) => {
                    resolveBacklog = resolve;
                }),
        );
    });

    afterEach(() => {
        Object.assign(window.api, originals);
    });

    test('seeds newest-first, merges racing live messages by seq, then appends live messages', async () => {
        const { result } = renderHook(() => useLogStream());
        await waitFor(() => expect(result.current.connected).toBe(true));
        await waitFor(() => expect(emit).toBeInstanceOf(Function));

        // Live messages during the backlog await: seq 2 is already in the
        // backlog (dropped), seq 5 is new, a seq-less message is always kept.
        act(() => {
            emit({ seq: 2, message: 'dup' });
            emit({ seq: 5, message: 'live-5' });
            emit({ message: 'no-seq' });
        });
        expect(result.current.entries).toEqual([]);

        await act(async () => {
            resolveBacklog([
                { seq: 1, message: 'b1' },
                { seq: 2, message: 'b2' },
            ]);
        });
        expect(result.current.entries.map((e) => e.message)).toEqual(['no-seq', 'live-5', 'b2', 'b1']);

        act(() => emit({ seq: 6, message: 'after-seed' }));
        expect(result.current.entries[0].message).toBe('after-seed');
        expect(result.current.entries).toHaveLength(5);
    });

    test('seq-less backlog entries do not lower the de-dup watermark', async () => {
        const { result } = renderHook(() => useLogStream());
        await waitFor(() => expect(emit).toBeInstanceOf(Function));
        act(() => {
            emit({ seq: 3, message: 'already-in-backlog' });
            emit({ seq: 4, message: 'new-live' });
        });
        await act(async () => resolveBacklog([{ seq: 3, message: 'b3' }, { message: 'b-noseq' }]));
        expect(result.current.entries.map((e) => e.message)).toEqual(['new-live', 'b-noseq', 'b3']);
    });

    test('caps the list at 1000 entries, dropping the oldest', async () => {
        const { result } = renderHook(() => useLogStream());
        await waitFor(() => expect(emit).toBeInstanceOf(Function));
        const backlog = Array.from({ length: 1000 }, (_, i) => ({ seq: i + 1, message: `m${i + 1}` }));
        await act(async () => resolveBacklog(backlog));
        expect(result.current.entries).toHaveLength(1000);
        expect(result.current.entries[0].message).toBe('m1000');

        act(() => emit({ seq: 1001, message: 'm1001' }));
        expect(result.current.entries).toHaveLength(1000);
        expect(result.current.entries[0].message).toBe('m1001');
        expect(result.current.entries[999].message).toBe('m2');
    });

    test('stays disconnected when the stream refuses to start', async () => {
        window.api.startLogStream.mockResolvedValue({ success: false });
        const { result } = renderHook(() => useLogStream());
        await waitFor(() => expect(window.api.startLogStream).toHaveBeenCalled());
        await act(async () => {});
        expect(result.current.connected).toBe(false);
        expect(window.api.onLogMessage).not.toHaveBeenCalled();
    });

    test('marks disconnected when connecting throws', async () => {
        window.api.getLogBacklog.mockRejectedValue(new Error('ipc down'));
        const { result } = renderHook(() => useLogStream());
        await waitFor(() => expect(window.api.getLogBacklog).toHaveBeenCalled());
        await act(async () => {});
        expect(result.current.connected).toBe(false);
    });

    test('a throw after unmount does not touch state', async () => {
        let rejectStart;
        window.api.startLogStream.mockReturnValue(
            new Promise((_, reject) => {
                rejectStart = reject;
            }),
        );
        const { result, unmount } = renderHook(() => useLogStream());
        unmount();
        await act(async () => rejectStart(new Error('late')));
        expect(result.current.connected).toBe(false);
        // Nothing subscribed yet, so there is nothing to unsubscribe.
        expect(unsubscribe).not.toHaveBeenCalled();
        expect(window.api.stopLogStream).toHaveBeenCalledTimes(1);
    });

    test('ignores a start that resolves after unmount', async () => {
        let resolveStart;
        window.api.startLogStream.mockReturnValue(
            new Promise((resolve) => {
                resolveStart = resolve;
            }),
        );
        const { unmount } = renderHook(() => useLogStream());
        unmount();
        await act(async () => resolveStart({ success: true }));
        expect(window.api.onLogMessage).not.toHaveBeenCalled();
    });

    test('unmount mid-backlog unsubscribes, stops the stream, and ignores late data', async () => {
        const { result, unmount } = renderHook(() => useLogStream());
        await waitFor(() => expect(emit).toBeInstanceOf(Function));
        unmount();
        expect(unsubscribe).toHaveBeenCalledTimes(1);
        expect(window.api.stopLogStream).toHaveBeenCalledTimes(1);

        // A message delivered after unmount and a late backlog are both ignored.
        act(() => emit({ seq: 9, message: 'late' }));
        await act(async () => resolveBacklog([{ seq: 1, message: 'b1' }]));
        expect(result.current.entries).toEqual([]);
    });
});
