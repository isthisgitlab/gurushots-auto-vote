/**
 * votingOrchestrator — where the automatic key / swap / fill spends sit in the
 * pass: key then swap BEFORE the deadline actions (so an unlocked boost and a
 * swapped-in photo are visible to them), fill AFTER the vote with the pool the
 * vote used (so it only spends when voting fell short). The user-defined
 * scenario step runs before all of them.
 */

jest.mock('../../src/js/settings', () => ({
    getEffectiveSetting: jest.fn(() => false),
}));

jest.mock('../../src/js/services/VotingLogic', () => ({
    isWithinEmergencyWindow: jest.fn(() => false),
    shouldPlayAutoTurbo: jest.fn(() => false),
    orderDeadlineActions: jest.fn(() => []),
    evaluateVotingDecision: jest.fn(() => ({ shouldVote: false, voteReason: 'test skip', targetExposure: 100 })),
}));

jest.mock('../../src/js/services/autoFill', () => ({
    maybeAutoFillChallenge: jest.fn(async () => 'skipped'),
    maybeEmergencyFillChallenge: jest.fn(async () => 'skipped'),
}));

jest.mock('../../src/js/services/currencyAuto', () => ({
    runAutoKey: jest.fn(async () => false),
    runAutoSwap: jest.fn(async () => false),
    runAutoExposureFill: jest.fn(async () => false),
    runMissionFill: jest.fn(async () => false),
}));

jest.mock('../../src/js/services/scenarioRunner', () => ({ runScenarioStep: jest.fn(async () => {}) }));

import votingLogicModule = require('../../src/js/services/VotingLogic');
const votingLogic = jest.mocked(votingLogicModule);
const { runScenarioStep } = jest.mocked(require('../../src/js/services/scenarioRunner') as typeof scenarioRunnerModule);
import autoFillModule = require('../../src/js/services/autoFill');
const autoFill = jest.mocked(autoFillModule);
import currencyAutoModule = require('../../src/js/services/currencyAuto');
const currencyAuto = jest.mocked(currencyAutoModule);
import type * as scenarioRunnerModule from '../../src/js/services/scenarioRunner';
import type * as votingOrchestratorModule from '../../src/js/services/votingOrchestrator';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type { CurrencyPassDeps } from '../../src/js/services/currencyAuto';
import type { MissionNeeds } from '../../src/js/services/missions';
import type { ScenarioDeps } from '../../src/js/types/votingPass';
import { invalid } from '../helpers/invalid';
const { runVotingPass } = require('../../src/js/services/votingOrchestrator') as typeof votingOrchestratorModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;

const NOW = Math.floor(Date.now() / 1000);
const challenge = () =>
    buildChallenge({
        id: 101,
        title: 'Currency',
        close_time: NOW + 3600,
        member: { boost: { state: 'LOCKED' }, ranking: { entries: [], exposure: { exposure_factor: 10 } } },
    });

const makeApi = (voteImages: { images: { id: string }[] } | null = { images: [{ id: 'i1' }] }) => ({
    getActiveChallenges: jest.fn(async () => ({ challenges: [challenge()] })),
    getVoteImages: jest.fn(async () => voteImages),
    submitVotes: jest.fn(async () => ({ success: true })),
});

const currency = invalid<CurrencyPassDeps>({ strategy: {}, swapLedger: {}, spendLedger: {} });
const run = (api: ReturnType<typeof makeApi>) =>
    runVotingPass('tok', null, {
        api: invalid(api),
        cleanupStaleMetadata: null,
        interChallengeDelay: () => 0,
        currency,
    });

const vote = () =>
    votingLogic.evaluateVotingDecision.mockReturnValue(
        invalid({ shouldVote: true, voteReason: 'low', targetExposure: 100 }),
    );

beforeEach(() => {
    jest.clearAllMocks();
    votingLogic.evaluateVotingDecision.mockReturnValue(
        invalid({ shouldVote: false, voteReason: 'skip', targetExposure: 100 }),
    );
    votingLogic.orderDeadlineActions.mockReturnValue(invalid([{ action: 'autoFill' }]));
});

