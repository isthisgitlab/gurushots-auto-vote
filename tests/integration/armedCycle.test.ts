/**
 * The cycle mode of the voting loop (types/votingPass.ts CycleMode) through the real and the mock strategy, the middleware and
 * the run-voting-cycle entry: `full` is the whole cycle; `armed` runs only the installation stage (publication and account
 * rules) and nothing else: no mission read, join, claim sweep, voting pass, pre-join, post-close or currency spend.
 */

jest.mock('../../src/ts/core/services/votingOrchestrator', () => ({
    runVotingPass: jest.fn(async () => ({ success: true, message: 'pass', challenges: [] })),
}));
jest.mock('../../src/ts/core/services/joinChallenges', () => ({
    runJoinPass: jest.fn(),
    joinChallengeSingle: jest.fn(),
}));
jest.mock('../../src/ts/core/services/autoClaim', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/core/services/autoClaim')>(
        '../../src/ts/core/services/autoClaim',
    ),
    runClaimPass: jest.fn(),
}));
jest.mock('../../src/ts/core/services/missions', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/core/services/missions')>('../../src/ts/core/services/missions'),
    loadMissionNeeds: jest.fn(async () => null),
}));
jest.mock('../../src/ts/core/services/scenarioRunner', () => ({
    backgroundServiceOwnsScenarios: jest.fn(() => false),
}));
jest.mock('../../src/ts/core/scenarioStateStore', () => ({
    scenarioStateLedger: {},
    scenarioStateLoaded: jest.fn(() => true),
    refreshScenarioStateAsync: jest.fn(async () => {}),
    mockScenarioStateLedger: {},
    scenarioStepLock: jest.fn(),
}));
const lifecycle = {
    operations: {},
    installation: jest.fn(async () => 'published'),
    preJoin: { armed: () => false, run: jest.fn() },
    postClose: jest.fn(async () => {}),
};
jest.mock('../../src/ts/core/services/scenarioRunner/lifecycle', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/core/services/scenarioRunner/lifecycle')>(
        '../../src/ts/core/services/scenarioRunner/lifecycle',
    ),
    createLifecycle: jest.fn(() => lifecycle),
}));

import votingOrchestratorModule = require('../../src/ts/core/services/votingOrchestrator');
import joinChallengesModule = require('../../src/ts/core/services/joinChallenges');
import autoClaimModule = require('../../src/ts/core/services/autoClaim');
import missionsModule = require('../../src/ts/core/services/missions');
import type * as realModule from '../../src/ts/core/strategies/real';
import type * as mockModule from '../../src/ts/core/mock';
import { runArmedCycle } from '../../src/ts/core/services/scenarioRunner/lifecycle';
import { invalid } from '../helpers/invalid';

const { runVotingPass } = jest.mocked(votingOrchestratorModule);
const { runJoinPass } = jest.mocked(joinChallengesModule);
const { runClaimPass } = jest.mocked(autoClaimModule);
const { loadMissionNeeds } = jest.mocked(missionsModule);
const { fetchChallengesAndVote: realCycle } = require('../../src/ts/core/strategies/real') as typeof realModule;
const mockCycle = (require('../../src/ts/core/mock') as typeof mockModule).mockApiClient.fetchChallengesAndVote;

beforeEach(() => jest.clearAllMocks());

const everythingElse = () => [
    runVotingPass,
    runJoinPass,
    runClaimPass,
    loadMissionNeeds,
    lifecycle.postClose,
    lifecycle.preJoin.run,
];

describe.each([
    ['real', realCycle],
    ['mock', mockCycle],
])('the %s strategy', (_name, cycle) => {
    test('armed: the installation stage with its account rules, and no other work', async () => {
        const result = await cycle('tok', null, 'armed');
        expect(result).toEqual({ success: true, message: 'Installation cycle completed' });
        expect(lifecycle.installation).toHaveBeenCalledTimes(1);
        expect(lifecycle.installation).toHaveBeenCalledWith({ rules: true });
        for (const never of everythingElse()) expect(never).not.toHaveBeenCalled();
    });

    test('armed covers no single challenge: a scoped one is refused and nothing runs', async () => {
        const result = await cycle('tok', '7', 'armed');
        expect(result).toEqual({ success: false, error: 'An installation cycle covers no single challenge' });
        expect(lifecycle.installation).not.toHaveBeenCalled();
        for (const never of everythingElse()) expect(never).not.toHaveBeenCalled();
    });

    test('full (and no mode at all) is the whole cycle as before', async () => {
        for (const run of [() => cycle('tok', null, 'full'), () => cycle('tok', null)]) {
            jest.clearAllMocks();
            await run();
            expect(lifecycle.installation).toHaveBeenCalledWith({ rules: true });
            expect(loadMissionNeeds).toHaveBeenCalledTimes(1);
            expect(runJoinPass).toHaveBeenCalledTimes(1);
            expect(runClaimPass).toHaveBeenCalledTimes(1);
            expect(runVotingPass).toHaveBeenCalledTimes(1);
            expect(lifecycle.postClose).toHaveBeenCalledTimes(1);
        }
    });

    test('a single-challenge full cycle only publishes the installation, and runs the pass for that challenge', async () => {
        await cycle('tok', '7');
        expect(lifecycle.installation).toHaveBeenCalledWith({ rules: false });
        expect(runVotingPass).toHaveBeenCalledTimes(1);
        expect(runJoinPass).not.toHaveBeenCalled();
        expect(lifecycle.postClose).not.toHaveBeenCalled();
    });
});

test('runArmedCycle alone: the installation stage, and the refusal of a scoped cycle', async () => {
    await expect(runArmedCycle(invalid(lifecycle), null)).resolves.toEqual({
        success: true,
        message: 'Installation cycle completed',
    });
    await expect(runArmedCycle(invalid(lifecycle), 3)).resolves.toMatchObject({ success: false });
    expect(lifecycle.installation).toHaveBeenCalledTimes(1);
});
