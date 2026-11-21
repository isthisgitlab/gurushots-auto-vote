/**
 * readChallengeTheme — open theme vs a subject the description confirms, read
 * from the title AND the description rather than a list of challenge names.
 * Fixtures are live GuruShots challenges (titles and descriptions as the API
 * returned them on 2026-09-28), trimmed to the sentences that matter.
 */

import type * as photoPickerModule from '../../src/ts/core/services/photoPicker';
const {
    readChallengeTheme,
    buildScoredCandidates,
    buildSearchTerms,
    buildChallengeKeywords,
    buildThemeKeywords,
    visualSubjectWords,
    detectLetterPrefix,
    readChallengeLetter,
    withoutLetterPhrases,
    parseNegation,
    tokenise,
} = require('../../src/ts/core/services/photoPicker') as typeof photoPickerModule;

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

const EYE_CONTACT = {
    title: 'Facing The Camera',
    url: 'facing-the-camera2',
    welcome_message:
        'For this challenge share your best photos where the subject is looking at the camera. I think that the most powerful photos are those where the viewer has direct eye-contact with the subject.',
};

test('camera-facing titles derive portrait subjects', () => {
    expect(readChallengeTheme(EYE_CONTACT)).toEqual({ kind: 'eye-contact', subjects: ['portrait', 'face', 'person'] });
    expect(buildSearchTerms(EYE_CONTACT)).toEqual(['portrait', 'face', 'person']);
    expect(buildChallengeKeywords(EYE_CONTACT)).toEqual(['portrait', 'face', 'person']);
    expect(buildThemeKeywords(EYE_CONTACT)).toEqual(['portrait', 'face', 'person']);
    expect(buildSearchTerms(EYE_CONTACT, { mustIncludeTags: ['cat'], shouldIncludeTags: ['dog'] })).toEqual(['cat']);
    expect(buildSearchTerms(EYE_CONTACT, { shouldIncludeTags: ['dog'] })).toEqual(['dog']);
    expect(readChallengeTheme({ title: 'Looking Directly Into The Camera' }).kind).toBe('eye-contact');
    expect(readChallengeTheme({ title: 'Looking At The Camera' }).kind).toBe('eye-contact');
    expect(readChallengeTheme({ title: 'Looking Into The Camera' }).kind).toBe('eye-contact');
    expect(readChallengeTheme({ title: 'Looking Directly At The Camera' }).kind).toBe('eye-contact');
    expect(readChallengeTheme({ title: 'Vintage Cameras' }).kind).not.toBe('eye-contact');
    expect(buildSearchTerms({ title: 'Vintage Cameras' })).toContain('camera');
});

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

describe('compound titles with the lexicon not loaded', () => {
    // This file runs with the lexicon unloaded, like the readers above: the
    // compound merge consults the lexicon's compound table, so nothing merges
    // here and the phrase-form ignore word finds no merged window either.
    test('words stay split, and a phrase-form ignore word is a no-op', () => {
        expect(buildThemeKeywords({ title: 'Beauty of Still Life' })).toEqual(['beauty', 'still']);
        expect(buildThemeKeywords({ title: 'Beauty of Still Life' }, ['still'])).toEqual(['beauty']);
        expect(buildThemeKeywords({ title: 'Beauty of Still Life' }, ['life'])).toEqual(['beauty', 'still']);
        expect(buildThemeKeywords({ title: 'Beauty of Still Life' }, ['still life'])).toEqual(['beauty', 'still']);
        expect(buildThemeKeywords({ title: 'Close Up' })).toEqual(['close', 'up']);
    });
});

