/**
 * mock/challenges.ts — the generated active-challenge list for mock mode.
 */

import { HOUR, MINUTE } from '../../src/ts/mock/time';
import type * as challengesModule from '../../src/ts/mock/challenges';
import type * as joinModule from '../../src/ts/mock/endpoints/join';
import type * as rewardsModule from '../../src/ts/mock/endpoints/rewards';
import type * as joinDecisionModule from '../../src/ts/services/decisions/joinDecision';
import type * as missionsModule from '../../src/ts/services/missions';

const { generateMockChallenges } = require('../../src/ts/mock/challenges') as typeof challengesModule;
const { getMemberChallenges } = require('../../src/ts/mock/endpoints/join') as typeof joinModule;
const { getMyMissions } = require('../../src/ts/mock/endpoints/rewards') as typeof rewardsModule;
const { joinFreshRefusal } = require('../../src/ts/services/decisions/joinDecision') as typeof joinDecisionModule;
const { classifyMission } = require('../../src/ts/services/missions') as typeof missionsModule;

// The same fixed epoch the generators guard pins, so the boost windows read exactly.
const PINNED_NOW_MS = Date.UTC(2026, 0, 15, 12, 0, 0);

afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
});

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

describe('the state inventory', () => {
    test('every turbo state is demoed, with one snap-mode turbo and one challenge with no turbo at all', () => {
        const { challenges } = generateMockChallenges();
        const states = challenges.map((c) => c.member?.turbo?.state);

        expect(states).toEqual(expect.arrayContaining(['FREE', 'WON', 'TIMER', 'IN_PROGRESS', 'LOCKED', 'USED']));
        expect(challenges.some((c) => c.member?.turbo?.mode === 'snap')).toBe(true);
        expect(challenges.some((c) => c.turbo_enable === false && c.member?.turbo === undefined)).toBe(true);
    });

    test('an own entry carries the turbo flag where the challenge-level turbo is WON or USED', () => {
        const { challenges } = generateMockChallenges();
        const turboEntries = challenges.flatMap((c) =>
            (c.member?.ranking?.entries ?? [])
                .filter((entry) => entry.turbo === true)
                .map((entry) => ({ challenge: c, entry })),
        );

        expect(turboEntries.length).toBeGreaterThan(0);
        for (const { challenge } of turboEntries) {
            expect(['WON', 'USED']).toContain(challenge.member?.turbo?.state);
        }
        // One entry is turbo without a boost, so the turbo-only paths show in mock mode.
        expect(turboEntries.some(({ entry }) => entry.boosted === false)).toBe(true);
    });

    test('boost AVAILABLE spans the 5, 10, 15 and 30 minute windows, and the other boost states are all covered', () => {
        jest.useFakeTimers({ now: PINNED_NOW_MS });
        const { challenges } = generateMockChallenges();
        const now = Math.floor(Date.now() / 1000);
        const windows = challenges
            .filter((c) => c.member?.boost?.state === 'AVAILABLE')
            .map((c) => (c.member?.boost?.timeout ?? 0) - now);

        for (const minutes of [5, 10, 15, 30]) {
            expect(windows).toContain(minutes * MINUTE);
        }
        expect(challenges.map((c) => c.member?.boost?.state)).toEqual(
            expect.arrayContaining(['AVAILABLE_KEY', 'LOCKED', 'USED', 'UNAVAILABLE']),
        );
    });

    test('an upcoming challenge starts about two hours out, and a not-joined one has no entries anywhere', () => {
        const { challenges } = generateMockChallenges();
        const now = Math.floor(Date.now() / 1000);
        const hoursToStart = challenges.filter((c) => c.status === 'upcoming').map((c) => (c.start_time - now) / HOUR);

        expect(hoursToStart.some((hours) => hours >= 1.5 && hours <= 2.5)).toBe(true);
        expect(challenges.some((c) => c.entries === 0 && (c.member?.ranking?.entries?.length ?? 0) === 0)).toBe(true);
    });

    test('the three challenge types, a benchmark challenge and a non-benchmark one are all present', () => {
        const { challenges } = generateMockChallenges();

        expect(challenges.map((c) => c.type)).toEqual(expect.arrayContaining(['default', 'flash', 'speed']));
        expect(challenges.some((c) => c.member?.ranking?.total?.benchmark !== undefined)).toBe(true);
        expect(challenges.some((c) => c.member?.ranking?.total?.benchmark === undefined)).toBe(true);
    });

    test('all five team-match standing variants are demoed', () => {
        const { challenges } = generateMockChallenges();
        const kinds = challenges
            .filter((c) => c.teamMatch !== undefined)
            .map((c) => c.teamMatch?.me?.kind ?? (c.teamMatch?.me === null ? 'null' : 'absent'));

        expect(kinds).toHaveLength(5);
        expect([...kinds].sort()).toEqual(['active', 'standby', 'absent', 'active', 'null'].sort());
    });

    test('an exhibition carries entries and no turbo', () => {
        const { challenges } = generateMockChallenges();
        const exhibition = challenges.find((c) => c.type === 'exhibition' && c.entries > 0 && c.turbo_enable === false);

        expect(exhibition).toBeDefined();
        expect((exhibition?.member?.ranking?.entries?.length ?? 0) > 0).toBe(true);
    });

    test('one challenge costs coins to join', () => {
        const { challenges } = generateMockChallenges();

        expect(challenges.some((c) => (c.join_coins ?? 0) > 0)).toBe(true);
    });

    test('fill is available on most challenges and locked on one, and the same holds for swaps', () => {
        const { challenges } = generateMockChallenges();

        expect(challenges.some((c) => c.fill_enable === true && c.fill_locked === false)).toBe(true);
        expect(challenges.some((c) => c.fill_locked === true)).toBe(true);
        expect(challenges.some((c) => c.swap_enable === true && c.swap_locked === false)).toBe(true);
        expect(challenges.some((c) => c.swap_locked === true)).toBe(true);
    });

    test('the mock missions classify, while DISABLED, as turbo, boost and vote, and exactly one is claimable', async () => {
        const missions = await getMyMissions('token');
        const disabledKinds = missions
            .filter((mission) => mission.claim_state === 'DISABLED')
            .map((mission) => classifyMission(mission));

        expect(disabledKinds).toEqual(expect.arrayContaining(['turbo', 'boost', 'vote']));
        const claimable = missions.filter((mission) => mission.claim_state === 'CLAIM');
        expect(claimable).toHaveLength(1);
        expect(claimable[0]?.id).toBe(900201);
    });

    test('the open join rows demo every listing-level join refusal, and none where the listing allows the join', async () => {
        const rows = (await getMemberChallenges('token', 'open')) ?? [];
        const refusals: Record<number, 'full' | 'price-unknown' | null> = Object.fromEntries(
            rows.map((row) => [row.id, joinFreshRefusal(row)] as const),
        );

        expect(refusals).toEqual({
            900001: null,
            900002: null,
            900003: null,
            900004: null,
            900005: null,
            900006: 'full',
            900007: null,
            900008: 'price-unknown',
        });
    });

    test('an active total sits below its next level threshold, and next is exactly the votes to that threshold', () => {
        const { challenges } = generateMockChallenges();
        const active = challenges.filter((c) => c.status === 'active' && (c.member?.ranking?.total?.level ?? 0) < 5);
        const nextKeyByLevel = ['level_1', 'level_2', 'level_3', 'level_4', 'level_5'] as const;

        expect(active.length).toBeGreaterThan(0);
        for (const challenge of active) {
            const total = challenge.member?.ranking?.total;
            const threshold = challenge.ranking_levels?.[nextKeyByLevel[total?.level ?? 0]] ?? 0;
            expect(threshold - (total?.votes ?? 0)).toBeGreaterThan(0);
            expect(total?.next).toBe(threshold - (total?.votes ?? 0));
        }
    });
});

