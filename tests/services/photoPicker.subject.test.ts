/**
 * The title-subject pass (abstractTitleWords) and the three title readers it
 * feeds — search terms, pooled theme keywords, lexical keywords — against the
 * REAL shipped lexicon, so "Balloon Fun" is judged by the axis that ships, not
 * by a stub. tests/setup.ts mocks fs globally, so the asset loader is mocked to
 * hand back the committed JSON read through requireActual (as lexicon.test.ts).
 */

const realFs = jest.requireActual<typeof import('fs')>('fs');
const realPath = jest.requireActual<typeof import('path')>('path');
const mockLexicon = JSON.parse(
    realFs.readFileSync(realPath.join(__dirname, '..', '..', 'src', 'assets', 'semantic-vectors.json'), 'utf8'),
) as RawLexicon;

jest.mock('../../src/ts/services/semantic/assets', () => ({
    loadLexiconAsset: async () => mockLexicon,
    ASSET_NAME: 'semantic-vectors.json',
    __resetForTests: () => {},
}));

import lexicon = require('../../src/ts/services/semantic/lexicon');
import type * as photoPickerModule from '../../src/ts/services/photoPicker';
import type * as semanticModule from '../../src/ts/services/semantic';
import type { PickerPhoto } from '../../src/ts/types/photoPicker';
import type { RawLexicon } from '../../src/ts/types/semantic';
import { invalid } from '../helpers/invalid';
const {
    abstractTitleWords,
    buildSearchTerms,
    buildThemeKeywords,
    buildThemeAlternatives,
    buildChallengeKeywords,
    visualSubjectWords,
    readChallengeTheme,
    pickPhotosForChallenge,
} = require('../../src/ts/services/photoPicker') as typeof photoPickerModule;
// The facade, so the assets mock above covers the lexicon load it triggers.
const { getSemanticScores } = require('../../src/ts/services/semantic') as typeof semanticModule;

const allowed = (id: string, labels: string[], uploadDate: number, extras: Partial<PickerPhoto> = {}) => ({
    id,
    labels,
    upload_date: uploadDate,
    permission: { allowed: true, message: null },
    ...extras,
});

describe('abstractTitleWords', () => {
    const scores: Record<string, number> = { balloon: 0.37, fun: -0.16, nature: -0.3, built: 0.11, cold: 0 };
    const demote = (words: string[]) => [...abstractTitleWords(words, (w) => scores[w] ?? null)];

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
        expect(demote(invalid(null))).toEqual([]);
    });

    test('a fixed phrase anchors the demotion, bounded at 0.05', () => {
        // The stub returns null for "still life" (no lexicon vector), so the
        // phrase is in the word list — the new branch's trigger — but never
        // demotes itself. The PHRASE_QUALIFIER_MAX bound is pinned from both
        // sides, and an unknown word stays as it does everywhere else.
        const withPhrase = (score: number | null) => [
            ...abstractTitleWords(['x', 'still life'], (w) => (w === 'x' ? score : null)),
        ];
        expect(withPhrase(0.05)).toEqual(['x']);
        expect(withPhrase(0.06)).toEqual([]);
        expect(withPhrase(null)).toEqual([]);
    });
});

