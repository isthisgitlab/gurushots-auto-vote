/**
 * The picker's Show stats: the one stats loader behind `get-photo-stats` and the loaded-photo sort
 * that goes by its answers. The ids to read come from the grid (`setTileIds`), the queue drains one
 * `get-photo-stats` call at a time, and the answers live for the whole opening — only unmounting
 * drops them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as ipc from '@/api/ipc';
import { LIBRARY_BATCH_PHOTOS, STATS_MIN_INTERVAL_MS } from '../../settings/limits';
import { sleep } from '../../timing';

import type { LoadedSort } from '../../librarySort';

/** What a stats run reports while it is out: how many of its ids are answered, of how many asked. */
export type StatsProgress = { done: number; total: number };

type StatsAnswer = Awaited<ReturnType<typeof ipc.getPhotoStats>>;

/** One photo's read display stats — exactly the get-photo-stats answer's stat row, nothing declared by hand. */
export type TileStats = Extract<StatsAnswer, { success: true }>['stats'][number];

/** The queue's bookkeeping, read across the drain loop's awaits. `asking` is the chunk a call is out for. */
type StatsQueue = {
    /** Bumped by every start: a call belongs to the run that was current when it went out. */
    runId: number;
    queue: string[];
    asking: string[];
    done: number;
    total: number;
    missing: string[];
    running: boolean;
};

/** What the queue tells its owner, as state updates. */
type StatsSink = {
    /** A run began over `total` ids: the count restarts, and no warning of an older run is kept. */
    started(total: number): void;
    progress(progress: StatsProgress | null): void;
    /** Answers landed (while the opening is current — a stopped run's included). */
    merge(landed: TileStats[]): void;
    /** The run finished: every id it could not read. */
    ended(missing: string[]): void;
    /** A call failed: every id of the run still without stats — the failed chunk, the unread queue, and the ids earlier chunks missed. */
    failed(unread: string[]): void;
};

/**
 * Drains the queue: one `get-photo-stats` call at a time, in chunks of one batch. Restarting while
 * a call is out never sends a second one beside it — the loop picks the rebuilt queue up when the
 * call it is waiting on has landed.
 */
const drainStatsQueue = async (
    q: StatsQueue,
    busy: { current: boolean },
    epochRef: { current: number },
    has: (id: string) => boolean,
    sink: StatsSink,
): Promise<void> => {
    const epoch = epochRef.current;
    try {
        while (q.running && epochRef.current === epoch && q.queue.length > 0) {
            // The run this call belongs to: a call that lands after a restart
            // merges its numbers but never counts, fills or ends the new run.
            const run = q.runId;
            const chunk = q.queue.splice(0, LIBRARY_BATCH_PHOTOS);
            q.asking = chunk;
            let answer: StatsAnswer | null = null;
            try {
                answer = await ipc.getPhotoStats(chunk);
            } catch {
                answer = null;
            }
            q.asking = [];
            const stale = run !== q.runId;
            // A landed answer merges its numbers while the opening is current, stopped or restarted
            // run or not: the photos are real either way. A call that resolved to nothing (a
            // missing bridge) counts as a failed one.
            if (answer != null && answer.success) {
                if (epochRef.current === epoch) sink.merge(answer.stats);
                if (!q.running || epochRef.current !== epoch) return;
                if (stale) {
                    // The restart left these ids out of the new run, so nobody else will report them:
                    // the ones still unread join its warning. They were never counted, so done and
                    // total stay as they are.
                    q.missing.push(...answer.missing.filter((id) => !has(id)));
                    continue;
                }
                q.done += chunk.length;
                q.missing.push(...answer.missing);
                sink.progress({ done: q.done, total: q.total });
                continue;
            }
            // An old run's failed or superseded answer must not end the new run — but its ids were
            // left out of the restart and now end with no stats, so they REJOIN the current run:
            // only ids with no stats that are not already queued or asked re-enter, so no id is
            // asked twice and done <= total keeps holding. With no run running, nothing restarts
            // for them — the warning's Retry covers it.
            if (stale) {
                if (!q.running || epochRef.current !== epoch) return;
                const knownOrWanted = new Set([...q.queue, ...q.asking]);
                const rejoined = chunk.filter((id) => !has(id) && !knownOrWanted.has(id));
                // At the front, like a current-run superseded's requeue: they are read before the
                // ids the new run had not reached yet.
                q.queue.unshift(...rejoined);
                q.total += rejoined.length;
                sink.progress({ done: q.done, total: q.total });
                continue;
            }
            if (!q.running || epochRef.current !== epoch) return;
            if (answer?.error === 'superseded') {
                // A newer call took this one's place in the queue: its ids go back to the front
                // and are asked again — after the queue's minimum gap. Every picker of the web
                // shell's one process shares that queue; two reading at once would otherwise
                // knock each other's waiting call out in a tight loop for the whole gap window.
                q.queue.unshift(...chunk);
                await sleep(STATS_MIN_INTERVAL_MS);
                // The wait can outlive the run: a stopped or closed opening must not fall
                // through to the normal end below, which would mark it read.
                if (!q.running || epochRef.current !== epoch) return;
                continue;
            }
            // A failed call: it and everything behind it stay unread, and the run ends so the
            // warning can offer its Retry. The ids earlier chunks missed join them, so the
            // warning names every id of the run still without stats — the same filter the
            // normal end path uses.
            sink.progress(null);
            sink.failed([...q.missing, ...chunk, ...q.queue].filter((id) => !has(id)));
            q.queue = [];
            q.running = false;
            return;
        }
        // The only way out of the loop is a drained queue: a stopped run or a closed opening returns
        // inside — after a stale answer too — so a run that gets here ended normally.
        q.running = false;
        sink.progress(null);
        // The warning names what is still unread: an id an earlier chunk missed and a later one
        // read (a requeue's) does not belong in it.
        sink.ended(q.missing.filter((id) => !has(id)));
    } finally {
        busy.current = false;
    }
};

