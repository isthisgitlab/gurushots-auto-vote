/**
 * Tests for photoStats.ts — per-photo popularity enrichment.
 *
 * The module exists because get_photos_private reports votes=0 and no
 * achievements for every library photo, so these tests care most about the
 * boundaries that keep enrichment cheap and honest: the per-fill fetch budget,
 * the uncached-first selection order, the persistent cache, and the failure
 * paths that must degrade instead of breaking a fill.
 */

// In-memory stand-in for the cross-platform JSON store.
let storeData: string | null = null;
const mockInitializeAsync = jest.fn(async () => {});
const mockFlushPendingWrites = jest.fn(async () => {});
jest.mock('../../src/ts/settings/storage', () => ({
    createJsonStore: () => ({
        readRaw: () => storeData,
        writeRaw: (data: string) => {
            storeData = data;
        },
        getFilePath: () => '/tmp/photo-stats.json',
        initializeAsync: mockInitializeAsync,
        flushPendingWrites: mockFlushPendingWrites,
    }),
}));

jest.mock('../../src/ts/logger', () => {
    const level = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => level), __level: level };
});

import photoStats = require('../../src/ts/services/photoStats');
import type { PickerPhoto } from '../../src/ts/types/photoPicker';
import type { RankDeps } from '../../src/ts/types/autoFill';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';
import { isPhotoStatsFile } from '../helpers/storedShapes';
import { parseJson, parseJsonAs } from '../helpers/parseJson';
const {
    enrichCandidates,
    resetPassState,
    createStatsBudget,
    statsBudgetTripped,
    MAX_ENRICH_PER_FILL,
    MAX_ENRICH_PER_PASS,
    MAX_CACHE_ENTRIES,
    STATS_TTL_MS,
} = photoStats;
const { __level: log } = invalid<{ __level: LevelMock }>(require('../../src/ts/logger'));

/** The per-category logger double the logger mock above hands out (and exposes as `__level`). */
type LevelMock = {
    [K in 'info' | 'error' | 'debug' | 'success' | 'warning']: jest.MockedFunction<CategoryLogger[K]>;
};

type GetImageData = NonNullable<RankDeps['getImageData']>;

const photo = (id: string, extra: Partial<PickerPhoto> = {}) => ({
    id,
    labels: ['Misc'],
    permission: { allowed: true },
    ...extra,
});

// A get_image_data payload shaped like the real one.
const payload = (votes: number, views: number, achievementCount = 0) => ({
    votes,
    views,
    achievements: Array.from({ length: achievementCount }, (_, i) => ({ name: `a${i}` })),
});

describe('the Android bootstrap hooks of the stats store', () => {
    test("hydrate and flush are the store's own", async () => {
        await photoStats.initializePhotoStatsAsync();
        await photoStats.flushPhotoStatsWrites();

        expect(mockInitializeAsync).toHaveBeenCalledTimes(1);
        expect(mockFlushPendingWrites).toHaveBeenCalledTimes(1);
    });
});

