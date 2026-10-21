/**
 * mock/index.ts — the mock endpoints the shared services run against in mock
 * mode. Uses the REAL mock data modules (index.test.ts stubs them) and fake
 * timers, so the simulated latency never slows the suite.
 *
 * Every endpoint must honour the no-token contract (resolve the real
 * counterpart's failure shape, never reject) and its fixture sentinels
 * (900004 unlock/spend fails, 900005 submit fails).
 */

jest.mock('../../src/ts/metadata', () => ({ updateChallengeVoteMetadata: jest.fn(() => true) }));
jest.mock('../../src/ts/services/votingOrchestrator', () => ({
    runVotingPass: jest.fn(async () => ({ success: true, message: 'pass' })),
}));
jest.mock('../../src/ts/services/joinChallenges', () => ({
    runJoinPass: jest.fn(async () => ({ ran: false, joined: 0, results: [] })),
    joinChallengeSingle: jest.fn(async () => ({ status: 'joined' })),
    forgetUnconfirmedPayment: jest.fn(async () => ({ status: 'nothing-to-forget', challengeId: 1 })),
}));
jest.mock('../../src/ts/services/missions', () => ({
    loadMissionNeeds: jest.fn(async () => null),
    registerMissionNeeds: jest.fn((_token: string, needs: missionsModule.MissionNeeds | null) =>
        needs ? jest.fn() : null,
    ),
}));

import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(loggerModule);
import metadataModule = require('../../src/ts/metadata');
const metadata = jest.mocked(metadataModule);
import type * as votingOrchestratorModule from '../../src/ts/services/votingOrchestrator';
import type * as joinChallengesModule from '../../src/ts/services/joinChallenges';
import type * as missionsModule from '../../src/ts/services/missions';
import type * as indexModule from '../../src/ts/mock/index';
import type { Challenge } from '../../src/ts/types/gurushots';
import { LIBRARY_BATCH_PHOTOS } from '../../src/ts/settings/limits';
import { invalid } from '../helpers/invalid';

/** The mock autocomplete called without a member id, as the no-token / term tests do. */
type TwoArgAutocomplete = (token: string | null, term: unknown) => Promise<string[]>;
const { runVotingPass } = jest.mocked(
    require('../../src/ts/services/votingOrchestrator') as typeof votingOrchestratorModule,
);
const { runJoinPass, joinChallengeSingle, forgetUnconfirmedPayment } = jest.mocked(
    require('../../src/ts/services/joinChallenges') as typeof joinChallengesModule,
);
const { loadMissionNeeds, registerMissionNeeds } = jest.mocked(
    require('../../src/ts/services/missions') as typeof missionsModule,
);
const { mockApiClient, clearSessionCache } = require('../../src/ts/mock/index') as typeof indexModule;

/** Resolve a promise that is gated on simulated latency. */
const settle = async <T>(promise: Promise<T>): Promise<T> => {
    let done = false;
    const tracked = promise.finally(() => {
        done = true;
    });
    // Swallow here; the caller awaits `promise` itself and sees the rejection.
    tracked.catch(() => {});
    while (!done) {
        await jest.advanceTimersByTimeAsync(500);
    }
    return promise;
};

let cat: {
    [K in 'api' | 'debug' | 'info' | 'success' | 'warning' | 'error']: jest.MockedFunction<
        loggerModule.CategoryLogger[K]
    >;
};
beforeEach(() => {
    jest.useFakeTimers();
    cat = {
        api: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
    };
    logger.withCategory.mockReturnValue(invalid(cat));
    clearSessionCache();
});
afterEach(() => jest.useRealTimers());

