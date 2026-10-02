/**
 * Integration cover for the tag-resolution retry inside
 * fetchCandidatesForChallenge — the path that keeps a "Stairs" challenge
 * from being filled with a yoga photo.
 *
 * Lives in its own file because it needs the REAL shipped lexicon, and making
 * the lexicon available inside the large autoFill.test.ts would change the
 * semantic tier under tests written without it.
 */

jest.mock('../../src/ts/services/semantic/lexicon', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/services/semantic/lexicon')>(
        '../../src/ts/services/semantic/lexicon',
    ),
}));

// See tests/services/tagResolver.test.ts — tests/setup.ts mocks `fs`, so the
// loader must go through the real one or every semantic check passes vacuously.
jest.mock('../../src/ts/services/semantic/assets', () => {
    const realFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const realPath = jest.requireActual<typeof import('node:path')>('node:path');
    const assetPath = realPath.join(__dirname, '..', '..', 'src', 'assets', 'semantic-vectors.json');
    let cached: unknown;
    return {
        ASSET_NAME: 'semantic-vectors.json',
        loadLexiconAsset: async () => {
            if (cached === undefined) cached = JSON.parse(realFs.readFileSync(assetPath, 'utf8'));
            return cached;
        },
        __resetForTests: () => {},
    };
});

const { fetchCandidatesForChallenge, __resetMemberIdCache } =
    require('../../src/ts/services/autoFill') as typeof autoFillModule;
import lexiconModule = require('../../src/ts/services/semantic/lexicon');
const lexicon = jest.mocked(lexiconModule);
import type * as autoFillModule from '../../src/ts/services/autoFill';
import type * as submissionsModule from '../../src/ts/api/submissions';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { FillLogger } from '../../src/ts/types/autoFill';
import { invalid } from '../helpers/invalid';

// getEligiblePhotos' options bag (its third, defaulted parameter).
type EligibleOptions = NonNullable<Parameters<typeof submissionsModule.getEligiblePhotos>[2]>;

const allowed = (id: string, labels: string[]) => ({ id, labels, permission: { allowed: true, message: null } });

// The real library: staircase photos exist, but only under the tag "staircase".
const LIBRARY = [
    allowed('stairs_1', ['Staircase', 'Handrail', 'Architecture']),
    allowed('stairs_2', ['Staircase', 'Building']),
    allowed('yoga_1', ['Yoga', 'Fitness', 'Person', 'Outdoors']),
    allowed('misc_1', ['Misc']),
];

// Mirrors the live endpoint: `search` is an EXACT tag match, not a text search.
const makeGetEligiblePhotos = () =>
    jest.fn(async (_challengeId: string | number, _token: string, options: EligibleOptions = {}) => {
        const search = typeof options.search === 'string' ? options.search.trim().toLowerCase() : '';
        if (search === '') return LIBRARY;
        return LIBRARY.filter((p) => p.labels.some((l) => l.toLowerCase() === search));
    });

const makeLogger = () => {
    const category = { info: jest.fn(), warning: jest.fn(), debug: jest.fn(), error: jest.fn(), success: jest.fn() };
    return {
        logger: invalid<FillLogger>({
            withCategory: () => category,
            challengeTag: (c: Challenge) => `[Challenge ${c.id}]`,
        }),
        category,
    };
};

const STAIRS = invalid<Challenge>({ id: 'c-stairs', title: 'Stairs', url: 'stairs38' });