test('key, then swap, then the deadline actions — all with the pass currency deps', async () => {
    await run(makeApi());
    const key = currencyAuto.runAutoKey.mock.invocationCallOrder[0];
    const swap = currencyAuto.runAutoSwap.mock.invocationCallOrder[0];
    const deadline = autoFill.maybeAutoFillChallenge.mock.invocationCallOrder[0];
    expect(key).toBeLessThan(swap);
    expect(swap).toBeLessThan(deadline);
    expect(currencyAuto.runAutoKey).toHaveBeenCalledWith(
        expect.objectContaining({ token: 'tok', currency, challenge: expect.objectContaining({ id: 101 }) }),
    );
});

test('the scenario step runs first, with the pass scenario deps', async () => {
    const scenarios = invalid<ScenarioDeps>({ ledger: {} });
    await runVotingPass('tok', null, {
        api: invalid(makeApi()),
        cleanupStaleMetadata: null,
        interChallengeDelay: () => 0,
        currency,
        scenarios,
    });
    expect(runScenarioStep).toHaveBeenCalledWith(
        expect.objectContaining({ id: 101 }),
        expect.any(Number),
        expect.objectContaining({ scenarios, currency, token: 'tok' }),
    );
    expect(runScenarioStep.mock.invocationCallOrder[0]).toBeLessThan(
        currencyAuto.runAutoKey.mock.invocationCallOrder[0],
    );
});

test('without scenario deps the pass still runs the step, which no-ops', async () => {
    await run(makeApi());
    expect(runScenarioStep).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Number),
        expect.objectContaining({ scenarios: null }),
    );
});

test('fill runs after the vote with the pool the vote used', async () => {
    vote();
    const pool = { images: [{ id: 'i1' }] };
    const api = makeApi(pool);
    await run(api);
    expect(currencyAuto.runAutoExposureFill).toHaveBeenCalledWith(expect.objectContaining({ currency }), pool);
    expect(currencyAuto.runAutoExposureFill.mock.invocationCallOrder[0]).toBeGreaterThan(
        api.submitVotes.mock.invocationCallOrder[0],
    );
});

test('an empty vote pool reaches the fill rule as null', async () => {
    vote();
    await run(makeApi(null));
    expect(currencyAuto.runAutoExposureFill.mock.calls[0][1]).toBeNull();
});

test('no vote this pass → the fill rule gets undefined and judges the pool itself', async () => {
    await run(makeApi());
    expect(currencyAuto.runAutoExposureFill.mock.calls[0]).toHaveLength(2);
    expect(currencyAuto.runAutoExposureFill.mock.calls[0][1]).toBeUndefined();
});

test('a vote that threw skips the fill (the pool is unknown)', async () => {
    vote();
    const api = makeApi();
    api.submitVotes.mockRejectedValue(new Error('boom'));
    await run(api);
    expect(currencyAuto.runAutoExposureFill).not.toHaveBeenCalled();
});

describe('fill missions', () => {
    const runWithMissions = (missions: MissionNeeds) =>
        runVotingPass('tok', null, {
            api: invalid(makeApi()),
            cleanupStaleMetadata: null,
            interChallengeDelay: () => 0,
            currency,
            missions,
        });

    test('with no exposure-rule fill, a mission fill gets what the mission still needs and counts it down', async () => {
        currencyAuto.runMissionFill.mockResolvedValueOnce(true);
        const missions = { join: 0, fill: 2, turbo: 0 };
        await runWithMissions(missions);
        expect(currencyAuto.runMissionFill).toHaveBeenCalledWith(expect.objectContaining({ currency }), 2);
        expect(currencyAuto.runMissionFill.mock.invocationCallOrder[0]).toBeGreaterThan(
            currencyAuto.runAutoExposureFill.mock.invocationCallOrder[0],
        );
        expect(missions.fill).toBe(1);
    });

    test('an exposure-rule fill counts toward the mission and skips the mission fill', async () => {
        currencyAuto.runAutoExposureFill.mockResolvedValueOnce(true);
        const missions = { join: 0, fill: 2, turbo: 0 };
        await runWithMissions(missions);
        expect(currencyAuto.runMissionFill).not.toHaveBeenCalled();
        expect(missions.fill).toBe(1);
    });

    test('without missions the mission fill is asked for 0', async () => {
        await run(makeApi());
        expect(currencyAuto.runMissionFill).toHaveBeenCalledWith(expect.any(Object), 0);
    });

    test('a mission fill that spent nothing leaves the mission as it was', async () => {
        const missions = { join: 0, fill: 2, turbo: 0 };
        await runWithMissions(missions);
        expect(missions.fill).toBe(2);
    });
});