describe('no-token contract for every endpoint not covered elsewhere', () => {
    test.each([
        ['applyTurbo', () => mockApiClient.applyTurbo(1, 'img', invalid(null)), { ok: false, raw: null }],
        [
            'runTurboGame',
            () => mockApiClient.runTurboGame(invalid({ id: 1 }), invalid(null)),
            { kind: 'classic', played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false },
        ],
        ['getEligiblePhotos', () => mockApiClient.getEligiblePhotos(1, invalid(null)), []],
        [
            'getEligiblePhotosWalk',
            () => mockApiClient.getEligiblePhotosWalk(1, invalid(null)),
            { items: [], truncated: true, nextStart: 0 },
        ],
        ['getImageData', () => mockApiClient.getImageData('photo_old_008', invalid(null)), null],
        ['submitToChallenge', () => mockApiClient.submitToChallenge(1, ['a'], invalid(null)), { ok: false, raw: null }],
        ['getMemberChallenges', () => mockApiClient.getMemberChallenges(invalid(null), 'open'), []],
        ['getBankroll', () => mockApiClient.getBankroll(invalid(null)), null],
        ['getCurrentMemberProfile', () => mockApiClient.getCurrentMemberProfile(invalid(null)), null],
        [
            'searchTagAutocomplete',
            () => invalid<TwoArgAutocomplete>(mockApiClient.searchTagAutocomplete)(null, 'flow'),
            [],
        ],
        ['coinsUnlock', () => mockApiClient.coinsUnlock(1, invalid(null)), { ok: false, raw: null }],
        [
            'joinChallenge',
            () => mockApiClient.joinChallenge(1, true, invalid(null)),
            { status: 'not-authenticated', challengeId: 1, cost: 0 },
        ],
        [
            'forgetUnconfirmedPayment',
            () => mockApiClient.forgetUnconfirmedPayment(1, invalid(null)),
            { status: 'not-authenticated', challengeId: 1 },
        ],
    ])('%s resolves its failure shape and logs the auth error', async (_name, call, expected) => {
        await expect(call()).resolves.toEqual(expected);
        expect(cat.error).toHaveBeenCalledWith(expect.stringMatching(/^No token provided/), null);
    });
});

describe('turbo', () => {
    test('applyTurbo mirrors the live { ok, raw } success shape', async () => {
        await expect(settle(mockApiClient.applyTurbo(5, 'img', 'tok'))).resolves.toEqual({
            ok: true,
            raw: { success: true },
        });
        expect(cat.debug).toHaveBeenCalledWith('Image ID: img', null);
    });

    test('runTurboGame reports a won Snap game for a Snap challenge', async () => {
        await expect(
            settle(mockApiClient.runTurboGame(invalid({ id: 5, member: { turbo: { mode: 'snap' } } }), 'tok')),
        ).resolves.toEqual({
            kind: 'snap',
            answered: 10,
            total: 10,
            meanAgreement: 72,
            won: true,
            stopReason: 'completed',
        });
    });

    test('runTurboGame reports one won battle for a classic challenge', async () => {
        await expect(settle(mockApiClient.runTurboGame(invalid({ id: 5 }), 'tok'))).resolves.toEqual({
            kind: 'classic',
            played: 1,
            correct: 1,
            flipped: 0,
            doubleFailed: 0,
            won: true,
        });
        expect(cat.api).toHaveBeenCalledWith('Mock runTurboGame', null);
    });
});

describe('getEligiblePhotos', () => {
    test('with no options returns the whole library', async () => {
        const items = await settle(mockApiClient.getEligiblePhotos(1, 'tok'));
        expect(items).toHaveLength(9);
    });

    test('a search is an EXACT tag match, like the live endpoint', async () => {
        const exact = await settle(mockApiClient.getEligiblePhotos(1, 'tok', { search: ' Flower ' }));
        expect(exact.map((p) => p.id)).toEqual(['photo_pink_flower_001', 'photo_blocked_007']);
        const partial = await settle(mockApiClient.getEligiblePhotos(1, 'tok', { search: 'flow' }));
        expect(partial).toEqual([]);
    });

    test('a non-string search is ignored', async () => {
        expect(await settle(mockApiClient.getEligiblePhotos(1, 'tok', invalid({ search: 42 })))).toHaveLength(9);
    });
});

