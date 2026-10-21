/**
 * mock/challenges.ts — the generated active-challenge list for mock mode.
 */

import type * as challengesModule from '../../src/ts/mock/challenges';

const { generateMockChallenges } = require('../../src/ts/mock/challenges') as typeof challengesModule;

afterEach(() => jest.restoreAllMocks());

describe('generateMockChallenges', () => {
    test('numbers the challenges consecutively from a random session base id', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0);
        const { challenges } = generateMockChallenges();

        expect(challenges.length).toBeGreaterThan(0);
        expect(challenges.map((c) => c.id)).toEqual(challenges.map((_, i) => 100000 + i));
    });

    test('every challenge has a unique url and is still open', () => {
        const now = Math.floor(Date.now() / 1000);
        const { challenges } = generateMockChallenges();

        expect(new Set(challenges.map((c) => c.url)).size).toBe(challenges.length);
        for (const challenge of challenges) {
            expect(challenge.close_time).toBeGreaterThan(now);
        }
    });
});

describe('the benchmark, prize and flag fixtures', () => {
    test('Ultimate Exposure carries the three benchmark rows and all four enable flags, on a challenge with a turbo', () => {
        const { challenges } = generateMockChallenges();
        const challenge = challenges.find((c) => c.title === 'Ultimate Exposure');

        expect(challenge?.member?.ranking?.total?.benchmark).toEqual([
            { benchmark: '1', score: '1437' },
            { benchmark: '10', score: '1187' },
            { benchmark: '100', score: '782' },
        ]);
        expect(challenge?.guru_pick_enable).toBe(true);
        expect(challenge?.top_photographer_enable).toBe(true);
        expect(challenge?.levels_rank_enable).toBe(true);
        expect(challenge?.new_ranking_enable).toBe(true);
        expect(challenge?.turbo_enable).toBe(true);
        expect(challenge?.member?.turbo).toBeDefined();
    });

    test('the no-turbo challenge still carries benchmarks, prizes and flags', () => {
        const { challenges } = generateMockChallenges();
        const challenge = challenges.find((c) => c.title === 'Architecture Photography');

        // No turbo at all — `member.turbo` reads as absent and the enable flag is false.
        expect(challenge?.turbo_enable).toBe(false);
        expect(challenge?.member?.turbo).toBeUndefined();
        // A benchmark row whose score the server left empty.
        expect(challenge?.member?.ranking?.total?.benchmark).toEqual([{ benchmark: '10', score: '' }]);
        // A MEMBER-rank tier, an IMAGE-rank tier, a tier with no rank window, and a prize type nothing knows.
        const tiers = challenge?.achievements_and_prizes ?? [];
        expect(tiers.slice(0, 3).map((tier) => tier.rank?.type ?? null)).toEqual(['MEMBER', 'IMAGE', null]);
        expect(tiers.some((tier) => tier.prizes?.some((prize) => prize.type === 'FREE_ENTRY'))).toBe(true);
        // The trailing tier is a rank window the server attached no prizes to.
        expect(tiers.at(-1)).toEqual({ title: 'First place', rank: { min_rank: 1, max_rank: 1, type: 'MEMBER' } });
        expect(challenge?.first_prizes?.length).toBeGreaterThan(0);
        // The one challenge where the levels rank is switched off.
        expect(challenge?.levels_rank_enable).toBe(false);
        expect(challenge?.guru_pick_enable).toBe(true);
        expect(challenge?.top_photographer_enable).toBe(true);
        expect(challenge?.new_ranking_enable).toBe(true);
    });

    test('most challenges carry no benchmark rows at all', () => {
        const { challenges } = generateMockChallenges();
        const withoutBenchmark = challenges.filter((c) => c.member?.ranking?.total?.benchmark === undefined);

        expect(withoutBenchmark.length).toBeGreaterThan(0);
    });
});

describe('the mock team match', () => {
    test('five challenges carry a team match: both standings, a null standing, no standing, and a match that ended', () => {
        const { challenges } = generateMockChallenges();
        const withMatch = challenges.filter((c) => c.teamMatch !== undefined);

        expect(withMatch).toHaveLength(5);
        expect(withMatch.map((c) => c.teamMatch?.me?.kind ?? (c.teamMatch?.me === null ? 'null' : 'absent'))).toEqual([
            'active',
            'standby',
            'absent',
            'active',
            'null',
        ]);
    });

    test('an active standing counts the cushion, on the challenge where the opponent is ahead', () => {
        const { challenges } = generateMockChallenges();
        const { teamMatch } = challenges.find((c) => c.title === 'Macro Photography') ?? {};

        expect(teamMatch?.them.votes).toBeGreaterThan(teamMatch?.us.votes ?? Infinity);
        expect(teamMatch?.me).toEqual({ kind: 'active', position: 2, votes: 78, activeSlots: 5, cushion: 12 });
    });

    test('a standby standing counts the votes to an active slot, on the challenge where our team is ahead', () => {
        const { challenges } = generateMockChallenges();
        const { teamMatch } = challenges.find((c) => c.title === 'Wildlife Photography') ?? {};

        expect(teamMatch?.us.votes).toBeGreaterThan(teamMatch?.them.votes ?? -Infinity);
        expect(teamMatch?.me).toEqual({
            kind: 'standby',
            position: 7,
            votes: 34,
            activeSlots: 5,
            votesToActive: 3,
        });
    });

    test('a match that has ended keeps running: false and the final standing, whose cushion is null off the cut', () => {
        const { challenges } = generateMockChallenges();
        const { teamMatch } = challenges.find((c) => c.title === 'Black & White Portraits') ?? {};

        expect(teamMatch?.running).toBe(false);
        expect(teamMatch?.me).toEqual({ kind: 'active', position: 1, votes: 34, activeSlots: 4, cushion: null });
    });

    test('a standing that could not be read arrives as null, and one match carries no standing at all', () => {
        const { challenges } = generateMockChallenges();
        const unreadable = challenges.find((c) => c.title === 'Golden Hour Magic')?.teamMatch;

        expect(unreadable?.me).toBeNull();
        expect('me' in (unreadable ?? {})).toBe(true);
        expect(challenges.find((c) => c.title === 'Urban Wildlife')?.teamMatch).not.toHaveProperty('me');
    });

    test('every readable standing votes what the member has in the challenge', () => {
        const { challenges } = generateMockChallenges();
        for (const challenge of challenges) {
            const me = challenge.teamMatch?.me;
            if (me !== null && me !== undefined) {
                expect(me.votes).toBe(challenge.member?.ranking?.total?.votes);
            }
        }
    });
});
