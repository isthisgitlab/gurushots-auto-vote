/**
 * Integration cover for the tag-resolution retry inside
 * fetchCandidatesForChallenge — the path that turns the reported bug
 * ("Stairs" filled from a yoga photo) into an on-theme fill.
 *
 * Lives in its own file because it needs the REAL shipped lexicon, and making
 * the lexicon available inside the large autoFill.test.js would change the
 * semantic tier under tests written without it.
 */

// See tests/services/tagResolver.test.js — tests/setup.js mocks `fs`, so the
// loader must go through the real one or every semantic check passes vacuously.
jest.mock('../../src/js/services/semantic/assets', () => {
    const realFs = jest.requireActual('node:fs');
    const realPath = jest.requireActual('node:path');
    const assetPath = realPath.join(__dirname, '..', '..', 'src', 'assets', 'semantic-vectors.json');
    let cached;
    return {
        ASSET_NAME: 'semantic-vectors.json',
        loadLexiconAsset: async () => {
            if (cached === undefined) cached = JSON.parse(realFs.readFileSync(assetPath, 'utf8'));
            return cached;
        },
        __resetForTests: () => {},
    };
});

const { fetchCandidatesForChallenge, __resetMemberIdCache } = require('../../src/js/services/autoFill');

const allowed = (id, labels) => ({ id, labels, permission: { allowed: true, message: null } });

// The real library: staircase photos exist, but only under the tag "staircase".
const LIBRARY = [
    allowed('stairs_1', ['Staircase', 'Handrail', 'Architecture']),
    allowed('stairs_2', ['Staircase', 'Building']),
    allowed('yoga_1', ['Yoga', 'Fitness', 'Person', 'Outdoors']),
    allowed('misc_1', ['Misc']),
];

// Mirrors the live endpoint: `search` is an EXACT tag match, not a text search.
const makeGetEligiblePhotos = () =>
    jest.fn(async (_challengeId, _token, options = {}) => {
        const search = typeof options.search === 'string' ? options.search.trim().toLowerCase() : '';
        if (search === '') return LIBRARY;
        return LIBRARY.filter((p) => p.labels.some((l) => l.toLowerCase() === search));
    });

const makeLogger = () => {
    const category = { info: jest.fn(), warning: jest.fn(), debug: jest.fn(), error: jest.fn(), success: jest.fn() };
    return { logger: { withCategory: () => category, challengeTag: (c) => `[Challenge ${c.id}]` }, category };
};

const STAIRS = { id: 'c-stairs', title: 'Stairs', url: 'stairs38' };

