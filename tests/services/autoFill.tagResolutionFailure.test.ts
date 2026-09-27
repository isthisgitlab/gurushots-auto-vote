/**
 * resolveTagsForTerms must never fail a fill: if tag resolution itself throws,
 * the themed fetch degrades to the pre-resolution fallback (the full library,
 * with its loud "nothing on theme" warning) and says why at debug level.
 */

import type * as tagResolverModule from '../../src/js/services/tagResolver';
import type * as autoFillModule from '../../src/js/services/autoFill';
import type * as submissionsModule from '../../src/js/api/submissions';
import type { Challenge, MemberIdentity } from '../../src/js/types/gurushots';
import type { FillLogger } from '../../src/js/types/autoFill';
import { invalid } from '../helpers/invalid';

jest.mock('../../src/js/services/tagResolver', () => ({
    resolveTermsToTags: jest.fn(),
}));

const { resolveTermsToTags } = jest.mocked(require('../../src/js/services/tagResolver') as typeof tagResolverModule);
const { fetchCandidatesForChallenge, __resetMemberIdCache } =
    require('../../src/js/services/autoFill') as typeof autoFillModule;

const allowed = (id: string, labels: string[]) => ({ id, labels, permission: { allowed: true, message: null } });
const LIBRARY = [allowed('a', ['Yoga']), allowed('b', ['Misc'])];

const makeLogger = () => {
    const lines: Record<string, string[]> = { info: [], warning: [], debug: [], error: [], success: [] };
    const cat = Object.fromEntries(Object.keys(lines).map((level) => [level, (m: string) => lines[level].push(m)]));
    return {
        logger: invalid<FillLogger>({ withCategory: () => cat, challengeTag: (c: Challenge) => `[Challenge ${c.id}]` }),
        lines,
    };
};

// Exact-tag search, like the live endpoint: nothing is tagged "zeppelin".
// getEligiblePhotos' options bag (its third, defaulted parameter).
type EligibleOptions = NonNullable<Parameters<typeof submissionsModule.getEligiblePhotos>[2]>;
const getEligiblePhotos = jest.fn(async (_id: string | number, _tok: string, opts: EligibleOptions = {}) =>
    opts.search ? [] : LIBRARY,
);

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
        invalid({ id: 'c-z', title: 'Zeppelins' }),
        'tok',
        {},
        {
            getEligiblePhotos,
            logger,
            searchTagAutocomplete: jest.fn(async () => []),
            getCurrentMemberProfile: jest.fn(
                async (): Promise<MemberIdentity> => ({ id: 'member-hash', userName: 'member' }),
            ),
        },
    );
    expect(resolveTermsToTags).toHaveBeenCalled();
    expect(result).toEqual(LIBRARY);
    expect(lines.debug).toContain(`autoFill: tag resolution unavailable: ${text}`);
    expect(lines.warning.some((m) => m.includes('nothing found by tag search'))).toBe(true);
});
