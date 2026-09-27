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

import * as logger from '../logger';
import { runVotingPass } from '../services/votingOrchestrator';
import { createMemoryEntryTracker } from '../services/newEntryTracker';
import { runJoinPass, joinChallengeSingle } from '../services/joinChallenges';
import { runClaimPass } from '../services/autoClaim';
import { loadMissionNeeds } from '../services/missions';
import { mockSwapBackLedger } from '../swapBackStore';
import { createMemoryAutoSpendLedger } from '../currencyAutoStore';
import { createMemoryEntryAgeLedger } from '../entryAgeStore';
import { mockScenarioStateLedger } from '../scenarioStateStore';
import { mockMethod } from './simulate';

/** @import { MockEndpoints } from './apiClient' */

// Module-level so snapshots survive across mock cycles within a run — a per-call
// tracker would look like "first sight" every cycle and never detect anything.
const mockEntryTracker = createMemoryEntryTracker();

// In-memory automatic-fill counter for the mock pass (process lifetime).
const mockAutoSpendLedger = createMemoryAutoSpendLedger();
const mockEntryAgeLedger = createMemoryEntryAgeLedger();

// Endpoints runVotingPass reads off `api`.
const VOTING_PASS_ENDPOINTS = /** @type {const} */ ([
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
]);

// Endpoints the automatic currency spends use (services/currencyAuto.ts).
const CURRENCY_ENDPOINTS = /** @type {const} */ ([
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
]);

// Endpoints the join flow uses (services/joinChallenges.ts).
const JOIN_ENDPOINTS = /** @type {const} */ ([
    'getMemberChallenges',
    'getBankroll',
    'coinsUnlock',
    'submitToChallenge',
    'getEligiblePhotos',
    'searchTagAutocomplete',
    'getCurrentMemberProfile',
]);

// Endpoints for the hourly prize-claim pre-step (services/autoClaim.ts).
const CLAIM_ENDPOINTS = /** @type {const} */ ([
    'getMyCompletedChallenges',
    'claimChallengeResources',
    'getMyMissions',
    'claimMissionPrize',
]);

/**
 * The named endpoints as they are on the client right now.
 *
 * @template {object} C
 * @template {keyof C} K
 * @param {C} client
 * @param {readonly K[]} names
 * @returns {Pick<C, K>}
 */
const pickEndpoints = (client, names) =>
    /** @type {Pick<C, K>} */ (Object.fromEntries(names.map((name) => [name, client[name]])));

/**
 * @param {MockEndpoints} client - the assembled mock endpoints
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
     * runs (services/joinChallenges.ts) over the mock endpoints, with a null
     * join-state store (no real state touched).
     *
     * @type {typeof import('../strategies/real').joinChallenge}
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
            onNoToken: (challengeId) => ({ status: 'not-authenticated', challengeId, cost: 0 }),
        },
        async (challengeId, spendCoins, token) =>
            joinChallengeSingle(challengeId, token, mockJoinDeps(), { spendCoins: spendCoins === true }),
    );

    /**
     * Simulate the main voting process — runs the SAME orchestration as the
     * real strategy (services/votingOrchestrator.ts) over the mock
     * endpoints, so mock mode exercises auto-fill, emergency fill,
     * turbo-earn, timer-ordered deadline actions, and the shared
     * cancellation/logging path instead of a hand-maintained fork.
     *
     * cleanupStaleMetadata is deliberately null: the metadata store is
     * shared and un-namespaced, and mock challenge ids never match real
     * ones — running cleanup here would purge the user's real voting
     * metadata.
     *
     * @param {string} token
     * @param {string|number|null} [challengeIdFilter]
     */
    const fetchChallengesAndVote = async (token, challengeIdFilter = null) => {
        logger.withCategory('voting').api('Mock fetchChallengesAndVote', null);
        logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
        if (!token) {
            // Real fetchChallengesAndVote has no token guard: the pass runs,
            // getActiveChallenges resolves { challenges: [] }, and the pass
            // completes empty. Log the condition but keep the same contract.
            logger.withCategory('authentication').error('No token provided, voting pass will find no challenges', null);
        }
        // Mission read (only while a mission setting is on), as in real.
        const missions = await loadMissionNeeds(token, Date.now(), { getMyMissions: client.getMyMissions });
        // Auto-join pre-step (gated by the default-off autoJoin setting), mirroring
        // the real strategy. Skipped for a single-challenge run; never aborts voting.
        if (challengeIdFilter === null) {
            try {
                await runJoinPass(token, Date.now(), mockJoinDeps(), missions);
            } catch (error) {
                logger
                    .withCategory('join')
                    .warning(
                        `Mock join pass errored: ${/** @type {{ message?: unknown } | null | undefined} */ (error)?.message || error}`,
                        null,
                    );
            }
            // Hourly prize-claim pre-step (default-off autoClaimPrizes), as in real.
            try {
                await runClaimPass(token, Date.now(), pickEndpoints(client, CLAIM_ENDPOINTS));
            } catch (error) {
                logger
                    .withCategory('claim')
                    .warning(
                        `Mock claim pass errored: ${/** @type {{ message?: unknown } | null | undefined} */ (error)?.message || error}`,
                        null,
                    );
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
            // In-memory: mock mode must never touch the real entryAges file.
            entryAges: mockEntryAgeLedger,
            // Short fixed spacing — mock cycles should stay fast.
            interChallengeDelay: () => 500,
            // Mock spends over the mock endpoints, with in-memory ledgers — mock
            // mode must never touch the real swap-back / auto-spend files.
            currency: {
                strategy: pickEndpoints(client, CURRENCY_ENDPOINTS),
                swapLedger: mockSwapBackLedger,
                spendLedger: mockAutoSpendLedger,
            },
            // In-memory scenario state — mock mode never touches scenarioState.json.
            // The Android background service does nothing in mock mode, so the
            // in-app loop always runs mock scenarios.
            scenarios: { ledger: mockScenarioStateLedger },
            missions,
        });
    };

    return { joinChallenge, fetchChallengesAndVote };
};

export { createMockStrategy };