describe('fetchCandidatesForChallenge — tag resolution', () => {
    beforeEach(() => __resetMemberIdCache());
    afterEach(() => jest.restoreAllMocks());

    test('resolves "stair" to the library tag "staircase" and returns on-theme photos', async () => {
        jest.spyOn(lexicon, 'relatedSearchTerms').mockReturnValue([]);
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
        // The UNFILTERED library walk must NOT have happened — that is the path
        // that submits an off-theme photo. What makes it unfiltered is the
        // absence of a `search` term, NOT `paginate`: themed searches paginate
        // too now (they just stop after one request when a term fits in a page),
        // so keying this on `paginate` would assert the opposite of the intent.
        const unfilteredCalls = getEligiblePhotos.mock.calls.filter(([, , opts]) => !opts || !opts.search);
        expect(unfilteredCalls).toEqual([]);
        expect(category.warning).not.toHaveBeenCalled();
        expect(category.info).toHaveBeenCalledWith(expect.stringContaining('"staircase"'), null);
    });

    test('without resolution deps it still finds related tags in the library', async () => {
        const getEligiblePhotos = makeGetEligiblePhotos();
        const { logger, category } = makeLogger();
        const result = await fetchCandidatesForChallenge(STAIRS, 'tok', {}, { getEligiblePhotos, logger });

        expect(result.map((p) => p.id).sort()).toEqual(['stairs_1', 'stairs_2']);
        expect(getEligiblePhotos).toHaveBeenCalledWith(
            'c-stairs',
            'tok',
            expect.objectContaining({ search: 'staircase', paginate: true }),
        );
        expect(category.warning).not.toHaveBeenCalled();
    });

    test('finds an older plane photo for a Flight challenge outside authored concepts', async () => {
        const getEligiblePhotos = jest.fn(
            async (_id: string | number, _token: string, options: EligibleOptions = {}) => {
                if (options.search === 'plane') return [allowed('plane', ['Plane'])];
                if (!options.search) return [allowed('portrait', ['Portrait'])];
                return [];
            },
        );
        const result = await fetchCandidatesForChallenge(
            invalid({ id: 'c-flight', title: 'Flight' }),
            'tok',
            {},
            { getEligiblePhotos, logger: makeLogger().logger },
        );
        expect(result.map((photo) => photo.id)).toEqual(['plane']);
        expect(getEligiblePhotos.mock.calls.filter(([, , options]) => !options!.search)).toEqual([]);
    });

    test('keeps both authored and generic subjects for a mixed title', async () => {
        const getEligiblePhotos = jest.fn(
            async (_id: string | number, _token: string, options: EligibleOptions = {}) => {
                if (options.search === 'history') return [allowed('history', ['History'])];
                if (options.search === 'plane') return [allowed('plane', ['Plane'])];
                return [];
            },
        );
        const result = await fetchCandidatesForChallenge(
            invalid({ id: 'c-mixed', title: 'History vs Flight' }),
            'tok',
            {},
            { getEligiblePhotos, logger: makeLogger().logger },
        );
        expect(result.map((photo) => photo.id)).toEqual(['history', 'plane']);
    });

    test('still falls back — loudly — when a real theme resolves to no tag', async () => {
        const getEligiblePhotos = makeGetEligiblePhotos();
        const { logger, category } = makeLogger();
        const result = await fetchCandidatesForChallenge(
            invalid({ id: 'c-zeppelin', title: 'Zeppelins' }),
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
        expect(category.warning).toHaveBeenCalledWith(expect.stringContaining('nothing found by tag search'), null);
    });

    test('logs how the theme was read, with the description it was read from', async () => {
        const { logger, category } = makeLogger();
        await fetchCandidatesForChallenge(
            invalid({
                id: 'c-roads',
                title: 'Roads to Anywhere',
                welcome_message: '<b>Show photos</b> of the different kinds of   roads.',
            }),
            'tok',
            {},
            { getEligiblePhotos: makeGetEligiblePhotos(), logger },
        );
        expect(category.info).toHaveBeenCalledWith(
            expect.stringContaining(
                'has the subject "road" (its description repeats it). Description: "Show photos of the different kinds of roads."',
            ),
            null,
        );
        await fetchCandidatesForChallenge(
            invalid({ id: 'c-bare', title: 'Anywhere' }),
            'tok',
            {},
            {
                getEligiblePhotos: makeGetEligiblePhotos(),
                logger,
            },
        );
        expect(category.info).toHaveBeenCalledWith(
            expect.stringContaining(
                'has no subject its description confirms, so its title is searched head-noun first. Description: ""',
            ),
            null,
        );
    });

    test('a contest-cadence title reads as an open theme and says so', async () => {
        // "week" is a stopword, so "Guru of The Week" yields no search term at
        // all — a different case from a theme that was searched and missed, and
        // it gets its own message rather than claiming a search happened.
        const getEligiblePhotos = makeGetEligiblePhotos();
        const { logger, category } = makeLogger();
        const searchTagAutocomplete = jest.fn(async () => ['staircase']);
        const result = await fetchCandidatesForChallenge(
            invalid({ id: 'c-meta', title: 'Guru of The Week' }),
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
        expect(category.info).toHaveBeenCalledWith(expect.stringContaining('reads as an open theme'), null);
        expect(category.warning).not.toHaveBeenCalled();
        // Nothing to resolve means no lookup is attempted at all.
        expect(searchTagAutocomplete).not.toHaveBeenCalled();
    });

    test('a negated title never searches its subject and explains the full-library fetch', async () => {
        // "No Humans" searching "human" would fetch exactly the forbidden photos.
        const getEligiblePhotos = makeGetEligiblePhotos();
        const { logger, category } = makeLogger();
        const result = await fetchCandidatesForChallenge(
            invalid({ id: 'c-nohumans', title: 'No Humans', url: 'no-humans' }),
            'tok',
            {},
            { getEligiblePhotos, logger },
        );
        expect(result).toEqual(LIBRARY);
        expect(getEligiblePhotos).toHaveBeenCalledTimes(1);
        expect(getEligiblePhotos.mock.calls[0][2]?.search).toBeUndefined();
        expect(category.info).toHaveBeenCalledWith(
            expect.stringContaining('only names what to leave out (human)'),
            null,
        );
        expect(category.warning).not.toHaveBeenCalledWith(expect.stringContaining('no searchable theme'), null);
    });

    test('a failing identity lookup still allows related-tag search', async () => {
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
        expect(result.map((p) => p.id).sort()).toEqual(['stairs_1', 'stairs_2']);
        // No identity means no lookup is even attempted.
        expect(searchTagAutocomplete).not.toHaveBeenCalled();
    });

    test('a failing identity lookup falls back when related tags also miss', async () => {
        jest.spyOn(lexicon, 'relatedSearchTerms').mockReturnValue([]);
        const getCurrentMemberProfile = jest.fn(async () => null);
        const searchTagAutocomplete = jest.fn(async () => ['staircase']);
        const result = await fetchCandidatesForChallenge(
            STAIRS,
            'tok',
            {},
            {
                getEligiblePhotos: makeGetEligiblePhotos(),
                logger: makeLogger().logger,
                getCurrentMemberProfile,
                searchTagAutocomplete,
            },
        );
        expect(result).toEqual(LIBRARY);
        expect(getCurrentMemberProfile).toHaveBeenCalledTimes(1);
        expect(searchTagAutocomplete).not.toHaveBeenCalled();
    });

    test('the identity lookup is made once and reused across challenges', async () => {
        jest.spyOn(lexicon, 'relatedSearchTerms').mockReturnValue([]);
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
