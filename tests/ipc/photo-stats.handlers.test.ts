/**
 * get-photo-stats: argument validation before the token lookup, the answer
 * shape (stats with all four numbers, missing for the rest), cache-first
 * reads, the failure breaker's 60 s cool-down, single flight with supersede,
 * the minimum gap between runs, mock isolation (nothing persisted), and
 * counts-only logging. The handler runs the REAL services/photoStats.ts over
 * an in-memory stand-in for its JSON store.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/apiFactory');
jest.mock('../../src/ts/services/auth');

// In-memory stand-in for the cross-platform JSON store photoStats persists to.
let storeData: string | null = null;
jest.mock('../../src/ts/settings/storage', () => ({
    createJsonStore: () => ({
        readRaw: () => storeData,
        writeRaw: (data: string) => {
            storeData = data;
        },
        getFilePath: () => '/tmp/photo-stats.handlers.json',
        initializeAsync: async () => {},
        flushPendingWrites: async () => {},
    }),
}));

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import authModule = require('../../src/ts/services/auth');
const auth = jest.mocked(authModule);
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(loggerModule);
import photoStatsModule = require('../../src/ts/services/photoStats');
import type * as photoStatsHandlersModule from '../../src/ts/ipc/actions/photoStats';
import { LIBRARY_BATCH_PHOTOS } from '../../src/ts/settings/limits';
import { isPlainObject } from '../../src/ts/plainObject';
import { invalid } from '../helpers/invalid';
import { logCategories } from '../helpers/logCategories';

const { handleGetPhotoStats, __resetPhotoStatsThrottle, STATS_MIN_INTERVAL_MS, STATS_COOLDOWN_MS } =
    require('../../src/ts/ipc/actions/photoStats') as typeof photoStatsHandlersModule;
const { __resetForTests, STATS_TTL_MS } = photoStatsModule;

// The handler is invoked the way ipcMain does: the event first.
const callStats = (ids: unknown) =>
    (handleGetPhotoStats as (...a: unknown[]) => ReturnType<typeof handleGetPhotoStats>)({}, ids);

type GetImageData = apiFactoryModule.ApiStrategy['getImageData'];
type GetDataMock = jest.Mock<ReturnType<GetImageData>, Parameters<GetImageData>>;

/** A get_image_data payload shaped like the live one; likes/guru_picks optional. */
const payload = (votes: number, views: number, likes?: number, guruPicks?: number) => ({
    votes,
    views,
    achievements: [],
    ...(likes === undefined ? {} : { likes }),
    ...(guruPicks === undefined ? {} : { guru_picks: guruPicks }),
});

const newGetData = (): GetDataMock => jest.fn<ReturnType<GetImageData>, Parameters<GetImageData>>();

const stubStrategy = (over: { getImageData?: GetDataMock } = {}) => {
    // A partial strategy stand-in: only the method the handler calls is real.
    const strategy = {
        getImageData: over.getImageData ?? newGetData(),
        getActiveChallenges: jest.fn(),
        getEligiblePhotosWalk: jest.fn(),
        getCurrentMemberProfile: jest.fn(),
    };
    apiFactory.getApiStrategy = jest.fn().mockReturnValue(strategy);
    return strategy;
};

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
};

// What every category logger was told, as JSON — for leak checks.
const loggedJson = (): string =>
    JSON.stringify(
        logger.withCategory.mock.results.flatMap((call) =>
            Object.values(invalid<Record<string, jest.Mock<unknown, unknown[]>>>(call.value)).flatMap(
                (fn) => fn.mock.calls,
            ),
        ),
    );

let mockMode = false;

beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    mockMode = false;
    storeData = null;
    __resetForTests();
    __resetPhotoStatsThrottle();
    // Bare jest.fn for the three module-slot mocks (getApiStrategy above,
    // requireAuthToken here, getSetting below): a jest.mocked() module slot's
    // type (fn & MockWithArgs<fn>) only accepts the any-based bare mock —
    // jest.fn<R, [Args]>, jest.fn<MockedFunction<fn>> and an annotated const
    // were each tried and none assigns. The sibling library.handlers.test.ts
    // keeps these bare for the same reason.
    auth.requireAuthToken = jest.fn().mockReturnValue({ ok: true, token: 'tok', settings: {} });
    settings.getSetting = jest.fn().mockImplementation((key: string) => (key === 'mock' ? mockMode : 'tok'));
});

