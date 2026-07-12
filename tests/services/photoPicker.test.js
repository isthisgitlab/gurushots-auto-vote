/**
 * Tests for photoPicker.js
 */

const {
    pickPhotosForChallenge,
    buildSearchTerms,
    detectLetterPrefix,
    tokenise,
    stem,
    matches,
    buildChallengeKeywords,
    scorePhoto,
    tokeniseTagList,
    labelWordStems,
    SEMANTIC_MATCH_FLOOR,
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
            // 'athletes' → 'athlet', 'runners' → 'runner', 'jumping' → 'jump'
            expect(tokenise('athletes runners jumping caught')).toEqual(['athlet', 'runner', 'jump', 'caught']);
        });
    });

    describe('stem', () => {
        test('drops trailing -s for plurals (but not -ss)', () => {
            expect(stem('flowers')).toBe('flower');
            expect(stem('miss')).toBe('miss');
            expect(stem('cats')).toBe('cat');
        });
        test('-es plurals', () => {
            expect(stem('athletes')).toBe('athlet');
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
            // This is the fix for the "Action Shots picked my last upload"
            // failure mode — the URL slug only gives [action] (shots filtered),
            // but welcome_message gives concrete vocabulary.
            const keys = buildChallengeKeywords({
                url: 'action-shots-2024',
                title: 'Action Shots',
                welcome_message: 'Capture athletes mid-jump and runners in motion!',
            });
            // After stemming: athletes→athlet, runners→runner
            // Stopwords filter: capture, in
            expect(keys).toEqual(expect.arrayContaining(['action', 'athlet', 'jump', 'runner', 'motion']));
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
    });

    describe('detectLetterPrefix', () => {
        test('parses the begins/starts-with family', () => {
            expect(detectLetterPrefix('Begins With L')).toBe('l');
            expect(detectLetterPrefix('Starts with the letter A')).toBe('a');
            expect(detectLetterPrefix('Things That Start With B')).toBe('b');
            expect(detectLetterPrefix('Beginning with C')).toBe('c');
            expect(detectLetterPrefix('STARTS WITH d')).toBe('d'); // case-insensitive, lowercased
        });
        test('a real word after "with" is not a letter challenge', () => {
            expect(detectLetterPrefix('Begins With Love')).toBeNull();
            expect(detectLetterPrefix('Begins With LA')).toBeNull();
            expect(detectLetterPrefix('Begins With L-A')).toBeNull();
        });
        test('out-of-scope title forms return null', () => {
            expect(detectLetterPrefix('Letter B Challenge')).toBeNull();
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
        test('matches Athlete (label) against athletes (keyword stem athlet)', () => {
            const photo = { labels: ['Athlete', 'Sport'] };
            // stem('athletes') = 'athlet'; label 'athlete' contains 'athlet'
            expect(scorePhoto(photo, ['athlet'])).toBe(1);
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
            // This is the "picked my last upload" fix: a freshly-uploaded
            // photo with 0 votes should NOT outrank a proven photo with
            // hundreds of votes when neither matches the theme.
            const photos = [
                allowed('proven', ['Misc'], 1000, { votes: 500 }),
                allowed('lastUpload', ['Misc'], 9999, { votes: 0 }),
            ];
            const picked = pickPhotosForChallenge(challenge, photos, 1);
            expect(picked).toEqual(['proven']);
        });

        test('quality fallback respects priority: score > achievements > votes > date', () => {
            const photos = [
                // Theme match wins despite no quality signals
                allowed('themeMatch', ['Pink'], 1000, { achievements: [], votes: 0 }),
                // High achievements beats high votes
                allowed('manyWins', ['Misc'], 1000, { achievements: ['a', 'b'], votes: 100 }),
                // Higher votes than the next
                allowed('highVotes', ['Misc'], 5000, { achievements: [], votes: 800 }),
                // Newest, no signals
                allowed('newest', ['Misc'], 9000, { achievements: [], votes: 0 }),
            ];
            expect(pickPhotosForChallenge(challenge, photos, 4)).toEqual([
                'themeMatch',
                'manyWins',
                'highVotes',
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
            // This test previously pinned the opposite: matches() was a
            // bidirectional substring test, so the tag stem 'bud' matched the label
            // stem 'buddha'. Its own comment said it existed to catch "a future
            // tightening of matches() (e.g. to require exact/whole-word stems)".
            // This is that tightening — 'bud' and 'buddha' are different things.
            // With fillWithoutTagMatch:false the slot is correctly left empty.
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

    // Regression suite for the "The Farm Life picked a Sea Life photo" bug.
    // Four separate defects conspired; each gets a test so a partial revert of
    // any one of them fails loudly rather than silently degrading picks.
    describe('theme matching — Farm Life / Sea Life regression', () => {
        const farmLife = { title: 'The Farm Life', url: 'the-farm-life' };

        test('the abstract head-noun "life" is not a search term or a keyword', () => {
            // "life" used to survive tokenisation, which (a) issued a server-side
            // search for `life` that dragged Sea Life / Still Life / Wildlife
            // photos into the candidate pool and (b) scored them as a match. The
            // modifier "farm" carries the whole subject; the head noun carries none.
            expect(buildSearchTerms(farmLife, {})).toEqual(['farm']);
            expect(buildChallengeKeywords(farmLife)).toEqual(['farm']);
        });

        test('multi-word labels are split into word stems, deduped', () => {
            // Labels used to be stemmed as ONE string ("Sea Life" -> "sea life"),
            // which is what let the keyword "life" substring-match them. User tags
            // were always split; labels being the odd one out was the root cause.
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
    });

    describe('matches() — whole-word, not substring', () => {
        test('rejects unrelated words that merely share characters', () => {
            // Every one of these matched under the old bidirectional-substring
            // rule. They are the reason a farm challenge could pick a sea photo.
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
});