describe('letter challenges — the letter phrase is not the subject', () => {
    test('All About E uses the description rule to filter candidates', () => {
        const challenge = {
            title: 'All About E',
            url: 'all-about-e10',
            welcome_message:
                "Share your best photos of anything that starts with the letter 'E'! Like, Eagle, Ears, Elephant, Engine, Eyes, Etc. Join our challenge and earn rewards! * Participation reward: 10 coins * Elite Level reward: 20 coins * ALLSTAR Level reward: 50 coins Good luck!",
        };
        const photos = [
            { id: 'eagle', labels: ['Eagle'], votes: 1, permission: { allowed: true, message: null } },
            { id: 'cat', labels: ['Cat'], votes: 1000, permission: { allowed: true, message: null } },
        ];
        expect(readChallengeTheme(challenge)).toEqual({ kind: 'unconfirmed', subjects: [] });
        expect(buildScoredCandidates(challenge, photos).map((candidate) => candidate.id)).toEqual(['eagle']);
        expect(buildScoredCandidates(challenge, [photos[1]], { submitWithoutTagMatch: false })).toEqual([]);
        expect(buildScoredCandidates(challenge, [photos[1]], { submitWithoutTagMatch: true }).map((p) => p.id)).toEqual(
            ['cat'],
        );
    });

    test.each([
        ['Starts with letter E', 'e'],
        ['Begins with the letter e', 'e'],
        ['Photos should begin with the letter “E”.', 'e'],
        ["Photos must start with letter 'E'.", 'e'],
        ['Photos. Starting with the letter E!', 'e'],
        ['<p>Starts with the letter E.</p>', 'e'],
        ['The letter E is exciting.', null],
        ['Any photos that start with the letter E', null],
        ['Do not submit any photos that start with the letter E.', null],
        ['Any photos that start with the letter E will be rejected.', null],
        ['Do not submit cats. Share photos that start with the letter E.', 'e'],
        ['Any photos that start with the letter S. Show photos that begin with the letter E.', 'e'],
        ['Share photos that start with the letter E without people.', 'e'],
        ['Share photos that start with the letter E. Avoid portraits.', 'e'],
        ["Don't share photos that start with the letter E.", null],
        ['Show photos that start with the letter E and exclude people.', 'e'],
        ['If you submit any photos that start with the letter E they will be rejected.', null],
        ['Share photos that start with the letter E, are not allowed.', null],
        ['Share photos that start with the letter E must not be submitted.', null],
        ['Submit photos that start with the letter E.', 'e'],
        ['Enter photos that start with the letter E.', 'e'],
        ['Photos must not start with the letter E.', null],
        ['Starts with the letter Eagle.', null],
        ['Starts with the letter E-x.', null],
        ["Starts with the letter 'E'x.", null],
        ['Starts with the letter “E”-x.', null],
    ])('reads description rule %s', (welcome_message, expected) => {
        expect(readChallengeLetter({ title: 'All About E', welcome_message })).toBe(expected);
    });

    test('title wins and descriptions use the existing text limit', () => {
        expect(readChallengeLetter({ title: 'Begins With S', welcome_message: 'Starts with the letter E.' })).toBe('s');
        const rule = 'Starts with the letter E';
        expect(
            readChallengeLetter({ title: 'All About E', welcome_message: `${' '.repeat(4096 - rule.length)}${rule}` }),
        ).toBe('e');
        expect(readChallengeLetter({ title: 'All About E', welcome_message: `${' '.repeat(4096)}${rule}` })).toBeNull();
        expect(readChallengeLetter({ title: 'All About E' })).toBeNull();
    });
    // GuruShots challenge 136581 ("The Letter \"S\""), quoted word for word as
    // the API returned it on 2026-10-22.
    const LETTER_S_DESC =
        'Share your shots that start with S! From snakes to snacks and shampoo to shopping carts, ' +
        "get stylistic and share those stunning shots that start with 'S' (in English). Join our " +
        'challenge and earn rewards! * Participation reward: 10 coins * Elite Level reward: 20 coins ' +
        '* ALLSTAR Level reward: 50 coins Scores of success and splendid shooting!';

    describe('withoutLetterPhrases', () => {
        test('replaces EVERY match with a space, in the middle of prose too', () => {
            expect(withoutLetterPhrases('things that start with the letter S today')).toBe('things that   today');
            expect(withoutLetterPhrases('The Letter "S"')).toBe('The  ');
        });

        test("the replacement stays ' ', so the whitespace LETTER_IS_FOR_RE consumes cannot glue words", () => {
            expect(withoutLetterPhrases('C is for…')).toBe(' …');
        });

        test('a bare "a" article is not a letter phrase: description prose keeps its object', () => {
            expect(withoutLetterPhrases('photos must start with a smile')).toBe('photos must start with a smile');
        });

        test('a non-string is empty', () => {
            expect(withoutLetterPhrases(null)).toBe('');
            expect(withoutLetterPhrases(undefined)).toBe('');
        });

        test('the /g strip carries no lastIndex state into detection (or back)', () => {
            const title = 'The Letter "S"';
            expect(withoutLetterPhrases(title)).toBe('The  ');
            expect(detectLetterPrefix(title)).toBe('s');
            expect(detectLetterPrefix(title)).toBe('s');
            expect(withoutLetterPhrases(title)).toBe('The  ');
        });
    });

    test('a letter title strips to the subject its title still names', () => {
        expect(buildThemeKeywords({ title: 'The Letter "S"' })).toEqual([]);
        expect(buildThemeKeywords({ title: 'A is for Apple' })).toEqual(['apple']);
        expect(buildThemeKeywords({ title: 'Letter G: Green Things' })).toEqual(['green']);
        expect(buildThemeKeywords({ title: 'Begins With L' })).toEqual([]);
        expect(buildThemeKeywords({ title: 'Snakes Starting With S' })).toEqual(['snake']);
        // titleSubject takes the tail "The Letter S" first and the strip then
        // empties it — the series prefix ("Color Hunt") must not become the
        // subject in its place.
        expect(buildThemeKeywords({ title: 'Color Hunt: The Letter S' })).toEqual([]);
    });

    test('the visual subject strips the same way', () => {
        expect(visualSubjectWords({ title: 'The Letter "S"' })).toEqual([]);
        expect(visualSubjectWords({ title: 'A is for Apple' })).toEqual(['apple']);
        expect(visualSubjectWords({ title: 'Begins With L' })).toEqual([]);
    });

    test('a series tail that is only the letter phrase leaves nothing — the accepted trade-off', () => {
        // titleSubject takes the tail "Starting With S", the strip empties it,
        // and the series prefix "Snakes" is not read back in its place: ranking
        // falls to the description and votes. Named as an accepted cost where
        // the strip order is decided (buildThemeKeywords in keywords.ts).
        expect(buildThemeKeywords({ title: 'Snakes: Starting With S' })).toEqual([]);
        expect(visualSubjectWords({ title: 'Snakes: Starting With S' })).toEqual([]);
    });

    test('the real 136581 description keeps its example subjects as keywords, never the rule words', () => {
        // Neither "letter" (the stripped title) nor "start" (the stripped
        // description) may come back; the slug is not consulted either.
        const keywords = buildChallengeKeywords({
            title: 'The Letter "S"',
            url: 'the-letter-s',
            welcome_message: LETTER_S_DESC,
        });
        expect(keywords).toEqual([
            'snake',
            'snack',
            'shampoo',
            'shopp',
            'cart',
            'get',
            'stylistic',
            'stunn',
            'english',
            'score',
            'success',
            'splendid',
            'shoot',
        ]);
    });

    test.each([
        ["Share your shots that start with 'S' this week. Sunsets are welcome too.", ['start'], 'sunset'],
        [
            'Share your shots that start with the letter "S" this week. Sunsets are welcome too.',
            ['start', 'letter'],
            'sunset',
        ],
        ['Share your shots: anything that begins with an S this week. Sunsets are welcome too.', ['begin'], 'sunset'],
    ] as const)(
        'a description that restates the rule (%s) leaves no rule word among the keywords',
        (welcome, banned, kept) => {
            const keywords = buildChallengeKeywords({ title: 'The Letter "S"', welcome_message: welcome });
            expect(keywords).toContain(kept);
            expect(keywords).not.toContain('letter');
            expect(keywords).not.toContain('start');
            expect(keywords).not.toContain('begin');
            for (const word of banned) expect(keywords).not.toContain(word);
        },
    );

    test('a negated letter title: strip and detect agree after parseNegation', () => {
        const title = 'Letter S: No People';
        const negation = parseNegation(title);
        const positive = negation.active ? negation.positiveTitle : title;
        expect(negation.active).toBe(true);
        expect(detectLetterPrefix(title)).toBe('s');
        expect(tokenise(withoutLetterPhrases(positive), { compounds: 'replace' })).toEqual([]);
        expect(buildThemeKeywords({ title })).toEqual([]);
        expect(visualSubjectWords({ title })).toEqual([]);
    });

    test('a letter title past the detection cap is an ordinary title on every reader', () => {
        const longTitle = `The Letter S ${'x'.repeat(196)}`;
        expect(longTitle.length).toBeGreaterThan(200);
        // detect returns null, so no reader strips: 'letter' stays exactly what
        // it was before the letter pass existed (a before/after pin).
        expect(detectLetterPrefix(longTitle)).toBeNull();
        expect(buildThemeKeywords({ title: longTitle })).toContain('letter');
        expect(visualSubjectWords({ title: longTitle })).toContain('letter');
        expect(buildChallengeKeywords({ title: longTitle })).toContain('letter');
    });
});