describe('the benchmark, prize and flag fixtures', () => {
    test('8 Hours carries the three benchmark rows and all four enable flags, on a challenge with a turbo', () => {
        const { challenges } = generateMockChallenges();
        const challenge = challenges.find((c) => c.title === '8 Hours');

        expect(challenge?.member?.ranking?.total?.benchmark).toEqual([
            { benchmark: '1', score: '2788' },
            { benchmark: '10', score: '2365' },
            { benchmark: '100', score: '1702' },
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
        const challenge = challenges.find((c) => c.title === 'Stunning Architecture');

        // No turbo at all — `member.turbo` reads as absent and the enable flag is false.
        expect(challenge?.turbo_enable).toBe(false);
        expect(challenge?.member?.turbo).toBeUndefined();
        // A benchmark row whose score the server left empty.
        expect(challenge?.member?.ranking?.total?.benchmark).toEqual([{ benchmark: '10', score: '' }]);
        // A MEMBER-rank tier, an IMAGE-rank tier, a tier with no rank window, and a prize type nothing knows.
        const tiers = challenge?.achievements_and_prizes ?? [];
        expect(tiers.slice(0, 3).map((tier) => tier.rank?.type ?? null)).toEqual(['MEMBER', 'IMAGE', null]);
        expect(tiers.some((tier) => tier.prizes?.some((prize) => prize.type === 'FREE_ENTRY'))).toBe(true);
        // The real prize types, so the translated names are exercised in mock mode.
        expect(tiers.some((tier) => tier.prizes?.some((prize) => prize.type === 'EXPOSURE_AUTOFILL'))).toBe(true);
        expect(tiers.some((tier) => tier.prizes?.some((prize) => prize.type === 'PHOTO_SWAP'))).toBe(true);
        // The trailing tier is a rank window the server attached no prizes to.
        expect(tiers.at(-1)).toEqual({ title: 'First place', rank: { min_rank: 1, max_rank: 1, type: 'MEMBER' } });
        expect(challenge?.first_prizes?.map((prize) => prize.type)).toEqual(['KEY', 'COINS']);
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
        const kinds = withMatch.map((c) => c.teamMatch?.me?.kind ?? (c.teamMatch?.me === null ? 'null' : 'absent'));
        expect([...kinds].sort()).toEqual(['active', 'standby', 'absent', 'active', 'null'].sort());
    });

    test('an active standing counts the cushion, on the challenge where the opponent is ahead', () => {
        const { challenges } = generateMockChallenges();
        const { teamMatch } = challenges.find((c) => c.title === '8 Hours') ?? {};

        expect(teamMatch?.them.votes).toBeGreaterThan(teamMatch?.us.votes ?? Infinity);
        expect(teamMatch?.me).toEqual({ kind: 'active', position: 2, votes: 481, activeSlots: 5, cushion: 12 });
    });

    test('a standby standing counts the votes to an active slot, on the challenge where our team is ahead', () => {
        const { challenges } = generateMockChallenges();
        const { teamMatch } = challenges.find((c) => c.title === 'Perfect Mistakes') ?? {};

        expect(teamMatch?.us.votes).toBeGreaterThan(teamMatch?.them.votes ?? -Infinity);
        expect(teamMatch?.me).toEqual({
            kind: 'standby',
            position: 7,
            votes: 676,
            activeSlots: 5,
            votesToActive: 3,
        });
    });

    test('a match that has ended keeps running: false and the final standing, whose cushion is null off the cut', () => {
        const { challenges } = generateMockChallenges();
        const { teamMatch } = challenges.find((c) => c.title === 'Walking') ?? {};

        expect(teamMatch?.running).toBe(false);
        expect(teamMatch?.me).toEqual({ kind: 'active', position: 1, votes: 1335, activeSlots: 4, cushion: null });
    });

    test('a standing that could not be read arrives as null, and one match carries no standing at all', () => {
        const { challenges } = generateMockChallenges();
        const unreadable = challenges.find((c) => c.title === 'My Favorite Exhibition Shot')?.teamMatch;

        expect(unreadable?.me).toBeNull();
        expect('me' in (unreadable ?? {})).toBe(true);
        expect(challenges.find((c) => c.title === 'Powerful Composition')?.teamMatch).not.toHaveProperty('me');
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
