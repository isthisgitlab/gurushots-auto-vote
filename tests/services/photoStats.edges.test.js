/**
 * Edge-case coverage for photoStats.js: store read/write failures (with and
 * without an Error message), malformed persisted cache shapes, null/id-less
 * candidates, non-Error request failures, the uncached-first comparator in
 * both argument orders, and the pass ceiling landing mid-chunk.
 */

// Store whose read/write behaviour each test controls.
const store = { read: () => null, write: () => {} };
jest.mock('../../src/js/settings/storage', () => ({
    createJsonStore: () => ({
        readRaw: () => store.read(),
        writeRaw: (data) => store.write(data),
        getFilePath: () => '/tmp/photo-stats-edges.json',
        initializeAsync: async () => {},
    }),
}));

jest.mock('../../src/js/logger', () => {
    const level = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => level), __level: level };
});

const photoStats = require('../../src/js/services/photoStats');
const { enrichCandidates, resetPassState, MAX_ENRICH_PER_FILL, MAX_ENRICH_PER_PASS, STATS_TTL_MS } = photoStats;
const { __level: log } = require('../../src/js/logger');

const photo = (id, extra = {}) => ({ id, labels: ['Misc'], permission: { allowed: true }, ...extra });
const payload = (votes, views) => ({ votes, views, achievements: [] });

let written;
beforeEach(() => {
    written = null;
    store.read = () => null;
    store.write = (data) => {
        written = data;
    };
    photoStats.__resetForTests();
    resetPassState();
    jest.clearAllMocks();
});

describe('loading the persisted cache', () => {
    test('a thrown non-Error read is logged verbatim and treated as an empty cache', async () => {
        store.read = () => {
            throw 'EACCES';
        };
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        const [out] = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(out.statsKnown).toBe(true);
        expect(getImageData).toHaveBeenCalledTimes(1);
        expect(log.debug).toHaveBeenCalledWith('photoStats: could not read the stats cache: EACCES', null);
    });

    test.each([
        ['a JSON null document', 'null'],
        ['a document without photos', JSON.stringify({ version: 1 })],
        ['a non-object photos field', JSON.stringify({ version: 1, photos: 'nope' })],
    ])('%s is an empty cache', async (_label, raw) => {
        store.read = () => raw;
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(getImageData).toHaveBeenCalledTimes(1);
    });

    test('drops non-object entries and unusable keys, and zeroes a non-finite fetchedAt', async () => {
        const now = Date.now();
        store.read = () =>
            JSON.stringify({
                version: 1,
                photos: {
                    good: { votes: 7, views: 3, achievementCount: 1, fetchedAt: now },
                    scalar: 5,
                    '': { votes: 1, fetchedAt: now },
                    ['x'.repeat(129)]: { votes: 1, fetchedAt: now },
                    undated: { votes: 9, views: 9, achievementCount: 0, fetchedAt: 'yesterday' },
                },
            });
        const getImageData = jest.fn().mockResolvedValue(payload(2, 2));
        const out = await enrichCandidates([photo('good'), photo('scalar'), photo('undated')], 'tok', {
            getImageData,
        });
        // 'good' is a fresh hit; 'scalar' was dropped; 'undated' has fetchedAt 0 → stale.
        expect(getImageData.mock.calls.map(([id]) => id).sort()).toEqual(['scalar', 'undated']);
        expect(out[0]).toEqual(expect.objectContaining({ id: 'good', votes: 7, statsKnown: true }));

        // The persisted file no longer carries the dropped keys.
        const persisted = JSON.parse(written).photos;
        expect(Object.keys(persisted).sort()).toEqual(['good', 'scalar', 'undated']);
        expect(persisted.undated.votes).toBe(2);
    });
});

describe('persisting the cache', () => {
    test.each([
        ['an Error', new Error('disk full'), 'disk full'],
        ['a bare string', 'EROFS', 'EROFS'],
    ])('a write failure with %s is logged at debug and the fill still succeeds', async (_label, thrown, text) => {
        store.write = () => {
            throw thrown;
        };
        const getImageData = jest.fn().mockResolvedValue(payload(4, 4));
        const [out] = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(out).toEqual(expect.objectContaining({ votes: 4, statsKnown: true }));
        expect(log.debug).toHaveBeenCalledWith(`photoStats: could not persist the stats cache: ${text}`, null);
    });
});

describe('candidate shapes', () => {
    test('null and id-less candidates are passed through as stats-unknown without a request', async () => {
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        const out = await enrichCandidates([null, photo(null), photo(''), photo('p1')], 'tok', { getImageData });
        expect(getImageData.mock.calls.map(([id]) => id)).toEqual(['p1']);
        expect(out.map((p) => p.statsKnown)).toEqual([false, false, false, true]);
    });

    test('a non-Error request failure is logged with the raw value', async () => {
        const getImageData = jest.fn().mockRejectedValue('timeout\nnow');
        const [out] = await enrichCandidates([photo('p1')], 'tok', { getImageData });
        expect(out.statsKnown).toBe(false);
        const line = log.debug.mock.calls.find(([m]) => m.includes('get_image_data failed'))[0];
        expect(line).toContain('timeout now');
    });
});

describe('fetch ordering', () => {
    const staleCache = () => {
        const stale = Date.now() - STATS_TTL_MS - 1000;
        store.read = () =>
            JSON.stringify({
                version: 1,
                photos: { stale: { votes: 1, views: 1, achievementCount: 0, fetchedAt: stale } },
            });
    };

    test.each([
        ['stale first', ['stale', 'never']],
        ['never-measured first', ['never', 'stale']],
    ])('never-measured beats stale regardless of input order (%s)', async (_label, order) => {
        staleCache();
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        // Many never-measured fillers push the stale photo past the per-fill budget.
        const fillers = Array.from({ length: MAX_ENRICH_PER_FILL - 1 }, (_, i) => photo(`f${i}`));
        const input = order.map((id) => photo(id, { views: id === 'stale' ? 1_000_000 : 0 }));
        await enrichCandidates([...input, ...fillers], 'tok', { getImageData });
        const fetched = getImageData.mock.calls.map(([id]) => id);
        expect(fetched).toContain('never');
        expect(fetched).not.toContain('stale');
    });
});

describe('pass ceiling reached inside a chunk', () => {
    test('workers started after the ceiling is hit issue no request', async () => {
        const getImageData = jest.fn().mockResolvedValue(payload(1, 1));
        // 3 + 7*25 = 178 lookups; the next fill hits 200 two photos into its last chunk.
        await enrichCandidates([photo('a0'), photo('a1'), photo('a2')], 'tok', { getImageData });
        for (let i = 0; i < 7; i++) {
            const batch = Array.from({ length: MAX_ENRICH_PER_FILL }, (_, j) => photo(`c${i}p${j}`));
            await enrichCandidates(batch, 'tok', { getImageData });
        }
        const last = Array.from({ length: MAX_ENRICH_PER_FILL }, (_, j) => photo(`last${j}`));
        const out = await enrichCandidates(last, 'tok', { getImageData });

        expect(getImageData).toHaveBeenCalledTimes(MAX_ENRICH_PER_PASS);
        const known = out.filter((p) => p.statsKnown).length;
        expect(known).toBe(MAX_ENRICH_PER_PASS - 178);
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining("this cycle's limit"), null);
    });
});
