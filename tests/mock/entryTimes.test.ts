/**
 * Mock mode records when a photo went in, as real mode does (services/entryTimes): a submit or swap through the
 * mock client — the voting pass's, or the one the API factory captured for a manual fill — is exact, and a fetch
 * carries each entry's recorded time. One in-memory ledger serves all of them; the real file is never touched.
 */

jest.mock('../../src/ts/metadata', () => ({ updateChallengeVoteMetadata: jest.fn(() => true) }));
jest.mock('../../src/ts/services/votingOrchestrator', () => ({
    runVotingPass: jest.fn(async () => ({ success: true, message: 'pass' })),
}));
jest.mock('../../src/ts/services/missions', () => ({
    loadMissionNeeds: jest.fn(async () => null),
    registerMissionNeeds: jest.fn(() => null),
}));
jest.mock('../../src/ts/services/joinChallenges', () => ({
    runJoinPass: jest.fn(async () => ({ ran: false, joined: 0, results: [] })),
    joinChallengeSingle: jest.fn(),
    forgetUnconfirmedPayment: jest.fn(),
}));
jest.mock('../../src/ts/services/autoClaim', () => ({ runClaimPass: jest.fn(async () => undefined) }));

import type * as votingOrchestratorModule from '../../src/ts/services/votingOrchestrator';
import type * as indexModule from '../../src/ts/mock/index';
import type * as strategyModule from '../../src/ts/mock/strategy';
import type * as apiFactoryModule from '../../src/ts/apiFactory';
import type { Challenge } from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';

const { runVotingPass } = jest.mocked(
    require('../../src/ts/services/votingOrchestrator') as typeof votingOrchestratorModule,
);
const { mockApiClient, clearSessionCache } = require('../../src/ts/mock/index') as typeof indexModule;
const { mockEntryAgeLedger } = require('../../src/ts/mock/strategy') as typeof strategyModule;
const { getApiStrategy } = require('../../src/ts/apiFactory') as typeof apiFactoryModule;

const settle = async <T>(promise: Promise<T>): Promise<T> => {
    let done = false;
    const tracked = promise.finally(() => {
        done = true;
    });
    tracked.catch(() => {});
    while (!done) {
        await jest.advanceTimersByTimeAsync(500);
    }
    return promise;
};

const listing = (id: number, entryIds: string[]) =>
    invalid<Challenge>({
        id,
        close_time: 4_000_000_000,
        member: { ranking: { entries: entryIds.map((entryId) => ({ id: entryId })) } },
    });

beforeEach(() => {
    jest.useFakeTimers();
    clearSessionCache();
});
afterEach(() => jest.useRealTimers());

describe('mock mode records when a photo went in', () => {
    test('a submit through the mock client is exact, and its result is the endpoint’s own', async () => {
        const result = await settle(mockApiClient.submitToChallenge(910_001, ['mock_a'], 'tok'));
        expect(result.ok).toBe(true);
        expect(mockEntryAgeLedger.observeAll([listing(910_001, ['mock_a'])], 1)['910001'].mock_a.exact).toBe(true);
    });

    test('so is one through the surface the API factory hands IPC (its captured method)', async () => {
        const strategy = getApiStrategy({ mock: true });
        await settle(strategy.submitToChallenge(910_002, ['mock_b'], 'tok'));
        expect(mockEntryAgeLedger.observeAll([listing(910_002, ['mock_b'])], 1)['910002'].mock_b.exact).toBe(true);
    });

    test('so is the pass’s: its submit is the recording one, over the same ledger', async () => {
        await settle(mockApiClient.fetchChallengesAndVote('tok'));
        const deps = runVotingPass.mock.calls.at(-1)![2];
        expect(deps.entryAges).toBe(mockEntryAgeLedger);
        await settle(deps.api.submitToChallenge(910_003, ['mock_c'], 'tok'));
        expect(mockEntryAgeLedger.enteredAt(910_003, 'mock_c')).toBeGreaterThan(0);
    });

    test('a swap through the mock client records the photo swapped in', async () => {
        await settle(mockApiClient.swapPhoto(910_004, 'old', 'mock_d', 'tok'));
        expect(mockEntryAgeLedger.enteredAt(910_004, 'mock_d')).toBeGreaterThan(0);
        expect(mockEntryAgeLedger.enteredAt(910_004, 'old')).toBeNull();
    });

    test('a failed submit is not recorded', async () => {
        const result = await settle(mockApiClient.submitToChallenge(900_005, ['mock_e'], 'tok'));
        expect(result.ok).toBe(false);
        expect(mockEntryAgeLedger.enteredAt(900_005, 'mock_e')).toBeNull();
    });

    test('a fetch carries the recorded time on each entry', async () => {
        const first = await settle(mockApiClient.getActiveChallenges('tok'));
        const challenge = first.challenges.find((c) => (c.member?.ranking?.entries?.length ?? 0) > 0)!;
        const entry = challenge.member!.ranking!.entries![0];
        mockEntryAgeLedger.markSubmitted(challenge.id, [entry.id], 1_800_000_000);

        const second = await settle(mockApiClient.getActiveChallenges('tok'));

        const sameEntry = second.challenges
            .find((c) => String(c.id) === String(challenge.id))!
            .member!.ranking!.entries!.find((e) => e.id === entry.id)!;
        expect(sameEntry.appEntered).toEqual({ at: 1_800_000_000, exact: true });
    });

    test('a fetch without a token is still the flagged empty list', async () => {
        await expect(settle(mockApiClient.getActiveChallenges(''))).resolves.toEqual({
            challenges: [],
            fetchFailed: true,
        });
    });
});