describe('validation', () => {
    test.each([
        ['a non-array', 'aa1'],
        ['a non-string id', ['aa1', 7]],
        ['an id failing the chosen-photo id shape', ['aa1', 'a/b']],
        ['a blank id', ['']],
        ['an id past the shape cap', ['x'.repeat(65)]],
        ['more unique ids than the batch cap', Array.from({ length: LIBRARY_BATCH_PHOTOS + 1 }, (_, i) => `i${i}aaaa`)],
    ])('refuses %s with invalid-args before the token lookup', async (_name, ids) => {
        const strategy = stubStrategy();
        await expect(callStats(invalid(ids))).resolves.toEqual({ success: false, error: 'invalid-args' });
        expect(auth.requireAuthToken).not.toHaveBeenCalled();
        expect(strategy.getImageData).not.toHaveBeenCalled();
        expect(logCategories('warning', 'Refused get-photo-stats: invalid id argument', null)).toEqual(['autoSubmit']);
    });

    test('an empty list, 100 unique ids, and 150 with repeats folded to 100 are accepted', async () => {
        stubStrategy({ getImageData: newGetData().mockResolvedValue(payload(1, 2, 3, 4)) });
        await expect(callStats([])).resolves.toEqual({ success: true, stats: [], missing: [] });
        __resetPhotoStatsThrottle();
        const base = Array.from({ length: LIBRARY_BATCH_PHOTOS }, (_, i) => `id${String(i).padStart(4, '0')}x`);
        await expect(callStats(base)).resolves.toMatchObject({ success: true, stats: { length: 100 } });
        __resetPhotoStatsThrottle();
        await expect(callStats([...base, ...base.slice(0, 50)])).resolves.toMatchObject({ success: true });
    });

    test('answers the auth guard when signed out', async () => {
        auth.requireAuthToken = jest
            .fn()
            .mockReturnValue({ ok: false, response: { success: false, error: 'No token' } });
        stubStrategy();
        await expect(callStats(['aa1'])).resolves.toEqual({ success: false, error: 'No token' });
    });

    test('a throw inside answers {success:false, error} and never throws to the renderer', async () => {
        stubStrategy();
        settings.getSetting = jest.fn().mockImplementation(() => {
            throw new Error('settings shut');
        });
        await expect(callStats(['aa1'])).resolves.toEqual({ success: false, error: 'settings shut' });
        expect(logCategories('error', 'Error handling get-photo-stats request:', new Error('settings shut'))).toEqual([
            'autoSubmit',
        ]);
    });
});

