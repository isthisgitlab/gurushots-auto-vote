/**
 * The title-subject pass (abstractTitleWords) and the three title readers it
 * feeds — search terms, pooled theme keywords, lexical keywords — against the
 * REAL shipped lexicon, so "Balloon Fun" is judged by the axis that ships, not
 * by a stub. tests/setup.js mocks fs globally, so the asset loader is mocked to
 * hand back the committed JSON read through requireActual (as lexicon.test.js).
 */

const realFs = jest.requireActual('fs');
const realPath = jest.requireActual('path');
const mockLexicon = JSON.parse(
    realFs.readFileSync(realPath.join(__dirname, '..', '..', 'src', 'assets', 'semantic-vectors.json'), 'utf8'),
);

jest.mock('../../src/js/services/semantic/assets', () => ({
    loadLexiconAsset: async () => mockLexicon,
    ASSET_NAME: 'semantic-vectors.json',
    __resetForTests: () => {},
}));

const lexicon = require('../../src/js/services/semantic/lexicon');
const {
    abstractTitleWords,
    buildSearchTerms,
    buildThemeKeywords,
    buildChallengeKeywords,
} = require('../../src/js/services/photoPicker');

describe('abstractTitleWords', () => {
    const scores = { balloon: 0.37, fun: -0.16, nature: -0.3, built: 0.11, cold: 0 };
    const demote = (words) => [...abstractTitleWords(words, (w) => scores[w] ?? null)];

    test('demotes the ideas in a title that has an unmistakable thing', () => {
        expect(demote(['balloon', 'fun'])).toEqual(['fun']);
    });

    test('leaves a title alone when no word is clearly a thing', () => {
        // "Built Among Nature": GloVe reads "nature" as abstract, but "built"
        // is not concrete enough to anchor a demotion.
        expect(demote(['built', 'nature'])).toEqual([]);
    });

    test('neither demotes a neutral word nor lets an unknown word vote', () => {
        expect(demote(['balloon', 'cold', 'zzz'])).toEqual([]);
        expect(demote(['zzz', 'yyy'])).toEqual([]);
    });

    test('needs at least two words to compare', () => {
        expect(demote(['fun'])).toEqual([]);
        expect(demote(null)).toEqual([]);
    });
});

describe('title readers with the real lexicon', () => {
    const balloonFun = { title: 'Balloon Fun', url: 'balloon-fun', welcome_message: 'Have fun with balloons!' };

    beforeEach(() => lexicon.__resetForTests());

    test('fall back to word order until the lexicon is loaded', () => {
        expect(buildSearchTerms(balloonFun)).toEqual(['fun', 'balloon']);
        expect(buildThemeKeywords(balloonFun)).toEqual(['balloon', 'fun']);
    });

    describe('once loaded', () => {
        beforeEach(() => lexicon.init());

        test('search the subject before the mood word', () => {
            expect(buildSearchTerms(balloonFun)).toEqual(['balloon', 'fun']);
            // Participles still sink behind nouns, and ideas behind both.
            expect(buildSearchTerms({ title: 'It’s Raining Out' })).toEqual(['rain', 'out']);
        });

        test('pool only the subject into the theme vector', () => {
            expect(buildThemeKeywords(balloonFun)).toEqual(['balloon']);
            // The slug fallback (a title with no usable word) is read the same way.
            expect(buildThemeKeywords({ title: 'Guru of The Week', url: 'balloon-fun' })).toEqual(['balloon']);
        });

        test('drop the mood word from every lexical source, slug and prose included', () => {
            expect(buildChallengeKeywords(balloonFun)).toEqual(['balloon']);
        });

        test('change nothing for a title without a clear thing in it', () => {
            const title = { title: 'Built Among Nature' };
            expect(buildSearchTerms(title)).toEqual(['nature', 'among', 'built']);
            expect(buildThemeKeywords(title)).toEqual(['built', 'among', 'nature']);
        });
    });
});
