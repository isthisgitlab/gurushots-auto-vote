/**
 * Tests for services/autoClaim.js — the hourly prize-claim pre-step: the
 * default-off gate, the once-an-hour throttle, claiming only CLAIM-state items,
 * paging, cancellation, and one half's failure never blocking the other.
 */

jest.mock('../../src/js/logger', () => {
    const level = { info: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return { withCategory: jest.fn(() => level), __level: level };
});
jest.mock('../../src/js/voting/cancellation', () => ({ isCancelled: jest.fn(() => false) }));
jest.mock('../../src/js/settings', () => ({ getEffectiveSetting: jest.fn() }));

const logger = require('../../src/js/logger');
const cancellation = require('../../src/js/voting/cancellation');
const settings = require('../../src/js/settings');
const { CLAIM_INTERVAL_MS, runClaimPass, resetClaimThrottle } = require('../../src/js/services/autoClaim');

const T0 = 1_790_000_000_000;

const challenge = (id, claimState, sections) => ({
    id,
    title: `Challenge ${id}`,
    member: {
        rewards_by_section: {
            claim_state: claimState,
            sections: sections ?? [{ type: 'TOTAL', resources: [{ type: 'COINS', value: 60 }] }],
        },
    },
});
const mission = (id, claimState, prizes = [{ type: 'COINS', amount: 20 }]) => ({
    id,
    name: `Mission ${id}`,
    claim_state: claimState,
    prizes,
});

const makeDeps = (over = {}) => ({
    getMyCompletedChallenges: jest.fn(async () => [challenge(1, 'CLAIM'), challenge(2, 'CLAIMED')]),
    claimChallengeResources: jest.fn(async () => true),
    getMyMissions: jest.fn(async () => [mission(10, 'CLAIM'), mission(11, 'DISABLED')]),
    claimMissionPrize: jest.fn(async () => true),
    ...over,
});

const successMessages = () => logger.__level.success.mock.calls.map((c) => c[0]);
const warningMessages = () => logger.__level.warning.mock.calls.map((c) => c[0]);

beforeEach(() => {
    jest.clearAllMocks();
    resetClaimThrottle();
    settings.getEffectiveSetting.mockImplementation((key) => (key === 'autoClaimPrizes' ? true : undefined));
    cancellation.isCancelled.mockReturnValue(false);
});

describe('gating', () => {
    test('setting off (the default) makes no calls', async () => {
        settings.getEffectiveSetting.mockReturnValue(false);
        const deps = makeDeps();
        const res = await runClaimPass('tok', T0, deps);
        expect(res).toEqual({ ran: false, challengesClaimed: 0, missionsClaimed: 0, results: [] });
        expect(deps.getMyCompletedChallenges).not.toHaveBeenCalled();
        expect(deps.getMyMissions).not.toHaveBeenCalled();
    });

    test('no token makes no calls', async () => {
        const deps = makeDeps();
        expect((await runClaimPass('', T0, deps)).ran).toBe(false);
        expect(deps.getMyCompletedChallenges).not.toHaveBeenCalled();
    });

    test('runs at most once per interval', async () => {
        const deps = makeDeps();
        expect((await runClaimPass('tok', T0, deps)).ran).toBe(true);
        expect((await runClaimPass('tok', T0 + CLAIM_INTERVAL_MS - 1, deps)).ran).toBe(false);
        expect(deps.getMyCompletedChallenges).toHaveBeenCalledTimes(1);
        expect((await runClaimPass('tok', T0 + CLAIM_INTERVAL_MS, deps)).ran).toBe(true);
        expect(deps.getMyCompletedChallenges).toHaveBeenCalledTimes(2);
    });

    test('the throttle is stamped even when every call fails', async () => {
        const deps = makeDeps({
            getMyCompletedChallenges: jest.fn(async () => {
                throw new Error('down');
            }),
            getMyMissions: jest.fn(async () => {
                throw new Error('down');
            }),
        });
        expect((await runClaimPass('tok', T0, deps)).ran).toBe(true);
        expect((await runClaimPass('tok', T0 + 1000, deps)).ran).toBe(false);
        expect(deps.getMyCompletedChallenges).toHaveBeenCalledTimes(1);
    });
});

describe('claiming', () => {
    test('claims only CLAIM-state challenges and missions', async () => {
        const deps = makeDeps();
        const res = await runClaimPass('tok', T0, deps);
        expect(deps.claimChallengeResources).toHaveBeenCalledTimes(1);
        expect(deps.claimChallengeResources).toHaveBeenCalledWith(1, 'tok');
        expect(deps.claimMissionPrize).toHaveBeenCalledTimes(1);
        expect(deps.claimMissionPrize).toHaveBeenCalledWith(10, 'tok');
        expect(res).toEqual({
            ran: true,
            challengesClaimed: 1,
            missionsClaimed: 1,
            results: [
                { kind: 'challenge', id: 1, claimed: true },
                { kind: 'mission', id: 10, claimed: true },
            ],
        });
        expect(successMessages()).toEqual([
            '🎁 Claimed challenge "Challenge 1": 60 COINS',
            '🎁 Claimed mission "Mission 10": 20 COINS',
        ]);
    });

    test('reads the first page of 20', async () => {
        const deps = makeDeps();
        await runClaimPass('tok', T0, deps);
        expect(deps.getMyCompletedChallenges).toHaveBeenCalledWith('tok', 0, 20);
    });

    test('pages while pages are full, stopping at a short page', async () => {
        const full = Array.from({ length: 20 }, (_, i) => challenge(100 + i, 'CLAIMED'));
        const deps = makeDeps({
            getMyCompletedChallenges: jest
                .fn()
                .mockResolvedValueOnce(full)
                .mockResolvedValueOnce([challenge(5, 'CLAIM')]),
        });
        await runClaimPass('tok', T0, deps);
        expect(deps.getMyCompletedChallenges).toHaveBeenNthCalledWith(2, 'tok', 20, 20);
        expect(deps.getMyCompletedChallenges).toHaveBeenCalledTimes(2);
        expect(deps.claimChallengeResources).toHaveBeenCalledWith(5, 'tok');
    });

    test('reads at most 5 pages', async () => {
        const full = Array.from({ length: 20 }, (_, i) => challenge(i, 'CLAIMED'));
        const deps = makeDeps({ getMyCompletedChallenges: jest.fn(async () => full) });
        await runClaimPass('tok', T0, deps);
        expect(deps.getMyCompletedChallenges).toHaveBeenCalledTimes(5);
    });

    test('tolerates non-array list responses and malformed items', async () => {
        const deps = makeDeps({
            getMyCompletedChallenges: jest.fn(async () => null),
            getMyMissions: jest.fn(async () => [null, mission(12, 'CLAIM')]),
        });
        const res = await runClaimPass('tok', T0, deps);
        expect(deps.claimChallengeResources).not.toHaveBeenCalled();
        expect(res.missionsClaimed).toBe(1);

        resetClaimThrottle();
        const deps2 = makeDeps({
            getMyCompletedChallenges: jest.fn(async () => [null, { id: 3 }]),
            getMyMissions: jest.fn(async () => undefined),
        });
        const res2 = await runClaimPass('tok', T0, deps2);
        expect(res2).toEqual({ ran: true, challengesClaimed: 0, missionsClaimed: 0, results: [] });
    });

    test('an unconfirmed claim is recorded and warned, not counted', async () => {
        const deps = makeDeps({ claimChallengeResources: jest.fn(async () => false) });
        const res = await runClaimPass('tok', T0, deps);
        expect(res.challengesClaimed).toBe(0);
        expect(res.results[0]).toEqual({ kind: 'challenge', id: 1, claimed: false });
        expect(warningMessages()).toContain('challenge 1 claim was not confirmed');
    });

    test('a throwing claim is logged and the next item is still claimed', async () => {
        const deps = makeDeps({
            getMyMissions: jest.fn(async () => [mission(10, 'CLAIM'), mission(13, 'CLAIM')]),
            claimMissionPrize: jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(true),
        });
        const res = await runClaimPass('tok', T0, deps);
        expect(deps.claimMissionPrize).toHaveBeenCalledTimes(2);
        expect(res.missionsClaimed).toBe(1);
        expect(warningMessages()).toContain('mission 10 claim errored: boom');
    });

    test('a failing challenge list does not block missions', async () => {
        const deps = makeDeps({
            getMyCompletedChallenges: jest.fn(async () => {
                throw new Error('list down');
            }),
        });
        const res = await runClaimPass('tok', T0, deps);
        expect(res.missionsClaimed).toBe(1);
        expect(warningMessages()).toContain('could not list claimable challenges: list down');
    });

    test('a failing mission list does not undo challenge claims', async () => {
        const deps = makeDeps({ getMyMissions: jest.fn().mockRejectedValue('nope') });
        const res = await runClaimPass('tok', T0, deps);
        expect(res.challengesClaimed).toBe(1);
        expect(warningMessages()).toContain('could not list claimable missions: nope');
    });

    test('a non-Error throw from a claim is still logged', async () => {
        const deps = makeDeps({ claimChallengeResources: jest.fn().mockRejectedValue('bad') });
        await runClaimPass('tok', T0, deps);
        expect(warningMessages()).toContain('challenge 1 claim errored: bad');
    });

    test('cancellation stops claiming', async () => {
        cancellation.isCancelled.mockReturnValue(true);
        const deps = makeDeps();
        const res = await runClaimPass('tok', T0, deps);
        expect(deps.claimChallengeResources).not.toHaveBeenCalled();
        expect(deps.claimMissionPrize).not.toHaveBeenCalled();
        expect(res.results).toEqual([]);
        expect(warningMessages()).toContain('claim pass cancelled by user');
    });
});

describe('prize descriptions', () => {
    test('falls back to the id and "no listed prizes" when details are missing', async () => {
        const deps = makeDeps({
            getMyCompletedChallenges: jest.fn(async () => [
                { id: 7, member: { rewards_by_section: { claim_state: 'CLAIM' } } },
            ]),
            getMyMissions: jest.fn(async () => [{ id: 8, claim_state: 'CLAIM', prizes: 'n/a' }]),
        });
        await runClaimPass('tok', T0, deps);
        expect(successMessages()).toEqual([
            '🎁 Claimed challenge "7": no listed prizes',
            '🎁 Claimed mission "8": no listed prizes',
        ]);
    });

    test('lists every prize of a mission', async () => {
        const deps = makeDeps({
            getMyCompletedChallenges: jest.fn(async () => []),
            getMyMissions: jest.fn(async () => [
                mission(9, 'CLAIM', [
                    { type: 'COINS', amount: 500 },
                    { type: 'KEY', amount: 1 },
                ]),
            ]),
        });
        await runClaimPass('tok', T0, deps);
        expect(successMessages()).toEqual(['🎁 Claimed mission "Mission 9": 500 COINS, 1 KEY']);
    });
});
