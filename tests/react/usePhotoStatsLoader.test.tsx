/**
 * usePhotoStatsLoader at the hook level: the queue behind Show stats asks for the ids the grid
 * reports, in chunks of one batch, one call at a time; a superseded answer waits out the queue's
 * gap and requeues its ids at the front, a failed one ends the run with every id still without
 * stats missing, and answers merge for the whole opening — a stopped run's included. The
 * loaded-photo sort snapshot refreshes on a sort change and when a run ends, never while a run
 * is out.
 */

import { act, renderHook, waitFor } from '@testing-library/preact';
import { usePhotoStatsLoader } from '@/hooks/usePhotoStatsLoader';
import { STATS_MIN_INTERVAL_MS } from '../../src/ts/settings/limits';

import type { WindowApi } from '../../src/ts/types/ipc';

type StatsReply = Awaited<ReturnType<WindowApi['getPhotoStats']>>;
type StatsAnswer = Extract<StatsReply, { success: true }>;

const stat = (n: number): { id: string; votes: number; views: number; likes: number; guruPicks: number } => ({
    id: `photo-${n}`,
    votes: n,
    views: n * 10,
    likes: n,
    guruPicks: n,
});

const ids = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `photo-${from + i}`);
const answer = (stats: StatsAnswer['stats'], missing: string[] = []): StatsReply => ({
    success: true,
    stats,
    missing,
});
const failure = (error: string): StatsReply => ({ success: false, error });
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
};

const getStats = () => jest.mocked(window.api.getPhotoStats);

beforeEach(() => {
    // A supersede test that stops early must not leak its fake timers into the next one.
    jest.useRealTimers();
    getStats().mockReset();
});

const flush = () => act(async () => undefined);