describe('fetching', () => {
    test('100 uncached ids make 100 calls and answer all four numbers', async () => {
        const getData = newGetData().mockResolvedValue(payload(11, 22, 3, 4));
        stubStrategy({ getImageData: getData });
        const ids = Array.from({ length: LIBRARY_BATCH_PHOTOS }, (_, i) => `id${String(i).padStart(4, '0')}x`);
        const result = (await callStats(ids)) as { stats: Array<Record<string, unknown>>; missing: string[] };
        expect(Array.isArray(result.stats)).toBe(true);
        expect(getData).toHaveBeenCalledTimes(LIBRARY_BATCH_PHOTOS);
        expect(getData).toHaveBeenLastCalledWith(ids[99], 'tok');
        expect(result.stats[0]).toEqual({ id: ids[0], votes: 11, views: 22, likes: 3, guruPicks: 4 });
        expect(result.missing).toEqual([]);
    });

    test('a repeated id is fetched once and answered once', async () => {
        const strategy = stubStrategy({ getImageData: newGetData().mockResolvedValue(payload(1, 2, 3, 4)) });
        const result = (await callStats(['dup1', 'dup1'])) as { stats: unknown[] };
        expect(strategy.getImageData).toHaveBeenCalledTimes(1);
        expect(result.stats).toHaveLength(1);
    });

    test('a fresh cache hit makes no call, and an entry without the display pair is fetched', async () => {
        const now = Date.now();
        storeData = JSON.stringify({
            version: 1,
            photos: {
                full: { votes: 11, views: 22, achievementCount: 0, fetchedAt: now, likes: 3, guruPicks: 1 },
                bare: { votes: 5, views: 6, achievementCount: 2, fetchedAt: now },
            },
        });
        const getData = newGetData().mockResolvedValue(payload(50, 60, 7, 2));
        stubStrategy({ getImageData: getData });
        const result = (await callStats(['full', 'bare'])) as { stats: Array<Record<string, unknown>> };
        expect(getData).toHaveBeenCalledTimes(1);
        expect(getData).toHaveBeenCalledWith('bare', 'tok');
        expect(result.stats).toEqual([
            { id: 'full', votes: 11, views: 22, likes: 3, guruPicks: 1 },
            { id: 'bare', votes: 50, views: 60, likes: 7, guruPicks: 2 },
        ]);
    });

    test('a fetch that fails leaves its id in missing', async () => {
        stubStrategy({ getImageData: newGetData().mockResolvedValue(null) });
        await expect(callStats(['solo'])).resolves.toEqual({ success: true, stats: [], missing: ['solo'] });
    });

    test('a successful read without the display pair stores 0s, so a second ask needs no fetch', async () => {
        const getData = newGetData().mockResolvedValue(payload(10, 20));
        stubStrategy({ getImageData: getData });
        const answer = {
            success: true,
            stats: [{ id: 'nopair', votes: 10, views: 20, likes: 0, guruPicks: 0 }],
            missing: [],
        };
        await expect(callStats(['nopair'])).resolves.toEqual(answer);
        __resetPhotoStatsThrottle();
        await expect(callStats(['nopair'])).resolves.toEqual(answer);
        expect(getData).toHaveBeenCalledTimes(1);
    });

    test('a stale entry with the display pair whose refetch fails still answers its stale numbers', async () => {
        const stale = Date.now() - STATS_TTL_MS - 1000;
        storeData = JSON.stringify({
            version: 1,
            photos: {
                aged: { votes: 111, views: 222, achievementCount: 1, fetchedAt: stale, likes: 33, guruPicks: 4 },
            },
        });
        const getData = newGetData().mockResolvedValue(null);
        stubStrategy({ getImageData: getData });
        await expect(callStats(['aged'])).resolves.toEqual({
            success: true,
            stats: [{ id: 'aged', votes: 111, views: 222, likes: 33, guruPicks: 4 }],
            missing: [],
        });
        expect(getData).toHaveBeenCalledTimes(1);
    });

    test('mock mode reads through the strategy and persists nothing; a following real call leaves no mock id in the file', async () => {
        mockMode = true;
        const getData = newGetData().mockResolvedValue(payload(1, 2, 3, 4));
        stubStrategy({ getImageData: getData });
        await expect(callStats(['mockaaa1', 'mockaaa2'])).resolves.toMatchObject({
            success: true,
            stats: { length: 2 },
        });
        expect(getData).toHaveBeenCalledTimes(2);
        expect(storeData).toBeNull();
        mockMode = false;
        __resetPhotoStatsThrottle();
        await expect(callStats(['realaaa1'])).resolves.toMatchObject({ success: true });
        const parsed: unknown = JSON.parse(storeData ?? '{}');
        const photos = isPlainObject(parsed) && isPlainObject(parsed.photos) ? parsed.photos : null;
        expect(photos !== null ? Object.keys(photos) : []).toEqual(['realaaa1']);
    });
});