describe('photoStats.enrichCandidates', () => {
    beforeEach(() => {
        storeData = null;
        photoStats.__resetForTests();
        resetPassState();
        jest.clearAllMocks();
    });

    test('merges real votes/views/achievement count and marks stats known', async () => {
        const getImageData = jest.fn().mockResolvedValue(payload(3701, 1203, 3));
        const out = await enrichCandidates([photo('p1', { votes: 0, views: 12 })], 'tok', { getImageData });
        expect(out).toEqual([
            expect.objectContaining({ id: 'p1', votes: 3701, views: 1203, achievementCount: 3, statsKnown: true }),
        ]);
    });

    test('does not mutate the input photos', async () => {
        const getImageData = jest.fn().mockResolvedValue(payload(3701, 1203, 3));
        const input = photo('p1', { votes: 0 });
        await enrichCandidates([input], 'tok', { getImageData });
        expect(input.votes).toBe(0);
        expect(input.statsKnown).toBeUndefined();
    });

    test('only the three ranking fields are taken from the payload', async () => {
        const getImageData = jest.fn().mockResolvedValue({
            ...payload(10, 20, 1),
            member: { name: 'someone' },
            meta_data: { iso: 200 },
        });
        const [out]: Array<PickerPhoto & { member?: unknown; meta_data?: unknown }> = await enrichCandidates(
            [photo('p1')],
            'tok',
            { getImageData },
        );
        expect(out.member).toBeUndefined();
        expect(out.meta_data).toBeUndefined();
    });

    test('a "__proto__" key in the payload cannot pollute Object.prototype', async () => {
        const evil = parseJson('{"votes":5,"views":5,"achievements":[],"__proto__":{"polluted":true}}');
        const getImageData = jest.fn().mockResolvedValue(evil);
        await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    });

    test('coerces hostile numeric values instead of ranking on them', async () => {
        const getImageData = jest
            .fn()
            .mockResolvedValue({ votes: -5, views: Number.POSITIVE_INFINITY, achievements: 'not-an-array' });
        const [out] = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(out.votes).toBe(0);
        expect(out.views).toBe(0);
        expect(out.achievementCount).toBe(0);
    });

    test('fetches at most MAX_ENRICH_PER_FILL photos in one fill', async () => {
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        const many = Array.from({ length: MAX_ENRICH_PER_FILL + 15 }, (_, i) => photo(`p${i}`));
        const out = await enrichCandidates(many, 'tok', { getImageData });
        expect(getImageData).toHaveBeenCalledTimes(MAX_ENRICH_PER_FILL);
        expect(out.filter((p) => p.statsKnown)).toHaveLength(MAX_ENRICH_PER_FILL);
        // The un-fetched remainder is explicitly unknown, NOT votes:0.
        expect(out.filter((p) => !p.statsKnown)).toHaveLength(15);
    });

    test('prefers UNCACHED photos so coverage grows across fills', async () => {
        const getImageData = jest
            .fn<ReturnType<GetImageData>, Parameters<GetImageData>>()
            .mockResolvedValue(payload(1, 1));
        const many = Array.from({ length: MAX_ENRICH_PER_FILL * 2 }, (_, i) => photo(`p${i}`));

        await enrichCandidates(many, 'tok', { getImageData });
        const firstRound = new Set(getImageData.mock.calls.map(([id]) => id));
        expect(firstRound.size).toBe(MAX_ENRICH_PER_FILL);

        getImageData.mockClear();
        const out = await enrichCandidates(many, 'tok', { getImageData });
        const secondRound = getImageData.mock.calls.map(([id]) => id);
        // Nothing already cached is re-fetched — the budget goes entirely to
        // photos never measured before, so the library converges to full
        // coverage instead of re-confirming one slice forever.
        expect(secondRound.some((id) => firstRound.has(id))).toBe(false);
        expect(out.every((p) => p.statsKnown)).toBe(true);
    });

    test('a cached photo costs no request at all', async () => {
        const getImageData = jest.fn().mockResolvedValue(payload(500, 10));
        await enrichCandidates([photo('p1')], 'tok', { getImageData });
        getImageData.mockClear();
        const out = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(getImageData).not.toHaveBeenCalled();
        expect(out[0]).toEqual(expect.objectContaining({ votes: 500, statsKnown: true }));
    });

    test('the cache persists across a module reload', async () => {
        const getImageData = jest.fn().mockResolvedValue(payload(500, 10));
        await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(storeData).toContain('p1');

        photoStats.__resetForTests(); // drops the in-memory map, keeps storeData
        getImageData.mockClear();
        const out = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(getImageData).not.toHaveBeenCalled();
        expect(out[0].votes).toBe(500);
    });

    test('a stale entry past the TTL is re-fetched', async () => {
        const now = Date.now();
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
        const getImageData = jest.fn().mockResolvedValue(payload(500, 10));
        await enrichCandidates([photo('p1')], 'tok', { getImageData });

        // Votes accrue while a challenge is live, so an aged entry must not win
        // a pick on numbers that have since moved.
        nowSpy.mockReturnValue(now + STATS_TTL_MS + 1);
        getImageData.mockClear().mockResolvedValue(payload(9000, 99));
        const out = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(getImageData).toHaveBeenCalledTimes(1);
        expect(out[0].votes).toBe(9000);
        nowSpy.mockRestore();
    });

    test('corrupt cache contents are ignored rather than thrown', async () => {
        storeData = '{not json';
        const getImageData = jest.fn().mockResolvedValue(payload(7, 7));
        const out = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(out[0].statsKnown).toBe(true);
    });

    test('expired counts survive when never-measured photos consume the lookup budget', async () => {
        const fetchedAt = Date.now() - STATS_TTL_MS - 1000;
        storeData = JSON.stringify({
            version: 1,
            photos: { portfolio: { votes: 373147, views: 12000, achievementCount: 10, fetchedAt } },
        });
        const unknown = Array.from({ length: MAX_ENRICH_PER_FILL }, (_, i) => photo(`new${i}`));
        const getImageData = jest.fn().mockResolvedValue(payload(29000, 100));

        const out = await enrichCandidates([photo('portfolio'), ...unknown], 'tok', { getImageData });

        expect(getImageData).toHaveBeenCalledTimes(MAX_ENRICH_PER_FILL);
        expect(getImageData).not.toHaveBeenCalledWith('portfolio', 'tok');
        expect(out[0]).toEqual(
            expect.objectContaining({ votes: 373147, views: 12000, achievementCount: 10, statsKnown: true }),
        );
        expect(parseJsonAs(storeData, isPhotoStatsFile).photos.portfolio.fetchedAt).toBe(fetchedAt);
    });

    test('a failed refresh preserves expired counts, including after the breaker opens', async () => {
        const fetchedAt = Date.now() - STATS_TTL_MS - 1000;
        storeData = JSON.stringify({
            version: 1,
            photos: { portfolio: { votes: 100000, views: 10000, achievementCount: 5, fetchedAt } },
        });
        const getImageData = jest.fn().mockResolvedValue(null);
        const input = [photo('portfolio'), photo('unknown1'), photo('unknown2')];

        const first = await enrichCandidates(input, 'tok', { getImageData });
        expect(first[0]).toEqual(expect.objectContaining({ votes: 100000, statsKnown: true }));
        expect(first.slice(1).every((entry) => !entry.statsKnown)).toBe(true);

        getImageData.mockClear();
        const second = await enrichCandidates(input, 'tok', { getImageData });
        expect(getImageData).not.toHaveBeenCalled();
        expect(second[0]).toEqual(expect.objectContaining({ votes: 100000, statsKnown: true }));
        expect(parseJsonAs(storeData, isPhotoStatsFile).photos.portfolio.fetchedAt).toBe(fetchedAt);
    });

    test('one photo failing leaves only that photo unknown', async () => {
        const getImageData = jest
            .fn()
            .mockResolvedValueOnce(payload(100, 1))
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(payload(300, 3));
        const out = await enrichCandidates([photo('a'), photo('b'), photo('c')], 'tok', { getImageData });
        expect(out.find((p) => p.id === 'a')!.statsKnown).toBe(true);
        expect(out.find((p) => p.id === 'b')!.statsKnown).toBe(false);
        expect(out.find((p) => p.id === 'c')!.statsKnown).toBe(true);
    });

    test('a thrown request is contained, not propagated', async () => {
        const getImageData = jest.fn().mockRejectedValue(new Error('429 Too Many Requests'));
        const out = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(out[0].statsKnown).toBe(false);
    });

    test('the breaker stops enrichment for the pass after repeated failures', async () => {
        const getImageData = jest.fn().mockResolvedValue(null);
        const many = Array.from({ length: MAX_ENRICH_PER_FILL }, (_, i) => photo(`p${i}`));
        await enrichCandidates(many, 'tok', { getImageData });
        // Chunked 5-wide, so the breaker trips within the first chunk and the
        // remaining chunks are never issued — no retry storm across the pass.
        expect(getImageData.mock.calls.length).toBeLessThan(MAX_ENRICH_PER_FILL);
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('skipping stat enrichment'), null);

        // A later fill in the same pass issues nothing at all.
        getImageData.mockClear();
        await enrichCandidates([photo('later')], 'tok', { getImageData });
        expect(getImageData).not.toHaveBeenCalled();

        // A new pass clears it.
        resetPassState();
        getImageData.mockClear().mockResolvedValue(payload(1, 1));
        await enrichCandidates([photo('later')], 'tok', { getImageData });
        expect(getImageData).toHaveBeenCalled();
    });

    test('a run of failures followed by a success does not trip the breaker', async () => {
        const getImageData = jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(payload(5, 5))
            .mockResolvedValue(null);
        await enrichCandidates([photo('a'), photo('b'), photo('c'), photo('d')], 'tok', { getImageData });
        expect(log.warning).not.toHaveBeenCalled();
    });

    describe('a budget of its own (a run outside any voting pass)', () => {
        test('starts untripped, and each one is separate', () => {
            const budget = createStatsBudget();
            expect(statsBudgetTripped(budget)).toBe(false);
            expect(statsBudgetTripped(createStatsBudget())).toBe(false);
        });

        test('its failure breaker opens without a warning and leaves the pass’s lookups alone', async () => {
            const budget = createStatsBudget();
            const failing = jest.fn().mockResolvedValue(null);
            const many = Array.from({ length: MAX_ENRICH_PER_FILL }, (_, i) => photo(`p${i}`));
            await enrichCandidates(many, 'tok', { getImageData: failing, statsBudget: budget });
            expect(statsBudgetTripped(budget)).toBe(true);
            expect(failing.mock.calls.length).toBeLessThan(MAX_ENRICH_PER_FILL);
            expect(log.warning).not.toHaveBeenCalled();

            // The same budget issues nothing more, while the pass's own still does.
            failing.mockClear();
            await enrichCandidates([photo('again')], 'tok', { getImageData: failing, statsBudget: budget });
            expect(failing).not.toHaveBeenCalled();
            const working = jest.fn().mockResolvedValue(payload(1, 1));
            await enrichCandidates([photo('pass')], 'tok', { getImageData: working });
            expect(working).toHaveBeenCalledTimes(1);
        });

        const batch = (prefix: string, size = MAX_ENRICH_PER_FILL) =>
            Array.from({ length: size }, (_, i) => photo(`${prefix}${i}`));

        test('a fill’s worth of successful lookups is not limited', async () => {
            const budget = createStatsBudget();
            const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
            await enrichCandidates(batch('a'), 'tok', { getImageData, statsBudget: budget });
            expect(getImageData).toHaveBeenCalledTimes(MAX_ENRICH_PER_FILL);
            expect(statsBudgetTripped(budget)).toBe(false);
            expect(log.warning).not.toHaveBeenCalled();
        });

        test('a fill’s worth spends the cap: a further call starts no lookup and is not tripped, and the pass’s ceiling is not spent', async () => {
            const budget = createStatsBudget();
            const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
            await enrichCandidates(batch('a'), 'tok', { getImageData, statsBudget: budget });
            getImageData.mockClear();
            await enrichCandidates(batch('b', 3), 'tok', { getImageData, statsBudget: budget });
            expect(getImageData).not.toHaveBeenCalled();
            expect(statsBudgetTripped(budget)).toBe(false);
            expect(log.warning).not.toHaveBeenCalled();

            // Cached photos are still answered free from it, and the pass's own budget is whole.
            const [cached] = await enrichCandidates([photo('a0')], 'tok', { getImageData, statsBudget: budget });
            expect(cached.statsKnown).toBe(true);
            expect(getImageData).not.toHaveBeenCalled();
            for (let i = 0; i < 7; i++) await enrichCandidates(batch(`c${i}-`), 'tok', { getImageData });
            expect(getImageData).toHaveBeenCalledTimes(7 * MAX_ENRICH_PER_FILL);
        });
    });

    test('degrades to stats-unknown when no getImageData is injected', async () => {
        const out = await enrichCandidates([photo('p1')], 'tok', {});
        expect(out).toEqual([expect.objectContaining({ id: 'p1', statsKnown: false })]);
    });

    test('empty input is a no-op', async () => {
        const getImageData = jest.fn();
        expect(await enrichCandidates([], 'tok', { getImageData })).toEqual([]);
        expect(getImageData).not.toHaveBeenCalled();
    });

    test('never-measured photos are fetched before merely-stale ones', async () => {
        const now = Date.now();
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
        const getImageData = jest
            .fn<ReturnType<GetImageData>, Parameters<GetImageData>>()
            .mockResolvedValue(payload(1, 1));

        // Measure 'stale' now, then jump past the TTL so it needs re-reading.
        await enrichCandidates([photo('stale', { views: 9999 })], 'tok', { getImageData });
        nowSpy.mockReturnValue(now + STATS_TTL_MS + 1);

        // 'stale' has by far the most views, so a purely views-ranked queue
        // would re-read it first. A never-measured photo has no numbers at all,
        // which is strictly worse for coverage, so it must go first.
        getImageData.mockClear();
        const many = [
            photo('stale', { views: 9999 }),
            ...Array.from({ length: MAX_ENRICH_PER_FILL }, (_, i) => photo(`fresh${i}`, { views: 1 })),
        ];
        await enrichCandidates(many, 'tok', { getImageData });
        const fetched = getImageData.mock.calls.map(([id]) => id);
        expect(fetched).toHaveLength(MAX_ENRICH_PER_FILL);
        expect(fetched).not.toContain('stale');
        nowSpy.mockRestore();
    });

    test('within the never-measured group, higher-view photos are read first', async () => {
        const getImageData = jest
            .fn<ReturnType<GetImageData>, Parameters<GetImageData>>()
            .mockResolvedValue(payload(1, 1));
        const many = [
            ...Array.from({ length: MAX_ENRICH_PER_FILL }, (_, i) => photo(`low${i}`, { views: 1 })),
            photo('high', { views: 5000 }),
        ];
        await enrichCandidates(many, 'tok', { getImageData });
        // views never feeds the ranking tiers — it only orders the reading
        // queue — but that order decides who gets measured first when the set
        // is larger than one fill's budget, so it is worth pinning.
        expect(getImageData.mock.calls[0][0]).toBe('high');
    });

    test('a duplicate id does not burn two budget slots', async () => {
        const getImageData = jest
            .fn<ReturnType<GetImageData>, Parameters<GetImageData>>()
            .mockResolvedValue(payload(1, 1));
        await enrichCandidates([photo('dup'), photo('dup'), photo('other')], 'tok', { getImageData });
        const fetched = getImageData.mock.calls.map(([id]) => id);
        expect(fetched.filter((id) => id === 'dup')).toHaveLength(1);
        expect(fetched).toContain('other');
    });

    test('a cache entry stamped in the future is not treated as fresh', async () => {
        const now = Date.now();
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
        const getImageData = jest.fn().mockResolvedValue(payload(7, 7));
        await enrichCandidates([photo('p1')], 'tok', { getImageData });

        // Clock skew or a corrupted file must not make an entry immortal.
        nowSpy.mockReturnValue(now - 60_000);
        getImageData.mockClear().mockResolvedValue(payload(8, 8));
        const out = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(getImageData).toHaveBeenCalledTimes(1);
        expect(out[0].votes).toBe(8);
        nowSpy.mockRestore();
    });

    test('an oversized photo id is still enriched but never persisted', async () => {
        const longId = 'x'.repeat(500);
        const getImageData = jest.fn().mockResolvedValue(payload(42, 42));
        const out = await enrichCandidates([photo(longId)], 'tok', { getImageData });
        expect(out[0]).toEqual(expect.objectContaining({ votes: 42, statsKnown: true }));
        // MAX_CACHE_ENTRIES bounds the entry COUNT, not key length — an
        // unbounded id would inflate the file past what that cap intends.
        expect(storeData === null || !storeData.includes(longId)).toBe(true);
    });

    test('a photo id of "__proto__" round-trips through the persisted cache', async () => {
        // A plain {} would swallow this key on write via the inherited setter,
        // silently dropping the entry on every persist.
        const getImageData = jest.fn().mockResolvedValue(payload(11, 22));
        await enrichCandidates([photo('__proto__')], 'tok', { getImageData });

        photoStats.__resetForTests();
        getImageData.mockClear();
        const out = await enrichCandidates([photo('__proto__')], 'tok', { getImageData });
        expect(getImageData).not.toHaveBeenCalled();
        expect(out[0].votes).toBe(11);
        expect(({} as { votes?: unknown }).votes).toBeUndefined();
    });

    test('the pass-wide ceiling stops enrichment across many challenges', async () => {
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        // Each call is a separate "challenge" within one pass.
        for (let i = 0; i < 12; i++) {
            const batch = Array.from({ length: MAX_ENRICH_PER_FILL }, (_, j) => photo(`c${i}p${j}`));
            await enrichCandidates(batch, 'tok', { getImageData });
        }
        expect(getImageData.mock.calls.length).toBeLessThanOrEqual(MAX_ENRICH_PER_PASS);
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining("this cycle's limit"), null);

        // A new pass lifts it.
        resetPassState();
        getImageData.mockClear();
        await enrichCandidates([photo('after-reset')], 'tok', { getImageData });
        expect(getImageData).toHaveBeenCalled();
    });

    test('cache eviction keeps the newest entries when over the cap', async () => {
        // Build a persisted cache already past the cap, with a clearly-oldest
        // and a clearly-newest entry, then force a write.
        const now = Date.now();
        const photos: Record<string, unknown> = {};
        for (let i = 0; i < MAX_CACHE_ENTRIES + 10; i++) {
            photos[`p${i}`] = { votes: i, views: 0, achievementCount: 0, fetchedAt: now - i };
        }
        storeData = JSON.stringify({ version: 1, photos });
        photoStats.__resetForTests();

        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        await enrichCandidates([photo('brand-new')], 'tok', { getImageData });

        const persisted = parseJsonAs(storeData, isPhotoStatsFile).photos;
        expect(Object.keys(persisted).length).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
        // Newest survive, oldest are dropped — a flipped comparator would
        // silently invert this and nothing else would notice.
        expect(persisted['brand-new']).toBeDefined();
        expect(persisted.p0).toBeDefined();
        expect(persisted[`p${MAX_CACHE_ENTRIES + 9}`]).toBeUndefined();
    });
});

