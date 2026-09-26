/**
 * GuruShots Auto Voter - API Factory
 *
 * Selects the real or mock API surface based on the current mock
 * setting and constructs the BaseMiddleware that wraps it. Each
 * surface is a plain object whose method names mirror what the
 * middleware expects — there is no class hierarchy. The real surface
 * is the api/ endpoint wrappers plus the real-strategy composition
 * (strategies/real); the mock surface is mockApiClient (mock/index.js).
 */

import * as settings from './settings';
import { BaseMiddleware } from './services/BaseMiddleware';
import * as logger from './logger';

import { authenticate } from './api/login';
import {
    fetchChallengesAndVote,
    getActiveChallenges,
    applyBoost,
    runTurboMiniGame,
    joinChallenge,
} from './strategies/real';
import { getVoteImages, submitVotes } from './api/voting';
import { applyBoostToEntry } from './api/boost';
import { applyTurbo } from './api/turbo';
import { getEligiblePhotos, getImageData, submitToChallenge } from './api/submissions';
import { getMemberChallenges, getBankroll } from './api/join';
import { getCurrentMemberProfile, searchTagAutocomplete } from './api/tags';
import { keyUnlock, swapPhoto, exposureAutofill } from './api/currency';
import { mockApiClient } from './mock';

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
    getImageData,
    submitToChallenge,
    getMemberChallenges,
    getBankroll,
    getCurrentMemberProfile,
    searchTagAutocomplete,
    joinChallenge,
    keyUnlock,
    swapPhoto,
    exposureAutofill,
    getStrategyType: () => 'RealAPI',
};

/**
 * The API surface both strategies implement: the real one's shape. The mock
 * surface below is checked against it, so a method missing on either side or
 * a signature that drifts fails `pnpm typecheck`.
 *
 * @typedef {typeof realApi} ApiStrategy
 */

/**
 * Wraps a mock implementation so each call emits a debug log first.
 *
 * @template {unknown[]} A
 * @template R
 * @param {string} label
 * @param {(...args: A) => R | Promise<R>} fn
 * @returns {(...args: A) => Promise<R>}
 */
const withMockDebug =
    (label, fn) =>
    async (...args) => {
        logger.withCategory('api').debug(`🔧 Using mock ${label}`, null);
        return fn(...args);
    };

/**
 * Each method is the matching mockApiClient method behind the debug
 * preamble. (The `authenticate` log label is 'authentication' so log lines
 * keep a stable wording.)
 *
 * @type {ApiStrategy}
 */
const mockApi = {
    authenticate: withMockDebug('authentication', mockApiClient.authenticate),
    fetchChallengesAndVote: withMockDebug('fetchChallengesAndVote', mockApiClient.fetchChallengesAndVote),
    runTurboMiniGame: withMockDebug('runTurboMiniGame', mockApiClient.runTurboMiniGame),
    getActiveChallenges: withMockDebug('getActiveChallenges', mockApiClient.getActiveChallenges),
    getVoteImages: withMockDebug('getVoteImages', mockApiClient.getVoteImages),
    submitVotes: withMockDebug('submitVotes', mockApiClient.submitVotes),
    applyBoost: withMockDebug('applyBoost', mockApiClient.applyBoost),
    applyBoostToEntry: withMockDebug('applyBoostToEntry', mockApiClient.applyBoostToEntry),
    applyTurbo: withMockDebug('applyTurbo', mockApiClient.applyTurbo),
    getEligiblePhotos: withMockDebug('getEligiblePhotos', mockApiClient.getEligiblePhotos),
    getImageData: withMockDebug('getImageData', mockApiClient.getImageData),
    submitToChallenge: withMockDebug('submitToChallenge', mockApiClient.submitToChallenge),
    getMemberChallenges: withMockDebug('getMemberChallenges', mockApiClient.getMemberChallenges),
    getBankroll: withMockDebug('getBankroll', mockApiClient.getBankroll),
    getCurrentMemberProfile: withMockDebug('getCurrentMemberProfile', mockApiClient.getCurrentMemberProfile),
    searchTagAutocomplete: withMockDebug('searchTagAutocomplete', mockApiClient.searchTagAutocomplete),
    joinChallenge: withMockDebug('joinChallenge', mockApiClient.joinChallenge),
    keyUnlock: withMockDebug('keyUnlock', mockApiClient.keyUnlock),
    swapPhoto: withMockDebug('swapPhoto', mockApiClient.swapPhoto),
    exposureAutofill: withMockDebug('exposureAutofill', mockApiClient.exposureAutofill),
    getStrategyType: () => 'MockAPI',
};

/** @type {ApiStrategy | null} */
let currentStrategy = null;
/** @type {InstanceType<typeof BaseMiddleware> | null} */
let currentMiddleware = null;
/** @type {boolean | null} */
let lastMockSetting = null;

/**
 * Returns the active API surface.
 *
 * Without arguments the surface follows the persisted `mock` setting
 * (cached until refreshApi or the setting changes). Passing an explicit
 * boolean `mock` overrides the setting for THIS call only — used by the
 * login flow, where the caller's choice pre-dates the committed setting —
 * without touching the cached strategy state.
 *
 * @param {{ mock?: boolean }} [options]
 * @returns {ApiStrategy}
 */
const getApiStrategy = ({ mock } = {}) => {
    if (typeof mock === 'boolean') {
        return mock ? mockApi : realApi;
    }
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

// The raw surfaces are deliberately NOT exported — every caller selects a
// surface through getApiStrategy (optionally with the explicit { mock }
// override) so the factory stays the single swap point.
export { getApiStrategy, getMiddleware, refreshApi };