/**
 * The stats queue machine: it holds the queue, the counts and the one-drain guard; the hook owns
 * the answers and the session state. `start` begins a run over the ids without stats yet (Show
 * stats turning on and the warning's Retry go through it), `enqueue` joins a run's new ids or
 * starts one, `stop` drops the queue — the answer of a call already out still lands.
 */
const createStatsQueue = (has: (id: string) => boolean, sink: StatsSink, epochRef: { current: number }) => {
    const q: StatsQueue = { runId: 0, queue: [], asking: [], done: 0, total: 0, missing: [], running: false };
    const busy = { current: false };
    const pump = (): void => {
        if (busy.current) return;
        busy.current = true;
        void drainStatsQueue(q, busy, epochRef, has, sink);
    };
    const start = (ids: readonly string[]): void => {
        // Ids a call is already out for are left out entirely: their answer lands during the new
        // run's lifetime and merges its numbers, but they are never asked again and never count —
        // excluded from the total too, so done <= total holds at every step.
        const inFlight = new Set(q.asking);
        const wanted = ids.filter((id) => !has(id) && !inFlight.has(id));
        // Nothing to ask (the grid loading with no tiles yet, or everything already read) starts
        // nothing: no status line appears and a shown warning keeps showing.
        if (wanted.length === 0) return;
        q.runId += 1;
        q.queue = wanted;
        q.done = 0;
        q.total = wanted.length;
        q.missing = [];
        q.running = true;
        sink.started(wanted.length);
        pump();
    };
    return {
        start,
        enqueue: (ids: readonly string[]): void => {
            if (!q.running) return start(ids);
            const knownOrWanted = new Set([...q.queue, ...q.asking]);
            const added = ids.filter((id) => !has(id) && !knownOrWanted.has(id));
            if (added.length === 0) return;
            q.queue.push(...added);
            q.total += added.length;
            sink.progress({ done: q.done, total: q.total });
        },
        stop: (): void => {
            q.running = false;
            q.queue = [];
            sink.progress(null);
        },
    };
};

/**
 * The queue's reports wired to state setters: `started` resets the count and the warning of an older
 * run, `ended` marks the run read and refreshes the sort snapshot, so answers that landed in it
 * reorder the grid once, now. `merge` lands answers in the by-id Map while the opening is current.
 */
