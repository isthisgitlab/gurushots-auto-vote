/**
 * Tests for the mock prize-claim surface in mock/index.ts: the four endpoint
 * fixtures (and their no-token shapes), and the claim pre-step the mock
 * fetchChallengesAndVote runs — wired to the mock endpoints, skipped for a
 * single-challenge run, and never allowed to abort voting.
 */

jest.mock('../../src/ts/services/autoClaim', () => ({ runClaimPass: jest.fn() }));
jest.mock('../../src/ts/services/joinChallenges', () => ({
    runJoinPass: jest.fn(async () => undefined),
    joinChallengeSingle: jest.fn(),
}));
jest.mock('../../src/ts/services/votingOrchestrator', () => ({
    runVotingPass: jest.fn(async () => ({ success: true, challenges: [] })),
}));
jest.mock('../../src/ts/logger', () => {
    const level = {
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        api: jest.fn(),
    };
    return { withCategory: jest.fn(() => level), __level: level };
});

import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(loggerModule);
import type * as autoClaimModule from '../../src/ts/services/autoClaim';
import type * as votingOrchestratorModule from '../../src/ts/services/votingOrchestrator';
import type * as indexModule from '../../src/ts/mock/index';
import { invalid } from '../helpers/invalid';
const { runClaimPass } = jest.mocked(require('../../src/ts/services/autoClaim') as typeof autoClaimModule);
const { runVotingPass } = jest.mocked(
    require('../../src/ts/services/votingOrchestrator') as typeof votingOrchestratorModule,
);
const { mockApiClient } = require('../../src/ts/mock/index') as typeof indexModule;

/** The shared category logger this file's logger mock hands out. */
type LoggerMock = {
    __level: jest.Mocked<Pick<loggerModule.CategoryLogger, 'info' | 'error' | 'debug' | 'success' | 'warning' | 'api'>>;
};

beforeEach(() => {
    jest.clearAllMocks();
    runClaimPass.mockResolvedValue(invalid(undefined));
});

describe('mock prize-claim endpoints', () => {
    test('getMyCompletedChallenges returns one claimable and one claimed challenge', async () => {
        const items = await mockApiClient.getMyCompletedChallenges('tok', 0, 20);
        expect(items.map((c) => [c.id, c.member!.rewards_by_section!.claim_state])).toEqual([
            [900101, 'CLAIM'],
            [900102, 'CLAIMED'],
        ]);
        expect(items[0].member!.rewards_by_section!.sections![0]).toEqual(
            expect.objectContaining({ type: 'TOTAL', resources: [{ type: 'COINS', title: 'Coins', value: 60 }] }),
        );
    });

    test('getMyMissions returns one claimable and two in-progress missions', async () => {
        const list = await mockApiClient.getMyMissions('tok');
        expect(list.map((m) => [m.id, m.claim_state])).toEqual([
            [900201, 'CLAIM'],
            [900202, 'DISABLED'],
            [900203, 'DISABLED'],
        ]);
    });

    test('both claims confirm', async () => {
        await expect(mockApiClient.claimChallengeResources(900101, 'tok')).resolves.toBe(true);
        await expect(mockApiClient.claimMissionPrize(900201, 'tok')).resolves.toBe(true);
    });

    test('no token resolves the empty / unconfirmed shapes', async () => {
        await expect(mockApiClient.getMyCompletedChallenges(invalid(null))).resolves.toEqual([]);
        await expect(mockApiClient.getMyMissions('')).resolves.toEqual([]);
        await expect(mockApiClient.claimChallengeResources(1, invalid(null))).resolves.toBe(false);
        await expect(mockApiClient.claimMissionPrize(1, invalid(undefined))).resolves.toBe(false);
    });
});

describe('mock fetchChallengesAndVote claim pre-step', () => {
    test('runs the claim pass with the mock endpoints before voting', async () => {
        await mockApiClient.fetchChallengesAndVote('tok');
        expect(runClaimPass).toHaveBeenCalledWith('tok', expect.any(Number), {
            getMyCompletedChallenges: mockApiClient.getMyCompletedChallenges,
            claimChallengeResources: mockApiClient.claimChallengeResources,
            getMyMissions: mockApiClient.getMyMissions,
            claimMissionPrize: mockApiClient.claimMissionPrize,
        });
        expect(runClaimPass.mock.invocationCallOrder[0]).toBeLessThan(runVotingPass.mock.invocationCallOrder[0]);
    });

    test('is skipped for a single-challenge run', async () => {
        await mockApiClient.fetchChallengesAndVote('tok', 5);
        expect(runClaimPass).not.toHaveBeenCalled();
        expect(runVotingPass).toHaveBeenCalledTimes(1);
    });

    test.each([
        ['an Error', new Error('boom'), 'boom'],
        ['a non-Error value', 'plain', 'plain'],
    ])('a claim pass that throws %s is logged and voting still runs', async (_label, thrown, expected) => {
        runClaimPass.mockRejectedValue(thrown);
        const result = await mockApiClient.fetchChallengesAndVote('tok');
        expect(result).toEqual({ success: true, challenges: [] });
        expect(invalid<LoggerMock>(logger).__level.warning).toHaveBeenCalledWith(
            `Mock claim pass errored: ${expected}`,
            null,
        );
    });
});
