/**
 * Tests for photoStats.js — per-photo popularity enrichment.
 *
 * The module exists because get_photos_private reports votes=0 and no
 * achievements for every library photo, so these tests care most about the
 * boundaries that keep enrichment cheap and honest: the per-fill fetch budget,
 * the uncached-first selection order, the persistent cache, and the failure
 * paths that must degrade instead of breaking a fill.
 */

// In-memory stand-in for the cross-platform JSON store.
let storeData = null;
jest.mock('../../src/js/settings/storage', () => ({
    createJsonStore: () => ({
        readRaw: () => storeData,
        writeRaw: (data) => {
            storeData = data;
        },
        getFilePath: () => '/tmp/photo-stats.json',
        initializeAsync: async () => {},
    }),
}));

jest.mock('../../src/js/logger', () => {
    const level = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => level), __level: level };
});

const photoStats = require('../../src/js/services/photoStats');
const { enrichCandidates, resetPassState, MAX_ENRICH_PER_FILL, STATS_TTL_MS } = photoStats;
const { __level: log } = require('../../src/js/logger');

const photo = (id, extra = {}) => ({ id, labels: ['Misc'], permission: { allowed: true }, ...extra });

// A get_image_data payload shaped like the real one.
const payload = (votes, views, achievementCount = 0) => ({
    votes,
    views,
    achievements: Array.from({ length: achievementCount }, (_, i) => ({ name: `a${i}` })),
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
        const [out] = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(out.member).toBeUndefined();
        expect(out.meta_data).toBeUndefined();
    });

    test('a "__proto__" key in the payload cannot pollute Object.prototype', async () => {
        const evil = JSON.parse('{"votes":5,"views":5,"achievements":[],"__proto__":{"polluted":true}}');
        const getImageData = jest.fn().mockResolvedValue(evil);
        await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect({}.polluted).toBeUndefined();
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
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
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

    test('one photo failing leaves only that photo unknown', async () => {
        const getImageData = jest
            .fn()
            .mockResolvedValueOnce(payload(100, 1))
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(payload(300, 3));
        const out = await enrichCandidates([photo('a'), photo('b'), photo('c')], 'tok', { getImageData });
        expect(out.find((p) => p.id === 'a').statsKnown).toBe(true);
        expect(out.find((p) => p.id === 'b').statsKnown).toBe(false);
        expect(out.find((p) => p.id === 'c').statsKnown).toBe(true);
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

    test('degrades to stats-unknown when no getImageData is injected', async () => {
        const out = await enrichCandidates([photo('p1')], 'tok', {});
        expect(out).toEqual([expect.objectContaining({ id: 'p1', statsKnown: false })]);
    });

    test('empty input is a no-op', async () => {
        const getImageData = jest.fn();
        expect(await enrichCandidates([], 'tok', { getImageData })).toEqual([]);
        expect(getImageData).not.toHaveBeenCalled();
    });
});