const createStatsSink = (
    setStats: (next: ReadonlyMap<string, TileStats>) => void,
    statsMapRef: { current: ReadonlyMap<string, TileStats> },
    setSortStats: (next: ReadonlyMap<string, TileStats>) => void,
    setStatsProgress: (progress: StatsProgress | null) => void,
    setStatsRead: (read: boolean) => void,
    setStatsMissing: (missing: readonly string[]) => void,
): StatsSink => ({
    started: (total) => {
        setStatsProgress({ done: 0, total });
        setStatsMissing([]);
        setStatsRead(false);
    },
    progress: setStatsProgress,
    merge: (landed) => {
        if (landed.length === 0) return;
        const next = new Map(statsMapRef.current);
        for (const stat of landed) next.set(stat.id, stat);
        statsMapRef.current = next;
        setStats(next);
    },
    // An id answered missing and re-asked after a grid report can arrive twice, and the warning
    // counts the list: both exits dedup it.
    ended: (missing) => {
        setStatsRead(true);
        setSortStats(new Map(statsMapRef.current));
        setStatsMissing([...new Set(missing)]);
    },
    failed: (unread) => setStatsMissing([...new Set(unread)]),
});

/**
 * The picker's Show stats state and loader. `sortStats` is the snapshot the grid sorts by: it is
 * refreshed when the user changes the sort (from what the Map holds at that moment) and when a run
 * ends — never while a run is on its way, so tiles do not move under the pointer while answers land.
 */
export function usePhotoStatsLoader() {
    const [stats, setStats] = useState<ReadonlyMap<string, TileStats>>(new Map());
    const statsMapRef = useRef(stats);
    const [sortStats, setSortStats] = useState<ReadonlyMap<string, TileStats>>(new Map());
    const [sortBy, setSortByState] = useState<LoadedSort>('library');
    const [showStats, setShowStatsState] = useState(false);
    const showStatsRef = useRef(false);
    const [statsProgress, setStatsProgress] = useState<StatsProgress | null>(null);
    const [statsRead, setStatsRead] = useState(false);
    const [statsMissing, setStatsMissing] = useState<readonly string[]>([]);
    // The ids the grid last reported as full photo tiles: what the loader asks for.
    const tileIdsRef = useRef<readonly string[]>([]);
    // Bumped when the chooser closes: a run stops answering to it and a late answer merges nothing.
    const statsEpochRef = useRef(0);
    const [queue] = useState(() =>
        createStatsQueue(
            (id) => statsMapRef.current.has(id),
            createStatsSink(setStats, statsMapRef, setSortStats, setStatsProgress, setStatsRead, setStatsMissing),
            statsEpochRef,
        ),
    );
    useEffect(
        () => () => {
            statsEpochRef.current += 1;
            queue.stop();
        },
        [queue],
    );

    /** Turns Show stats on or off. Off stops the queue; the answers already read stay for the opening. */
    const setShowStats = useCallback(
        (on: boolean) => {
            showStatsRef.current = on;
            setShowStatsState(on);
            if (on) queue.start(tileIdsRef.current);
            else {
                queue.stop();
                setStatsMissing([]);
            }
        },
        [queue],
    );

    /** The loaded-photo sort: a change applies from the Map at once; one needing stats turns Show stats on. */
    const setSortBy = useCallback(
        (next: LoadedSort) => {
            setSortByState(next);
            if (next === 'library') return;
            setSortStats(new Map(statsMapRef.current));
            if (!showStatsRef.current) {
                showStatsRef.current = true;
                setShowStatsState(true);
                queue.start(tileIdsRef.current);
            }
        },
        [queue],
    );

    /** What the grid renders as full photo tiles: a run's new ids join its queue, or a run starts. */
    const setTileIds = useCallback(
        (ids: readonly string[]) => {
            tileIdsRef.current = ids;
            if (showStatsRef.current) queue.enqueue(ids);
        },
        [queue],
    );

    /** The warning's Retry: restarts the loader over the ids on screen (it sends no call of its own). */
    const retryStats = useCallback(() => {
        if (showStatsRef.current) queue.start(tileIdsRef.current);
    }, [queue]);

    return {
        sortBy,
        setSortBy,
        showStats,
        setShowStats,
        stats,
        sortStats,
        statsProgress,
        statsRead,
        statsMissing,
        retryStats,
        setTileIds,
    };
}