describe('getEligiblePhotosWalk', () => {
    test('reads the whole mock library in one complete walk', async () => {
        const walk = await settle(mockApiClient.getEligiblePhotosWalk(1, 'tok'));
        expect(walk.items).toHaveLength(9);
        expect(walk.truncated).toBe(false);
        // Without a `skip` nothing is reported as left out.
        expect(walk).not.toHaveProperty('skipped');
        // All there was: a continuation from here re-reads nothing.
        expect(walk.nextStart).toBe(9);
    });

    test('with a skip the photos it names are left out of the items and reported by id', async () => {
        const walk = await settle(
            mockApiClient.getEligiblePhotosWalk(1, 'tok', {
                skip: (photo) =>
                    photo.permission?.allowed === false && /won a challenge/.test(String(photo.permission.message)),
            }),
        );
        expect(walk.items.map((p) => p.id)).not.toContain('photo_won_009');
        expect(walk.items).toHaveLength(8);
        expect(walk.skipped).toEqual(['photo_won_009']);
        expect(walk.truncated).toBe(false);
        // nextStart counts the rows read (9), not the kept ones (8): a full
        // read consumed every row.
        expect(walk.nextStart).toBe(9);
        const searched = await settle(
            mockApiClient.getEligiblePhotosWalk(1, 'tok', { search: 'Trophy', skip: () => true }),
        );
        expect(searched).toEqual({ items: [], truncated: false, skipped: ['photo_won_009'], nextStart: 1 });
    });

    test('a search is the same exact tag match as the paged read; a non-string search is ignored', async () => {
        const exact = await settle(mockApiClient.getEligiblePhotosWalk(1, 'tok', { search: ' Flower ' }));
        expect(exact.items.map((p) => p.id)).toEqual(['photo_pink_flower_001', 'photo_blocked_007']);
        const ignored = await settle(mockApiClient.getEligiblePhotosWalk(1, 'tok', invalid({ search: 42 })));
        expect(ignored.items).toHaveLength(9);
    });

    const skipWon = (photo: { permission?: { allowed?: boolean; message?: string | null } }) =>
        photo.permission?.allowed === false && /won a challenge/.test(String(photo.permission.message));

    test('a maxKept extent keeps whole pages of four until the kept count reaches it', async () => {
        const first = await settle(mockApiClient.getEligiblePhotosWalk(1, 'tok', { maxKept: 4, skip: skipWon }));
        expect(first.items.map((p) => p.id)).toEqual([
            'photo_pink_flower_001',
            'photo_nature_landscape_002',
            'photo_urban_003',
            'photo_recent_004',
        ]);
        expect(first.skipped).toEqual([]);
        expect(first.truncated).toBe(true);
        expect(first.nextStart).toBe(4);
        const second = await settle(
            mockApiClient.getEligiblePhotosWalk(1, 'tok', { maxKept: 4, skip: skipWon, start: first.nextStart }),
        );
        expect(second.items.map((p) => p.id)).toEqual([
            'photo_pink_petal_005',
            'photo_animal_006',
            'photo_blocked_007',
            'photo_old_008',
        ]);
        expect(second.truncated).toBe(true);
        expect(second.nextStart).toBe(8);
        // The short last page, the exact-multiple case: the won photo is skipped, nothing new is listed,
        // and the rows have run out.
        const third = await settle(
            mockApiClient.getEligiblePhotosWalk(1, 'tok', { maxKept: 4, skip: skipWon, start: second.nextStart }),
        );
        expect(third).toEqual({ items: [], skipped: ['photo_won_009'], truncated: false, nextStart: 12 });
    });

    test('the default batch (LIBRARY_BATCH_PHOTOS) is one page of four rows', async () => {
        const walk = await settle(
            mockApiClient.getEligiblePhotosWalk(1, 'tok', { maxKept: LIBRARY_BATCH_PHOTOS, skip: skipWon }),
        );
        expect(walk.items).toHaveLength(4);
        expect(walk.skipped).toEqual([]);
        expect(walk.truncated).toBe(true);
        expect(walk.nextStart).toBe(4);
        // Without a skip the page is kept whole and no skipped list is reported.
        const plain = await settle(mockApiClient.getEligiblePhotosWalk(1, 'tok', { maxKept: LIBRARY_BATCH_PHOTOS }));
        expect(plain.items).toHaveLength(4);
        expect(plain).not.toHaveProperty('skipped');
        expect(plain.truncated).toBe(true);
        expect(plain.nextStart).toBe(4);
        // A default batch whose only row is the won photo: it rides along in skipped.
        const won = await settle(
            mockApiClient.getEligiblePhotosWalk(1, 'tok', { maxKept: LIBRARY_BATCH_PHOTOS, start: 8, skip: skipWon }),
        );
        expect(won).toEqual({ items: [], skipped: ['photo_won_009'], truncated: false, nextStart: 12 });
    });

    test('a Refresh extent (keep 8) reads two pages, and only photos on read pages are skipped', async () => {
        const walk = await settle(mockApiClient.getEligiblePhotosWalk(1, 'tok', { maxKept: 8, skip: skipWon }));
        expect(walk.items).toHaveLength(8);
        // The won photo sits beyond the two pages the extent needed: it was
        // never read, so it is not reported as skipped either.
        expect(walk.skipped).toEqual([]);
        expect(walk.truncated).toBe(true);
        expect(walk.nextStart).toBe(8);
    });

    test('an extent beyond the library reads every page; the short last page ends it untruncated', async () => {
        const walk = await settle(mockApiClient.getEligiblePhotosWalk(1, 'tok', { maxKept: 12, skip: skipWon }));
        expect(walk.items).toHaveLength(8);
        expect(walk.skipped).toEqual(['photo_won_009']);
        expect(walk.truncated).toBe(false);
        expect(walk.nextStart).toBe(12);
        // A continuation past the end reads nothing and stays untruncated.
        const over = await settle(
            mockApiClient.getEligiblePhotosWalk(1, 'tok', { maxKept: 12, skip: skipWon, start: walk.nextStart }),
        );
        expect(over).toEqual({ items: [], skipped: [], truncated: false, nextStart: 12 });
    });

    test('a short page wins over the extent, like the real walk', async () => {
        // The last three rows: the extent (3 kept) is reached on the very page
        // that runs out, and the rows having run out decides.
        const walk = await settle(mockApiClient.getEligiblePhotosWalk(1, 'tok', { maxKept: 3, start: 6 }));
        expect(walk.items.map((p) => p.id)).toEqual(['photo_blocked_007', 'photo_old_008', 'photo_won_009']);
        expect(walk.truncated).toBe(false);
        expect(walk.nextStart).toBe(10);
    });

    test('a maxKept batch without a skip keeps the whole page and reports no skipped list', async () => {
        const walk = await settle(mockApiClient.getEligiblePhotosWalk(1, 'tok', { maxKept: 4 }));
        expect(walk.items).toHaveLength(4);
        expect(walk).not.toHaveProperty('skipped');
        expect(walk.truncated).toBe(true);
        expect(walk.nextStart).toBe(4);
    });

    test('a maxKept page is sliced from the search-filtered library', async () => {
        const walk = await settle(mockApiClient.getEligiblePhotosWalk(1, 'tok', { maxKept: 4, search: ' Pink ' }));
        expect(walk.items.map((p) => p.id)).toEqual([
            'photo_pink_flower_001',
            'photo_pink_petal_005',
            'photo_blocked_007',
        ]);
        // Three filtered rows are a short page: the batch is over.
        expect(walk.truncated).toBe(false);
        expect(walk.nextStart).toBe(4);
    });

    test('without a token nextStart is the normalized start: nothing was read', async () => {
        await expect(mockApiClient.getEligiblePhotosWalk(1, invalid(null), { start: 12 })).resolves.toEqual({
            items: [],
            truncated: true,
            nextStart: 12,
        });
        await expect(mockApiClient.getEligiblePhotosWalk(1, invalid(null), { start: -5 })).resolves.toEqual({
            items: [],
            truncated: true,
            nextStart: 0,
        });
        await expect(
            mockApiClient.getEligiblePhotosWalk(1, invalid(null), invalid({ start: 'later' })),
        ).resolves.toEqual({ items: [], truncated: true, nextStart: 0 });
    });
});

