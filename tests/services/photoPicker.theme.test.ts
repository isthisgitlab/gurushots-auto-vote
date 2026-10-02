/**
 * readChallengeTheme — open theme vs a subject the description confirms, read
 * from the title AND the description rather than a list of challenge names.
 * Fixtures are live GuruShots challenges (titles and descriptions as the API
 * returned them on 2026-09-28), trimmed to the sentences that matter.
 */

import type * as photoPickerModule from '../../src/ts/services/photoPicker';
const { readChallengeTheme, buildSearchTerms, buildChallengeKeywords, buildThemeKeywords, visualSubjectWords } =
    require('../../src/ts/services/photoPicker') as typeof photoPickerModule;

const TEN_HOURS = {
    title: '10 Hours',
    url: '10-hours105',
    welcome_message:
        '<b>This is a 10-hour challenge, and now with Turbo!</b>We are waiting to see your breathtaking ' +
        'pictures.The challenge is an open theme.Take this time to Wow us!<p><br></p>',
};
const ROADS = {
    title: 'Roads to Anywhere',
    welcome_message: 'Show photos of the different kinds of roads found all around the world.',
};

describe('readChallengeTheme', () => {
    describe('open theme', () => {
        test('the description saying so, whatever the title', () => {
            expect(readChallengeTheme(TEN_HOURS)).toEqual({ kind: 'open', subjects: [] });
            expect(
                readChallengeTheme({ title: 'Lanterns', welcome_message: 'The theme is open this week.' }).kind,
            ).toBe('open');
            expect(readChallengeTheme({ title: 'Open Theme' }).kind).toBe('open');
        });

        test('a title of only format words — its length or a GuruShots feature', () => {
            expect(readChallengeTheme({ title: '10 Hours' }).kind).toBe('open');
            expect(readChallengeTheme({ title: "500 Guru's Picks", url: '500-gurus-picks' }).kind).toBe('open');
            expect(readChallengeTheme({ title: 'Turbo Exhibition' }).kind).toBe('open');
        });

        test('a title of only boilerplate, when the slug names nothing either', () => {
            expect(readChallengeTheme({ title: 'Guru of The Week', url: 'guru-of-the-week3' }).kind).toBe('open');
            expect(readChallengeTheme({ title: 'My Best Shot' }).kind).toBe('open');
            // The user's own ignore words count as boilerplate too.
            expect(readChallengeTheme({ title: 'Stunning' }, ['stunning']).kind).toBe('open');
        });
    });

    describe('confirmed subject', () => {
        test('a title word the description repeats is the subject', () => {
            expect(readChallengeTheme(ROADS)).toEqual({ kind: 'subject', subjects: ['road'] });
            expect(
                readChallengeTheme({
                    title: "Let's Go Fishing",
                    welcome_message: 'Time to show anything related to fish or fishing.',
                }).subjects,
            ).toEqual(['fish']);
        });

        test('counts a repeat whatever the lexicon thinks of the word', () => {
            // "people" and "models" read as abstract (-0.38, -0.19) yet are real
            // subjects; a concreteness gate would have called these open.
            const people = readChallengeTheme({
                title: 'People in Action',
                welcome_message: 'Share your photos of people in action: dancing, running, jumping.',
            });
            expect(people).toEqual({ kind: 'subject', subjects: ['people', 'action'] });
            const models = readChallengeTheme({
                title: 'Models At Work',
                welcome_message: 'Share your best photos of Models, Men or Women.',
            });
            expect(models).toEqual({ kind: 'subject', subjects: ['model'] });
        });

        test('reads the series subject, not the series name', () => {
            const theme = readChallengeTheme({
                title: 'Screen Stars - Amazing Landscapes',
                welcome_message:
                    "The theme is 'Amazing Landscapes' —capture the beauty and grandeur of landscapes in your photos.",
            });
            // The quoted "'Amazing Landscapes'" confirms nothing; the later
            // "landscapes in your photos" does.
            expect(theme).toEqual({ kind: 'subject', subjects: ['landscape'] });
        });

        test('ignore words never become the subject', () => {
            const theme = readChallengeTheme(
                {
                    title: 'Breathtaking Windmills',
                    welcome_message: 'We want to see breathtaking photos of classic windmills.',
                },
                ['breathtaking'],
            );
            expect(theme.subjects).toEqual(['windmill']);
        });

        test('"open to interpretation" still names a theme', () => {
            const theme = readChallengeTheme({
                title: 'Doors',
                welcome_message: 'The theme is open to interpretation — show us your doors.',
            });
            expect(theme).toEqual({ kind: 'subject', subjects: ['door'] });
        });
    });

    describe('unconfirmed — no opinion, the title is searched unchanged', () => {
        test('the description quoting the title back confirms nothing', () => {
            const theme = readChallengeTheme({
                title: 'Travel Wonders',
                welcome_message: "Prove it now in the 'Travel Wonders' challenge!",
            });
            expect(theme).toEqual({ kind: 'unconfirmed', subjects: [] });
        });

        test('curly or spaced quotes, and a title with regex characters, are matched literally', () => {
            expect(
                readChallengeTheme({
                    title: 'Captivating Macro',
                    welcome_message: 'Get up-close in this exciting ‘Captivating Macro’ challenge!',
                }).kind,
            ).toBe('unconfirmed');
            expect(
                readChallengeTheme({
                    title: 'Cats (and Dogs?)',
                    welcome_message: 'Enter the " Cats (and Dogs?) " challenge. Cats welcome.',
                }),
            ).toEqual({ kind: 'subject', subjects: ['cat'] });
        });

        test('a subject the description words differently', () => {
            // "reflective" does not stem to "reflection"; staying unconfirmed keeps
            // the search on, where calling it open would switch it off.
            const theme = readChallengeTheme({
                title: 'Using Reflections',
                welcome_message: 'Share photos using reflective surfaces such as marble, tile or water.',
            });
            expect(theme.kind).toBe('unconfirmed');
        });

        test('an all-boilerplate title whose slug still names a subject', () => {
            expect(readChallengeTheme({ title: 'Best of the Best', url: 'macro-insects4' }).kind).toBe('unconfirmed');
        });

        test('missing, letter and negated titles keep their own handling', () => {
            expect(readChallengeTheme(null).kind).toBe('unconfirmed');
            expect(readChallengeTheme({ welcome_message: 'The challenge is an open theme.' }).kind).toBe('unconfirmed');
            expect(readChallengeTheme({ title: '   ' }).kind).toBe('unconfirmed');
            expect(readChallengeTheme({ title: 'Begins With L' }).kind).toBe('unconfirmed');
            expect(readChallengeTheme({ title: 'No Humans', welcome_message: 'An open theme.' }).kind).toBe(
                'unconfirmed',
            );
        });
    });
});

describe('the title readers follow the theme', () => {
    test('an open theme gives no search term, keyword, theme word or visual subject', () => {
        expect(buildSearchTerms(TEN_HOURS)).toEqual([]);
        expect(buildChallengeKeywords(TEN_HOURS)).toEqual([]);
        expect(buildThemeKeywords(TEN_HOURS)).toEqual([]);
        expect(visualSubjectWords(TEN_HOURS)).toEqual([]);
    });

    test("an open theme still searches the user's own tags", () => {
        expect(buildSearchTerms(TEN_HOURS, { mustIncludeTags: ['clock'] })).toEqual(['clock']);
    });

    test('confirmed subject words are searched first', () => {
        // Head-noun-first alone would search "anywhere" before "roads".
        expect(buildSearchTerms({ title: 'Roads to Anywhere' })).toEqual(['anywhere', 'road']);
        expect(buildSearchTerms(ROADS)).toEqual(['road', 'anywhere']);
    });
});