describe('limits', () => {
    test('the breaker trips: every uncached id is missing, and the cool-down answers without fetching', async () => {
        jest.useFakeTimers();
        const getData = newGetData().mockResolvedValue(null);
        stubStrategy({ getImageData: getData });
        const ids = Array.from({ length: 10 }, (_, i) => `f${i}aaaa`);
        await expect(callStats(ids)).resolves.toEqual({ success: true, stats: [], missing: [...ids] });
        // Chunked 5-wide: the breaker trips inside the first chunk, the rest are never issued.
        expect(getData).toHaveBeenCalledTimes(5);
        // Within the cool-down a later call answers every uncached id as missing, fetching nothing.
        getData.mockClear();
        const cooling = callStats(ids);
        await jest.advanceTimersByTimeAsync(STATS_MIN_INTERVAL_MS);
        await expect(cooling).resolves.toEqual({ success: true, stats: [], missing: [...ids] });
        expect(getData).not.toHaveBeenCalled();
        // After the cool-down it fetches again.
        await jest.advanceTimersByTimeAsync(STATS_COOLDOWN_MS);
        const again = callStats(['f0aaaa']);
        await jest.advanceTimersByTimeAsync(STATS_MIN_INTERVAL_MS);
        await expect(again).resolves.toEqual({ success: true, stats: [], missing: ['f0aaaa'] });
        expect(getData).toHaveBeenCalledTimes(1);
    });

    test('overlapping calls run one at a time, and a queued call replaced by a newer one answers superseded', async () => {
        jest.useFakeTimers();
        const gate = deferred<Awaited<ReturnType<GetImageData>>>();
        const getData = newGetData()
            .mockReturnValueOnce(gate.promise)
            .mockResolvedValue(payload(1, 2, 3, 4));
        stubStrategy({ getImageData: getData });
        const one = callStats(['aa1']);
        const two = callStats(['bb2']);
        const three = callStats(['cc3']);
        // The replaced request is answered at once; only the first fetch is running.
        await expect(two).resolves.toEqual({ success: false, error: 'superseded' });
        expect(getData).toHaveBeenCalledTimes(1);
        gate.resolve(payload(9, 8, 7, 6));
        await expect(one).resolves.toEqual({
            success: true,
            stats: [{ id: 'aa1', votes: 9, views: 8, likes: 7, guruPicks: 6 }],
            missing: [],
        });
        // The survivor waits out the minimum gap, then runs.
        await jest.advanceTimersByTimeAsync(STATS_MIN_INTERVAL_MS - 1);
        expect(getData).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        await expect(three).resolves.toMatchObject({ success: true, stats: [{ id: 'cc3' }] });
        expect(getData).toHaveBeenLastCalledWith('cc3', 'tok');
    });

    test('a Retry inside the minimum gap waits for STATS_MIN_INTERVAL_MS before fetching', async () => {
        jest.useFakeTimers();
        const getData = newGetData().mockResolvedValue(payload(1, 2, 3, 4));
        stubStrategy({ getImageData: getData });
        await callStats(['aa1']);
        expect(getData).toHaveBeenCalledTimes(1);
        const retry = callStats(['bb2']);
        await jest.advanceTimersByTimeAsync(STATS_MIN_INTERVAL_MS - 1);
        expect(getData).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        await expect(retry).resolves.toMatchObject({ success: true, stats: [{ id: 'bb2' }] });
        expect(getData).toHaveBeenCalledTimes(2);
    });

    test('a call queued behind a breaker-tripping call reads the cool-down when it runs, not at enqueue', async () => {
        jest.useFakeTimers();
        const gate = deferred<Awaited<ReturnType<GetImageData>>>();
        const getData = newGetData()
            .mockReturnValueOnce(gate.promise)
            .mockReturnValueOnce(gate.promise)
            .mockReturnValueOnce(gate.promise)
            .mockResolvedValue(null);
        stubStrategy({ getImageData: getData });
        const first = callStats(['a1', 'a2', 'a3']);
        // Queued behind the running call before its failures come back.
        const queued = callStats(['b1', 'b2', 'b3']);
        gate.resolve(null);
        await expect(first).resolves.toEqual({ success: true, stats: [], missing: ['a1', 'a2', 'a3'] });
        // All three of the first call's reads failed in a row: the breaker tripped.
        expect(getData).toHaveBeenCalledTimes(3);
        // The queued call runs only after the minimum gap — by then the cool-down
        // the first call started is in force, so it fetches nothing.
        await jest.advanceTimersByTimeAsync(STATS_MIN_INTERVAL_MS);
        await expect(queued).resolves.toEqual({ success: true, stats: [], missing: ['b1', 'b2', 'b3'] });
        expect(getData).toHaveBeenCalledTimes(3);
    });
});

describe('logging', () => {
    test('the failure path logs counts only: the handler names no id and no response', async () => {
        stubStrategy({ getImageData: newGetData().mockResolvedValue(null) });
        await expect(callStats(['leaky1', 'leaky2'])).resolves.toMatchObject({ success: true, missing: { length: 2 } });
        // The handler's one line carries the counts, never the ids.
        expect(logCategories('debug', 'get-photo-stats: 0 answered, 2 missing', null)).toEqual(['autoSubmit']);
        // Nothing louder than that, and no line at all logs a response body.
        expect(loggedJson()).not.toContain('votes');
        const nonDebug = logger.withCategory.mock.results.flatMap((call) => {
            const level = invalid<Record<string, jest.Mock<unknown, unknown[]>>>(call.value);
            return [...level.error.mock.calls, ...level.warning.mock.calls, ...level.info.mock.calls];
        });
        expect(JSON.stringify(nonDebug)).not.toContain('leaky');
    });
});