describe('getImageData', () => {
    test('returns the per-photo record for a known photo', async () => {
        await expect(settle(mockApiClient.getImageData('photo_old_008', 'tok'))).resolves.toEqual({
            id: 'photo_old_008',
            votes: 12400,
            views: 70,
            achievements: ['elite', 'top_30', 'top_50', 'top_100'],
        });
    });

    test.each(['unknown', '__proto__', 'constructor'])('%s is not a photo → null', async (id) => {
        await expect(settle(mockApiClient.getImageData(id, 'tok'))).resolves.toBeNull();
    });
});

describe('submitToChallenge', () => {
    test('submits and echoes the numeric challenge id', async () => {
        const res = await settle(mockApiClient.submitToChallenge('12', ['a', 'b'], 'tok'));
        expect(res).toEqual({
            ok: true,
            raw: { success: true, challenge_id: 12, member_challenge_count: 5, join: false, show_join_message: false },
        });
        expect(cat.debug).toHaveBeenCalledWith('Challenge ID: 12, photos: a,b', null);
    });

    test.each([[[]], ['not-a-list']])('no image ids (%p) → rejected without a round-trip', async (ids) => {
        await expect(mockApiClient.submitToChallenge(1, invalid(ids), 'tok')).resolves.toEqual({
            ok: false,
            raw: { success: false, error: 'No image_ids provided' },
        });
    });

    test('logs a non-array id list as invalid', async () => {
        await mockApiClient.submitToChallenge(1, invalid('x'), 'tok');
        expect(cat.debug).toHaveBeenCalledWith('Challenge ID: 1, photos: invalid', null);
    });

    test('fixture 900005 fails the submit', async () => {
        await expect(settle(mockApiClient.submitToChallenge(900005, ['a'], 'tok'))).resolves.toEqual({
            ok: false,
            raw: { success: false, error: 'mock submit failure' },
        });
    });
});

