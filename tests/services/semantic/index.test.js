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
jest.mock('../../../src/js/services/semantic/diagnostics', () => ({
    diagnostics: { record: jest.fn() },
    shouldCollect: jest.fn(() => false),
}));

const { getSemanticScores, __resetForTests } = require('../../../src/js/services/semantic');
const { diagnostics, shouldCollect } = require('../../../src/js/services/semantic/diagnostics');
const lexicon = require('../../../src/js/services/semantic/lexicon');
const { SEMANTIC_MATCH_FLOOR, SEMANTIC_SUPPORT_CAP } = require('../../../src/js/services/photoPicker');

const challenge = {
    title: 'Feline Friends',
    url: 'feline-friends',
    welcome_message: 'Show us your best cats',
};

describe('getSemanticScores — lexicon backend, end-to-end', () => {
    beforeEach(() => {
        __resetForTests();
        lexicon.__resetForTests();
        diagnostics.record.mockClear();
        shouldCollect.mockReturnValue(false);
    });

    test('collects only missing word stems without changing semantic scores', async () => {
        shouldCollect.mockReturnValue(true);
        const scores = await getSemanticScores({ title: 'Flowers', url: 'flowers' }, [
            { id: 'one', labels: ['Sunflower', 'Zzqqxx'] },
        ]);
        expect(scores.get('one').score).toBeGreaterThan(SEMANTIC_MATCH_FLOOR / 100);
        expect(diagnostics.record).toHaveBeenCalledWith('flowers', {
            themeWords: [],
            labelWords: ['zzqqxx'],
            noThemeVector: false,
            noLabelVectors: false,
            noOnThemeScore: false,
        });
    });

    test('records an out-of-vocabulary theme before the scorer falls back', async () => {
        shouldCollect.mockReturnValue(true);
        expect(
            await getSemanticScores({ title: 'Zzqqxx', url: 'zzqqxx' }, [{ id: 'one', labels: ['Zzqqxx'] }]),
        ).toBeNull();
        expect(diagnostics.record).toHaveBeenCalledWith('zzqqxx', {
            themeWords: ['zzqqxx'],
            labelWords: ['zzqqxx'],
            noThemeVector: true,
            noLabelVectors: true,
            noOnThemeScore: false,
        });
    });

    test('ranks an on-theme (cat) photo above an off-theme (car) one', async () => {
        const photos = [
            { id: 'cat', labels: ['cat', 'kitten', 'whiskers'] },
            { id: 'car', labels: ['automobile', 'sedan', 'wheel'] },
        ];
        const scores = await getSemanticScores(challenge, photos);
        expect(scores).toBeInstanceOf(Map);
        expect(scores.get('cat').score).toBeGreaterThan(scores.get('car').score);
        expect(scores.get('cat').score).toBeGreaterThan(0.5);
    });

    test('all scores are clamped to 0..1 and support is bounded by the cap', async () => {
        const scores = await getSemanticScores(challenge, [{ id: 'cat', labels: ['cat'] }]);
        for (const v of scores.values()) {
            expect(v.score).toBeGreaterThanOrEqual(0);
            expect(v.score).toBeLessThanOrEqual(1);
            expect(v.support).toBeGreaterThanOrEqual(0);
            expect(v.support).toBeLessThanOrEqual(SEMANTIC_SUPPORT_CAP);
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
        expect(scores.get('seaLife').score).toBeGreaterThan(0);
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
        expect(scores.get('farm').score).toBeGreaterThan(SEMANTIC_MATCH_FLOOR / 100);
        expect(scores.get('sea').score).toBeLessThan(SEMANTIC_MATCH_FLOOR / 100);
    });

    test('compound labels are matched via the lexicon, not the string matcher', async () => {
        // matches() is prefix-based, so it cannot see that "sunflower" is a kind of
        // "flower" (suffix matching was rejected — it would also equate "rain" with
        // "train"). "is a kind of" is the lexicon's job; this pins that it does it.
        const scores = await getSemanticScores({ title: 'Flowers' }, [
            { id: 'sunflower', labels: ['Sunflower'] },
            { id: 'car', labels: ['Sedan'] },
        ]);
        expect(scores.get('sunflower').score).toBeGreaterThan(SEMANTIC_MATCH_FLOOR / 100);
        expect(scores.get('car').score).toBeLessThan(SEMANTIC_MATCH_FLOOR / 100);
    });

    describe("support — the photo's OTHER labels", () => {
        test('two photos peaking on the SAME label are separated by the rest of their labels', async () => {
            // The case the support count exists for, and it is the fill's normal
            // shape: the challenge resolves to one tag, the search returns photos
            // that all carry it, so every candidate peaks on that same label and
            // the max cannot tell them apart. Only the remaining labels can.
            const scores = await getSemanticScores({ title: 'Flowers', url: 'flowers' }, [
                { id: 'onTheme', labels: ['Sunflower', 'Rose', 'Garden'] },
                { id: 'incidental', labels: ['Sunflower', 'Sedan', 'Breakfast'] },
            ]);
            // Identical headline score — the tier above is blind here, by design.
            expect(scores.get('onTheme').score).toBeCloseTo(scores.get('incidental').score, 10);
            expect(scores.get('onTheme').support).toBeGreaterThan(scores.get('incidental').support);
            expect(scores.get('incidental').support).toBe(1);
        });

        test('an off-theme photo gets no support', async () => {
            const scores = await getSemanticScores({ title: 'Flowers', url: 'flowers' }, [
                { id: 'off', labels: ['Sedan', 'Breakfast'] },
            ]);
            expect(scores.get('off').score).toBeLessThan(SEMANTIC_MATCH_FLOOR / 100);
            expect(scores.get('off').support).toBe(0);
        });

        test('an on-theme photo always counts its own peaking label', async () => {
            const scores = await getSemanticScores({ title: 'Flowers' }, [{ id: 'one', labels: ['Sunflower'] }]);
            expect(scores.get('one').score).toBeGreaterThan(SEMANTIC_MATCH_FLOOR / 100);
            expect(scores.get('one').support).toBe(1);
        });

        test('support saturates at the cap rather than rewarding a long label list', async () => {
            // Without the cap this tier would rank "carries many loosely related
            // tags" above "is genuinely about the theme" — the failure that made
            // mean-pooling wrong, wearing a different hat.
            const many = ['Cat', 'Kitten', 'Feline', 'Tabby'];
            const scores = await getSemanticScores({ title: 'Feline Friends' }, [{ id: 'cats', labels: many }]);
            expect(scores.get('cats').support).toBe(SEMANTIC_SUPPORT_CAP);
        });

        test('a label outside the pruned vocabulary contributes no support', async () => {
            // The shipped lexicon is a pruned vocabulary, so a perfectly on-theme
            // vision label can simply be absent from it ("handrail" is). Such a
            // label is skipped, exactly as it is for the max — this tier never
            // invents signal the lexicon does not have, it just goes quiet.
            const scores = await getSemanticScores({ title: 'Flowers' }, [
                { id: 'oov', labels: ['Sunflower', 'Zzqqxx', 'Handrail'] },
            ]);
            expect(scores.get('oov').support).toBe(1);
        });
    });
});