describe('fetchCandidatesForChallenge — tag resolution', () => {
    beforeEach(() => __resetMemberIdCache());

    test('resolves "stair" to the library tag "staircase" and returns on-theme photos', async () => {
        const getEligiblePhotos = makeGetEligiblePhotos();
        const { logger, category } = makeLogger();
        const result = await fetchCandidatesForChallenge(
            STAIRS,
            'tok',
            {},
            {
                getEligiblePhotos,
                logger,
                searchTagAutocomplete: jest.fn(async (_t, term) => (term === 'stair' ? ['staircase'] : [])),
                getCurrentMemberProfile: jest.fn(async () => ({ id: 'member-hash', userName: 'guru' })),
            },
        );

        expect(result.map((p) => p.id).sort()).toEqual(['stairs_1', 'stairs_2']);
        // The unfiltered library walk must NOT have happened — that is the path
        // that submits an off-theme photo.
        expect(getEligiblePhotos).not.toHaveBeenCalledWith(
            'c-stairs',
            'tok',
            expect.objectContaining({ paginate: true }),
        );
        expect(category.warning).not.toHaveBeenCalled();
        expect(category.info).toHaveBeenCalledWith(expect.stringContaining('"staircase"'), null);
    });

    test('without resolution deps it falls back to the full library, exactly as before', async () => {
        const getEligiblePhotos = makeGetEligiblePhotos();
        const { logger, category } = makeLogger();
        const result = await fetchCandidatesForChallenge(STAIRS, 'tok', {}, { getEligiblePhotos, logger });

        // This is the pre-existing behavior the bug report described: the whole
        // library, ranked by popularity, off-theme photo included.
        expect(result).toEqual(LIBRARY);
        expect(getEligiblePhotos).toHaveBeenCalledWith('c-stairs', 'tok', expect.objectContaining({ paginate: true }));
        expect(category.warning).toHaveBeenCalledWith(expect.stringContaining('nothing on theme'), null);
    });

    test('still falls back — loudly — when a real theme resolves to no tag', async () => {
        const getEligiblePhotos = makeGetEligiblePhotos();
        const { logger, category } = makeLogger();
        const result = await fetchCandidatesForChallenge(
            { id: 'c-zeppelin', title: 'Zeppelins' },
            'tok',
            {},
            {
                getEligiblePhotos,
                logger,
                searchTagAutocomplete: jest.fn(async () => []),
                getCurrentMemberProfile: jest.fn(async () => ({ id: 'member-hash', userName: 'guru' })),
            },
        );
        expect(result).toEqual(LIBRARY);
        expect(category.warning).toHaveBeenCalledWith(expect.stringContaining('nothing on theme'), null);
    });

    test('a contest-cadence title has no theme to search and says so', async () => {
        // "week" is a stopword, so "Guru of The Week" yields no search term at
        // all — a different case from a theme that was searched and missed, and
        // it gets its own message rather than claiming a search happened.
        const getEligiblePhotos = makeGetEligiblePhotos();
        const { logger, category } = makeLogger();
        const searchTagAutocomplete = jest.fn(async () => ['staircase']);
        const result = await fetchCandidatesForChallenge(
            { id: 'c-meta', title: 'Guru of The Week' },
            'tok',
            {},
            {
                getEligiblePhotos,
                logger,
                searchTagAutocomplete,
                getCurrentMemberProfile: jest.fn(async () => ({ id: 'member-hash', userName: 'guru' })),
            },
        );
        expect(result).toEqual(LIBRARY);
        expect(category.warning).toHaveBeenCalledWith(expect.stringContaining('no matchable theme in its title'), null);
        // Nothing to resolve means no lookup is attempted at all.
        expect(searchTagAutocomplete).not.toHaveBeenCalled();
    });

    test('a failing identity lookup degrades to the old behavior instead of throwing', async () => {
        const getEligiblePhotos = makeGetEligiblePhotos();
        const { logger } = makeLogger();
        const searchTagAutocomplete = jest.fn(async () => ['staircase']);
        const result = await fetchCandidatesForChallenge(
            STAIRS,
            'tok',
            {},
            {
                getEligiblePhotos,
                logger,
                searchTagAutocomplete,
                getCurrentMemberProfile: jest.fn(async () => null),
            },
        );
        expect(result).toEqual(LIBRARY);
        // No identity means no lookup is even attempted.
        expect(searchTagAutocomplete).not.toHaveBeenCalled();
    });

    test('the identity lookup is made once and reused across challenges', async () => {
        const getCurrentMemberProfile = jest.fn(async () => ({ id: 'member-hash', userName: 'guru' }));
        const searchTagAutocomplete = jest.fn(async (_t, term) => (term === 'stair' ? ['staircase'] : []));
        const { logger } = makeLogger();
        const deps = {
            getEligiblePhotos: makeGetEligiblePhotos(),
            logger,
            searchTagAutocomplete,
            getCurrentMemberProfile,
        };

        await fetchCandidatesForChallenge(STAIRS, 'tok', {}, deps);
        await fetchCandidatesForChallenge({ ...STAIRS, id: 'c-stairs-2' }, 'tok', {}, deps);

        // A fill pass touches every active challenge; re-reading identity on each
        // one would be pure latency for an answer that cannot change.
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(1);
    });
});