describe('join endpoints', () => {
    test('getMemberChallenges returns the five fixtures with epoch-second timing', async () => {
        const list = (await settle(mockApiClient.getMemberChallenges('tok', 'open'))) ?? [];
        expect(list.map((c) => c.id)).toEqual([900001, 900002, 900003, 900004, 900005]);
        const nowSec = Math.floor(Date.now() / 1000);
        list.forEach((c) => {
            expect(c.close_time).toBeGreaterThan(nowSec);
            expect(c.start_time).toBeLessThan(nowSec);
        });
        expect(cat.debug).toHaveBeenCalledWith('Filter: open', null);
    });

    test('getMemberChallenges branches on the filter: upcoming has its own fixtures, not started yet', async () => {
        const list = (await settle(mockApiClient.getMemberChallenges('tok', 'upcoming'))) ?? [];
        expect(list.map((c) => c.id)).toEqual([900101, 900102, 900103]);
        const nowSec = Math.floor(Date.now() / 1000);
        list.forEach((c) => {
            expect(c.status).toBe('upcoming');
            expect(c.start_time).toBeGreaterThan(nowSec);
            expect(c.close_time).toBeGreaterThan(c.start_time);
        });
        // A free one and a paid one inside the default 24 h window, one beyond it.
        expect(list.map((c) => c.join_coins)).toEqual([0, 150, 100]);
        expect(list[1].start_time - nowSec).toBeLessThanOrEqual(24 * 3600);
        expect(list[2].start_time - nowSec).toBeGreaterThan(24 * 3600);
        expect(cat.debug).toHaveBeenCalledWith('Filter: upcoming', null);
        // No id is shared with the open fixtures.
        const open = (await settle(mockApiClient.getMemberChallenges('tok', 'open'))) ?? [];
        expect(open.some((c) => list.some((u) => u.id === c.id))).toBe(false);
    });

    test('getBankroll returns the flat balance shape', async () => {
        await expect(settle(mockApiClient.getBankroll('tok'))).resolves.toEqual({
            keys: 8,
            swaps: 41,
            fills: 818,
            coins: 17540,
        });
    });

    test('getCurrentMemberProfile returns a member id', async () => {
        await expect(settle(mockApiClient.getCurrentMemberProfile('tok'))).resolves.toEqual({
            id: 'mock_member_c1d1f773',
            userName: 'mockguru',
        });
    });

    test('coinsUnlock succeeds, except for fixture 900004', async () => {
        await expect(settle(mockApiClient.coinsUnlock(900002, 'tok'))).resolves.toEqual({
            ok: true,
            raw: { success: true },
        });
        await expect(settle(mockApiClient.coinsUnlock('900004', 'tok'))).resolves.toEqual({
            ok: false,
            raw: { success: false },
        });
    });

    test('joinChallenge runs the shared single-join service over the mock endpoints with no persisted state', async () => {
        await expect(mockApiClient.joinChallenge(900002, true, 'tok')).resolves.toEqual({ status: 'joined' });
        expect(joinChallengeSingle).toHaveBeenCalledWith(
            900002,
            'tok',
            expect.objectContaining({
                getMemberChallenges: mockApiClient.getMemberChallenges,
                coinsUnlock: mockApiClient.coinsUnlock,
                submitToChallenge: mockApiClient.submitToChallenge,
                joinStateStore: null,
            }),
            { spendCoins: true },
        );
        expect(cat.debug).toHaveBeenCalledWith('Join challenge ID: 900002, spendCoins: true', null);
    });

    test('forgetUnconfirmedPayment runs the shared service over the mock endpoints, whose join-state store is null', async () => {
        await expect(mockApiClient.forgetUnconfirmedPayment(900002, 'tok')).resolves.toEqual({
            status: 'nothing-to-forget',
            challengeId: 1,
        });
        expect(forgetUnconfirmedPayment).toHaveBeenCalledWith(
            900002,
            'tok',
            expect.objectContaining({ joinStateStore: null }),
        );
    });

    test('joinChallenge passes the confirmed cost on to the shared service', async () => {
        await mockApiClient.joinChallenge(900002, true, 'tok', 100);
        expect(joinChallengeSingle).toHaveBeenLastCalledWith(900002, 'tok', expect.any(Object), {
            spendCoins: true,
            expectedCost: 100,
        });
    });

    test('joinChallenge treats anything but a literal true as "do not spend"', async () => {
        await mockApiClient.joinChallenge(900002, invalid('yes'), 'tok');
        expect(joinChallengeSingle).toHaveBeenCalledWith(900002, 'tok', expect.any(Object), { spendCoins: false });
    });
});

