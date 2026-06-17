/**
 * Tests for photoPicker.js
 */

const {
    pickPhotosForChallenge,
    buildSearchTerms,
    tokenise,
    stem,
    buildChallengeKeywords,
    scorePhoto,
    tokeniseTagList,
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

        test('keeps only photos whose labels match ANY listed tag', () => {
            const photos = [allowed('hasSunset', ['Sunset', 'Sky'], 1000), allowed('hasOther', ['Cat', 'Pet'], 9000)];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                mustIncludeTags: ['sunset'],
            });
            expect(picked).toEqual(['hasSunset']);
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

        test('ANY (not ALL) semantics: photo matching one of several tags qualifies', () => {
            const photos = [allowed('a', ['Sunset'], 1000)];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                mustIncludeTags: ['sunset', 'beach', 'ocean'],
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

        test('fallback does not kick in when there IS a match (partial match, no top-up beyond matches)', () => {
            // 'match' matches 'sunset'; 'other' does not. Even though there are
            // 2 slots and the fallback is on, the filter has a non-empty result
            // so only the matching photo is returned — fallback is all-or-nothing.
            const photos = [allowed('match', ['Sunset'], 1000), allowed('other', ['Cat'], 9000)];
            const picked = pickPhotosForChallenge(challenge, photos, 5, {
                mustIncludeTags: ['sunset'],
                fillWithoutTagMatch: true,
            });
            expect(picked).toEqual(['match']);
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
});