describe('photoStats display pair (likes / guruPicks)', () => {
    beforeEach(() => {
        storeData = null;
        photoStats.__resetForTests();
        resetPassState();
        jest.clearAllMocks();
    });

    const payload = (votes: number, views: number, achievementCount = 0) => ({
        votes,
        views,
        achievements: Array.from({ length: achievementCount }, (_, i) => ({ name: `a${i}` })),
    });

    test('a payload with likes and guru_picks lands them as numbers, and nothing else of the payload', async () => {
        const getImageData = jest
            .fn()
            .mockResolvedValue({ ...payload(10, 20, 1), likes: 4, guru_picks: 2, title: 'server text' });
        const out = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(out[0]).toEqual(expect.objectContaining({ likes: 4, guruPicks: 2, statsKnown: true }));
        expect((out[0] as { title?: unknown }).title).toBeUndefined();
        expect((out[0] as { guru_picks?: unknown }).guru_picks).toBeUndefined();
    });

    test('a payload without them lands 0s — a successful read means none, so the entry is complete for display', async () => {
        const getImageData = jest.fn().mockResolvedValue(payload(10, 20, 1));
        const out = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(out[0]).toEqual(
            expect.objectContaining({ votes: 10, views: 20, likes: 0, guruPicks: 0, statsKnown: true }),
        );
    });

    test('a hostile display value is coerced like the ranking numbers', async () => {
        const getImageData = jest.fn().mockResolvedValue({ ...payload(1, 1), likes: -5, guru_picks: 2.9 });
        const out = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(out[0].likes).toBe(0);
        expect(out[0].guruPicks).toBe(2);
    });

    test('the map enrichCandidates returns copies them from a cache hit too', async () => {
        storeData = JSON.stringify({
            version: 1,
            photos: { hit: { votes: 7, views: 8, achievementCount: 0, fetchedAt: Date.now(), likes: 9, guruPicks: 1 } },
        });
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        const out = await enrichCandidates([photo('hit')], 'tok', { getImageData });
        expect(getImageData).not.toHaveBeenCalled();
        expect(out[0]).toEqual(expect.objectContaining({ likes: 9, guruPicks: 1, statsKnown: true }));
    });
});