describe('searchTagAutocomplete', () => {
    test('substring match over the library tags, like the live endpoint', async () => {
        await expect(
            settle(invalid<TwoArgAutocomplete>(mockApiClient.searchTagAutocomplete)('tok', 'FLOW')),
        ).resolves.toEqual(['flower']);
    });

    test.each([['fl'], [null], [123]])('%p (under three characters / not text) answers nothing', async (term) => {
        await expect(
            settle(invalid<TwoArgAutocomplete>(mockApiClient.searchTagAutocomplete)('tok', term)),
        ).resolves.toEqual([]);
    });
});

describe('submitVotes — no vote metadata', () => {
    const images = [{ id: 'i1' }];

    test.each([
        ['a challenge with its pre-vote exposure', { id: 31 }, { exposure: { exposure_factor: 42.4 } }],
        ['a challenge without one', { id: 32 }, undefined],
        ['no challenge', undefined, undefined],
    ])(
        'a successful mock vote for %s writes no metadata, the real metadata.json included',
        async (_name, challenge, voting) => {
            await settle(mockApiClient.submitVotes(invalid({ images, challenge, voting }), 'tok', 80));
            expect(metadata.updateChallengeVoteMetadata).not.toHaveBeenCalled();
            expect(cat.debug).toHaveBeenCalledWith('Exposure threshold: 80', null);
            expect(cat.info).toHaveBeenCalledWith('Submitting mock votes successfully', null);
            expect(cat.success).not.toHaveBeenCalled();
        },
    );

    test('a payload without an images list is logged as 0 and rejected', async () => {
        await expect(settle(mockApiClient.submitVotes(invalid({}), 'tok'))).rejects.toEqual(
            expect.objectContaining({ success: false }),
        );
        expect(cat.debug).toHaveBeenCalledWith('Vote images count: 0', null);
    });
});

