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
 * `realApi` is structurally checked against this typedef by `pnpm typecheck`;
 * `mockApi` mirrors realApi BY CONSTRUCTION (built from its key list below),
 * so real/mock parity is a construction-time invariant enforced by the
 * missing-method guard in the builder plus the key-parity unit test — not by
 * the compiler.
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

/**
 * The mock surface is derived from realApi's key list — every method
 * except getStrategyType is the matching mockApiClient method wrapped
 * in the debug preamble — so the two surfaces can never drift at
 * runtime. (The `authenticate` log label stays 'authentication' for
 * log compatibility.) The Object.fromEntries construction is opaque to
 * the checker, hence the cast: realApi keeps the typedef lockstep, and
 * mockApi mirrors realApi by construction.
 */
const mockClient = /** @type {Record<string, (...args: any[]) => any>} */ (/** @type {any} */ (mockApiClient));

/** @type {ApiStrategy} */
const mockApi = /** @type {any} */ ({
    ...Object.fromEntries(
        Object.keys(realApi)
            .filter((name) => name !== 'getStrategyType')
            .map((name) => {
                if (typeof mockClient[name] !== 'function') {
                    // Fail fast with a self-diagnosing message: a new realApi
                    // method needs a same-named mockApiClient counterpart.
                    throw new Error(`mockApiClient is missing a '${name}' implementation for the realApi surface`);
                }
                return [
                    name,
                    withMockDebug(
                        name === 'authenticate' ? 'authentication' : name,
                        mockClient[name].bind(mockApiClient),
                    ),
                ];
            }),
    ),
    getStrategyType: () => 'MockAPI',
});

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
