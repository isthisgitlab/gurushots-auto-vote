// @ts-check
/**
 * GuruShots Auto Voter - API Factory
 *
 * Selects the real or mock API surface based on the current mock
 * setting and constructs the BaseMiddleware that wraps it. Each
 * surface is a plain object whose method names mirror what the
 * middleware expects — there is no class hierarchy.
 */

const settings = require('./settings');
const BaseMiddleware = require('./services/BaseMiddleware');
const logger = require('./logger');

const { authenticate } = require('./api/login');
const { fetchChallengesAndVote, runTurboMiniGame } = require('./api/main');
const { getActiveChallenges } = require('./api/challenges');
const { getVoteImages, submitVotes } = require('./api/voting');
const { applyBoost, applyBoostToEntry } = require('./api/boost');
const { applyTurbo } = require('./api/turbo');
const { getEligiblePhotos, submitToChallenge } = require('./api/submissions');
const { mockApiClient } = require('./mock');

/**
 * The API surface that both the real and mock strategies must implement.
 * Annotating `realApi` and `mockApi` against this keeps the two in lockstep:
 * drop, rename, or mistype a method on one and `pnpm typecheck` fails.
 *
 * @typedef {object} ApiStrategy
 * @property {(...args: any[]) => any} authenticate
 * @property {(...args: any[]) => any} fetchChallengesAndVote
 * @property {(...args: any[]) => any} runTurboMiniGame
 * @property {(...args: any[]) => any} getActiveChallenges
 * @property {(...args: any[]) => any} getVoteImages
 * @property {(...args: any[]) => any} submitVotes
 * @property {(...args: any[]) => any} applyBoost
 * @property {(...args: any[]) => any} applyBoostToEntry
 * @property {(...args: any[]) => any} applyTurbo
 * @property {(...args: any[]) => any} getEligiblePhotos
 * @property {(...args: any[]) => any} submitToChallenge
 * @property {() => string} getStrategyType
 */

/** @type {ApiStrategy} */
const realApi = {
    authenticate,
    fetchChallengesAndVote,
    runTurboMiniGame,
    getActiveChallenges,
    getVoteImages,
    submitVotes,
    applyBoost,
    applyBoostToEntry,
    applyTurbo,
    getEligiblePhotos,
    submitToChallenge,
    getStrategyType: () => 'RealAPI',
};

/**
 * Wraps a mock implementation so each call emits a debug log first.
 *
 * @param {string} label
 * @param {(...args: any[]) => any} fn
 * @returns {(...args: any[]) => Promise<any>}
 */
const withMockDebug =
    (label, fn) =>
    async (...args) => {
        logger.withCategory('api').debug(`🔧 Using mock ${label}`, null);
        return fn(...args);
    };

/** @type {ApiStrategy} */
const mockApi = {
    authenticate: withMockDebug('authentication', mockApiClient.authenticate.bind(mockApiClient)),
    fetchChallengesAndVote: withMockDebug(
        'fetchChallengesAndVote',
        mockApiClient.fetchChallengesAndVote.bind(mockApiClient),
    ),
    runTurboMiniGame: withMockDebug('runTurboMiniGame', mockApiClient.runTurboMiniGame.bind(mockApiClient)),
    getActiveChallenges: withMockDebug('getActiveChallenges', mockApiClient.getActiveChallenges.bind(mockApiClient)),
    getVoteImages: withMockDebug('getVoteImages', mockApiClient.getVoteImages.bind(mockApiClient)),
    submitVotes: withMockDebug('submitVotes', mockApiClient.submitVotes.bind(mockApiClient)),
    applyBoost: withMockDebug('applyBoost', mockApiClient.applyBoost.bind(mockApiClient)),
    applyBoostToEntry: withMockDebug('applyBoostToEntry', mockApiClient.applyBoostToEntry.bind(mockApiClient)),
    applyTurbo: withMockDebug('applyTurbo', mockApiClient.applyTurbo.bind(mockApiClient)),
    getEligiblePhotos: withMockDebug('getEligiblePhotos', mockApiClient.getEligiblePhotos.bind(mockApiClient)),
    submitToChallenge: withMockDebug('submitToChallenge', mockApiClient.submitToChallenge.bind(mockApiClient)),
    getStrategyType: () => 'MockAPI',
};

/** @type {ApiStrategy | null} */
let currentStrategy = null;
/** @type {InstanceType<typeof BaseMiddleware> | null} */
let currentMiddleware = null;
/** @type {boolean | null} */
let lastMockSetting = null;

const getApiStrategy = () => {
    const userSettings = settings.loadSettings();
    if (lastMockSetting !== userSettings.mock || !currentStrategy) {
        logger.withCategory('api').debug('=== API Factory Debug ===', null);
        logger.withCategory('settings').debug(`Mock setting: ${userSettings.mock}`);
        logger.withCategory('settings').debug(`Token exists: ${!!userSettings.token}`);

        if (userSettings.mock) {
            logger.withCategory('api').info('✅ Using MOCK API strategy for development/testing', null);
            currentStrategy = mockApi;
        } else {
            logger.withCategory('api').info('🌐 Using REAL API strategy for production', null);
            currentStrategy = realApi;
        }

        lastMockSetting = userSettings.mock;
        currentMiddleware = null;
    }
    return currentStrategy;
};

const getMiddleware = () => {
    const strategy = getApiStrategy();
    if (!currentMiddleware) {
        logger.withCategory('api').debug(`Creating middleware with ${strategy.getStrategyType()} strategy`, null);
        currentMiddleware = new BaseMiddleware(strategy);
    }
    return currentMiddleware;
};

const refreshApi = () => {
    logger.withCategory('settings').info('🔄 Forcing API refresh due to settings change');
    currentStrategy = null;
    currentMiddleware = null;
    lastMockSetting = null;
};

module.exports = {
    getApiStrategy,
    getMiddleware,
    refreshApi,
    realApi,
    mockApi,
};