describe('photoStats.loadCache and the display pair', () => {
    beforeEach(() => {
        storeData = null;
        photoStats.__resetForTests();
        resetPassState();
        jest.clearAllMocks();
    });

    const payload = (votes: number, views: number) => ({ votes, views, achievements: [] });

    test('an entry without likes keeps them absent and still ranks as fresh', async () => {
        storeData = JSON.stringify({
            version: 1,
            photos: { old: { votes: 1, views: 2, achievementCount: 0, fetchedAt: Date.now() } },
        });
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        const out = await enrichCandidates([photo('old')], 'tok', { getImageData });
        expect(getImageData).not.toHaveBeenCalled();
        expect(out[0]).toEqual(expect.objectContaining({ votes: 1, statsKnown: true }));
        expect(out[0].likes).toBeUndefined();
        expect(out[0].guruPicks).toBeUndefined();
    });

    test.each([
        ['a numeric string', '7', 7],
        ['a negative number', -5, 0],
        ['a fraction', 2.9, 2],
    ])('a persisted likes of %s reads as nonNegInt (%p)', async (_label, stored, expected) => {
        storeData = JSON.stringify({
            version: 1,
            photos: {
                e: { votes: 1, views: 1, achievementCount: 0, fetchedAt: Date.now(), likes: stored, guruPicks: stored },
            },
        });
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        const out = await enrichCandidates([photo('e')], 'tok', { getImageData });
        expect(out[0].likes).toBe(expected);
        expect(out[0].guruPicks).toBe(expected);
    });
});

