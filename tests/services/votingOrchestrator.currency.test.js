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
}));

jest.mock('../../src/js/services/scenarioRunner', () => ({ runScenarioStep: jest.fn(async () => {}) }));

const votingLogic = require('../../src/js/services/VotingLogic');
const { runScenarioStep } = require('../../src/js/services/scenarioRunner');
const autoFill = require('../../src/js/services/autoFill');
const currencyAuto = require('../../src/js/services/currencyAuto');
const { runVotingPass } = require('../../src/js/services/votingOrchestrator');
const { buildChallenge } = require('../helpers/challengeFixtures');

const NOW = Math.floor(Date.now() / 1000);
const challenge = () =>
    buildChallenge({
        id: 101,
        title: 'Currency',
        close_time: NOW + 3600,
        member: { boost: { state: 'LOCKED' }, ranking: { entries: [], exposure: { exposure_factor: 10 } } },
    });

const makeApi = (voteImages = { images: [{ id: 'i1' }] }) => ({
    getActiveChallenges: jest.fn(async () => ({ challenges: [challenge()] })),
    getVoteImages: jest.fn(async () => voteImages),
    submitVotes: jest.fn(async () => ({ success: true })),
});

const currency = { strategy: {}, swapLedger: {}, spendLedger: {} };
const run = (api) =>
    runVotingPass('tok', null, { api, cleanupStaleMetadata: null, interChallengeDelay: () => 0, currency });

const vote = () =>
    votingLogic.evaluateVotingDecision.mockReturnValue({ shouldVote: true, voteReason: 'low', targetExposure: 100 });

beforeEach(() => {
    jest.clearAllMocks();
    votingLogic.evaluateVotingDecision.mockReturnValue({ shouldVote: false, voteReason: 'skip', targetExposure: 100 });
    votingLogic.orderDeadlineActions.mockReturnValue([{ action: 'autoFill' }]);
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
    const scenarios = { ledger: {} };
    await runVotingPass('tok', null, {
        api: makeApi(),
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
