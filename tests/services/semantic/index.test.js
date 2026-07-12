/**
 * Tests for the semantic scorer orchestrator (getSemanticScores), exercised
 * end-to-end against the real shipped lexicon data. (tests/setup.js mocks
 * fs/path, so the asset loader is mocked to return the real JSON — see
 * lexicon.test.js for the same pattern.)
 *
 * Headline behavior: a "Feline Friends" challenge ranks a cat photo above an
 * unrelated one — which the lexical matcher cannot do.
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

const { getSemanticScores, __resetForTests } = require('../../../src/js/services/semantic');
const lexicon = require('../../../src/js/services/semantic/lexicon');
const { SEMANTIC_MATCH_FLOOR } = require('../../../src/js/services/photoPicker');

const challenge = {
    title: 'Feline Friends',
    url: 'feline-friends',
    welcome_message: 'Show us your best cats',
};

describe('getSemanticScores — lexicon backend, end-to-end', () => {
    beforeEach(() => {
        __resetForTests();
        lexicon.__resetForTests();
    });

    test('ranks an on-theme (cat) photo above an off-theme (car) one', async () => {
        const photos = [
            { id: 'cat', labels: ['cat', 'kitten', 'whiskers'] },
            { id: 'car', labels: ['automobile', 'sedan', 'wheel'] },
        ];
        const scores = await getSemanticScores(challenge, photos);
        expect(scores).toBeInstanceOf(Map);
        expect(scores.get('cat')).toBeGreaterThan(scores.get('car'));
        expect(scores.get('cat')).toBeGreaterThan(0.5);
    });

    test('all scores are clamped to 0..1', async () => {
        const scores = await getSemanticScores(challenge, [{ id: 'cat', labels: ['cat'] }]);
        for (const v of scores.values()) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
    });

    test('returns null when no photo carries labels', async () => {
        expect(await getSemanticScores(challenge, [{ id: 'x' }, { id: 'y', labels: [] }])).toBeNull();
    });

    test('returns null for empty / non-array photo sets', async () => {
        expect(await getSemanticScores(challenge, [])).toBeNull();
        expect(await getSemanticScores(challenge, null)).toBeNull();
    });

    test('skips photos whose labels are all out-of-vocabulary, scores the rest', async () => {
        const photos = [
            { id: 'cat', labels: ['cat'] },
            { id: 'oov', labels: ['zzqqxx'] },
        ];
        const scores = await getSemanticScores(challenge, photos);
        expect(scores.has('cat')).toBe(true);
        expect(scores.has('oov')).toBe(false);
    });

    test('returns null when the challenge has no usable theme text', async () => {
        expect(await getSemanticScores({}, [{ id: 'cat', labels: ['cat'] }])).toBeNull();
    });

    test('multi-word labels reach the lexicon', async () => {
        // The lexicon has no multi-word keys, so a raw label like "Sea Life" was
        // looked up as one token and always missed — every multi-word vision label
        // was invisible to the semantic tier. Labels are now word-stemmed first.
        const scores = await getSemanticScores({ title: 'Underwater' }, [{ id: 'seaLife', labels: ['Sea Life'] }]);
        expect(scores).not.toBeNull();
        expect(scores.get('seaLife')).toBeGreaterThan(0);
    });

    test('the semantic tier carries the theme when the lexical matcher cannot', async () => {
        // The bug in one assertion. No word of "The Farm Life" appears in either
        // photo's labels, so the lexical scorer rates BOTH zero and would fall
        // through to view count. The lexicon is what knows a cow belongs on a farm
        // and a fish does not.
        const challenge = { title: 'The Farm Life', url: 'the-farm-life' };
        const scores = await getSemanticScores(challenge, [
            { id: 'sea', labels: ['Sea Life', 'Underwater', 'Fish'] },
            { id: 'farm', labels: ['Cow', 'Barn', 'Pasture'] },
        ]);
        expect(scores.get('farm')).toBeGreaterThan(SEMANTIC_MATCH_FLOOR / 100);
        expect(scores.get('sea')).toBeLessThan(SEMANTIC_MATCH_FLOOR / 100);
    });

    test('compound labels are matched via the lexicon, not the string matcher', async () => {
        // matches() is prefix-based, so it cannot see that "sunflower" is a kind of
        // "flower" (suffix matching was rejected — it would also equate "rain" with
        // "train"). "is a kind of" is the lexicon's job; this pins that it does it.
        const scores = await getSemanticScores({ title: 'Flowers' }, [
            { id: 'sunflower', labels: ['Sunflower'] },
            { id: 'car', labels: ['Sedan'] },
        ]);
        expect(scores.get('sunflower')).toBeGreaterThan(SEMANTIC_MATCH_FLOOR / 100);
        expect(scores.get('car')).toBeLessThan(SEMANTIC_MATCH_FLOOR / 100);
    });
});