describe('photoStats.enrichCandidates options', () => {
    beforeEach(() => {
        storeData = null;
        photoStats.__resetForTests();
        resetPassState();
        jest.clearAllMocks();
    });

    const payload = (votes: number, views: number) => ({ votes, views, achievements: [] });

    test('maxFetch bounds the photos newly fetched by this call', async () => {
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        const many = Array.from({ length: 10 }, (_, i) => photo(`m${i}`));
        await enrichCandidates(many, 'tok', { getImageData, maxFetch: 3 });
        expect(getImageData).toHaveBeenCalledTimes(3);
    });

    test('needDisplay fetches a fresh entry without the pair, and not one that has it', async () => {
        storeData = JSON.stringify({
            version: 1,
            photos: {
                bare: { votes: 1, views: 2, achievementCount: 0, fetchedAt: Date.now() },
                full: { votes: 3, views: 4, achievementCount: 0, fetchedAt: Date.now(), likes: 5, guruPicks: 6 },
            },
        });
        const getImageData = jest.fn().mockResolvedValue({ ...payload(9, 9), likes: 8, guru_picks: 7 });
        // Without needDisplay a fresh entry costs nothing.
        await enrichCandidates([photo('bare')], 'tok', { getImageData });
        expect(getImageData).not.toHaveBeenCalled();
        // With it, the pair-less entry is fetched and the complete one is not.
        const out = await enrichCandidates([photo('bare'), photo('full')], 'tok', { getImageData, needDisplay: true });
        expect(getImageData).toHaveBeenCalledTimes(1);
        expect(getImageData).toHaveBeenCalledWith('bare', 'tok');
        expect(out[0]).toEqual(expect.objectContaining({ likes: 8, guruPicks: 7, statsKnown: true }));
    });

    test('persist:false answers a landed lookup without ever writing the store', async () => {
        const getImageData = jest.fn().mockResolvedValue({ ...payload(4, 5), likes: 6, guru_picks: 7 });
        const out = await enrichCandidates([photo('pp')], 'tok', { getImageData, persist: false });
        expect(out[0]).toEqual(expect.objectContaining({ votes: 4, likes: 6, guruPicks: 7, statsKnown: true }));
        expect(storeData).toBeNull();
        // The next call fetches again: nothing was kept.
        getImageData.mockClear();
        await enrichCandidates([photo('pp')], 'tok', { getImageData });
        expect(getImageData).toHaveBeenCalledTimes(1);
    });

    test("createStatsBudget(cap) spends the caller's cap, not the fill default", async () => {
        const budget = createStatsBudget(2);
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        const many = Array.from({ length: 5 }, (_, i) => photo(`c${i}`));
        await enrichCandidates(many, 'tok', { getImageData, statsBudget: budget });
        expect(getImageData).toHaveBeenCalledTimes(2);
        expect(statsBudgetTripped(budget)).toBe(false);
    });
});

