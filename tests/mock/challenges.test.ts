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

describe('the mock team match', () => {
    test('exactly one joined, active challenge carries a team match, with the opponent ahead', () => {
        const { challenges } = generateMockChallenges();
        const withMatch = challenges.filter((c) => 'teamMatch' in c);

        expect(withMatch).toHaveLength(1);
        const [challenge] = withMatch;
        expect(challenge.status).toBe('active');
        expect(challenge.teamMatch?.them.votes).toBeGreaterThan(challenge.teamMatch?.us.votes ?? Infinity);
    });
});
