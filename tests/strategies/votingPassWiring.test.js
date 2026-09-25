/**
 * Guards the hand-built `api` surface both strategies hand to runVotingPass.
 *
 * WHY THIS EXISTS: src/js/strategies/real/index.js (an object literal) and
 * src/js/mock/strategy.js (the VOTING_PASS_ENDPOINTS name list) each list every
 * method by hand, while
 * votingOrchestrator turns it into the `fillDeps` bundle the auto-fill pipeline
 * consumes. Nothing forces the two lists to agree — a method on the API
 * surface but missing from these literals (e.g. `getImageData`) reaches every
 * scheduled fill as `undefined`. photoStats treats that as "degrade to
 * stats-unknown", so auto-fill, emergency fill and fill-new would all quietly
 * rank on the flat votes:0 data this feature exists to replace, in BOTH real
 * and mock mode, with every unit test still green (they inject deps by hand
 * and never exercise this wiring).
 *
 * A missing key here is invisible at runtime, so it gets a structural test.
 */

jest.mock('../../src/js/services/votingOrchestrator', () => ({
    runVotingPass: jest.fn(async () => ({ success: true })),
}));

jest.mock('../../src/js/logger', () => {
    const level = {
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        api: jest.fn(),
        apiRequest: jest.fn(),
    };
    return {
        withCategory: jest.fn(() => level),
        challengeTag: (c) => `[Challenge ${c?.id}]`,
        startOperation: jest.fn(),
        endOperation: jest.fn(),
        ...level,
    };
});

// Keeps the storage layer (and its electron require) out of this test.
jest.mock('../../src/js/settings/storage', () => ({
    createJsonStore: () => ({
        readRaw: () => null,
        writeRaw: () => {},
        getFilePath: () => '/tmp/x.json',
        initializeAsync: async () => {},
    }),
}));

const { runVotingPass } = require('../../src/js/services/votingOrchestrator');

// Every API method the auto-fill pipeline reaches for through fillDeps.
// votingOrchestrator builds fillDeps from `api.*`, so a name absent from the
// literal arrives as undefined rather than failing loudly.
const REQUIRED_FILL_METHODS = ['getEligiblePhotos', 'getImageData', 'submitToChallenge', 'getActiveChallenges'];

describe('runVotingPass api surface wiring', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('real strategy passes every method the fill pipeline needs', async () => {
        const { fetchChallengesAndVote } = require('../../src/js/strategies/real');
        await fetchChallengesAndVote('tok');
        expect(runVotingPass).toHaveBeenCalledTimes(1);
        const { api } = runVotingPass.mock.calls[0][2];
        for (const method of REQUIRED_FILL_METHODS) {
            expect(typeof api[method]).toBe('function');
        }
    });

    test('mock strategy passes every method the fill pipeline needs', async () => {
        const { mockApiClient } = require('../../src/js/mock');
        await mockApiClient.fetchChallengesAndVote('tok');
        expect(runVotingPass).toHaveBeenCalledTimes(1);
        const { api } = runVotingPass.mock.calls[0][2];
        for (const method of REQUIRED_FILL_METHODS) {
            expect(typeof api[method]).toBe('function');
        }
    });
});

// Every API method a scenario action calls on pass.api (services/scenarioRunner.js).
const SCENARIO_ACTION_METHODS = [
    'getActiveChallenges',
    'submitToChallenge',
    'applyBoostToEntry',
    'applyTurbo',
    'getVoteImages',
    'submitVotes',
];

describe('runVotingPass scenario wiring', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('real strategy runs scenarios over the persisted state ledger, off-Android', async () => {
        const { scenarioStateLedger } = require('../../src/js/scenarioStateStore');
        const { fetchChallengesAndVote } = require('../../src/js/strategies/real');
        await fetchChallengesAndVote('tok');
        const { api, scenarios } = runVotingPass.mock.calls[0][2];
        expect(scenarios.ledger).toBe(scenarioStateLedger);
        expect(scenarios.enabled()).toBe(true);
        for (const method of SCENARIO_ACTION_METHODS) expect(typeof api[method]).toBe('function');
    });

    test('mock strategy runs scenarios over the in-memory ledger', async () => {
        const { mockScenarioStateLedger } = require('../../src/js/scenarioStateStore');
        const { mockApiClient } = require('../../src/js/mock');
        await mockApiClient.fetchChallengesAndVote('tok');
        const { api, scenarios } = runVotingPass.mock.calls[0][2];
        expect(scenarios).toEqual({ ledger: mockScenarioStateLedger });
        for (const method of SCENARIO_ACTION_METHODS) expect(typeof api[method]).toBe('function');
    });
});