describe('fetchChallengesAndVote — join pre-step', () => {
    test('a join pass that throws a non-Error is logged and voting still runs', async () => {
        runJoinPass.mockRejectedValueOnce('join exploded');
        await expect(mockApiClient.fetchChallengesAndVote('tok')).resolves.toEqual({ success: true, message: 'pass' });
        expect(cat.warning).toHaveBeenCalledWith('Mock join pass errored: join exploded', null);
        expect(runVotingPass).toHaveBeenCalledWith(
            'tok',
            null,
            expect.objectContaining({ cleanupStaleMetadata: null }),
        );
    });

    test('a join pass that throws an Error is logged by message', async () => {
        runJoinPass.mockRejectedValueOnce(new Error('boom'));
        await mockApiClient.fetchChallengesAndVote('tok');
        expect(cat.warning).toHaveBeenCalledWith('Mock join pass errored: boom', null);
    });

    test('reads the missions over the mock endpoint and hands the same needs to the join pass and the vote', async () => {
        const needs = { join: 1, fill: 0, turbo: 2, boost: 0, vote: 0 };
        loadMissionNeeds.mockResolvedValueOnce(needs);
        const unregister = jest.fn();
        registerMissionNeeds.mockReturnValueOnce(unregister);
        await mockApiClient.fetchChallengesAndVote('tok');
        expect(loadMissionNeeds).toHaveBeenCalledWith('tok', expect.any(Number), {
            getMyMissions: expect.any(Function),
        });
        expect(runJoinPass.mock.calls.at(-1)![3]).toBe(needs);
        expect(runVotingPass.mock.calls.at(-1)![2].missions).toBe(needs);
        expect(runVotingPass.mock.calls.at(-1)![2].refreshMissionNeeds).toBeNull();
        expect(registerMissionNeeds).toHaveBeenLastCalledWith('tok', needs);
        expect(unregister).toHaveBeenCalledTimes(1);
    });

    test('headless mock mode also passes a live mission refresh', async () => {
        const original = Object.getOwnPropertyDescriptor(globalThis, '__GS_HEADLESS__');
        Object.assign(globalThis, { __GS_HEADLESS__: true });
        loadMissionNeeds
            .mockResolvedValueOnce({ join: 0, fill: 0, turbo: 1, boost: 0, vote: 0 })
            .mockResolvedValueOnce({ join: 0, fill: 0, turbo: 0, boost: 0, vote: 0 });
        try {
            await mockApiClient.fetchChallengesAndVote('tok');
            const refresh = runVotingPass.mock.calls.at(-1)![2].refreshMissionNeeds;
            expect(refresh).toEqual(expect.any(Function));
            await expect(refresh?.()).resolves.toMatchObject({ turbo: 0 });
        } finally {
            if (original) Object.defineProperty(globalThis, '__GS_HEADLESS__', original);
            else Reflect.deleteProperty(globalThis, '__GS_HEADLESS__');
        }
    });

    test('a single-challenge run skips the join pass', async () => {
        await mockApiClient.fetchChallengesAndVote('tok', 7);
        expect(runJoinPass).not.toHaveBeenCalled();
        expect(runVotingPass).toHaveBeenCalledWith('tok', 7, expect.any(Object));
    });
});

describe('getVoteImages — session cache', () => {
    test('a second fetch for the same challenge reuses the generated images', async () => {
        const challenge = invalid<Challenge>({ id: 9, title: 'Cached', url: 'street-photography-2024' });
        const first = await settle(mockApiClient.getVoteImages(challenge, 'tok'));
        const second = await settle(mockApiClient.getVoteImages(challenge, 'tok'));
        expect(second).toBe(first);
        expect(cat.debug).toHaveBeenCalledWith('Using cached vote images for Cached', null);
    });
});
