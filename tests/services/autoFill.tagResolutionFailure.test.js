/**
 * resolveTagsForTerms must never fail a fill: if tag resolution itself throws,
 * the themed fetch degrades to the pre-resolution fallback (the full library,
 * with its loud "nothing on theme" warning) and says why at debug level.
 */

jest.mock('../../src/js/services/tagResolver', () => ({
    resolveTermsToTags: jest.fn(),
}));

const { resolveTermsToTags } = require('../../src/js/services/tagResolver');
const { fetchCandidatesForChallenge, __resetMemberIdCache } = require('../../src/js/services/autoFill');

const allowed = (id, labels) => ({ id, labels, permission: { allowed: true, message: null } });
const LIBRARY = [allowed('a', ['Yoga']), allowed('b', ['Misc'])];

const makeLogger = () => {
    const lines = { info: [], warning: [], debug: [], error: [], success: [] };
    const cat = Object.fromEntries(Object.keys(lines).map((level) => [level, (m) => lines[level].push(m)]));
    return { logger: { withCategory: () => cat, challengeTag: (c) => `[Challenge ${c.id}]` }, lines };
};

// Exact-tag search, like the live endpoint: nothing is tagged "zeppelin".
const getEligiblePhotos = jest.fn(async (_id, _tok, opts = {}) => (opts.search ? [] : LIBRARY));

beforeEach(() => {
    __resetMemberIdCache();
    getEligiblePhotos.mockClear();
});

test.each([
    ['an Error', new Error('lexicon exploded'), 'lexicon exploded'],
    ['a bare value', 'boom', 'boom'],
])('a resolver that throws %s falls back to the full library', async (_label, thrown, text) => {
    resolveTermsToTags.mockRejectedValueOnce(thrown);
    const { logger, lines } = makeLogger();
    const result = await fetchCandidatesForChallenge(
        { id: 'c-z', title: 'Zeppelins' },
        'tok',
        {},
        {
            getEligiblePhotos,
            logger,
            searchTagAutocomplete: jest.fn(async () => []),
            getCurrentMemberProfile: jest.fn(async () => ({ id: 'member-hash' })),
        },
    );
    expect(resolveTermsToTags).toHaveBeenCalled();
    expect(result).toEqual(LIBRARY);
    expect(lines.debug).toContain(`autoFill: tag resolution unavailable: ${text}`);
    expect(lines.warning.some((m) => m.includes('nothing on theme'))).toBe(true);
});
