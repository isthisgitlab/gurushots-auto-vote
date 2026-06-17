/**
 * Tests for the static word-vector lexicon backend.
 *
 * tests/setup.js mocks `fs`/`path` globally, so the cross-platform asset loader
 * (assets.js) can't read the real file here. We mock that loader to hand back
 * the real shipped lexicon JSON (read via requireActual) and exercise the
 * lexicon math against actual data. The platform loader itself is integration
 * code, exercised in real runs.
 *
 * The property under test is what makes the feature worthwhile: exact synonyms
 * embed to identical vectors, bridging gaps the substring matcher scores at 0.
 */

const realFs = jest.requireActual('fs');
const realPath = jest.requireActual('path');
const mockLexicon = JSON.parse(
    realFs.readFileSync(realPath.join(__dirname, '..', '..', '..', 'src', 'assets', 'semantic-vectors.json'), 'utf8'),
);

jest.mock('../../../src/js/services/semantic/assets', () => ({
    loadLexiconAsset: async () => mockLexicon,
    ASSET_NAME: 'semantic-vectors.json',
    __resetForTests: () => {},
}));

const lexicon = require('../../../src/js/services/semantic/lexicon');

const sim = (a, b) => lexicon.cosine(lexicon.embed(a), lexicon.embed(b));

describe('semantic lexicon backend', () => {
    beforeEach(() => lexicon.__resetForTests());

    test('loads the lexicon asset', async () => {
        expect(await lexicon.isAvailable()).toBe(true);
    });

    test('synonyms across the substring-matcher blind spots embed near-identically', async () => {
        await lexicon.init();
        // Each pair is a real gap: no shared substring, so photoPicker.matches()
        // scores 0 — but they mean the same thing, so cosine here is ~1.
        expect(sim(['feline'], ['cat'])).toBeGreaterThan(0.99);
        expect(sim(['canine'], ['dog'])).toBeGreaterThan(0.99);
        expect(sim(['automobile'], ['car'])).toBeGreaterThan(0.99);
        expect(sim(['avian'], ['bird'])).toBeGreaterThan(0.99);
        expect(sim(['blossom'], ['flower'])).toBeGreaterThan(0.99);
        expect(sim(['monochrome'], ['grayscale'])).toBeGreaterThan(0.99);
    });

    test('plural / inflected forms stem to the same point', async () => {
        await lexicon.init();
        expect(sim(['cats'], ['feline'])).toBeGreaterThan(0.99);
        expect(sim(['puppies'], ['dog'])).toBeGreaterThan(0.99);
    });

    test('synonyms score far higher than unrelated concepts', async () => {
        await lexicon.init();
        const synonym = sim(['cat'], ['feline']);
        const unrelated = sim(['cat'], ['skyscraper']);
        expect(unrelated).toBeLessThan(synonym);
        expect(synonym - unrelated).toBeGreaterThan(0.5);
        expect(unrelated).toBeLessThan(0.7);
    });

    test('embed is deterministic', async () => {
        await lexicon.init();
        expect(Array.from(lexicon.embed(['cat', 'kitten']))).toEqual(Array.from(lexicon.embed(['cat', 'kitten'])));
    });

    test('out-of-vocabulary tokens and empty input degrade to null without throwing', async () => {
        await lexicon.init();
        expect(lexicon.embed(['zzqqxx', 'wibblewobble'])).toBeNull();
        expect(lexicon.embed([])).toBeNull();
        expect(lexicon.embed('not-an-array')).toBeNull();
    });

    test('cosine is safe with a null operand', () => {
        expect(lexicon.cosine(null, null)).toBe(0);
        expect(lexicon.cosine(null, new Float64Array(4))).toBe(0);
    });
});