describe('title readers with the real lexicon', () => {
    const balloonFun = { title: 'Balloon Fun', url: 'balloon-fun', welcome_message: 'Have fun with balloons!' };

    // A real challenge description (136550), word for word: its quoted
    // "Still Life" and "no living ... objects" wording are what the theme
    // reader sees.
    const STILL_LIFE = {
        title: 'Beauty of Still Life',
        url: 'beauty-of-still-life',
        welcome_message:
            'Share your outstanding "Still Life" images, depicting inanimate subject matter. ' +
            'Capture images that are so real, you feel that you could reach out and touch. At the same time, ' +
            'the lighting should be such that it looks like a painting. Try to use objects and items that do ' +
            'not relate to each other. Remember: no living or moving objects, so people and animals will be ' +
            'considered off-topic for this challenge. Join our challenge and earn rewards! * Participation ' +
            'reward: 10 coins * Elite Level reward: 20 coins * ALLSTAR Level reward: 50 coins Good luck!',
    };

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

        test('treats versus titles as alternative subjects', () => {
            expect(buildThemeAlternatives({ title: 'History vs Religion' })).toEqual([['history'], ['religion']]);
            expect(buildThemeAlternatives({ title: 'History Versus Religion' })).toEqual([['history'], ['religion']]);
            expect(buildThemeAlternatives({ title: 'Balloon Fun' })).toEqual([['balloon']]);
            expect(buildThemeAlternatives({ title: 'of vs the' })).toEqual([[]]);
        });

        test('drop the mood word from every lexical source, slug and prose included', () => {
            expect(buildChallengeKeywords(balloonFun)).toEqual(['balloon']);
        });

        test('change nothing for a title without a clear thing in it', () => {
            const title = { title: 'Built Among Nature' };
            expect(buildSearchTerms(title)).toEqual(['nature', 'among', 'built']);
            expect(buildThemeKeywords(title)).toEqual(['built', 'among', 'nature']);
        });

        test('a fixed phrase anchors the title: "beauty" is demoted, a real qualifier is not', () => {
            expect([...abstractTitleWords(['beauty', 'still life'])]).toEqual(['beauty']);
            expect([...abstractTitleWords(['fruit', 'still life'])]).toEqual([]);
        });

        test('real qualifiers survive next to the phrase, including the 0.05–0.15 band', () => {
            expect(buildChallengeKeywords({ title: 'Fruit Still Life' })).toEqual(
                expect.arrayContaining(['fruit', 'still life']),
            );
            expect(buildThemeKeywords({ title: 'Fruit Still Life' })).toEqual(['fruit', 'still life']);
            // "food" (0.116) sits between PHRASE_QUALIFIER_MAX and
            // CONCRETE_SUBJECT_MIN — exactly the band the phrase anchor exists
            // to bridge without dropping real qualifiers.
            expect(buildChallengeKeywords({ title: 'Food Still Life' })).toEqual(
                expect.arrayContaining(['food', 'still life']),
            );
            expect(buildThemeKeywords({ title: 'Food Still Life' })).toEqual(['food', 'still life']);
        });

        test('the 136550 fixture reads "still life" as its one subject', () => {
            expect(readChallengeTheme(STILL_LIFE)).toEqual({ kind: 'subject', subjects: ['still life'] });
            expect(buildThemeKeywords(STILL_LIFE)).toEqual(['still life']);
            // Demoted to last, but still searched (the existing design).
            expect(buildSearchTerms(STILL_LIFE)).toEqual(['still life', 'beauty']);
            // The vision prompt keeps every word readable — visualSubjectWords
            // deliberately skips abstractTitleWords.
            expect(visualSubjectWords(STILL_LIFE)).toEqual(['beauty', 'still life']);
        });

        test('the fixture keywords lose "beauty" and the bare "still"', () => {
            const keywords = buildChallengeKeywords(STILL_LIFE);
            expect(keywords).toContain('still life');
            expect(keywords).not.toContain('beauty');
            expect(keywords).not.toContain('still');
        });

        test('the still-life photo ranks first, and a "still life" must-tag keeps only it', async () => {
            const photos = [
                allowed('fish', ['Fish', 'Still water', 'Underwater'], 5000, { votes: 500 }),
                allowed('portrait', ['Beauty', 'Woman', 'Fashion'], 3000, { votes: 300 }),
                allowed('still-life', ['Still life', 'Fruit', 'Vase'], 1000, { votes: 5 }),
            ];
            // First, unconditionally: the semantic tier is OFF for this
            // challenge under the real lexicon — the theme pools to "still
            // life", which has no vector — so the ranking runs without it.
            await expect(getSemanticScores(STILL_LIFE, photos)).resolves.toBeNull();
            expect(pickPhotosForChallenge(STILL_LIFE, photos, 1, { semanticScores: null })).toEqual(['still-life']);
            expect(pickPhotosForChallenge(STILL_LIFE, photos, 1, { mustIncludeTags: ['still life'] })).toEqual([
                'still-life',
            ]);
        });
    });
});

describe('visualSubjectWords', () => {
    beforeEach(() => lexicon.init());
    afterAll(() => lexicon.__resetForTests());

    test('keeps every subject word readable — the lexicon reads "leaves" as abstract', () => {
        expect(buildThemeKeywords({ title: 'Glorious Green Leaves' })).not.toContain('leav');
        expect(visualSubjectWords({ title: 'Glorious Green Leaves' })).toEqual(['glorious', 'green', 'leaves']);
        expect(visualSubjectWords({ title: 'Glorious Green Leaves' }, ['glorious'])).toEqual(['green', 'leaves']);
    });

    test('drops the series prefix and negated subjects, and is empty for meta titles', () => {
        expect(visualSubjectWords({ title: 'Screen Stars - Tropic Paradise' })).toEqual(['tropic', 'paradise']);
        expect(visualSubjectWords({ title: 'People-Free Streets' })).toEqual(['streets']);
        expect(visualSubjectWords({ title: 'No Humans' })).toEqual([]);
        expect(visualSubjectWords({ title: 'Photo of the Week!' })).toEqual([]);
        expect(visualSubjectWords({ title: 'Street Street' })).toEqual(['street']);
        expect(visualSubjectWords(undefined)).toEqual([]);
    });
});
