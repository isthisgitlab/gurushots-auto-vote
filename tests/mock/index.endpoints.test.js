/**
 * mock/index.js — the mock endpoints the shared services run against in mock
 * mode. Uses the REAL mock data modules (index.test.js stubs them) and fake
 * timers, so the simulated latency never slows the suite.
 *
 * Every endpoint must honour the no-token contract (resolve the real
 * counterpart's failure shape, never reject) and its fixture sentinels
 * (900004 unlock/spend fails, 900005 submit fails).
 */

jest.mock('../../src/js/metadata', () => ({ updateChallengeVoteMetadata: jest.fn(() => true) }));
jest.mock('../../src/js/services/votingOrchestrator', () => ({
    runVotingPass: jest.fn(async () => ({ success: true, message: 'pass' })),
}));
jest.mock('../../src/js/services/joinChallenges', () => ({
    runJoinPass: jest.fn(async () => ({ ran: false, joined: 0, results: [] })),
    joinChallengeSingle: jest.fn(async () => ({ status: 'joined' })),
}));

const logger = require('../../src/js/logger');
const metadata = require('../../src/js/metadata');
const { runVotingPass } = require('../../src/js/services/votingOrchestrator');
const { runJoinPass, joinChallengeSingle } = require('../../src/js/services/joinChallenges');
const { mockApiClient, clearSessionCache } = require('../../src/js/mock/index');

/** Resolve a promise that is gated on simulated latency. */
const settle = async (promise) => {
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

let cat;
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
    logger.withCategory.mockReturnValue(cat);
    clearSessionCache();
});
afterEach(() => jest.useRealTimers());

