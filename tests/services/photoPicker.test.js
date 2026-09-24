/**
 * Tests for photoPicker.js
 */

const {
    pickPhotosForChallenge,
    buildScoredCandidates,
    selectEnrichmentSet,
    finalizePick,
    buildSearchTerms,
    detectLetterPrefix,
    parseNegation,
    tokenise,
    stem,
    matches,
    buildChallengeKeywords,
    buildThemeKeywords,
    labelStemGroups,
    scorePhoto,
    tokeniseTagList,
    labelWordStems,
    wholeLabelStems,
    SEMANTIC_MATCH_FLOOR,
    SEMANTIC_SUPPORT_CAP,
} = require('../../src/js/services/photoPicker');

const allowed = (id, labels, uploadDate = 1000, extras = {}) => ({
    id,
    labels,
    upload_date: uploadDate,
    permission: { allowed: true, message: null },
    ...extras,
});

const blocked = (id, labels) => ({
    id,
    labels,
    upload_date: 9999,
    permission: { allowed: false, message: 'blocked' },
});

describe('photoPicker', () => {
    describe('tokenise', () => {
        test('lowercases, splits, drops stopwords and pure-digit tokens', () => {
            expect(tokenise('Pink-In-Nature23')).toEqual(['pink', 'nature']);
        });
        test('handles HTML and punctuation', () => {
            expect(tokenise('<b>Bold the color Pink in Nature</b>!')).toEqual(['bold', 'color', 'pink', 'nature']);
        });
        test('drops title-imperative verbs (let / see / show / share)', () => {
            // "Let's See Hats" and "Show Us Your Pets" are pure GuruShots
            // boilerplate framing — only the subject noun should survive.
            expect(tokenise("Let's See Hats")).toEqual(['hat']);
            expect(tokenise('Show us your Pets')).toEqual(['pet']);
            expect(tokenise('Share your best Sunsets')).toEqual(['sunset']);
        });
        test('returns [] for empty/null', () => {
            expect(tokenise('')).toEqual([]);
            expect(tokenise(null)).toEqual([]);
            expect(tokenise(undefined)).toEqual([]);
        });
        test('strips photography-noise stopwords (shots, photo, gurushots)', () => {
            // "Action Shots" — the slug "action-shots" should leave just [action]
            expect(tokenise('action-shots-2024')).toEqual(['action']);
        });
        test('strips reward / level boilerplate from welcome messages', () => {
            // None of these should survive: rewards, coins, elite, allstar, level
            expect(tokenise('Earn rewards: 10 coins, Elite Level reward')).toEqual([]);
        });
        test('stems plurals, gerunds, and past tense', () => {
            // 'athletes' → 'athlete', 'runners' → 'runner', 'jumping' → 'jump'
            expect(tokenise('athletes runners jumping caught')).toEqual(['athlete', 'runner', 'jump', 'caught']);
        });
    });

    describe('stem', () => {
        test('drops trailing -s for plurals (but not -ss)', () => {
            expect(stem('flowers')).toBe('flower');
            expect(stem('miss')).toBe('miss');
            expect(stem('cats')).toBe('cat');
        });
        test('-es plurals', () => {
            // '-es' is only a suffix after a sibilant. Elsewhere the base ends
            // in '-e' and only the '-s' is inflection, so stripping two ate a
            // real letter ('athletes' → 'athlet', 'faces' → 'fac').
            expect(stem('athletes')).toBe('athlete');
            expect(stem('faces')).toBe('face');
            expect(stem('trees')).toBe('tree');
            expect(stem('houses')).toBe('house');
            expect(stem('horses')).toBe('horse');
            // The stems that actually drove auto-fill off theme: a "Lighthouses"
            // challenge searched the exact tag 'lighthous' (no such tag) and
            // missed the lexicon, which carries 'lighthouse' and not 'lighthous'.
            expect(stem('lighthouses')).toBe('lighthouse');
        });
        test('-o + es plurals keep a trailing e, and stay recoverable', () => {
            // "heroes" is hero + es, so the ideal stem is "hero"; this stemmer
            // yields "heroe". Adding 'o' to SIBILANT_ES_RE would fix it and
            // BREAK "shoes" -> "sho" ("Shoe" is a real vision label, "hero" is
            // not), so the residue is accepted rather than traded.
            expect(stem('heroes')).toBe('heroe');
            expect(stem('potatoes')).toBe('potatoe');
            expect(stem('shoes')).toBe('shoe');
            // It stays recoverable on every path that matters: the label still
            // matches via the bounded-prefix branch, and tagResolver's backoff
            // shortens the search term by one character. (The lexicon key is
            // covered by the trailing-e retry in semantic/lexicon.js.)
            expect(matches(stem('hero'), stem('heroes'))).toBe(true);
            expect(matches(stem('potato'), stem('potatoes'))).toBe(true);
        });

        test('-es plurals keep both letters after a sibilant base', () => {
            expect(stem('boxes')).toBe('box');
            expect(stem('dishes')).toBe('dish');
            expect(stem('churches')).toBe('church');
            // 'ss' is the disambiguator: a single trailing 's' is ambiguous
            // ('glass'+es vs 'hous'+e+s) and only the doubled form is reliable.
            expect(stem('glasses')).toBe('glass');
        });
        test('-ies → -y', () => {
            expect(stem('categories')).toBe('category');
        });
        test('-ed past tense', () => {
            expect(stem('jumped')).toBe('jump');
        });
        test('-ing gerunds', () => {
            expect(stem('jumping')).toBe('jump');
            expect(stem('running')).toBe('runn'); // bidirectional substring picks up "run"
        });
        test('short words pass through unchanged', () => {
            expect(stem('run')).toBe('run');
            expect(stem('cat')).toBe('cat');
            expect(stem('')).toBe('');
        });
    });

    describe('labelStemGroups', () => {
        test('keeps each label separate and collapses duplicates', () => {
            expect(labelStemGroups({ labels: ['Sea Life', 'Staircase', 'Staircase'] })).toEqual([
                ['sea', 'life'],
                ['staircase'],
            ]);
        });
        test('is empty for a photo with no labels', () => {
            expect(labelStemGroups({ labels: [] })).toEqual([]);
            expect(labelStemGroups({})).toEqual([]);
        });
    });

    describe('series titles and ignore words', () => {
        test('a series prefix is dropped - the subject is what follows the colon', () => {
            expect(buildThemeKeywords({ title: 'Color Hunt: Green' })).toEqual(['green']);
            expect(buildThemeKeywords({ title: 'Screen Stars: Mountains' })).toEqual(['mountain']);
        });

        test('the theme trusts the title over a recycled slug', () => {
            // The live "Color Hunt: Green" ships url="color-hunt-blue1" - the
            // slug is reused from the previous run in the series and names the
            // WRONG colour. Pooling url+title put "blue" in a green theme.
            expect(buildThemeKeywords({ title: 'Color Hunt: Green', url: 'color-hunt-blue1' })).toEqual(['green']);
        });

        test('the slug is still used when the title says nothing', () => {
            expect(buildThemeKeywords({ title: 'Best of the Best', url: 'macro-insects4' })).toEqual([
                'macro',
                'insect',
            ]);
        });

        test('a tail with no usable word falls back to the whole title', () => {
            expect(buildThemeKeywords({ title: 'Mountains: !!!' })).toEqual(['mountain']);
        });

        test('a SPACE-DELIMITED hyphen separates the series from the subject', () => {
            // The live series ships this form - "Screen Stars - Tropic Paradise",
            // plain ASCII hyphen (0x2d), not a colon. Treating it as part of the
            // title puts "stars" in the pooled theme vector, and the semantic tier
            // then ranks a Milky Way photo over a genuine tropical one, pre-empting
            // the lexical tier where the tropical photo wins.
            expect(buildThemeKeywords({ title: 'Screen Stars - Tropic Paradise' })).toEqual(['tropic', 'paradise']);
            expect(buildThemeKeywords({ title: 'Color Hunt - Green' })).toEqual(['green']);
        });

        test('the long dashes keep working alongside the spaced hyphen', () => {
            expect(buildThemeKeywords({ title: 'Screen Stars \u2013 Tropic Paradise' })).toEqual([
                'tropic',
                'paradise',
            ]);
            expect(buildThemeKeywords({ title: 'Screen Stars \u2014 Tropic Paradise' })).toEqual([
                'tropic',
                'paradise',
            ]);
        });

        test('a BARE hyphen is still not a separator - compounds survive whole', () => {
            // The spacing is the whole distinction: a compound joins its parts
            // with no spaces, so splitting on a bare "-" would silently discard
            // a real subject.
            expect(buildThemeKeywords({ title: 'Black-and-White Portraits' })).toEqual(['black', 'white', 'portrait']);
            expect(buildThemeKeywords({ title: 'Close-Up Macro' })).toEqual(['close', 'up', 'macro']);
        });

        test('a spaced-hyphen tail with no usable word falls back to the whole title', () => {
            expect(buildThemeKeywords({ title: 'Mountains - !!!' })).toEqual(['mountain']);
        });

        test('the search terms drop the series prefix on a spaced-hyphen title', () => {
            // Not cosmetic: SEARCH_TERMS_CAP is 3, so the un-split title yielded
            // [paradise, tropic, star] and spent a server round-trip actively
            // fetching starry photos into the candidate pool.
            expect(buildSearchTerms({ title: 'Screen Stars - Tropic Paradise' })).toEqual(['paradise', 'tropic']);
        });

        test('the lexical tier keeps the whole title, series prefix included', () => {
            // It matches each keyword independently, so an extra word is weak
            // evidence rather than vector noise - and it is the safety net for a
            // title whose subject sits BEFORE the separator.
            expect(buildChallengeKeywords({ title: 'Mountains: A Tribute' })).toEqual(['mountain', 'tribute']);
        });

        test('ignore words are matched on the raw word, before stemming', () => {
            // A user types "captivating"; the stemmer turns it into "captivat",
            // so filtering after stemming would silently never match.
            expect(buildThemeKeywords({ title: 'Captivating Macro' }, ['captivating'])).toEqual(['macro']);
            expect(buildThemeKeywords({ title: 'Epic Lighthouses' }, ['epic'])).toEqual(['lighthouse']);
        });

        test('ignore words are case- and whitespace-insensitive', () => {
            expect(buildThemeKeywords({ title: 'Epic Lighthouses' }, ['  EPIC  '])).toEqual(['lighthouse']);
        });

        test('an empty or missing ignore list changes nothing', () => {
            expect(buildThemeKeywords({ title: 'Epic Lighthouses' }, [])).toEqual(['epic', 'lighthouse']);
            expect(buildThemeKeywords({ title: 'Epic Lighthouses' }, null)).toEqual(['epic', 'lighthouse']);
        });
    });

    describe('search-term ordering', () => {
        test('reads nouns right-to-left so the subject survives the cap', () => {
            // Read left-to-right, "Color Hunt: Blue & Orange" would yield
            // [color, hunt, blue] and drop "orange" entirely.
            expect(buildSearchTerms({ title: 'Color Hunt: Blue & Orange' }, {})).toEqual(['orange', 'blue']);
            expect(buildSearchTerms({ title: 'Epic Lighthouses' }, {})).toEqual(['lighthouse', 'epic']);
        });

        test('participles sink behind the nouns', () => {
            // The subject LEADS in "Noun Verbing" titles, so a blanket reverse
            // would bury it.
            expect(buildSearchTerms({ title: 'Cats and Dogs Running Jumping Playing' }, {})).toEqual([
                'dog',
                'cat',
                'runn',
            ]);
            expect(buildSearchTerms({ title: 'Leading with Lines' }, {})).toEqual(['line', 'lead']);
        });

        test('short -ing words are subjects, not participles', () => {
            expect(buildSearchTerms({ title: 'Kings and Rings' }, {})).toEqual(['ring', 'king']);
        });

        test('honours the ignore list', () => {
            expect(buildSearchTerms({ title: 'Dramatic Storms' }, { ignoreWords: ['dramatic'] })).toEqual(['storm']);
        });

        test('user tags still take precedence over the title', () => {
            expect(buildSearchTerms({ title: 'Epic Lighthouses' }, { mustIncludeTags: ['sunset'] })).toEqual([
                'sunset',
            ]);
        });
    });

    describe('buildThemeKeywords', () => {
        test('uses url + title and IGNORES welcome_message', () => {
            // The live "Stairs" challenge body reads "Stairs are both practical
            // and ornamental... made of wood or stone... with people on them".
            // Mean-pooled into the theme vector those thirteen words drag it off
            // its own subject: measured against the shipped lexicon the
            // similarity to the tag "staircase" falls from 0.94 to 0.25.
            const challenge = {
                url: 'stairs38',
                title: 'Stairs',
                welcome_message:
                    'Stairs are both practical and ornamental, made of wood or stone, with people on them.',
            };
            expect(buildThemeKeywords(challenge)).toEqual(['stair']);
            // The lexical tier still sees the body — there each keyword matches
            // independently, so extra words cannot drag a vector around.
            expect(buildChallengeKeywords(challenge)).toEqual(expect.arrayContaining(['stair', 'wood', 'stone']));
        });

        test('returns [] for a contest-cadence title rather than falling back to the body', () => {
            // An empty result is informative: it means every word was
            // boilerplate, which is what a meta-challenge looks like. The
            // semantic tier then goes inert instead of scoring photos against
            // marketing copy.
            expect(
                buildThemeKeywords({
                    title: 'Guru of The Week',
                    welcome_message: 'Win coins and badges for your best flower photos!',
                }),
            ).toEqual([]);
            expect(buildThemeKeywords({ title: 'Photographer of the Month' })).toEqual([]);
        });
    });

    describe('buildChallengeKeywords', () => {
        test('combines url and title tokens, dedup', () => {
            const keys = buildChallengeKeywords({ url: 'pink-in-nature23', title: 'Pink Showcase' });
            expect(keys).toEqual(expect.arrayContaining(['pink', 'nature', 'showcase']));
            // 'pink' appears in both — should be deduplicated
            expect(keys.filter((k) => k === 'pink').length).toBe(1);
        });
        test('empty when neither url nor title nor welcome_message present', () => {
            expect(buildChallengeKeywords({})).toEqual([]);
        });
        test('includes welcome_message tokens', () => {
            // Guards the "Action Shots picked my last upload" failure mode —
            // the URL slug only gives [action] (shots filtered),
            // but welcome_message gives concrete vocabulary.
            const keys = buildChallengeKeywords({
                url: 'action-shots-2024',
                title: 'Action Shots',
                welcome_message: 'Capture athletes mid-jump and runners in motion!',
            });
            // After stemming: athletes→athlete, runners→runner
            // Stopwords filter: capture, in
            expect(keys).toEqual(expect.arrayContaining(['action', 'athlete', 'jump', 'runner', 'motion']));
            expect(keys).not.toContain('shots');
            expect(keys).not.toContain('capture');
        });
        test('strips HTML from welcome_message', () => {
            const keys = buildChallengeKeywords({
                welcome_message: '<b>Golden</b> your <i>sunsets</i><br/>',
            });
            expect(keys).toEqual(expect.arrayContaining(['golden', 'sunset']));
        });
        test('drops title-imperative verbs from the keyword scorer (only the subject survives)', () => {
            // The new stopwords feed both buildSearchTerms and this client-side
            // scorer — verify the scorer keeps only the subject noun so "Show Us
            // Your Pets" scores on 'pet', not on the boilerplate framing.
            const keys = buildChallengeKeywords({ title: 'Show Us Your Pets', welcome_message: "Let's see them!" });
            expect(keys).toEqual(['pet']);
        });
    });

    describe('buildSearchTerms', () => {
        test('Must Include Tags take precedence over Should and title', () => {
            const terms = buildSearchTerms(
                { title: 'Pink In Nature' },
                { mustIncludeTags: ['hat'], shouldIncludeTags: ['dog'] },
            );
            expect(terms).toEqual(['hat']);
        });
        test('falls back to Should Include Tags when Must is empty', () => {
            const terms = buildSearchTerms(
                { title: 'Pink In Nature' },
                { mustIncludeTags: [], shouldIncludeTags: ['dog'] },
            );
            expect(terms).toEqual(['dog']);
        });
        test('falls back to the title (imperative verbs dropped) when no tags', () => {
            expect(buildSearchTerms({ title: "Let's See Hats" }, {})).toEqual(['hat']);
        });
        test('lower-cases, trims and dedupes tags', () => {
            expect(buildSearchTerms(null, { mustIncludeTags: [' Hat ', 'hat', 'HAT'] })).toEqual(['hat']);
        });
        test('drops tags shorter than the min stem length, then falls through', () => {
            // 'hi' (2 chars) is dropped → Must is effectively empty → title used.
            expect(buildSearchTerms({ title: 'Mood' }, { mustIncludeTags: ['hi'] })).toEqual(['mood']);
        });
        test('caps the number of search terms', () => {
            const terms = buildSearchTerms({ title: 'Cats and Dogs Running Jumping Playing' }, {});
            expect(terms).toHaveLength(3);
            expect(terms).toEqual(expect.arrayContaining(['cat', 'dog']));
        });
        test('returns [] when nothing is derivable (abstract title, no tags)', () => {
            expect(buildSearchTerms({}, {})).toEqual([]);
            expect(buildSearchTerms(null, null)).toEqual([]);
        });
        test('letter challenge with no tags returns [] (skips the bogus "begin" search)', () => {
            // "Begins With L" would otherwise tokenise to ['begin']; the letter-
            // challenge guard returns [] so the caller fetches the full library
            // and the client-side letter filter narrows it.
            expect(buildSearchTerms({ title: 'Begins With L' }, {})).toEqual([]);
        });
        test('letter challenge still honors Should Include Tags (guard does not fire)', () => {
            expect(buildSearchTerms({ title: 'Begins With L' }, { shouldIncludeTags: ['nature'] })).toEqual(['nature']);
        });
        test('letter challenge still honors Must Include Tags', () => {
            expect(buildSearchTerms({ title: 'Begins With L' }, { mustIncludeTags: ['pink'] })).toEqual(['pink']);
        });
        test('"X is for" letter challenge with no tags returns [] too', () => {
            // "C is for…" tokenises to nothing useful anyway ("c" is under the
            // length floor, "is"/"for" are stopwords) — the guard makes the
            // intent explicit and keeps the caller on the full-library path.
            expect(buildSearchTerms({ title: 'C is for…' }, {})).toEqual([]);
        });
        test('"The Letter X" returns [] instead of searching for the noun "letter"', () => {
            // Tokenising to ['letter'] would narrow the library to
            // mail/notes/signage — the correspondence sense — instead of leaving
            // the full library for the client-side letter filter.
            expect(buildSearchTerms({ title: "The Letter 'G'" }, {})).toEqual([]);
            expect(buildSearchTerms({ title: 'The Letter G' }, {})).toEqual([]);
            // A title that merely contains the word still tokenises normally.
            expect(buildSearchTerms({ title: 'Love Letter' }, {})).toEqual(['letter', 'love']);
        });
    });

    describe('detectLetterPrefix', () => {
        test('parses the begins/starts-with family', () => {
            expect(detectLetterPrefix('Begins With L')).toBe('l');
            expect(detectLetterPrefix('Starts with the letter A')).toBe('a');
            expect(detectLetterPrefix('Things That Start With B')).toBe('b');
            expect(detectLetterPrefix('Beginning with C')).toBe('c');
            expect(detectLetterPrefix('STARTS WITH d')).toBe('d'); // case-insensitive, lowercased
        });
        test('parses the "X is for" family', () => {
            expect(detectLetterPrefix('C is for…')).toBe('c'); // unicode ellipsis
            expect(detectLetterPrefix('C is for...')).toBe('c'); // ASCII ellipsis
            expect(detectLetterPrefix('A is for Apple')).toBe('a');
            expect(detectLetterPrefix('B Is For')).toBe('b'); // case-insensitive, end-of-string boundary
        });
        test('parses the named "The Letter X" family', () => {
            // The form GuruShots actually ships. Unparsed, the title tokenises to
            // the subject noun "letter" and the fill chases correspondence (mail,
            // notes, signage) instead of G-subjects.
            expect(detectLetterPrefix("The Letter 'G'")).toBe('g');
            expect(detectLetterPrefix('The Letter "G"')).toBe('g');
            expect(detectLetterPrefix('The Letter ‘G’')).toBe('g'); // curly single
            expect(detectLetterPrefix('The Letter “G”')).toBe('g'); // curly double
            expect(detectLetterPrefix('The Letter G')).toBe('g'); // bare, terminal
            expect(detectLetterPrefix('Letter G')).toBe('g');
            expect(detectLetterPrefix('the letter g')).toBe('g'); // case-insensitive
            expect(detectLetterPrefix('Letter: G')).toBe('g');
        });
        test('a named letter terminal in its SEGMENT still parses', () => {
            expect(detectLetterPrefix('Letter G: Green Things')).toBe('g');
            expect(detectLetterPrefix('Letter G - Show your best')).toBe('g');
            expect(detectLetterPrefix('Letter G.')).toBe('g');
            expect(detectLetterPrefix('Letter G!')).toBe('g');
        });
        test('a bare mid-title letter is treated as an article, not a theme', () => {
            // The quoted-or-terminal rule is what keeps the article "a" out. The
            // accepted cost is that "Letter B Challenge" is also left alone: an
            // unquoted letter with a trailing word is not distinguishable from
            // the article case by shape alone.
            expect(detectLetterPrefix('A Letter a Day')).toBeNull();
            expect(detectLetterPrefix('Letter B Challenge')).toBeNull();
        });
        test('the word "letter" without a lone letter after it is not a letter challenge', () => {
            expect(detectLetterPrefix('Love Letter')).toBeNull();
            expect(detectLetterPrefix('The Letter')).toBeNull();
            expect(detectLetterPrefix('Letters From Home')).toBeNull();
            expect(detectLetterPrefix('Letter to Santa')).toBeNull();
        });
        test('a word merely ending in a letter before "is for" is not a letter challenge', () => {
            expect(detectLetterPrefix('What is for dinner')).toBeNull();
            expect(detectLetterPrefix('This is for you')).toBeNull();
            expect(detectLetterPrefix('Music is for everyone')).toBeNull();
            expect(detectLetterPrefix('Q&A is for everyone')).toBeNull(); // punctuation-adjacent letter
            expect(detectLetterPrefix('Art is forever')).toBeNull(); // "for" must be a whole word
        });
        test('a real word after "with" is not a letter challenge', () => {
            expect(detectLetterPrefix('Begins With Love')).toBeNull();
            expect(detectLetterPrefix('Begins With LA')).toBeNull();
            expect(detectLetterPrefix('Begins With L-A')).toBeNull();
        });
        test('out-of-scope title forms return null', () => {
            expect(detectLetterPrefix('L Words')).toBeNull();
            expect(detectLetterPrefix('Sunset')).toBeNull();
        });
        test('non-string and empty input return null', () => {
            expect(detectLetterPrefix('')).toBeNull();
            expect(detectLetterPrefix(null)).toBeNull();
            expect(detectLetterPrefix(undefined)).toBeNull();
            expect(detectLetterPrefix(123)).toBeNull();
        });
        test('a pathologically long title is rejected by the length cap', () => {
            const long = `Begins With L ${'x'.repeat(300)}`;
            expect(detectLetterPrefix(long)).toBeNull();
            // Same cap guards the "is for" family.
            expect(detectLetterPrefix(`${'x '.repeat(150)}C is for…`)).toBeNull();
            // ...and the named family.
            expect(detectLetterPrefix(`The Letter 'G' ${'x'.repeat(300)}`)).toBeNull();
        });
    });

    describe('scorePhoto', () => {
        test('counts label-keyword overlaps (substring both ways)', () => {
            const photo = { labels: ['Pink', 'Flower', 'Petal'] };
            const keys = ['pink', 'nature'];
            expect(scorePhoto(photo, keys)).toBe(1);
        });
        test('substring match catches plurals via stemming', () => {
            const photo = { labels: ['Flowers'] };
            expect(scorePhoto(photo, ['flower'])).toBe(1);
        });
        test('matches Athlete (label) against athletes (keyword stem athlete)', () => {
            const photo = { labels: ['Athlete', 'Sport'] };
            // stem('athletes') = 'athlete', which equals the label's own stem.
            expect(scorePhoto(photo, ['athlete'])).toBe(1);
        });
        test('matches Running (label) against run (keyword)', () => {
            // stem('running') = 'runn'; substring match: 'runn'.includes('run')
            const photo = { labels: ['Running'] };
            expect(scorePhoto(photo, ['run'])).toBe(1);
        });
        test('returns 0 when keywords empty', () => {
            expect(scorePhoto({ labels: ['Anything'] }, [])).toBe(0);
        });
        test('returns 0 when labels missing', () => {
            expect(scorePhoto({}, ['pink'])).toBe(0);
        });
        test('skips empty labels without crashing', () => {
            const photo = { labels: ['', 'Pink', ''] };
            expect(scorePhoto(photo, ['pink'])).toBe(1);
        });
        test('2-char challenge keyword can match a label (keyword path floor is 2, not 3)', () => {
            // tokenise keeps 2-char tokens for the challenge-keyword path,
            // unlike the user-tag path which floors at 3. Confirm a 2-char
            // keyword still matches.
            const photo = { labels: ['Ox', 'Farm'] };
            expect(scorePhoto(photo, ['ox'])).toBe(1);
        });
        test('honors precomputed label stems when provided', () => {
            const photo = { labels: ['Pink'] };
            // Pass stems directly; scorePhoto should use them rather than re-deriving.
            expect(scorePhoto(photo, ['pink'], ['pink'])).toBe(1);
        });
    });

    describe('pickPhotosForChallenge', () => {
        const challenge = { url: 'pink-in-nature23', title: 'Show the color Pink' };

        test('empty input → []', () => {
            expect(pickPhotosForChallenge(challenge, [], 2)).toEqual([]);
            expect(pickPhotosForChallenge(challenge, null, 2)).toEqual([]);
        });

        test('all permission.allowed=false → []', () => {
            const photos = [blocked('a', ['pink']), blocked('b', ['nature'])];
            expect(pickPhotosForChallenge(challenge, photos, 2)).toEqual([]);
        });

        test('slotsToFill <= 0 → []', () => {
            const photos = [allowed('a', ['pink'])];
            expect(pickPhotosForChallenge(challenge, photos, 0)).toEqual([]);
            expect(pickPhotosForChallenge(challenge, photos, -1)).toEqual([]);
        });

        test('ranks by tag-match score desc', () => {
            // challenge.url + title yields keywords [pink, nature, show, color]
            // 'hi' matches two distinct keywords (pink, nature), 'mid' just one (pink),
            // 'low' none — so the order by score is hi > mid > low even though
            // 'low' has the most-recent upload_date.
            const photos = [
                allowed('low', ['Animal'], 5000),
                allowed('hi', ['Pink', 'Nature'], 1000),
                allowed('mid', ['Pink'], 2000),
            ];
            expect(pickPhotosForChallenge(challenge, photos, 3)).toEqual(['hi', 'mid', 'low']);
        });

        test('tiebreaks by upload_date desc when scores equal AND no quality signal differs', () => {
            const photos = [
                allowed('older', ['Misc'], 1000),
                allowed('newer', ['Misc'], 5000),
                allowed('mid', ['Misc'], 3000),
            ];
            expect(pickPhotosForChallenge(challenge, photos, 3)).toEqual(['newer', 'mid', 'older']);
        });

        test('quality fallback: when score is tied at 0, more achievements wins', () => {
            // None of these labels match the "pink-in-nature" challenge.
            // Without quality fallback, "fresh" would win on upload_date.
            // With it, "winner" wins on achievements (3 > 0 > 0).
            const photos = [
                allowed('winner', ['Misc'], 1000, { achievements: ['top_100', 'top_30', 'guru_pick'] }),
                allowed('fresh', ['Misc'], 9000, { achievements: [] }),
                allowed('avg', ['Misc'], 5000),
            ];
            const picked = pickPhotosForChallenge(challenge, photos, 1);
            expect(picked).toEqual(['winner']);
        });

        test('quality fallback: votes break ties when achievements equal', () => {
            // Guards the "picked my last upload" case: a freshly-uploaded
            // photo with 0 votes should NOT outrank a proven photo with
            // hundreds of votes when neither matches the theme.
            const photos = [
                allowed('proven', ['Misc'], 1000, { votes: 500 }),
                allowed('lastUpload', ['Misc'], 9999, { votes: 0 }),
            ];
            const picked = pickPhotosForChallenge(challenge, photos, 1);
            expect(picked).toEqual(['proven']);
        });

        test('quality fallback respects priority: score > votes > achievements > date', () => {
            const photos = [
                // Theme match wins despite no quality signals
                allowed('themeMatch', ['Pink'], 1000, { achievements: [], votes: 0 }),
                // Highest votes — outranks the badge-heavier photo below, because
                // raw popularity is the stronger signal (see the tier list in
                // photoPicker/tiers.js's header).
                allowed('highVotes', ['Misc'], 5000, { achievements: [], votes: 800 }),
                // More achievements, but fewer votes
                allowed('manyWins', ['Misc'], 1000, { achievements: ['a', 'b'], votes: 100 }),
                // Newest, no signals
                allowed('newest', ['Misc'], 9000, { achievements: [], votes: 0 }),
            ];
            expect(pickPhotosForChallenge(challenge, photos, 4)).toEqual([
                'themeMatch',
                'highVotes',
                'manyWins',
                'newest',
            ]);
        });

        test('photo with no upload_date sorts to bottom, not crash', () => {
            const photos = [
                { id: 'noDate', labels: ['Misc'], permission: { allowed: true } },
                allowed('hasDate', ['Misc'], 5000),
            ];
            // hasDate (5000) > noDate (treated as 0)
            expect(pickPhotosForChallenge(challenge, photos, 2)).toEqual(['hasDate', 'noDate']);
        });

        test('Action Shots end-to-end: theme-relevant photos beat newest', () => {
            const actionChallenge = {
                url: 'action-shots-2024',
                title: 'Action Shots',
                welcome_message: 'Capture athletes mid-jump and runners in motion!',
            };
            const photos = [
                // User's last upload — unrelated, no votes
                allowed('lastUpload', ['Indoor', 'Furniture'], 9999, { votes: 0 }),
                // Theme-aligned photo from earlier with some votes
                allowed('actionPhoto', ['Athlete', 'Running'], 1000, { votes: 50 }),
                // Pretty but unrelated, with some votes
                allowed('sunset', ['Sky', 'Nature'], 5000, { votes: 100 }),
            ];
            const picked = pickPhotosForChallenge(actionChallenge, photos, 1);
            // The action-themed photo should win on theme score, not the newest.
            expect(picked).toEqual(['actionPhoto']);
        });

        test('honors slotsToFill cap', () => {
            const photos = [
                allowed('a', ['Pink'], 5000),
                allowed('b', ['Pink'], 4000),
                allowed('c', ['Pink'], 3000),
                allowed('d', ['Pink'], 2000),
            ];
            expect(pickPhotosForChallenge(challenge, photos, 2)).toEqual(['a', 'b']);
        });

        test('returns what is available when slotsToFill > eligible.length', () => {
            const photos = [allowed('a', ['Pink'], 1000)];
            expect(pickPhotosForChallenge(challenge, photos, 5)).toEqual(['a']);
        });

        test('drops blocked photos even if otherwise high-score', () => {
            const photos = [blocked('blocked-perfect', ['Pink', 'Nature']), allowed('weak', ['Misc'], 1000)];
            expect(pickPhotosForChallenge(challenge, photos, 2)).toEqual(['weak']);
        });
    });

    describe('tokeniseTagList', () => {
        test('lowercases, stems, and dedups across a tag array', () => {
            // 'sunsets' stems to 'sunset'; 'Beach' lowercases; duplicate dropped
            expect(tokeniseTagList(['Sunsets', 'beach', 'Beach'])).toEqual(['sunset', 'beach']);
        });
        test('empty / non-array → []', () => {
            expect(tokeniseTagList([])).toEqual([]);
            expect(tokeniseTagList(null)).toEqual([]);
            expect(tokeniseTagList(undefined)).toEqual([]);
        });
        test('multi-word tag is split into per-word stems', () => {
            // A user typing "golden hour" gets ["golden", "hour"] for matching.
            expect(tokeniseTagList(['golden hour'])).toEqual(['golden', 'hour']);
        });
        test('drops stems shorter than 3 chars to avoid spurious substring matches', () => {
            // "pi" would otherwise match labels like "spiral" via substring
            // containment. Tags that stem to <3 chars are filtered out.
            expect(tokeniseTagList(['pi'])).toEqual([]);
            expect(tokeniseTagList(['go'])).toEqual([]);
            // 3-char stems pass through.
            expect(tokeniseTagList(['cat'])).toEqual(['cat']);
        });
        test('filters non-string entries gracefully', () => {
            // Schema validation rejects these upstream, but the picker
            // still defends against bad input reaching it.
            expect(tokeniseTagList([42, 'beach', null, 'cat'])).toEqual(['beach', 'cat']);
        });
        test('whitespace-only entries collapse to []', () => {
            expect(tokeniseTagList(['   ', '\t'])).toEqual([]);
        });
        test('keeps stopwords (a user typing "shot" means it literally)', () => {
            // The challenge-keyword path strips "shot" as photography noise,
            // but an explicit user tag must be honored.
            expect(tokeniseTagList(['shot'])).toEqual(['shot']);
            expect(tokeniseTagList(['winner'])).toEqual(['winner']);
        });
    });

    describe('tokenise keepStopwords option', () => {
        test('default strips photography-noise stopwords', () => {
            expect(tokenise('best shot ever')).toEqual(['ever']);
        });
        test('keepStopwords:true retains them', () => {
            expect(tokenise('best shot ever', { keepStopwords: true })).toEqual(['best', 'shot', 'ever']);
        });
    });

    describe('pickPhotosForChallenge — short tag stems are filtered (no spurious matches)', () => {
        const challenge = { url: 'pink-in-nature23', title: 'Show the color Pink' };

        test('2-char user tag does not substring-match longer labels', () => {
            // Without the min-length filter, mustIncludeTags=['pi'] would
            // pass through to matches() and 'pi'.includes / 'spiral'.includes
            // would not trigger, but 'spi'.includes('pi') would — so the
            // hard filter must NOT keep a photo via a 2-char user stem.
            const photos = [allowed('a', ['Spiral'], 1000), allowed('b', ['Cat'], 5000)];
            // Filter degrades to "no tags" → both photos pass, ranked
            // by date.
            expect(pickPhotosForChallenge(challenge, photos, 5, { mustIncludeTags: ['pi'] })).toEqual(['b', 'a']);
        });
    });

    describe('pickPhotosForChallenge — mustIncludeTags', () => {
        const challenge = { url: 'pink-in-nature23', title: 'Show the color Pink' };

        test('empty list is a no-op (same result as no opts)', () => {
            const photos = [allowed('a', ['Pink'], 1000), allowed('b', ['Misc'], 2000)];
            expect(pickPhotosForChallenge(challenge, photos, 2, { mustIncludeTags: [] })).toEqual(
                pickPhotosForChallenge(challenge, photos, 2),
            );
        });

        test('keeps only photos whose labels match every listed tag', () => {
            // 'hasBoth' carries labels for both required tags; the others miss
            // at least one and are excluded under ALL semantics.
            const photos = [
                allowed('hasBoth', ['Sunset', 'Beach'], 1000),
                allowed('onlySunset', ['Sunset', 'Sky'], 5000),
                allowed('onlyBeach', ['Beach', 'Sand'], 9000),
            ];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                mustIncludeTags: ['sunset', 'beach'],
                fillWithoutTagMatch: false,
            });
            expect(picked).toEqual(['hasBoth']);
        });

        test('stemming applies: "cats" tag matches label "Cat"', () => {
            const photos = [allowed('a', ['Cat'], 1000), allowed('b', ['Dog'], 5000)];
            const picked = pickPhotosForChallenge(challenge, photos, 5, { mustIncludeTags: ['cats'] });
            expect(picked).toEqual(['a']);
        });

        test('no candidates after filter → [] when fillWithoutTagMatch is false', () => {
            const photos = [allowed('a', ['Cat'], 1000), allowed('b', ['Dog'], 5000)];
            expect(
                pickPhotosForChallenge(challenge, photos, 5, {
                    mustIncludeTags: ['mountain'],
                    fillWithoutTagMatch: false,
                }),
            ).toEqual([]);
        });

        test('ALL (not ANY) semantics: photo matching only one of several tags is excluded', () => {
            // 'one' matches a single tag, 'all' matches every tag. Under ALL
            // semantics only 'all' qualifies; fillWithoutTagMatch is off so the
            // partial match is not relaxed back in.
            const photos = [allowed('one', ['Sunset'], 9000), allowed('all', ['Sunset', 'Beach', 'Ocean'], 1000)];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                mustIncludeTags: ['sunset', 'beach', 'ocean'],
                fillWithoutTagMatch: false,
            });
            expect(picked).toEqual(['all']);
        });

        test('strict matches(): a tag that is merely a substring of a label does NOT match', () => {
            // matches() compares whole stems, not substrings: the tag stem 'bud'
            // and the label stem 'buddha' are different things. With
            // fillWithoutTagMatch:false the slot is correctly left empty.
            const photos = [allowed('a', ['Buddha'], 1000)];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                mustIncludeTags: ['bud'],
                fillWithoutTagMatch: false,
            });
            expect(picked).toEqual([]);
        });

        test('duplicate stems collapse: "sunset, sunsets" is a single requirement', () => {
            // tokeniseTagList stems then Set-dedups, so the two tags reduce to
            // one stem. Under ALL semantics a photo carrying just "Sunset"
            // therefore satisfies the whole list — it is not two requirements.
            const photos = [allowed('a', ['Sunset'], 1000)];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                mustIncludeTags: ['sunset', 'sunsets'],
                fillWithoutTagMatch: false,
            });
            expect(picked).toEqual(['a']);
        });
    });

    describe('pickPhotosForChallenge — fillWithoutTagMatch fallback', () => {
        const challenge = { url: 'pink-in-nature23', title: 'Show the color Pink' };

        test('default (undefined): no must-match falls back to unfiltered set', () => {
            const photos = [allowed('a', ['Cat'], 1000), allowed('b', ['Dog'], 5000)];
            // No photo matches 'mountain'; with the default-on fallback, the
            // best unfiltered photo (newest, since neither matches keywords) is
            // returned rather than [].
            const picked = pickPhotosForChallenge(challenge, photos, 5, { mustIncludeTags: ['mountain'] });
            expect(picked).toEqual(['b', 'a']);
        });

        test('explicit true: same fallback behavior', () => {
            const photos = [allowed('a', ['Cat'], 1000)];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                mustIncludeTags: ['mountain'],
                fillWithoutTagMatch: true,
            });
            expect(picked).toEqual(['a']);
        });

        test('false: keeps the slot empty when nothing matches', () => {
            const photos = [allowed('a', ['Cat'], 1000)];
            expect(
                pickPhotosForChallenge(challenge, photos, 5, {
                    mustIncludeTags: ['mountain'],
                    fillWithoutTagMatch: false,
                }),
            ).toEqual([]);
        });

        test('multi-tag: a full match suppresses the fallback; a partial match does not survive', () => {
            // 'full' matches every required tag; 'partial' matches only one and
            // is excluded under ALL semantics. Because 'full' exists, the filter
            // is non-empty and the fallback never relaxes 'partial' back in —
            // even with 2 slots and fillWithoutTagMatch on.
            const photos = [allowed('full', ['Sunset', 'Beach'], 1000), allowed('partial', ['Sunset'], 9000)];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                mustIncludeTags: ['sunset', 'beach'],
                fillWithoutTagMatch: true,
            });
            expect(picked).toEqual(['full']);
        });

        test('multi-tag: when no photo matches every tag, fallback returns the unfiltered best', () => {
            // Each photo matches only a subset of the required tags, so the ALL
            // filter empties out and the default-on fallback returns the
            // unfiltered set (ranked newest-first, neither matches keywords).
            const photos = [allowed('partialA', ['Sunset'], 1000), allowed('partialB', ['Beach'], 9000)];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                mustIncludeTags: ['sunset', 'beach'],
            });
            expect(picked).toEqual(['partialB', 'partialA']);
        });

        test('fallback still applies shouldIncludeTags ranking', () => {
            // Nothing matches the must tag → fallback to all photos, but the
            // should tag still boosts the matching one to the top.
            const photos = [allowed('plain', ['Cat'], 9000), allowed('preferred', ['Beach'], 1000)];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                mustIncludeTags: ['mountain'],
                shouldIncludeTags: ['beach'],
            });
            expect(picked).toEqual(['preferred', 'plain']);
        });
    });

    describe('pickPhotosForChallenge — shouldIncludeTags', () => {
        const challenge = { url: 'pink-in-nature23', title: 'Show the color Pink' };

        test('matching photo wins over higher keyword-score photo', () => {
            // Without should: 'themeMatch' would win by score (matches 'pink').
            // With shouldIncludeTags=['sunset'], 'preferred' takes the top slot
            // because shouldMatchCount outranks keyword score.
            const photos = [allowed('themeMatch', ['Pink', 'Flower'], 1000), allowed('preferred', ['Sunset'], 1000)];
            const picked = pickPhotosForChallenge(challenge, photos, 2, {
                shouldIncludeTags: ['sunset'],
            });
            expect(picked).toEqual(['preferred', 'themeMatch']);
        });

        test('does not exclude non-matching photos (soft, not hard)', () => {
            const photos = [allowed('hasPreferred', ['Sunset'], 1000), allowed('noMatch', ['Misc'], 5000)];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                shouldIncludeTags: ['sunset'],
            });
            expect(picked).toEqual(['hasPreferred', 'noMatch']);
        });

        test('more should-matches outranks fewer', () => {
            const photos = [allowed('twoMatches', ['Sunset', 'Beach'], 1000), allowed('oneMatch', ['Sunset'], 9000)];
            const picked = pickPhotosForChallenge(challenge, photos, 2, {
                shouldIncludeTags: ['sunset', 'beach'],
            });
            expect(picked).toEqual(['twoMatches', 'oneMatch']);
        });
    });

    describe('pickPhotosForChallenge — must + should together', () => {
        const challenge = { url: 'pink-in-nature23', title: 'Show the color Pink' };

        test('must filters first, should orders within survivors', () => {
            const photos = [
                allowed('mustOnly', ['Sunset'], 5000),
                allowed('mustAndShould', ['Sunset', 'Beach'], 1000),
                allowed('shouldOnly', ['Beach'], 9000), // dropped by must
            ];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                mustIncludeTags: ['sunset'],
                shouldIncludeTags: ['beach'],
            });
            expect(picked).toEqual(['mustAndShould', 'mustOnly']);
        });
    });

    describe('pickPhotosForChallenge — letter challenge ("Begins With L")', () => {
        const challenge = { title: 'Begins With L' };

        test('keeps only photos with a label starting with the letter', () => {
            const photos = [
                allowed('landscape', ['Nature', 'Landscape'], 1000),
                allowed('pink', ['Pink', 'Flower'], 5000),
                allowed('urban', ['Architecture'], 9000),
            ];
            // Only 'landscape' carries an L-label; the newer non-L photos are dropped.
            expect(pickPhotosForChallenge(challenge, photos, 5, {})).toEqual(['landscape']);
        });

        test('multiple letter matches fall through to the ranking tiers (votes)', () => {
            const photos = [
                allowed('lowVotes', ['Lion'], 1000, { votes: 10 }),
                allowed('highVotes', ['Leaf'], 1000, { votes: 500 }),
            ];
            // Both match L and score 0 on keywords/achievements; votes breaks the tie.
            expect(pickPhotosForChallenge(challenge, photos, 5, {})).toEqual(['highVotes', 'lowVotes']);
        });

        test('multi-word labels match on the first character of the whole label', () => {
            const photos = [allowed('multi', ['Leisure Activity'], 1000), allowed('cat', ['Cat'], 9000)];
            expect(pickPhotosForChallenge(challenge, photos, 5, {})).toEqual(['multi']);
        });

        test('a multi-word label does NOT match on a later word ("Ocean Life" is not an L)', () => {
            // The discriminating case the test above cannot express: in 'Leisure
            // Activity' both the whole label AND its first word start with 'l', so
            // it passes whether the filter reads whole-label stems or word stems.
            // 'Ocean Life' separates them — its second word starts with 'l', and
            // "begins with L" must read the label as written, not word-by-word.
            // Guards the wholeLabelStems / labelWordStems split in
            // pickPhotosForChallenge, where crossing the wires is silent.
            const photos = [allowed('ocean', ['Ocean Life'], 1000)];
            expect(pickPhotosForChallenge(challenge, photos, 5, { fillWithoutTagMatch: false })).toEqual([]);
        });

        test('short generic labels are excluded by the min-stem-length floor', () => {
            const iChallenge = { title: 'Begins With I' };
            const photos = [allowed('shortIn', ['In'], 9000), allowed('iceberg', ['Iceberg'], 1000)];
            // "In" stems to a 2-char token (< floor of 3) → does not satisfy an I challenge.
            expect(pickPhotosForChallenge(iChallenge, photos, 5, {})).toEqual(['iceberg']);
        });

        test('floor leaves the slot empty when only a too-short label would match (fillWithoutTagMatch:false)', () => {
            const iChallenge = { title: 'Begins With I' };
            const photos = [allowed('shortIn', ['In'], 1000)];
            expect(pickPhotosForChallenge(iChallenge, photos, 5, { fillWithoutTagMatch: false })).toEqual([]);
        });

        test('no letter match + fillWithoutTagMatch:false keeps the slot empty', () => {
            const photos = [allowed('cat', ['Cat'], 1000)];
            expect(pickPhotosForChallenge(challenge, photos, 5, { fillWithoutTagMatch: false })).toEqual([]);
        });

        test('no letter match + default fallback submits the off-theme best performer', () => {
            const photos = [allowed('cat', ['Cat'], 1000), allowed('dog', ['Dog'], 5000)];
            // No L-label exists; the default-on fallback returns the unfiltered best
            // (newest, since neither matches keywords) — intentionally off-theme.
            expect(pickPhotosForChallenge(challenge, photos, 5, {})).toEqual(['dog', 'cat']);
        });

        test('composes with Must Include Tags (AND): only a photo matching both survives', () => {
            const photos = [
                allowed('lighthouse', ['Lighthouse'], 1000), // matches must + letter
                allowed('landscape', ['Landscape'], 9000), // letter only — excluded by must
            ];
            const picked = pickPhotosForChallenge(challenge, photos, 5, { mustIncludeTags: ['lighthouse'] });
            expect(picked).toEqual(['lighthouse']);
        });

        test('combined must + letter with no full match relaxes both filters on fallback', () => {
            const photos = [
                allowed('landscape', ['Landscape'], 9000), // letter only, no must
                allowed('cat', ['Cat'], 1000), // neither
            ];
            // Neither satisfies must('lighthouse') AND letter L → filter empties →
            // default fallback relaxes both and ranks the unfiltered set newest-first.
            const picked = pickPhotosForChallenge(challenge, photos, 5, { mustIncludeTags: ['lighthouse'] });
            expect(picked).toEqual(['landscape', 'cat']);
        });

        test('combined must + letter with no full match and fillWithoutTagMatch:false leaves the slot empty', () => {
            const photos = [
                allowed('landscape', ['Landscape'], 9000), // letter only, no must
                allowed('cat', ['Cat'], 1000), // neither
            ];
            // No photo satisfies must AND letter; with fallback opted out, the slot
            // stays empty rather than relaxing to an off-theme best performer.
            expect(
                pickPhotosForChallenge(challenge, photos, 5, {
                    mustIncludeTags: ['lighthouse'],
                    fillWithoutTagMatch: false,
                }),
            ).toEqual([]);
        });

        test('shouldIncludeTags re-orders within the letter-filtered survivors', () => {
            const photos = [
                allowed('plainL', ['Lion'], 9000), // L, no should match, newer
                allowed('preferredL', ['Lighthouse'], 1000), // L + should 'lighthouse'
            ];
            // Both survive the letter filter; the should-tag match outranks recency.
            const picked = pickPhotosForChallenge(challenge, photos, 5, { shouldIncludeTags: ['lighthouse'] });
            expect(picked).toEqual(['preferredL', 'plainL']);
        });
    });

    describe('pickPhotosForChallenge — letter challenge ("C is for…") and onFallback', () => {
        const challenge = { title: 'C is for…' };

        test('a letter-matching photo beats a higher-voted non-matching one', () => {
            const photos = [
                allowed('cat', ['Cat'], 1000, { votes: 10 }),
                allowed('dog', ['Dog'], 9000, { votes: 500 }),
            ];
            // "dog" is newer and far more popular, but only "cat" starts with C.
            expect(pickPhotosForChallenge(challenge, photos, 5, {})).toEqual(['cat']);
        });

        test('composes with Must Include Tags (AND) under the new phrasing', () => {
            const photos = [
                allowed('castle', ['Castle'], 1000), // matches must + letter
                allowed('cloud', ['Cloud'], 9000), // letter only — excluded by must
            ];
            expect(pickPhotosForChallenge(challenge, photos, 5, { mustIncludeTags: ['castle'] })).toEqual(['castle']);
        });

        test('no letter match + fillWithoutTagMatch:false keeps the slot empty', () => {
            const photos = [allowed('dog', ['Dog'], 1000)];
            expect(pickPhotosForChallenge(challenge, photos, 5, { fillWithoutTagMatch: false })).toEqual([]);
        });

        test('onFallback fires with the letter when relaxation kicks in', () => {
            const photos = [allowed('dog', ['Dog'], 1000)];
            const onFallback = jest.fn();
            expect(pickPhotosForChallenge(challenge, photos, 5, { onFallback })).toEqual(['dog']);
            expect(onFallback).toHaveBeenCalledTimes(1);
            expect(onFallback).toHaveBeenCalledWith(expect.objectContaining({ letterPrefix: 'c' }));
        });

        test('onFallback does NOT fire when a letter match exists', () => {
            const photos = [allowed('cat', ['Cat'], 1000)];
            const onFallback = jest.fn();
            expect(pickPhotosForChallenge(challenge, photos, 5, { onFallback })).toEqual(['cat']);
            expect(onFallback).not.toHaveBeenCalled();
        });

        test('onFallback does NOT fire when fillWithoutTagMatch:false returns []', () => {
            const photos = [allowed('dog', ['Dog'], 1000)];
            const onFallback = jest.fn();
            expect(pickPhotosForChallenge(challenge, photos, 5, { onFallback, fillWithoutTagMatch: false })).toEqual(
                [],
            );
            expect(onFallback).not.toHaveBeenCalled();
        });

        test('a throwing onFallback is swallowed and the fallback pick still succeeds', () => {
            const photos = [allowed('dog', ['Dog'], 1000)];
            const onFallback = jest.fn(() => {
                throw new Error('boom');
            });
            expect(pickPhotosForChallenge(challenge, photos, 5, { onFallback })).toEqual(['dog']);
        });
    });

    describe('semantic ranking tier (opts.semanticScores)', () => {
        // Title keywords (pink/nature) don't match the labels below, so the
        // lexical keyword score is 0 for every photo and the tiers under test
        // are the ones that decide order.
        const challenge = { title: 'Pink In Nature', url: '', welcome_message: '' };

        test('no semanticScores → ranking is the lexical-only behavior', () => {
            const pA = allowed('a', ['Random'], 1000, { votes: 1 });
            const pB = allowed('b', ['Random'], 1000, { votes: 5 });
            // votes tiebreak → b
            expect(pickPhotosForChallenge(challenge, [pA, pB], 1)).toEqual(['b']);
        });

        test('promotes an on-theme photo above a higher-vote off-theme one', () => {
            const pA = allowed('a', ['Random'], 1000, { votes: 1 });
            const pB = allowed('b', ['Random'], 1000, { votes: 5 });
            const semanticScores = new Map([
                ['a', 0.9],
                ['b', 0.1],
            ]);
            expect(pickPhotosForChallenge(challenge, [pA, pB], 1, { semanticScores })).toEqual(['a']);
        });

        test('sits below the explicit Should Include Tags preference', () => {
            const pA = allowed('a', ['Random'], 1000);
            const pB = allowed('b', ['Sunset'], 1000);
            const semanticScores = new Map([
                ['a', 0.95],
                ['b', 0.0],
            ]);
            const out = pickPhotosForChallenge(challenge, [pA, pB], 2, {
                shouldIncludeTags: ['sunset'],
                semanticScores,
            });
            expect(out[0]).toBe('b'); // should-match outranks a higher semantic score
        });

        test('sub-percent differences bucket together and fall through to lexical tiers', () => {
            const pA = allowed('a', ['Random'], 1000, { votes: 1 });
            const pB = allowed('b', ['Random'], 1000, { votes: 5 });
            // 0.901 and 0.904 both bucket to 90 → votes decide → b
            const semanticScores = new Map([
                ['a', 0.901],
                ['b', 0.904],
            ]);
            expect(pickPhotosForChallenge(challenge, [pA, pB], 1, { semanticScores })).toEqual(['b']);
        });

        test('a non-Map semanticScores value is ignored', () => {
            const pA = allowed('a', ['x'], 1000, { votes: 1 });
            const pB = allowed('b', ['x'], 1000, { votes: 5 });
            expect(pickPhotosForChallenge(challenge, [pA, pB], 1, { semanticScores: { a: 0.9 } })).toEqual(['b']);
        });

        test('a bare number value still scores — the pre-support map shape', () => {
            // The documented opt shape before support existed. Callers and tests
            // that build the map by hand keep working and simply contribute no
            // support; only the scorer emits the record form.
            const pA = allowed('a', ['Random'], 1000, { votes: 1 });
            const pB = allowed('b', ['Random'], 1000, { votes: 5 });
            const semanticScores = new Map([
                ['a', 0.9],
                ['b', { score: 0.1, support: 3 }],
            ]);
            expect(pickPhotosForChallenge(challenge, [pA, pB], 1, { semanticScores })).toEqual(['a']);
        });
    });

    describe("semantic support tier (the photo's other labels)", () => {
        const challenge = { title: 'Pink In Nature', url: '', welcome_message: '' };

        test('breaks a tie the max-pooled score cannot, ahead of popularity', () => {
            // Both photos peak identically — the shape a tag-narrowed fetch
            // produces — so without this tier votes would decide and pick 'b'.
            const pA = allowed('a', ['Random'], 1000, { votes: 1 });
            const pB = allowed('b', ['Random'], 1000, { votes: 5 });
            const semanticScores = new Map([
                ['a', { score: 0.9, support: 3 }],
                ['b', { score: 0.9, support: 1 }],
            ]);
            expect(pickPhotosForChallenge(challenge, [pA, pB], 1, { semanticScores })).toEqual(['a']);
        });

        test('never outranks a stronger headline match', () => {
            // The governing constraint: support only orders photos the max already
            // agreed are equally on theme. A better best-label always wins, however
            // much corroboration the loser carries.
            const pA = allowed('a', ['Random'], 1000);
            const pB = allowed('b', ['Random'], 1000);
            const semanticScores = new Map([
                ['a', { score: 0.95, support: 1 }],
                ['b', { score: 0.6, support: 3 }],
            ]);
            expect(pickPhotosForChallenge(challenge, [pA, pB], 1, { semanticScores })).toEqual(['a']);
        });

        test('sits below the explicit Should Include Tags preference', () => {
            const pA = allowed('a', ['Random'], 1000);
            const pB = allowed('b', ['Sunset'], 1000);
            const semanticScores = new Map([
                ['a', { score: 0.9, support: 3 }],
                ['b', { score: 0.9, support: 0 }],
            ]);
            const out = pickPhotosForChallenge(challenge, [pA, pB], 2, {
                shouldIncludeTags: ['sunset'],
                semanticScores,
            });
            expect(out[0]).toBe('b');
        });

        test('support below the match floor is discarded with its score', () => {
            // A sub-floor score means no label cleared the floor, so a support count
            // paired with one is incoherent and must not smuggle itself past the
            // floor into the tier above the lexical keyword hit.
            const pA = allowed('a', ['Random'], 1000, { votes: 1 });
            const pB = allowed('b', ['Random'], 1000, { votes: 5 });
            const semanticScores = new Map([
                ['a', { score: 0.2, support: 3 }],
                ['b', { score: 0.2, support: 0 }],
            ]);
            // Both collapse to (0,0) → votes decide, exactly as with no map at all.
            expect(pickPhotosForChallenge(challenge, [pA, pB], 1, { semanticScores })).toEqual(['b']);
        });

        test('support is clamped to the cap, so a huge count cannot run away', () => {
            const pA = allowed('a', ['Random'], 1000, { votes: 1 });
            const pB = allowed('b', ['Random'], 1000, { votes: 5 });
            const semanticScores = new Map([
                ['a', { score: 0.9, support: 999 }],
                ['b', { score: 0.9, support: SEMANTIC_SUPPORT_CAP }],
            ]);
            // Clamped equal → votes decide → b. An unclamped 999 would pick 'a'.
            expect(pickPhotosForChallenge(challenge, [pA, pB], 1, { semanticScores })).toEqual(['b']);
        });

        test('a contested tie the support tier settles costs no stat enrichment', () => {
            // selectEnrichmentSet reads the same theme comparator, so a tie this
            // tier resolves is no longer contested — one fewer get_image_data call.
            const pA = allowed('a', ['Random'], 1000, { votes: 1 });
            const pB = allowed('b', ['Random'], 1000, { votes: 5 });
            const semanticScores = new Map([
                ['a', { score: 0.9, support: 3 }],
                ['b', { score: 0.9, support: 1 }],
            ]);
            const scored = buildScoredCandidates(challenge, [pA, pB], { semanticScores });
            expect(selectEnrichmentSet(scored, 1)).toEqual([]);
        });
    });

    describe('views ranking tier', () => {
        // Untaggable title → no theme signal; votes is 0 on the real API, so
        // views is the meaningful "best performer" tiebreak above recency.
        const challenge = { title: 'Your Photography Goal', url: '', welcome_message: '' };

        test('more views wins over a newer upload with fewer views', () => {
            const newerFewer = allowed('newer-fewer', ['Random'], 9000, { views: 10 });
            const olderMore = allowed('older-more', ['Random'], 1000, { views: 999 });
            expect(pickPhotosForChallenge(challenge, [newerFewer, olderMore], 1)).toEqual(['older-more']);
        });

        test('upload date still decides when views are equal/absent', () => {
            const older = allowed('older', ['Random'], 1000);
            const newer = allowed('newer', ['Random'], 9000);
            expect(pickPhotosForChallenge(challenge, [older, newer], 1)).toEqual(['newer']);
        });

        test('votes still outranks views when a real vote count is present', () => {
            const hiViews = allowed('hi-views', ['Random'], 1000, { views: 9999, votes: 1 });
            const hiVotes = allowed('hi-votes', ['Random'], 1000, { views: 1, votes: 5 });
            expect(pickPhotosForChallenge(challenge, [hiViews, hiVotes], 1)).toEqual(['hi-votes']);
        });
    });

    // Guards against "The Farm Life" picking a Sea Life photo. Four separate
    // rules prevent it; each gets a test so weakening any one of them fails
    // loudly rather than silently degrading picks.
    // A plural challenge title vs. a singular vision label is the FIRST thing
    // suspected whenever an auto-fill leaves a slot empty ("the challenge said
    // Dogs, the photo is tagged dog"). It is not the cause and must stay that
    // way: the stemmer collapses both sides before anything compares them, on
    // the client scorer AND on the derived server-side search term.
    describe('plural title vs. singular label — "Let\'s See Dogs!"', () => {
        const dogs = { title: "Let's See Dogs!", url: 'lets-see-dogs' };

        test('the plural title collapses to the singular stem everywhere', () => {
            expect(buildChallengeKeywords(dogs)).toEqual(['dog']);
            expect(buildSearchTerms(dogs, {})).toEqual(['dog']);
        });

        test('a photo labelled with the singular scores as a match', () => {
            expect(scorePhoto({ labels: ['Dog', 'Pet', 'Canidae'] }, buildChallengeKeywords(dogs))).toBe(1);
        });

        test('and is the pick, over a higher-view off-theme photo', () => {
            const onTheme = { id: 'dog-1', labels: ['Dog'], views: 1, permission: { allowed: true } };
            const offTheme = { id: 'other-1', labels: ['Skyscraper'], views: 99_999, permission: { allowed: true } };

            expect(pickPhotosForChallenge(dogs, [offTheme, onTheme], 1)).toEqual(['dog-1']);
        });

        test('the reverse direction holds too — singular title, plural label', () => {
            const dog = { title: "Let's See A Dog" };
            expect(scorePhoto({ labels: ['Dogs'] }, buildChallengeKeywords(dog))).toBe(1);
        });
    });

    describe('theme matching — Farm Life / Sea Life regression', () => {
        const farmLife = { title: 'The Farm Life', url: 'the-farm-life' };

        test('the abstract head-noun "life" is not a search term or a keyword', () => {
            // Keeping "life" would (a) issue a server-side search for `life` that
            // drags Sea Life / Still Life / Wildlife photos into the candidate
            // pool and (b) score them as a match. The modifier "farm" carries the
            // whole subject; the head noun carries none.
            expect(buildSearchTerms(farmLife, {})).toEqual(['farm']);
            expect(buildChallengeKeywords(farmLife)).toEqual(['farm']);
        });

        test('multi-word labels are split into word stems, deduped', () => {
            // Stemming a label as ONE string ("Sea Life" -> "sea life") would let
            // the keyword "life" substring-match it. Labels split into words, the
            // same as user tags.
            expect(labelWordStems({ labels: ['Sea Life'] })).toEqual(['sea', 'life']);
            // "sea" appears in two labels but must only be counted once.
            expect(labelWordStems({ labels: ['Sea', 'Sea Life'] })).toEqual(['sea', 'life']);
            expect(labelWordStems({ labels: [] })).toEqual([]);
            expect(labelWordStems({})).toEqual([]);
        });

        test('a Sea Life photo no longer scores as a match for a farm challenge', () => {
            const keywords = buildChallengeKeywords(farmLife);
            expect(scorePhoto({ labels: ['Sea Life', 'Underwater', 'Fish'] }, keywords)).toBe(0);
        });

        test('views cannot outrank a wording fit (the governing rule)', () => {
            // THE headline guarantee, asserted at the extremes so that any future
            // reordering of the comparator tiers fails here rather than quietly
            // shipping. The sea photo is the overwhelmingly better "performer";
            // it must still lose, because the farm photo is on theme and it is not.
            const sea = allowed('sea', ['Sea Life', 'Underwater', 'Fish'], 9000, { views: 9999 });
            const farm = allowed('farm', ['Cow', 'Barn', 'Pasture'], 1000, { views: 1 });
            // Semantic scores as the real lexicon produces them for this challenge.
            const semanticScores = new Map([
                ['sea', 0.003],
                ['farm', 0.73],
            ]);
            expect(pickPhotosForChallenge(farmLife, [sea, farm], 1, { semanticScores })).toEqual(['farm']);
        });

        test('views still decide when nothing matches the theme (intended last resort)', () => {
            // The flip side of the rule: popularity is not banned, it is demoted.
            // With no photo on theme, the best performer is the right pick.
            const a = allowed('a', ['Teapot'], 1000, { views: 10 });
            const b = allowed('b', ['Stapler'], 1000, { views: 9999 });
            expect(pickPhotosForChallenge(farmLife, [a, b], 1, {})).toEqual(['b']);
        });

        test('a sub-floor semantic score cannot outrank a genuine lexical hit', () => {
            // The semantic tier sits ABOVE the lexical score, so without the floor
            // pure vector noise would beat a real keyword match. `noise` scores just
            // under the floor and must be treated as no match at all.
            const belowFloor = (SEMANTIC_MATCH_FLOOR - 1) / 100;
            const noise = allowed('noise', ['Teapot'], 9000);
            const real = allowed('real', ['Farm'], 1000);
            const semanticScores = new Map([
                ['noise', belowFloor],
                ['real', 0],
            ]);
            expect(pickPhotosForChallenge(farmLife, [noise, real], 1, { semanticScores })).toEqual(['real']);
        });

        test('the floor is inclusive: a score exactly AT it counts as a match', () => {
            // Pins `>=` rather than `>`. An off-by-one here would silently discard
            // the weakest genuine matches, and no other test would notice.
            const atFloor = allowed('atFloor', ['Teapot'], 1000, { views: 1 });
            const none = allowed('none', ['Stapler'], 9000, { views: 9999 });
            const semanticScores = new Map([
                ['atFloor', SEMANTIC_MATCH_FLOOR / 100],
                ['none', 0],
            ]);
            expect(pickPhotosForChallenge(farmLife, [atFloor, none], 1, { semanticScores })).toEqual(['atFloor']);
        });

        test('scores straddling the floor order correctly (39 loses, 41 wins)', () => {
            const below = allowed('below', ['Teapot'], 9000, { views: 9999 });
            const above = allowed('above', ['Stapler'], 1000, { views: 1 });
            const semanticScores = new Map([
                ['below', (SEMANTIC_MATCH_FLOOR - 1) / 100],
                ['above', (SEMANTIC_MATCH_FLOOR + 1) / 100],
            ]);
            // `below` is floored to 0 (no match), so despite 9999 views it loses to
            // `above`, which clears the floor with a single view.
            expect(pickPhotosForChallenge(farmLife, [below, above], 2, { semanticScores })).toEqual(['above', 'below']);
        });
    });

    describe('label stems — untrusted input is bounded and type-guarded', () => {
        test('labelWordStems caps the number of distinct stems per photo', () => {
            // Labels are untrusted API data. Feed more distinct words than the cap
            // and confirm the fan-out is bounded rather than unbounded.
            const labels = Array.from({ length: 200 }, (_, i) => `word${'abcdefgh'[i % 8]}${i}x`);
            const stems = labelWordStems({ labels });
            expect(stems.length).toBeLessThanOrEqual(64);
        });

        test('labelWordStems caps words taken from a single label', () => {
            const oneHugeLabel = Array.from({ length: 100 }, (_, i) => `alpha${i}zz`).join(' ');
            expect(labelWordStems({ labels: [oneHugeLabel] }).length).toBeLessThanOrEqual(12);
        });

        test('labelWordStems ignores non-string labels rather than stringifying them', () => {
            // String(null) === 'null' would otherwise become a real, matchable stem.
            expect(labelWordStems({ labels: [null, undefined, {}, 'Cow'] })).toEqual(['cow']);
        });

        test('wholeLabelStems ignores non-string labels (so null cannot satisfy "Begins With N")', () => {
            // The letter filter reads the first character of these stems. Without the
            // type guard, a null label would stem to the literal string "null" and
            // count as a label beginning with N.
            expect(wholeLabelStems({ labels: [null, 'Sea Life'] })).toEqual(['sea life']);
            expect(wholeLabelStems({ labels: undefined })).toEqual([]);
        });
    });

    describe('matches() — whole-word, not substring', () => {
        test('rejects unrelated words that merely share characters', () => {
            // Every one of these matches under a bidirectional-substring rule —
            // the way a farm challenge could pick a sea photo.
            expect(matches('heart', 'art')).toBe(false);
            expect(matches('catamaran', 'cat')).toBe(false);
            expect(matches('seagull', 'sea')).toBe(false);
            expect(matches('buddha', 'bud')).toBe(false);
            expect(matches('office', 'ice')).toBe(false);
            expect(matches('spiral', 'spi')).toBe(false);
        });

        test('still absorbs stemmer residue and inflections', () => {
            expect(matches('runn', 'run')).toBe(true); // stem('running') === 'runn'
            expect(matches('cat', stem('cats'))).toBe(true);
            expect(matches('flower', stem('flowers'))).toBe(true);
            expect(matches('sea', 'sea')).toBe(true);
        });

        test('is symmetric', () => {
            expect(matches('run', 'runn')).toBe(true);
            expect(matches('art', 'heart')).toBe(false);
        });
    });

    describe('multi-word user tags', () => {
        const challenge = { title: 'Underwater', url: 'underwater' };

        test('"sea life" matches a Sea Life photo but not a bare Ocean photo', () => {
            // A multi-word tag keeps every word (ALL semantics), so it is precise:
            // the photo must carry both words. Stopwords are kept on the tag and
            // label side — a user who types "life" means it literally, unlike the
            // same word scraped out of a challenge title.
            const seaLife = allowed('seaLife', ['Sea Life'], 1000);
            const ocean = allowed('ocean', ['Ocean', 'Wave'], 2000);
            const picked = pickPhotosForChallenge(challenge, [seaLife, ocean], 5, {
                mustIncludeTags: ['sea life'],
                fillWithoutTagMatch: false,
            });
            expect(picked).toEqual(['seaLife']);
        });
    });

    describe('selectEnrichmentSet', () => {
        // "Your Legacy" is the canonical abstract title: no label can match it
        // and its semantic score sits under the floor, so every candidate ties.
        const abstract = { title: 'Your Legacy', url: 'your-legacy' };
        const themed = { title: 'Pink In Nature', url: 'pink-in-nature' };
        const setOf = (challenge, photos, slots, opts = {}) =>
            selectEnrichmentSet(buildScoredCandidates(challenge, photos, opts), slots).map((p) => p.id);

        test('an abstract title leaves the whole library contested', () => {
            const photos = [allowed('a', ['Boy']), allowed('b', ['Cat']), allowed('c', ['Tree'])];
            expect(setOf(abstract, photos, 1).sort()).toEqual(['a', 'b', 'c']);
        });

        test('a decisive theme match costs nothing to enrich', () => {
            const photos = [allowed('pink', ['Pink', 'Flower']), allowed('other', ['Car']), allowed('more', ['Dog'])];
            expect(setOf(themed, photos, 1)).toEqual([]);
        });

        test('candidates that all fit in the available slots are never contested', () => {
            const photos = [allowed('a', ['Boy']), allowed('b', ['Cat'])];
            expect(setOf(abstract, photos, 2)).toEqual([]);
            expect(setOf(abstract, photos, 5)).toEqual([]);
        });

        test('MULTI-SLOT: a unique leader must not hide the contest for the later slots', () => {
            // Regression guard. Emergency fill and manual fill-all pass
            // wantCount = slotsRemaining, so multi-slot batches are routine. A
            // global-maximum tie group would see the single on-theme leader,
            // return nothing, and leave slots 2..N to be decided by the very
            // flat-zero popularity data this mechanism replaces.
            const photos = [
                allowed('pink', ['Pink', 'Flower']),
                ...Array.from({ length: 50 }, (_, i) => allowed(`tied${i}`, ['Misc'])),
            ];
            const contested = setOf(themed, photos, 3);
            expect(contested).not.toContain('pink');
            expect(contested).toHaveLength(50);
        });

        test('only the photos level with the boundary slot are contested', () => {
            // Two distinct theme ranks: 'pink' scores, the rest do not. With one
            // slot the boundary is 'pink' alone, so nothing is contested.
            const photos = [
                allowed('pink', ['Pink']),
                allowed('x', ['Misc']),
                allowed('y', ['Misc']),
                allowed('z', ['Misc']),
            ];
            expect(setOf(themed, photos, 1)).toEqual([]);
            expect(setOf(themed, photos, 2).sort()).toEqual(['x', 'y', 'z']);
        });

        test('respects the must-tag hard filter', () => {
            const photos = [allowed('cat', ['Cat']), allowed('dog', ['Dog']), allowed('bird', ['Bird'])];
            // Only 'cat' survives the filter, so there is nothing left to contest.
            expect(setOf(abstract, photos, 1, { mustIncludeTags: ['cat'], fillWithoutTagMatch: false })).toEqual([]);
        });

        test('respects the letter-challenge hard filter', () => {
            const letters = { title: 'Begins With L', url: 'begins-with-l' };
            const photos = [allowed('lion', ['Lion']), allowed('leaf', ['Leaf']), allowed('cat', ['Cat'])];
            expect(setOf(letters, photos, 1).sort()).toEqual(['leaf', 'lion']);
        });

        test('never invokes onFallback — that warning belongs to the real pick only', () => {
            const onFallback = jest.fn();
            const photos = [allowed('a', ['Boy']), allowed('b', ['Cat'])];
            selectEnrichmentSet(
                buildScoredCandidates(abstract, photos, { mustIncludeTags: ['nothingmatches'], onFallback }),
                1,
            );
            // buildScoredCandidates legitimately fires it once (the pick path);
            // selectEnrichmentSet itself must add no further calls.
            const afterBuild = onFallback.mock.calls.length;
            selectEnrichmentSet(buildScoredCandidates(abstract, photos, {}), 1);
            expect(onFallback.mock.calls.length).toBe(afterBuild);
        });

        test('handles empty and invalid inputs', () => {
            expect(selectEnrichmentSet([], 1)).toEqual([]);
            expect(selectEnrichmentSet(null, 1)).toEqual([]);
            expect(setOf(abstract, [allowed('a', ['Boy']), allowed('b', ['Cat'])], 0)).toEqual([]);
        });

        test('finalizePick guards its own inputs', () => {
            expect(finalizePick([], 1)).toEqual([]);
            expect(finalizePick(null, 1)).toEqual([]);
            const scored = buildScoredCandidates(abstract, [allowed('a', ['Boy'])], {});
            expect(finalizePick(scored, 0)).toEqual([]);
            expect(finalizePick(scored, 1)).toEqual(['a']);
        });
    });

    describe('statsKnown tier', () => {
        const abstract = { title: 'Your Legacy', url: 'your-legacy' };
        const pick = (photos) => pickPhotosForChallenge(abstract, photos, photos.length);

        test('a measured photo outranks an unmeasured one regardless of its stale votes', () => {
            // The unmeasured photo still carries get_photos_private's flat
            // votes:0. That is missing data, not a measurement of zero, so it
            // must not be sorted as though it genuinely has no votes.
            const measured = allowed('measured', ['Misc'], 1000, { votes: 40, statsKnown: true });
            const unmeasured = allowed('unmeasured', ['Misc'], 9000, { votes: 0 });
            expect(pick([unmeasured, measured])).toEqual(['measured', 'unmeasured']);
        });

        test('among measured photos, votes decide', () => {
            const low = allowed('low', ['Misc'], 9000, { votes: 2000, achievementCount: 3, statsKnown: true });
            const high = allowed('high', ['Misc'], 1000, { votes: 100000, achievementCount: 20, statsKnown: true });
            expect(pick([low, high])).toEqual(['high', 'low']);
        });

        test('achievementCount is honoured as a number and as a raw array', () => {
            const asNumber = allowed('num', ['Misc'], 1000, { votes: 10, achievementCount: 5, statsKnown: true });
            const asArray = allowed('arr', ['Misc'], 1000, {
                votes: 10,
                achievements: ['a', 'b', 'c', 'd', 'e', 'f'],
                statsKnown: true,
            });
            expect(pick([asNumber, asArray])).toEqual(['arr', 'num']);
        });

        test('a theme match still beats any amount of measured popularity', () => {
            const themeless = allowed('rich', ['Misc'], 1000, { votes: 999999, statsKnown: true });
            const onTheme = allowed('legacy', ['Legacy'], 1000, { votes: 0 });
            // "legacy" is the challenge keyword, so this photo scores on tier 3.
            expect(pick([themeless, onTheme])[0]).toBe('legacy');
        });
    });

    // Guards the "Your Legacy" case: get_photos_private reports votes=0 / no
    // achievements for EVERY library photo, so without enrichment ranking
    // collapses to views then upload_date and a soccer photo with 3 badges and
    // ~2k votes beats photos with 20+ badges and 100k+ votes. Mirrors the
    // Farm-Life/Sea-Life block above: dropping the enrichment or changing the
    // tier order fails this loudly.
    describe('"Your Legacy" regression — popularity fallback on the real payload shape', () => {
        const challenge = { title: 'Your Legacy', url: 'your-legacy' };
        const soccerLabels = [
            'People',
            'Person',
            'Boy',
            'Male',
            'Teen',
            'Clothing',
            'Shorts',
            'Adult',
            'Man',
            'Footwear',
            'Shoe',
            'Ball',
            'Football',
            'Soccer',
            'Soccer Ball',
            'Sport',
        ];

        // The shape get_photos_private actually returns: votes flat zero, no
        // achievements field at all, views populated.
        const unenriched = (id, labels, views, uploadDate) => allowed(id, labels, uploadDate, { votes: 0, views });

        test('the whole library ties on theme, so every candidate is contested', () => {
            const photos = [
                unenriched('soccer', soccerLabels, 1203, 9000),
                unenriched('portfolio', ['Landscape', 'Mountain'], 400, 1000),
            ];
            const contested = selectEnrichmentSet(buildScoredCandidates(challenge, photos, {}), 1);
            expect(contested.map((p) => p.id).sort()).toEqual(['portfolio', 'soccer']);
        });

        test('unenriched, the higher-VIEW soccer photo wins — the reported bug', () => {
            const photos = [
                unenriched('soccer', soccerLabels, 1203, 9000),
                unenriched('portfolio', ['Landscape', 'Mountain'], 400, 1000),
            ];
            expect(pickPhotosForChallenge(challenge, photos, 1)).toEqual(['soccer']);
        });

        test('enriched, the 100k-vote photo wins even with fewer views', () => {
            const photos = [
                allowed('soccer', soccerLabels, 9000, {
                    votes: 3701,
                    views: 1203,
                    achievementCount: 3,
                    statsKnown: true,
                }),
                allowed('portfolio', ['Landscape', 'Mountain'], 1000, {
                    votes: 100000,
                    views: 400,
                    achievementCount: 20,
                    statsKnown: true,
                }),
            ];
            expect(pickPhotosForChallenge(challenge, photos, 1)).toEqual(['portfolio']);
        });
    });

    describe('negated titles ("No Humans")', () => {
        test('parseNegation reads a leading negation and the "X-free" compound', () => {
            expect(parseNegation('No Humans')).toEqual({ positiveTitle: '', stems: ['human'], active: true });
            expect(parseNegation('Without People').stems).toEqual(['people']);
            expect(parseNegation('Color Hunt: No Red').stems).toEqual(['red']);
            const free = parseNegation('People-Free Streets');
            expect(free.stems).toEqual(['people']);
            expect(tokenise(free.positiveTitle)).toEqual(['street']);
        });

        test.each(['No Place Like Home', 'No Limits', 'Wild and Free', 'Street Photography', 'Nobody Home'])(
            '"%s" is not a negation',
            (title) => {
                expect(parseNegation(title).active).toBe(false);
            },
        );

        test('the negated subject never becomes a theme, keyword or search term', () => {
            const challenge = { title: 'No Humans', url: 'no-humans', welcome_message: 'No humans in frame.' };
            expect(buildThemeKeywords(challenge)).toEqual([]);
            expect(buildChallengeKeywords(challenge)).toEqual(['frame']);
            expect(buildSearchTerms(challenge)).toEqual([]);
            // The url slug must not smuggle the marker word back in either.
            expect(buildThemeKeywords({ title: 'Without People', url: 'without-people' })).toEqual([]);
            expect(buildSearchTerms({ title: 'People-Free Streets' })).toEqual(['street']);
        });

        test('photos of people are excluded even when their labels never say "human"', () => {
            const photos = [
                allowed('portrait', ['Portrait', 'Woman'], 3000),
                allowed('crowd', ['Crowd', 'Street'], 2900),
                allowed('kid', ['Boy', 'Playground'], 2800),
                allowed('dog', ['Dog', 'Animal'], 1000),
                // "man" is matched by exact stem, so a mango is not a man.
                allowed('mango', ['Mango', 'Fruit'], 900),
            ];
            expect(pickPhotosForChallenge({ title: 'No Humans' }, photos, 5)).toEqual(['dog', 'mango']);
        });

        test('a non-people negation excludes by the word itself', () => {
            const photos = [allowed('car', ['Car', 'Road'], 3000), allowed('tree', ['Tree'], 1000)];
            expect(pickPhotosForChallenge({ title: 'No Cars' }, photos, 2)).toEqual(['tree']);
        });

        test('when every photo shows the negated subject it falls back and says why', () => {
            const photos = [allowed('portrait', ['Portrait'], 3000), allowed('crowd', ['Crowd'], 2000)];
            const onFallback = jest.fn();
            expect(pickPhotosForChallenge({ title: 'No Humans' }, photos, 1, { onFallback })).toEqual(['portrait']);
            expect(onFallback).toHaveBeenCalledWith({ letterPrefix: null, mustStems: [], excludedStems: ['human'] });
        });

        test('fillWithoutTagMatch:false leaves the slot empty instead', () => {
            const photos = [allowed('portrait', ['Portrait'], 3000)];
            expect(pickPhotosForChallenge({ title: 'No Humans' }, photos, 1, { fillWithoutTagMatch: false })).toEqual(
                [],
            );
        });

        test('an unlabelled photo cannot be judged and is kept', () => {
            const photos = [allowed('portrait', ['Person'], 3000), allowed('bare', [], 1000)];
            expect(pickPhotosForChallenge({ title: 'No Humans' }, photos, 2)).toEqual(['bare']);
        });
    });
});
