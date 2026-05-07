/**
 * Tests for photoPicker.js
 */

const {
    pickPhotosForChallenge,
    tokenise,
    stem,
    buildChallengeKeywords,
    scorePhoto,
} = require('../../src/js/services/photoPicker');

const allowed = (id, labels, uploadDate = 1000, extras = {}) => ({
    id,
    labels,
    upload_date: uploadDate,
    permission: {allowed: true, message: null},
    ...extras,
});

const blocked = (id, labels) => ({
    id,
    labels,
    upload_date: 9999,
    permission: {allowed: false, message: 'blocked'},
});

describe('photoPicker', () => {
    describe('tokenise', () => {
        test('lowercases, splits, drops stopwords and pure-digit tokens', () => {
            expect(tokenise('Pink-In-Nature23')).toEqual(['pink', 'nature']);
        });
        test('handles HTML and punctuation', () => {
            expect(tokenise('<b>Show the color Pink in Nature</b>!')).toEqual(['show', 'color', 'pink', 'nature']);
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
            expect(tokenise('Earn rewards: 10 coins, Elite Level reward'))
                .toEqual([]);
        });
        test('stems plurals, gerunds, and past tense', () => {
            // 'athletes' → 'athlet', 'runners' → 'runner', 'jumping' → 'jump'
            expect(tokenise('athletes runners jumping caught')).toEqual([
                'athlet', 'runner', 'jump', 'caught',
            ]);
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
            const keys = buildChallengeKeywords({url: 'pink-in-nature23', title: 'Pink Showcase'});
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
                welcome_message: '<b>Show</b> your <i>sunsets</i><br/>',
            });
            expect(keys).toEqual(expect.arrayContaining(['show', 'sunset']));
        });
    });

    describe('scorePhoto', () => {
        test('counts label-keyword overlaps (substring both ways)', () => {
            const photo = {labels: ['Pink', 'Flower', 'Petal']};
            const keys = ['pink', 'nature'];
            expect(scorePhoto(photo, keys)).toBe(1);
        });
        test('substring match catches plurals via stemming', () => {
            const photo = {labels: ['Flowers']};
            expect(scorePhoto(photo, ['flower'])).toBe(1);
        });
        test('matches Athlete (label) against athletes (keyword stem athlet)', () => {
            const photo = {labels: ['Athlete', 'Sport']};
            // stem('athletes') = 'athlet'; label 'athlete' contains 'athlet'
            expect(scorePhoto(photo, ['athlet'])).toBe(1);
        });
        test('matches Running (label) against run (keyword)', () => {
            // stem('running') = 'runn'; substring match: 'runn'.includes('run')
            const photo = {labels: ['Running']};
            expect(scorePhoto(photo, ['run'])).toBe(1);
        });
        test('returns 0 when keywords empty', () => {
            expect(scorePhoto({labels: ['Anything']}, [])).toBe(0);
        });
        test('returns 0 when labels missing', () => {
            expect(scorePhoto({}, ['pink'])).toBe(0);
        });
        test('skips empty labels without crashing', () => {
            const photo = {labels: ['', 'Pink', '']};
            expect(scorePhoto(photo, ['pink'])).toBe(1);
        });
    });

    describe('pickPhotosForChallenge', () => {
        const challenge = {url: 'pink-in-nature23', title: 'Show the color Pink'};

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
                allowed('winner', ['Misc'], 1000, {achievements: ['top_100', 'top_30', 'guru_pick']}),
                allowed('fresh', ['Misc'], 9000, {achievements: []}),
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
                allowed('proven', ['Misc'], 1000, {votes: 500}),
                allowed('lastUpload', ['Misc'], 9999, {votes: 0}),
            ];
            const picked = pickPhotosForChallenge(challenge, photos, 1);
            expect(picked).toEqual(['proven']);
        });

        test('quality fallback respects priority: score > achievements > votes > date', () => {
            const photos = [
                // Theme match wins despite no quality signals
                allowed('themeMatch', ['Pink'], 1000, {achievements: [], votes: 0}),
                // High achievements beats high votes
                allowed('manyWins', ['Misc'], 1000, {achievements: ['a', 'b'], votes: 100}),
                // Higher votes than the next
                allowed('highVotes', ['Misc'], 5000, {achievements: [], votes: 800}),
                // Newest, no signals
                allowed('newest', ['Misc'], 9000, {achievements: [], votes: 0}),
            ];
            expect(pickPhotosForChallenge(challenge, photos, 4)).toEqual(
                ['themeMatch', 'manyWins', 'highVotes', 'newest'],
            );
        });

        test('photo with no upload_date sorts to bottom, not crash', () => {
            const photos = [
                {id: 'noDate', labels: ['Misc'], permission: {allowed: true}},
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
                allowed('lastUpload', ['Indoor', 'Furniture'], 9999, {votes: 0}),
                // Theme-aligned photo from earlier with some votes
                allowed('actionPhoto', ['Athlete', 'Running'], 1000, {votes: 50}),
                // Pretty but unrelated, with some votes
                allowed('sunset', ['Sky', 'Nature'], 5000, {votes: 100}),
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
            const photos = [
                blocked('blocked-perfect', ['Pink', 'Nature']),
                allowed('weak', ['Misc'], 1000),
            ];
            expect(pickPhotosForChallenge(challenge, photos, 2)).toEqual(['weak']);
        });
    });
});