describe('no-token contract for every endpoint not covered elsewhere', () => {
    test.each([
        ['applyTurbo', () => mockApiClient.applyTurbo(1, 'img', null), { ok: false, raw: null }],
        [
            'runTurboMiniGame',
            () => mockApiClient.runTurboMiniGame({ id: 1 }, null),
            { played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false },
        ],
        ['getEligiblePhotos', () => mockApiClient.getEligiblePhotos(1, null), []],
        ['getImageData', () => mockApiClient.getImageData('photo_old_008', null), null],
        ['submitToChallenge', () => mockApiClient.submitToChallenge(1, ['a'], null), { ok: false, raw: null }],
        ['getMemberChallenges', () => mockApiClient.getMemberChallenges(null, 'open'), []],
        ['getBankroll', () => mockApiClient.getBankroll(null), null],
        ['getCurrentMemberProfile', () => mockApiClient.getCurrentMemberProfile(null), null],
        ['searchTagAutocomplete', () => mockApiClient.searchTagAutocomplete(null, 'flow'), []],
        ['coinsUnlock', () => mockApiClient.coinsUnlock(1, null), { ok: false, raw: null }],
        [
            'joinChallenge',
            () => mockApiClient.joinChallenge(1, true, null),
            { status: 'not-authenticated', challengeId: null, cost: 0 },
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

    test('runTurboMiniGame reports one won battle', async () => {
        await expect(settle(mockApiClient.runTurboMiniGame({ id: 5 }, 'tok'))).resolves.toEqual({
            played: 1,
            correct: 1,
            flipped: 0,
            doubleFailed: 0,
            won: true,
        });
        expect(cat.api).toHaveBeenCalledWith('Mock runTurboMiniGame', null);
    });
});

describe('getEligiblePhotos', () => {
    test('with no options returns the whole library', async () => {
        const items = await settle(mockApiClient.getEligiblePhotos(1, 'tok'));
        expect(items).toHaveLength(8);
    });

    test('a search is an EXACT tag match, like the live endpoint', async () => {
        const exact = await settle(mockApiClient.getEligiblePhotos(1, 'tok', { search: ' Flower ' }));
        expect(exact.map((p) => p.id)).toEqual(['photo_pink_flower_001', 'photo_blocked_007']);
        const partial = await settle(mockApiClient.getEligiblePhotos(1, 'tok', { search: 'flow' }));
        expect(partial).toEqual([]);
    });

    test('a non-string search is ignored', async () => {
        expect(await settle(mockApiClient.getEligiblePhotos(1, 'tok', { search: 42 }))).toHaveLength(8);
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
        await expect(mockApiClient.submitToChallenge(1, ids, 'tok')).resolves.toEqual({
            ok: false,
            raw: { success: false, error: 'No image_ids provided' },
        });
    });

    test('logs a non-array id list as invalid', async () => {
        await mockApiClient.submitToChallenge(1, 'x', 'tok');
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
        const list = await settle(mockApiClient.getMemberChallenges('tok', 'open'));
        expect(list.map((c) => c.id)).toEqual([900001, 900002, 900003, 900004, 900005]);
        const nowSec = Math.floor(Date.now() / 1000);
        list.forEach((c) => {
            expect(c.close_time).toBeGreaterThan(nowSec);
            expect(c.start_time).toBeLessThan(nowSec);
        });
        expect(cat.debug).toHaveBeenCalledWith('Filter: open', null);
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

    test('joinChallenge treats anything but a literal true as "do not spend"', async () => {
        await mockApiClient.joinChallenge(900002, 'yes', 'tok');
        expect(joinChallengeSingle).toHaveBeenCalledWith(900002, 'tok', expect.any(Object), { spendCoins: false });
    });
});

describe('searchTagAutocomplete', () => {
    test('substring match over the library tags, like the live endpoint', async () => {
        await expect(settle(mockApiClient.searchTagAutocomplete('tok', 'FLOW'))).resolves.toEqual(['flower']);
    });

    test.each([['fl'], [null], [123]])('%p (under three characters / not text) answers nothing', async (term) => {
        await expect(settle(mockApiClient.searchTagAutocomplete('tok', term))).resolves.toEqual([]);
    });
});

describe('submitVotes — metadata bookkeeping', () => {
    const images = [{ id: 'i1' }];

    test('records the ORIGINAL exposure for the challenge after a successful mock vote', async () => {
        await settle(
            mockApiClient.submitVotes(
                { images, challenge: { id: 31 }, voting: { exposure: { exposure_factor: 42.4 } } },
                'tok',
                80,
            ),
        );
        expect(metadata.updateChallengeVoteMetadata).toHaveBeenCalledWith('31', 42);
        expect(cat.debug).toHaveBeenCalledWith('Exposure threshold: 80', null);
        expect(cat.success).toHaveBeenCalledWith(
            'Mock metadata updated for challenge 31: original exposure 42%',
            null,
            null,
        );
    });

    test('defaults the original exposure to 50% when the payload has none', async () => {
        await settle(mockApiClient.submitVotes({ images, challenge: { id: 32 } }, 'tok'));
        expect(metadata.updateChallengeVoteMetadata).toHaveBeenCalledWith('32', 50);
    });

    test('a failed metadata write is a warning, the vote still succeeds', async () => {
        metadata.updateChallengeVoteMetadata.mockReturnValueOnce(false);
        const res = await settle(mockApiClient.submitVotes({ images, challenge: { id: 33 } }, 'tok'));
        expect(res).toEqual(expect.objectContaining({ success: true }));
        expect(cat.warning).toHaveBeenCalledWith('Failed to update mock metadata for challenge 33', null);
    });

    test('a throwing metadata write is logged, the vote still succeeds', async () => {
        metadata.updateChallengeVoteMetadata.mockImplementationOnce(() => {
            throw new Error('disk');
        });
        const res = await settle(mockApiClient.submitVotes({ images, challenge: { id: 34 } }, 'tok'));
        expect(res).toEqual(expect.objectContaining({ success: true }));
        expect(cat.error).toHaveBeenCalledWith('Error updating mock metadata: disk', null);
    });

    test.each([[undefined], [{}]])('no challenge id (%p) → no metadata write', async (challenge) => {
        await settle(mockApiClient.submitVotes({ images, challenge }, 'tok'));
        expect(metadata.updateChallengeVoteMetadata).not.toHaveBeenCalled();
    });

    test('a payload without an images list is logged as 0 and rejected', async () => {
        await expect(settle(mockApiClient.submitVotes({}, 'tok'))).rejects.toEqual(
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

    test('a single-challenge run skips the join pass', async () => {
        await mockApiClient.fetchChallengesAndVote('tok', null, 7);
        expect(runJoinPass).not.toHaveBeenCalled();
        expect(runVotingPass).toHaveBeenCalledWith('tok', 7, expect.any(Object));
    });
});

describe('getVoteImages — session cache', () => {
    test('a second fetch for the same challenge reuses the generated images', async () => {
        const challenge = { id: 9, title: 'Cached', url: 'street-photography-2024' };
        const first = await settle(mockApiClient.getVoteImages(challenge, 'tok'));
        const second = await settle(mockApiClient.getVoteImages(challenge, 'tok'));
        expect(second).toBe(first);
        expect(cat.debug).toHaveBeenCalledWith('Using cached vote images for Cached', null);
    });
});
