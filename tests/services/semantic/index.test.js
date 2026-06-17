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
});
