/**
 * GuruShots Auto Voter - Mock strategy
 *
 * Mock counterpart to strategies/real/index.js: the voting pass (with its
 * join and prize-claim pre-steps) and the manual join, running the SAME
 * shared services as the real strategy over the mock endpoints.
 *
 * Built against the assembled mock client (mock/apiClient.js) and reads each
 * endpoint off it at call time, so a method replaced on the client (e.g. a
 * test spy on mockApiClient) is what the pass and the join actually call.
 */

const logger = require('../logger');
const { runVotingPass } = require('../services/votingOrchestrator');
const { createMemoryEntryTracker } = require('../services/newEntryTracker');
const { runJoinPass, joinChallengeSingle } = require('../services/joinChallenges');
const { runClaimPass } = require('../services/autoClaim');
const { mockSwapBackLedger } = require('../swapBackStore');
const { createMemoryAutoSpendLedger } = require('../currencyAutoStore');
const { mockMethod } = require('./simulate');

// Module-level so snapshots survive across mock cycles within a run — a per-call
// tracker would look like "first sight" every cycle and never detect anything.
const mockEntryTracker = createMemoryEntryTracker();

// In-memory automatic-fill counter for the mock pass (process lifetime).
const mockAutoSpendLedger = createMemoryAutoSpendLedger();

// Endpoints runVotingPass reads off `api`.
const VOTING_PASS_ENDPOINTS = [
    'getActiveChallenges',
    'getVoteImages',
    'submitVotes',
    'applyBoost',
    'applyBoostToEntry',
    'applyTurbo',
    'getEligiblePhotos',
    'getImageData',
    'submitToChallenge',
    'runTurboMiniGame',
    'searchTagAutocomplete',
    'getCurrentMemberProfile',
];

// Endpoints the automatic currency spends use (services/currencyAuto.js).
const CURRENCY_ENDPOINTS = [
    'getActiveChallenges',
    'getBankroll',
    'keyUnlock',
    'swapPhoto',
    'exposureAutofill',
    'getVoteImages',
    'getEligiblePhotos',
    'getImageData',
    'searchTagAutocomplete',
    'getCurrentMemberProfile',
];

// Endpoints the join flow uses (services/joinChallenges.js).
const JOIN_ENDPOINTS = [
    'getMemberChallenges',
    'getBankroll',
    'coinsUnlock',
    'submitToChallenge',
    'getEligiblePhotos',
    'searchTagAutocomplete',
    'getCurrentMemberProfile',
];

// Endpoints for the hourly prize-claim pre-step (services/autoClaim.js).
const CLAIM_ENDPOINTS = ['getMyCompletedChallenges', 'claimChallengeResources', 'getMyMissions', 'claimMissionPrize'];

/**
 * The named endpoints as they are on the client right now.
 *
 * @param {Record<string, Function>} client
 * @param {string[]} names
 * @returns {Record<string, Function>}
 */
const pickEndpoints = (client, names) => Object.fromEntries(names.map((name) => [name, client[name]]));

/**
 * @param {Record<string, Function>} client - the assembled mock endpoints
 * @returns {{ joinChallenge: Function, fetchChallengesAndVote: Function }}
 */
const createMockStrategy = (client) => {
    // Join deps over the mock endpoints. joinStateStore is null — mock mode must
    // never touch real persisted state (same rationale as cleanupStaleMetadata:null).
    // No acquireUnlockLock either: mock spends no real coins and runs
    // single-process, so idempotency persistence and the cross-process lock are
    // unnecessary.
    const mockJoinDeps = () => ({ ...pickEndpoints(client, JOIN_ENDPOINTS), joinStateStore: null });

    /**
     * Simulate a manual single join, running the SAME service the real strategy
     * runs (services/joinChallenges.js) over the mock endpoints, with a null
     * join-state store (no real state touched).
     */
    const joinChallenge = mockMethod(
        {
            name: 'joinChallenge',
            tokenArg: 2,
            debug: (challengeId, spendCoins) => {
                logger
                    .withCategory('challenges')
                    .debug(`Join challenge ID: ${challengeId}, spendCoins: ${!!spendCoins}`, null);
            },
            onNoToken: () => ({ status: 'not-authenticated', challengeId: null, cost: 0 }),
        },
        async (challengeId, spendCoins, token) =>
            joinChallengeSingle(challengeId, token, mockJoinDeps(), { spendCoins: spendCoins === true }),
    );

    /**
     * Simulate the main voting process — runs the SAME orchestration as the
     * real strategy (services/votingOrchestrator.js) over the mock
     * endpoints, so mock mode exercises auto-fill, emergency fill,
     * turbo-earn, timer-ordered deadline actions, and the shared
     * cancellation/logging path instead of a hand-maintained fork.
     *
     * cleanupStaleMetadata is deliberately null: the metadata store is
     * shared and un-namespaced, and mock challenge ids never match real
     * ones — running cleanup here would purge the user's real voting
     * metadata.
     */
    const fetchChallengesAndVote = async (token, _exposureThreshold = null, challengeIdFilter = null) => {
        logger.withCategory('voting').api('Mock fetchChallengesAndVote', null);
        logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
        if (!token) {
            // Real fetchChallengesAndVote has no token guard: the pass runs,
            // getActiveChallenges resolves { challenges: [] }, and the pass
            // completes empty. Log the condition but keep the same contract.
            logger.withCategory('authentication').error('No token provided, voting pass will find no challenges', null);
        }
        // Auto-join pre-step (gated by the default-off autoJoin setting), mirroring
        // the real strategy. Skipped for a single-challenge run; never aborts voting.
        if (challengeIdFilter === null) {
            try {
                await runJoinPass(token, Date.now(), mockJoinDeps());
            } catch (error) {
                logger.withCategory('join').warning(`Mock join pass errored: ${error?.message || error}`, null);
            }
            // Hourly prize-claim pre-step (default-off autoClaimPrizes), as in real.
            try {
                await runClaimPass(token, Date.now(), pickEndpoints(client, CLAIM_ENDPOINTS));
            } catch (error) {
                logger.withCategory('claim').warning(`Mock claim pass errored: ${error?.message || error}`, null);
            }
        }
        return runVotingPass(token, challengeIdFilter, {
            api: pickEndpoints(client, VOTING_PASS_ENDPOINTS),
            cleanupStaleMetadata: null,
            // In-memory for the same reason cleanupStaleMetadata is null: the
            // metadata store is shared and un-namespaced, and mock challenge ids
            // never match real ones, so persisting mock entry snapshots would
            // accumulate junk in the user's real metadata.json that nothing prunes.
            entryTracker: mockEntryTracker,
            // Short fixed spacing — mock cycles should stay fast.
            interChallengeDelay: () => 500,
            // Mock spends over the mock endpoints, with in-memory ledgers — mock
            // mode must never touch the real swap-back / auto-spend files.
            currency: {
                strategy: pickEndpoints(client, CURRENCY_ENDPOINTS),
                swapLedger: mockSwapBackLedger,
                spendLedger: mockAutoSpendLedger,
            },
        });
    };

    return { joinChallenge, fetchChallengesAndVote };
};

module.exports = { createMockStrategy };
