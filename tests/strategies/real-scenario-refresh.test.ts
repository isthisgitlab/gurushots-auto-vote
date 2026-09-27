/**
 * In the Android app WebView the native background service advances
 * scenarios in its own JS context, so the in-app pass re-reads the shared
 * scenario state first — its phase-settings overlay must be current.
 */

import type * as votingOrchestratorModule from '../../src/js/services/votingOrchestrator';
import type * as scenarioRunnerModule from '../../src/js/services/scenarioRunner';
import type * as scenarioStateStoreModule from '../../src/js/scenarioStateStore';
import type * as realModule from '../../src/js/strategies/real';

jest.mock('../../src/js/services/votingOrchestrator', () => ({
    runVotingPass: jest.fn(async () => ({ success: true })),
}));
jest.mock('../../src/js/services/scenarioRunner', () => ({ backgroundServiceOwnsScenarios: jest.fn() }));
jest.mock('../../src/js/scenarioStateStore', () => ({
    scenarioStateLedger: {},
    refreshScenarioStateAsync: jest.fn(async () => {}),
}));
jest.mock('../../src/js/services/joinChallenges', () => ({ runJoinPass: jest.fn(), joinChallengeSingle: jest.fn() }));
jest.mock('../../src/js/services/autoClaim', () => ({ runClaimPass: jest.fn() }));

const { runVotingPass } = jest.mocked(
    require('../../src/js/services/votingOrchestrator') as typeof votingOrchestratorModule,
);
const { backgroundServiceOwnsScenarios } = jest.mocked(
    require('../../src/js/services/scenarioRunner') as typeof scenarioRunnerModule,
);
const { refreshScenarioStateAsync } = jest.mocked(
    require('../../src/js/scenarioStateStore') as typeof scenarioStateStoreModule,
);
const { fetchChallengesAndVote } = require('../../src/js/strategies/real') as typeof realModule;

beforeEach(() => jest.clearAllMocks());

test('re-reads the scenario state before the pass when the background service owns scenarios', async () => {
    backgroundServiceOwnsScenarios.mockReturnValue(true);
    await fetchChallengesAndVote('tok', '7');
    expect(refreshScenarioStateAsync).toHaveBeenCalledTimes(1);
    expect(refreshScenarioStateAsync.mock.invocationCallOrder[0]).toBeLessThan(
        runVotingPass.mock.invocationCallOrder[0],
    );
    expect(runVotingPass.mock.calls[0][2].scenarios!.enabled!()).toBe(false);
});

test('elsewhere the pass starts straight away and owns scenarios', async () => {
    backgroundServiceOwnsScenarios.mockReturnValue(false);
    await fetchChallengesAndVote('tok', '7');
    expect(refreshScenarioStateAsync).not.toHaveBeenCalled();
    expect(runVotingPass.mock.calls[0][2].scenarios!.enabled!()).toBe(true);
});
