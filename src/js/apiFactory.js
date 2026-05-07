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

const {authenticate} = require('./api/login');
const {fetchChallengesAndVote} = require('./api/main');
const {getActiveChallenges} = require('./api/challenges');
const {getVoteImages, submitVotes} = require('./api/voting');
const {applyBoost, applyBoostToEntry} = require('./api/boost');
const {mockApiClient} = require('./mock');

const realApi = {
    authenticate,
    fetchChallengesAndVote,
    getActiveChallenges,
    getVoteImages,
    submitVotes,
    applyBoost,
    applyBoostToEntry,
    getStrategyType: () => 'RealAPI',
};

const withMockDebug = (label, fn) => async (...args) => {
    logger.withCategory('api').debug(`🔧 Using mock ${label}`, null);
    return fn(...args);
};

const mockApi = {
    authenticate: withMockDebug('authentication', mockApiClient.authenticate.bind(mockApiClient)),
    fetchChallengesAndVote: withMockDebug('fetchChallengesAndVote', mockApiClient.fetchChallengesAndVote.bind(mockApiClient)),
    getActiveChallenges: withMockDebug('getActiveChallenges', mockApiClient.getActiveChallenges.bind(mockApiClient)),
    getVoteImages: withMockDebug('getVoteImages', mockApiClient.getVoteImages.bind(mockApiClient)),
    submitVotes: withMockDebug('submitVotes', mockApiClient.submitVotes.bind(mockApiClient)),
    applyBoost: withMockDebug('applyBoost', mockApiClient.applyBoost.bind(mockApiClient)),
    applyBoostToEntry: withMockDebug('applyBoostToEntry', mockApiClient.applyBoostToEntry.bind(mockApiClient)),
    getStrategyType: () => 'MockAPI',
};

let currentStrategy = null;
let currentMiddleware = null;
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