describe('the queue', () => {
    test('chunks the ids into batches of 100, one call at a time, and merges the answers', async () => {
        getStats().mockImplementation((asked: unknown) =>
            Promise.resolve(answer((asked as string[]).map((id) => ({ ...stat(Number(id.slice(6))) })))),
        );
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(250));
        });
        await act(async () => result.current.setShowStats(true));
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(getStats().mock.calls.map((call) => (call[0] as string[]).length)).toEqual([100, 100, 50]);
        expect(result.current.stats.size).toBe(250);
        expect(result.current.statsProgress).toBeNull();
        expect(result.current.statsMissing).toEqual([]);
    });

    test('shows the count at once, even while the first call is still out, and counts chunks as they land', async () => {
        const pending = deferred<StatsReply>();
        getStats()
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValue(answer([stat(1)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(120));
            result.current.setShowStats(true);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsProgress).toEqual({ done: 0, total: 120 });
        await act(async () => {
            pending.resolve(answer([stat(0)], ['photo-1']));
        });
        expect(result.current.statsProgress).toEqual({ done: 100, total: 120 });
        await flush();
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        // The first chunk came back missing photo-1, the second read it: the run's warning keeps only
        // what is still unread.
        expect([...result.current.stats.keys()]).toEqual(['photo-0', 'photo-1']);
        expect(result.current.statsMissing).toEqual([]);
    });

    test('asks only for ids without stats, and skips ids already queued', async () => {
        getStats().mockResolvedValue(answer([stat(0), stat(1)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        // The same ids again (a re-render's report): nothing is asked, no run restarts.
        act(() => {
            result.current.setTileIds(ids(2));
        });
        await flush();
        expect(getStats()).toHaveBeenCalledTimes(1);
        // A finished run and one new id: the run starts over the ids without stats.
        getStats().mockResolvedValueOnce(answer([stat(2)]));
        act(() => {
            result.current.setTileIds([...ids(2), 'photo-2']);
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(getStats().mock.calls[1][0]).toEqual(['photo-2']);
        expect(result.current.stats.size).toBe(3);
    });

    test('a listing change mid-run joins the new ids to the queue and grows the count', async () => {
        const pending = deferred<StatsReply>();
        getStats()
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValue(answer([stat(100)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        expect(result.current.statsProgress).toEqual({ done: 0, total: 2 });
        act(() => {
            result.current.setTileIds([...ids(2), 'photo-100']);
        });
        expect(result.current.statsProgress).toEqual({ done: 0, total: 3 });
        await act(async () => {
            pending.resolve(answer([]));
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(getStats().mock.calls[1][0]).toEqual(['photo-100']);
        expect(result.current.stats.size).toBe(1);
    });

    test('an id answered missing and re-reported by the grid is named once in the warning', async () => {
        const first = deferred<StatsReply>();
        const second = deferred<StatsReply>();
        getStats()
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise)
            .mockResolvedValue(answer([], ['photo-0']));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        // A new tile joins before the first answer: chunk two keeps the run alive past it.
        act(() => {
            result.current.setTileIds([...ids(2), 'photo-2']);
        });
        await act(async () => {
            first.resolve(answer([], ['photo-0', 'photo-1']));
        });
        expect(getStats().mock.calls[1][0]).toEqual(['photo-2']);
        // The grid re-reports photo-0 while the run is still on: enqueue asks it again.
        act(() => {
            result.current.setTileIds(['photo-0']);
        });
        await act(async () => {
            second.resolve(answer([], ['photo-0']));
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(getStats()).toHaveBeenCalledTimes(3);
        expect(getStats().mock.calls[2][0]).toEqual(['photo-0']);
        // Missing twice across the run, named once.
        expect(result.current.statsMissing).toEqual(['photo-0', 'photo-1']);
        expect(result.current.statsProgress).toBeNull();
    });

    test('a failed call names an id re-reported by the grid once', async () => {
        const first = deferred<StatsReply>();
        const second = deferred<StatsReply>();
        getStats().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        // A new tile joins before the first answer: chunk two keeps the run alive past it.
        act(() => {
            result.current.setTileIds([...ids(2), 'photo-2']);
        });
        await act(async () => {
            first.resolve(answer([], ['photo-0', 'photo-1']));
        });
        expect(getStats().mock.calls[1][0]).toEqual(['photo-2']);
        // The grid re-reports photo-0 while the run is still on: it now sits in q.missing and the queue.
        act(() => {
            result.current.setTileIds(['photo-0']);
        });
        await act(async () => {
            second.resolve(failure('boom'));
        });
        await waitFor(() => expect(result.current.statsProgress).toBeNull());
        expect(result.current.statsRead).toBe(false);
        expect(getStats()).toHaveBeenCalledTimes(2);
        // photo-0 reached the failed exit twice — as an earlier chunk's miss and as an unread
        // queued id — and is named once.
        expect(result.current.statsMissing).toEqual(['photo-0', 'photo-1', 'photo-2']);
    });

    test('a re-asked id that lands with stats is not named by a later failed call', async () => {
        const first = deferred<StatsReply>();
        const second = deferred<StatsReply>();
        const third = deferred<StatsReply>();
        getStats()
            .mockReturnValueOnce(first.promise)
            .mockReturnValueOnce(second.promise)
            .mockReturnValueOnce(third.promise)
            .mockResolvedValue(failure('boom'));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        // A new tile joins before the first answer: chunk two keeps the run alive past it.
        act(() => {
            result.current.setTileIds([...ids(2), 'photo-2']);
        });
        await act(async () => {
            first.resolve(answer([], ['photo-0', 'photo-1']));
        });
        expect(getStats().mock.calls[1][0]).toEqual(['photo-2']);
        // The grid re-reports photo-0: it re-enters the queue while sitting in the warning's ids.
        act(() => {
            result.current.setTileIds(['photo-0']);
        });
        await act(async () => {
            second.resolve(answer([stat(2)]));
        });
        expect(getStats().mock.calls[2][0]).toEqual(['photo-0']);
        // The re-ask is out; the grid reports one more tile, whose chunk will fail.
        act(() => {
            result.current.setTileIds(['photo-0', 'photo-4']);
        });
        await act(async () => {
            third.resolve(answer([stat(0)]));
        });
        expect(getStats().mock.calls[3][0]).toEqual(['photo-4']);
        await waitFor(() => expect(result.current.statsProgress).toBeNull());
        expect(getStats()).toHaveBeenCalledTimes(4);
        // photo-0 was answered missing once and has stats now: the failed call's warning keeps
        // photo-1 and the failed chunk's photo-4, and does not name photo-0 again.
        expect([...result.current.stats.keys()]).toEqual(['photo-2', 'photo-0']);
        expect(result.current.statsRead).toBe(false);
        expect(result.current.statsMissing).toEqual(['photo-1', 'photo-4']);
    });

    test('a superseded answer requeues its ids at the front of the current run', async () => {
        jest.useFakeTimers();
        getStats()
            .mockResolvedValueOnce(failure('superseded'))
            .mockResolvedValue(answer([stat(0), stat(1)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        // The re-ask waits out the shared queue's gap first.
        await act(async () => {
            await jest.advanceTimersByTimeAsync(STATS_MIN_INTERVAL_MS);
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(getStats().mock.calls[1][0]).toEqual(['photo-0', 'photo-1']);
        expect(result.current.stats.size).toBe(2);
        expect(result.current.statsMissing).toEqual([]);
    });

    test('a superseded answer sends no second call before the gap ends; after it the re-ask goes out and merges', async () => {
        jest.useFakeTimers();
        getStats()
            .mockResolvedValueOnce(failure('superseded'))
            .mockResolvedValue(answer([stat(0), stat(1)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        await act(async () => {
            await jest.advanceTimersByTimeAsync(STATS_MIN_INTERVAL_MS - 1);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        await act(async () => {
            await jest.advanceTimersByTimeAsync(1);
        });
        expect(getStats().mock.calls[1][0]).toEqual(['photo-0', 'photo-1']);
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(result.current.stats.size).toBe(2);
        expect(result.current.statsMissing).toEqual([]);
    });

    test('Show stats off during the supersede wait: nothing goes out after the gap and nothing is read', async () => {
        jest.useFakeTimers();
        getStats().mockResolvedValueOnce(failure('superseded'));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        // Flush the superseded answer first: the drain must be parked on the gap's timer before
        // Show stats goes off, or the stop lands on the pre-wait guard and the post-wait one
        // never runs.
        await act(async () => {
            await jest.advanceTimersByTimeAsync(0);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        act(() => {
            result.current.setShowStats(false);
        });
        await act(async () => {
            await jest.advanceTimersByTimeAsync(STATS_MIN_INTERVAL_MS);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsRead).toBe(false);
    });

    test('a failed call ends the run: it and everything behind it are missing, and the loader stops', async () => {
        getStats()
            .mockResolvedValueOnce(answer(ids(100).map((_, i) => stat(i))))
            .mockResolvedValueOnce(failure('boom'));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(250));
            result.current.setShowStats(true);
        });
        await waitFor(() => expect(result.current.statsProgress).toBeNull());
        expect(result.current.statsRead).toBe(false);
        expect(getStats()).toHaveBeenCalledTimes(2);
        expect(result.current.statsMissing).toEqual(ids(150, 100));
        expect(result.current.stats.size).toBe(100);
    });

    test('a failed call keeps the earlier chunks missing ids in the warning beside its own unread ones', async () => {
        getStats()
            .mockResolvedValueOnce(
                answer(
                    ids(98).map((_, i) => stat(i)),
                    ['photo-98', 'photo-99'],
                ),
            )
            .mockResolvedValueOnce(failure('boom'));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(250));
            result.current.setShowStats(true);
        });
        await waitFor(() => expect(result.current.statsProgress).toBeNull());
        expect(result.current.statsRead).toBe(false);
        expect(getStats()).toHaveBeenCalledTimes(2);
        // photo-98 and photo-99 the first chunk answered missing; the failed chunk and everything
        // behind it were never read. The warning names all of them together.
        expect(result.current.statsMissing).toEqual([...ids(2, 98), ...ids(150, 100)]);
        expect(result.current.stats.size).toBe(98);
    });

    test('a call that throws (no bridge) counts as a failed one', async () => {
        getStats().mockRejectedValueOnce(new Error('down'));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        await waitFor(() => expect(result.current.statsProgress).toBeNull());
        expect(result.current.statsMissing).toEqual(ids(2));
        expect(result.current.statsRead).toBe(false);
    });

    test('an answer with only missing ids merges nothing and ends the run with the warning', async () => {
        getStats().mockResolvedValue(answer([], ids(2)));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(result.current.stats.size).toBe(0);
        expect(result.current.statsMissing).toEqual(ids(2));
    });

    test('Show stats on with nothing to ask starts nothing: no call, no status line, no warning change', async () => {
        getStats().mockResolvedValue(answer([stat(0)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        // No tiles at all (the grid is loading): turning Show stats on announces nothing.
        act(() => {
            result.current.setShowStats(true);
        });
        expect(getStats()).not.toHaveBeenCalled();
        expect(result.current.statsRead).toBe(false);
        expect(result.current.statsProgress).toBeNull();
        // Tiles arrive and are read; a restart over the same, all-read tiles starts nothing.
        act(() => {
            result.current.setTileIds(ids(1));
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        getStats().mockClear();
        act(() => {
            result.current.setShowStats(false);
            result.current.setShowStats(true);
        });
        expect(getStats()).not.toHaveBeenCalled();
        expect(result.current.statsProgress).toBeNull();
        expect(result.current.statsMissing).toEqual([]);
    });
});

describe('the run lifetime', () => {
    test('turning Show stats off stops the queue; the answer of the call already out still merges', async () => {
        const pending = deferred<StatsReply>();
        getStats()
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValue(answer([stat(1)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(3));
            result.current.setShowStats(true);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        act(() => {
            result.current.setShowStats(false);
        });
        expect(result.current.statsProgress).toBeNull();
        expect(result.current.statsMissing).toEqual([]);
        await act(async () => {
            pending.resolve(answer([stat(0)]));
        });
        await flush();
        // The stopped run sends nothing more; the landed answer stays for the opening.
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect([...result.current.stats.keys()]).toEqual(['photo-0']);
        // New ids reported while off start nothing.
        act(() => {
            result.current.setTileIds([...ids(3), 'photo-9']);
        });
        await flush();
        expect(getStats()).toHaveBeenCalledTimes(1);
    });

    test('the Retry restarts the loader over the ids without stats, and is inert while Show stats is off', async () => {
        getStats()
            .mockResolvedValueOnce(answer([], ['photo-0', 'photo-1']))
            .mockResolvedValueOnce(answer([stat(0), stat(1)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(result.current.statsMissing).toEqual(ids(2));
        // Retry during a run: the queue is rebuilt, the count starts over, and no extra call goes out.
        const pending = deferred<StatsReply>();
        getStats().mockReturnValueOnce(pending.promise);
        act(() => {
            result.current.retryStats();
        });
        expect(getStats()).toHaveBeenCalledTimes(2);
        expect(result.current.statsProgress).toEqual({ done: 0, total: 2 });
        expect(result.current.statsRead).toBe(false);
        expect(result.current.statsMissing).toEqual([]);
        await act(async () => {
            pending.resolve(answer([stat(0), stat(1)]));
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect([...result.current.stats.keys()]).toEqual(['photo-0', 'photo-1']);
        expect(result.current.statsMissing).toEqual([]);
    });

    test('retryStats does nothing while Show stats is off', async () => {
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.retryStats();
        });
        await flush();
        expect(getStats()).not.toHaveBeenCalled();
    });

    test('a run that is out when the chooser closes merges nothing and sends nothing more', async () => {
        const pending = deferred<StatsReply>();
        getStats().mockReturnValueOnce(pending.promise);
        const { result, unmount } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        act(() => unmount());
        await act(async () => {
            pending.resolve(answer([stat(0)]));
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.stats.size).toBe(0);
    });

    test('a failed answer that lands after the chooser closed ends nothing and merges nothing', async () => {
        const pending = deferred<StatsReply>();
        getStats().mockReturnValueOnce(pending.promise);
        const { result, unmount } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        act(() => unmount());
        await act(async () => {
            pending.resolve(failure('boom'));
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsMissing).toEqual([]);
    });

    test('Retry while a call is out restarts only the ids not in flight, without a second call beside it', async () => {
        const pending = deferred<StatsReply>();
        getStats()
            .mockReturnValueOnce(pending.promise)
            .mockImplementation((asked: unknown) =>
                Promise.resolve(answer((asked as string[]).map((id) => stat(Number(id.slice(6)))))),
            );
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(3));
            result.current.setShowStats(true);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsProgress).toEqual({ done: 0, total: 3 });
        // A new tile joins, then a Retry: the ids of the call that is out stay out of the new run,
        // which counts only what it will ask for, and no second call goes out beside the first.
        act(() => {
            result.current.setTileIds([...ids(3), 'photo-3']);
            result.current.retryStats();
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsProgress).toEqual({ done: 0, total: 1 });
        expect(result.current.statsMissing).toEqual([]);
        await act(async () => {
            pending.resolve(answer([stat(0), stat(1)], ['photo-2']));
        });
        // The old call's answer merges its numbers for the opening but counts for no run; only the
        // id the old run did not have in flight is asked, once.
        expect(getStats().mock.calls[1][0]).toEqual(['photo-3']);
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        // photo-2 was left out of the new run and the old call missed it: it lands in the warning.
        expect(result.current.statsMissing).toEqual(['photo-2']);
        expect(result.current.stats.size).toBe(3);
    });

    test('a listing change mid-run that names only known ids grows nothing', async () => {
        const pending = deferred<StatsReply>();
        getStats()
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValue(answer([stat(0), stat(1)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        expect(result.current.statsProgress).toEqual({ done: 0, total: 2 });
        // The same ids again while the call is out: nothing joins the queue, the count stands.
        act(() => {
            result.current.setTileIds(ids(2));
        });
        expect(result.current.statsProgress).toEqual({ done: 0, total: 2 });
        await act(async () => {
            pending.resolve(answer([stat(0), stat(1)]));
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(getStats()).toHaveBeenCalledTimes(1);
    });
});

describe('the loaded-photo sort', () => {
    test('choosing a sort that needs stats turns Show stats on and starts a run; Library order does not', async () => {
        getStats().mockResolvedValue(answer([stat(0)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(1));
        });
        await flush();
        expect(getStats()).not.toHaveBeenCalled();
        expect(result.current.showStats).toBe(false);
        act(() => {
            result.current.setSortBy('ratio');
        });
        expect(result.current.showStats).toBe(true);
        expect(result.current.sortBy).toBe('ratio');
        await waitFor(() => expect(getStats()).toHaveBeenCalledTimes(1));
        // Back to Library order: the sort snapshot is not refreshed, nothing restarts.
        const reads = getStats().mock.calls.length;
        act(() => {
            result.current.setSortBy('library');
        });
        expect(result.current.sortBy).toBe('library');
        expect(result.current.showStats).toBe(true);
        await flush();
        expect(getStats().mock.calls.length).toBe(reads);
    });

    test('a sort change snapshots what the Map holds; answers landing after it do not refresh it', async () => {
        getStats().mockResolvedValue(answer([stat(0)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(1));
            result.current.setShowStats(true);
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        const snapshot = result.current.sortStats;
        expect([...snapshot.keys()]).toEqual(['photo-0']);
        act(() => {
            result.current.setSortBy('likes');
        });
        // The new snapshot is a fresh Map with the same answers.
        expect(result.current.sortStats).not.toBe(result.current.stats);
        expect([...result.current.sortStats.keys()]).toEqual(['photo-0']);
        expect(result.current.sortStats.get('photo-0')).toEqual(result.current.stats.get('photo-0'));
    });

    test('re-choosing the sort it already holds reads nothing and re-snapshots nothing', async () => {
        getStats().mockResolvedValue(answer([stat(0)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(1));
            result.current.setSortBy('ratio');
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(result.current.statsProgress).toBeNull();
        const snapshot = result.current.sortStats;
        act(() => {
            result.current.setSortBy('ratio');
        });
        await flush();
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsProgress).toBeNull();
        // The same Map object: no fresh snapshot was taken.
        expect(result.current.sortStats).toBe(snapshot);
    });

    test('Library re-chosen while Library is the sort does nothing', async () => {
        getStats().mockResolvedValue(answer([stat(0)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(1));
        });
        await flush();
        const snapshot = result.current.sortStats;
        act(() => {
            result.current.setSortBy('library');
        });
        await flush();
        expect(getStats()).not.toHaveBeenCalled();
        expect(result.current.showStats).toBe(false);
        expect(result.current.statsProgress).toBeNull();
        expect(result.current.sortStats).toBe(snapshot);
    });

    test('the sort it already holds re-chosen while its run is out leaves the run alone', async () => {
        const pending = deferred<StatsReply>();
        getStats().mockReturnValueOnce(pending.promise);
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setSortBy('ratio');
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsProgress).toEqual({ done: 0, total: 2 });
        const snapshot = result.current.sortStats;
        act(() => {
            result.current.setSortBy('ratio');
        });
        // No new call, the in-flight run's count stands, and no mid-run re-snapshot.
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsProgress).toEqual({ done: 0, total: 2 });
        expect(result.current.sortStats).toBe(snapshot);
        await act(async () => {
            pending.resolve(answer([stat(0), stat(1)]));
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsProgress).toBeNull();
        expect([...result.current.stats.keys()]).toEqual(['photo-0', 'photo-1']);
    });
});

describe('restarts while a call is out', () => {
    const echo = (asked: unknown) =>
        Promise.resolve(answer((asked as string[]).map((id) => stat(Number(id.slice(6))))));

    test('a restart leaves the in-flight ids out, counts only its own run, and asks no id twice', async () => {
        const first = deferred<StatsReply>();
        getStats().mockReturnValueOnce(first.promise).mockImplementation(echo);
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(250));
            result.current.setShowStats(true);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsProgress).toEqual({ done: 0, total: 250 });
        // Off/on while chunk one (ids 0-99) is out: the new run asks only what it will read.
        act(() => {
            result.current.setShowStats(false);
            result.current.setShowStats(true);
        });
        expect(result.current.statsProgress).toEqual({ done: 0, total: 150 });
        // The old chunk lands for the still-open chooser: its numbers merge, its count does not.
        await act(async () => {
            first.resolve(answer(ids(100).map((id) => stat(Number(id.slice(6))))));
        });
        expect(result.current.statsProgress).toEqual({ done: 0, total: 150 });
        expect(result.current.stats.size).toBe(100);
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        // Every id after the restart is one of the new run's, and none was asked twice.
        const asked = getStats()
            .mock.calls.slice(1)
            .map((call) => call[0] as string[]);
        expect(asked).toEqual([ids(100, 100), ids(50, 200)]);
        const flat = asked.flat();
        expect(new Set(flat).size).toBe(flat.length);
        expect(result.current.statsProgress).toBeNull();
        expect(result.current.stats.size).toBe(250);
        expect(result.current.statsMissing).toEqual([]);
    });

    test('an old run failure landing after a restart ends nothing and marks no new-run id missing', async () => {
        const first = deferred<StatsReply>();
        getStats().mockReturnValueOnce(first.promise).mockImplementation(echo);
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(120));
            result.current.setShowStats(true);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        act(() => {
            result.current.setShowStats(false);
            result.current.setShowStats(true);
        });
        await act(async () => {
            first.resolve(failure('library down'));
        });
        // The failed chunk belonged to the old run: it ends nothing, and its ids rejoin the new
        // run behind its own, growing the count.
        expect(result.current.statsRead).toBe(false);
        expect(result.current.statsMissing).toEqual([]);
        expect(result.current.statsProgress).toEqual({ done: 0, total: 120 });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(
            getStats()
                .mock.calls.slice(1)
                .map((call) => call[0] as string[]),
        ).toEqual([ids(100), ids(20, 100)]);
        expect(result.current.statsMissing).toEqual([]);
    });

    test('an empty report with no run active starts nothing, and a shown warning keeps showing', async () => {
        getStats()
            .mockResolvedValueOnce(failure('flaky'))
            .mockResolvedValue(answer([stat(0)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(1));
            result.current.setShowStats(true);
        });
        await waitFor(() => expect(result.current.statsMissing).toEqual(['photo-0']));
        expect(result.current.statsRead).toBe(false);
        // The listing goes away for a re-read (the grid reports no tiles): nothing is announced and
        // the warning stays exactly as it was.
        getStats().mockClear();
        act(() => {
            result.current.setTileIds([]);
        });
        expect(result.current.statsRead).toBe(false);
        expect(result.current.statsProgress).toBeNull();
        expect(result.current.statsMissing).toEqual(['photo-0']);
        expect(getStats()).not.toHaveBeenCalled();
        // The re-read listing's tiles start the run that reads the missed id again.
        act(() => {
            result.current.setTileIds(ids(1));
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(result.current.statsMissing).toEqual([]);
    });

    /** A hook render that records every progress the loader reports, so a test can check done <= total at each step. */
    const renderTraced = () => {
        const trace: Array<{ done: number; total: number } | null> = [];
        const rendered = renderHook(() => {
            const loader = usePhotoStatsLoader();
            trace.push(loader.statsProgress);
            return loader;
        });
        return { ...rendered, trace };
    };
    const expectBounded = (trace: Array<{ done: number; total: number } | null>) => {
        for (const progress of trace) if (progress != null) expect(progress.done).toBeLessThanOrEqual(progress.total);
    };
    const restartWhileOut = (result: { current: ReturnType<typeof usePhotoStatsLoader> }) => {
        act(() => {
            result.current.setTileIds(ids(250));
            result.current.setShowStats(true);
        });
        act(() => {
            result.current.setShowStats(false);
            result.current.setShowStats(true);
        });
    };
    const askedAfterFirst = () =>
        getStats()
            .mock.calls.slice(1)
            .map((call) => call[0] as string[]);

    test.each(['flaky', 'superseded'])(
        'a stale chunk that answers "%s" rejoins the current run: every id ends read, none asked twice',
        async (error) => {
            const first = deferred<StatsReply>();
            getStats().mockReturnValueOnce(first.promise).mockImplementation(echo);
            const { result, trace } = renderTraced();
            restartWhileOut(result);
            expect(getStats()).toHaveBeenCalledTimes(1);
            expect(result.current.statsProgress).toEqual({ done: 0, total: 150 });
            await act(async () => {
                first.resolve(failure(error));
            });
            // The old chunk's 100 ids rejoin the front of the new run and join its count.
            expect(result.current.statsProgress).toEqual({ done: 0, total: 250 });
            await waitFor(() => expect(result.current.statsRead).toBe(true));
            const asked = askedAfterFirst();
            expect(asked).toEqual([ids(100), ids(100, 100), ids(50, 200)]);
            expect(new Set(asked.flat()).size).toBe(250);
            expectBounded(trace);
            expect(result.current.stats.size).toBe(250);
            expect(result.current.statsMissing).toEqual([]);
        },
    );

    test('a restart during the supersede wait is picked up when the wait ends, and the new run ends', async () => {
        jest.useFakeTimers();
        getStats()
            .mockResolvedValueOnce(failure('superseded'))
            .mockResolvedValue(answer([stat(0), stat(1), stat(5)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        // The superseded answer parks the drain in the gap wait, holding busy.
        await flush();
        // A new tile joins and the Retry restarts during the wait: the restart's pump call no-ops
        // while busy is held, so only the loop's next iteration can pick the new run's queue up.
        act(() => {
            result.current.setTileIds([...ids(2), 'photo-5']);
            result.current.retryStats();
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsProgress).toEqual({ done: 0, total: 3 });
        await act(async () => {
            await jest.advanceTimersByTimeAsync(STATS_MIN_INTERVAL_MS);
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(getStats()).toHaveBeenCalledTimes(2);
        expect(getStats().mock.calls[1][0]).toEqual(['photo-0', 'photo-1', 'photo-5']);
        expect(result.current.stats.size).toBe(3);
        expect(result.current.statsProgress).toBeNull();
        expect(result.current.statsMissing).toEqual([]);
    });

    test('a requeued chunk that fails again ends the run with every id in the warning, and asks nothing more', async () => {
        const first = deferred<StatsReply>();
        getStats().mockReturnValueOnce(first.promise).mockResolvedValueOnce(failure('boom'));
        const { result, trace } = renderTraced();
        restartWhileOut(result);
        await act(async () => {
            first.resolve(failure('flaky'));
        });
        await waitFor(() => expect(result.current.statsProgress).toBeNull());
        // The old chunk's ids were asked once more, failed again, and no loop follows.
        expect(getStats()).toHaveBeenCalledTimes(2);
        expect(askedAfterFirst()).toEqual([ids(100)]);
        expectBounded(trace);
        expect(result.current.statsRead).toBe(false);
        expect(result.current.stats.size).toBe(0);
        expect(result.current.statsMissing).toEqual(ids(250));
    });

    test('a stale failure that lands after the chooser closed rejoins nothing and sends nothing more', async () => {
        const first = deferred<StatsReply>();
        getStats().mockReturnValueOnce(first.promise).mockImplementation(echo);
        const { result, unmount } = renderHook(() => usePhotoStatsLoader());
        restartWhileOut(result);
        act(() => unmount());
        await act(async () => {
            first.resolve(failure('flaky'));
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsMissing).toEqual([]);
    });

    test('a stale success after Show stats went off merges its numbers but marks nothing read', async () => {
        const first = deferred<StatsReply>();
        getStats().mockReturnValueOnce(first.promise).mockImplementation(echo);
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        // Restart (the out chunk is stale), then off: no run is running when the chunk lands.
        act(() => {
            result.current.setShowStats(false);
            result.current.setShowStats(true);
            result.current.setShowStats(false);
        });
        await act(async () => {
            first.resolve(answer([stat(0)], ['photo-1']));
        });
        await flush();
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect([...result.current.stats.keys()]).toEqual(['photo-0']);
        expect(result.current.statsRead).toBe(false);
        expect(result.current.statsProgress).toBeNull();
        expect(result.current.statsMissing).toEqual([]);
    });

    test('a stale failure with no run running rejoins nothing; turning Show stats on reads the ids again', async () => {
        const first = deferred<StatsReply>();
        getStats().mockReturnValueOnce(first.promise).mockImplementation(echo);
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        // Restart (so the out chunk is stale), then stop: no run is running when it fails.
        act(() => {
            result.current.setShowStats(false);
            result.current.setShowStats(true);
            result.current.setShowStats(false);
        });
        await act(async () => {
            first.resolve(failure('down'));
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        expect(result.current.statsRead).toBe(false);
        expect(result.current.statsProgress).toBeNull();
        expect(result.current.statsMissing).toEqual([]);
        // Retry while off does nothing; turning Show stats on reads both ids again.
        act(() => {
            result.current.retryStats();
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        act(() => {
            result.current.setTileIds(ids(2));
            result.current.setShowStats(true);
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(result.current.stats.size).toBe(2);
        expect(result.current.statsMissing).toEqual([]);
    });

    test('a second superseded answer in a row still ends once a success follows', async () => {
        jest.useFakeTimers();
        getStats()
            .mockResolvedValueOnce(failure('superseded'))
            .mockResolvedValueOnce(failure('superseded'))
            .mockResolvedValue(answer([stat(0)]));
        const { result } = renderHook(() => usePhotoStatsLoader());
        act(() => {
            result.current.setTileIds(ids(1));
            result.current.setShowStats(true);
        });
        expect(getStats()).toHaveBeenCalledTimes(1);
        await act(async () => {
            await jest.advanceTimersByTimeAsync(STATS_MIN_INTERVAL_MS);
        });
        expect(getStats()).toHaveBeenCalledTimes(2);
        await act(async () => {
            await jest.advanceTimersByTimeAsync(STATS_MIN_INTERVAL_MS);
        });
        await waitFor(() => expect(result.current.statsRead).toBe(true));
        expect(getStats()).toHaveBeenCalledTimes(3);
        expect(result.current.stats.size).toBe(1);
        expect(result.current.statsProgress).toBeNull();
        expect(result.current.statsMissing).toEqual([]);
    });
});
