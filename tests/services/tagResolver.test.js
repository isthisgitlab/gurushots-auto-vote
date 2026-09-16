/**
 * Tests for services/tagResolver.js.
 *
 * Runs against the REAL shipped lexicon, not a fixture: the whole point of the
 * validation step is that it rejects plausible-looking noise, and that is only
 * a meaningful assertion against the vectors that actually ship.
 */

// tests/setup.js mocks `fs` globally, so the loader's own read comes back
// undefined and the lexicon would silently report itself unavailable — which
// would quietly turn every semantic assertion below into a vacuous pass. Load
// the shipped asset through the REAL fs instead, so these tests exercise the
// vectors that actually ship rather than a fixture that agrees with them.
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

const { resolveTermsToTags, MAX_RESOLVED_TAGS, isLexicalMatch } = require('../../src/js/services/tagResolver');

const makeLogger = () => {
    const category = { info: jest.fn(), warning: jest.fn(), debug: jest.fn(), error: jest.fn(), success: jest.fn() };
    return { logger: { withCategory: () => category, challengeTag: (c) => `[Challenge ${c.id}]` }, category };
};

// An autocomplete stub driven by a term -> tags table, so a test states the
// server's answers directly.
const stubAutocomplete = (table) => jest.fn(async (_token, term) => table[term] || []);

const baseDeps = (searchTagAutocomplete) => ({
    token: 'tok',
    memberId: 'member-hash',
    searchTagAutocomplete,
    ...makeLogger(),
});

describe('tagResolver', () => {
    describe('isLexicalMatch', () => {
        test('accepts a tag that is the term modulo stemming', () => {
            expect(isLexicalMatch('face', 'fac')).toBe(true);
            expect(isLexicalMatch('flowers', 'flower')).toBe(true);
        });
        test('rejects a tag that merely shares an opening', () => {
            // "staircase" vs "stair" is NOT lexical — it is four characters
            // longer. It gets in via the semantic branch instead, which is the
            // distinction the two guards exist to draw.
            expect(isLexicalMatch('staircase', 'stair')).toBe(false);
            expect(isLexicalMatch('factory', 'fac')).toBe(false);
        });
        test('matches inside a multi-word tag', () => {
            expect(isLexicalMatch('flower bouquet', 'bouquet')).toBe(true);
        });
    });

    describe('resolveTermsToTags', () => {
        test('resolves the Stairs case: "stair" -> "staircase" via the semantic branch', async () => {
            const ac = stubAutocomplete({ stair: ['staircase'] });
            const tags = await resolveTermsToTags(['stair'], { title: 'Stairs' }, baseDeps(ac));
            expect(tags).toEqual(['staircase']);
        });

        test('rejects same-prefix noise that is off theme', async () => {
            // The live endpoint answers "fac" with exactly this list. "face" is
            // the challenge's own word; the other two are a different industry.
            const ac = stubAutocomplete({ fac: ['face', 'factory', 'manufacturing'] });
            const tags = await resolveTermsToTags(['fac'], { title: 'Faces In Things' }, baseDeps(ac));
            expect(tags).toEqual(['face']);
        });

        test('backs the term off a character when the full term misses', async () => {
            // "stairs" itself resolves to nothing — autocomplete is a SUBSTRING
            // match and no tag contains "stairs".
            const ac = stubAutocomplete({ stairs: [], stair: ['staircase'] });
            const tags = await resolveTermsToTags(['stairs'], { title: 'Stairs' }, baseDeps(ac));
            expect(tags).toEqual(['staircase']);
            expect(ac).toHaveBeenCalledTimes(2);
        });

        test('stops backing off once the server answers, even if nothing passes validation', async () => {
            // A shorter probe can only be looser, so widening a match we just
            // judged off-theme would spend round-trips to get a worse answer.
            const ac = stubAutocomplete({ zzzz: ['bicycle'], zzz: ['bicycle', 'wheel'] });
            const tags = await resolveTermsToTags(['zzzz'], { title: 'Flowers' }, baseDeps(ac));
            expect(tags).toEqual([]);
            expect(ac).toHaveBeenCalledTimes(1);
        });

        test('never probes below three characters', async () => {
            const ac = stubAutocomplete({});
            await resolveTermsToTags(['abcd'], { title: 'Whatever' }, baseDeps(ac));
            for (const [, probe] of ac.mock.calls) expect(probe.length).toBeGreaterThanOrEqual(3);
        });

        test('caps the number of resolved tags', async () => {
            const ac = stubAutocomplete({ flower: ['flower', 'flowers', 'sunflower', 'flower bouquet'] });
            const tags = await resolveTermsToTags(['flower'], { title: 'Flowers' }, baseDeps(ac));
            expect(tags.length).toBeLessThanOrEqual(MAX_RESOLVED_TAGS);
        });

        test('deduplicates tags surfaced by more than one term', async () => {
            const ac = stubAutocomplete({ flower: ['flower'], bloom: ['flower'] });
            const tags = await resolveTermsToTags(['flower', 'bloom'], { title: 'Flowers' }, baseDeps(ac));
            expect(tags).toEqual(['flower']);
        });

        test('returns [] rather than throwing when the lookup rejects', async () => {
            // A fill must never fail because an optional enhancement did.
            const ac = jest.fn(async () => {
                throw new Error('network down');
            });
            await expect(resolveTermsToTags(['stair'], { title: 'Stairs' }, baseDeps(ac))).resolves.toEqual([]);
        });

        test('returns [] when resolution is not wired up', async () => {
            await expect(resolveTermsToTags(['stair'], { title: 'Stairs' }, {})).resolves.toEqual([]);
            const ac = stubAutocomplete({ stair: ['staircase'] });
            await expect(
                resolveTermsToTags(['stair'], { title: 'Stairs' }, { ...baseDeps(ac), memberId: '' }),
            ).resolves.toEqual([]);
            expect(ac).not.toHaveBeenCalled();
        });

        test('returns [] for no terms', async () => {
            const ac = stubAutocomplete({ stair: ['staircase'] });
            await expect(resolveTermsToTags([], { title: 'Stairs' }, baseDeps(ac))).resolves.toEqual([]);
            expect(ac).not.toHaveBeenCalled();
        });
    });
});