describe('photoStats.persistCache trims in place', () => {
    beforeEach(() => {
        storeData = null;
        photoStats.__resetForTests();
        resetPassState();
        jest.clearAllMocks();
    });

    const payload = (votes: number, views: number) => ({ votes, views, achievements: [] });

    test("a concurrent call's landed lookup survives a trim that happened while it ran", async () => {
        const now = Date.now();
        const photos: Record<string, unknown> = {};
        for (let i = 0; i < MAX_CACHE_ENTRIES + 10; i++) {
            photos[`p${i}`] = { votes: i, views: 0, achievementCount: 0, fetchedAt: now - i };
        }
        storeData = JSON.stringify({ version: 1, photos });
        photoStats.__resetForTests();

        type Payload = { votes: number; views: number; achievements: unknown[] };
        let releaseLate!: (value: Payload) => void;
        const lateGate = new Promise<Payload>((resolve) => (releaseLate = resolve));
        const getImageData = jest
            .fn<ReturnType<NonNullable<RankDeps['getImageData']>>, Parameters<NonNullable<RankDeps['getImageData']>>>()
            .mockImplementation((id) => (String(id) === 'late-one' ? lateGate : Promise.resolve(payload(1, 1))));

        // `late` starts fetching and hangs; the trimmer overflows the cache and
        // persists while it runs; then `late` lands and writes.
        const late = enrichCandidates([photo('late-one')], 'tok', { getImageData });
        await enrichCandidates([photo('trim-one')], 'tok', { getImageData });
        releaseLate(payload(9, 9));
        await late;

        const persisted = parseJsonAs(storeData, isPhotoStatsFile).photos;
        // With a replaced Map the late write went into one nobody reads and was lost.
        expect(persisted['late-one']).toBeDefined();
        expect(persisted['trim-one']).toBeDefined();
        expect(Object.keys(persisted).length).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
    });
});
