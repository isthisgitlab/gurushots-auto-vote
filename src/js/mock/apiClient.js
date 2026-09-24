/**
 * GuruShots Auto Voter - Mock API client
 *
 * The mock API surface apiFactory selects in mock mode: the mock endpoints
 * (mock/endpoints/*, counterparts to api/*) plus the mock strategy
 * (mock/strategy.js, counterpart to strategies/real/), which is built over
 * this same object so it calls whatever is on the client at call time.
 */

const { authenticate } = require('./endpoints/login');
const { getActiveChallenges } = require('./endpoints/challenges');
const { getVoteImages, submitVotes } = require('./endpoints/voting');
const { applyBoost, applyBoostToEntry } = require('./endpoints/boost');
const { applyTurbo, runTurboMiniGame } = require('./endpoints/turbo');
const { getEligiblePhotos, getImageData, submitToChallenge } = require('./endpoints/submissions');
const { getMemberChallenges, getBankroll, coinsUnlock } = require('./endpoints/join');
const {
    getMyCompletedChallenges,
    claimChallengeResources,
    getMyMissions,
    claimMissionPrize,
} = require('./endpoints/rewards');
const { getCurrentMemberProfile, searchTagAutocomplete } = require('./endpoints/tags');
const { keyUnlock, swapPhoto, exposureAutofill } = require('./endpoints/currency');
const { createMockStrategy } = require('./strategy');

/**
 * Mock API client that can be used for testing
 */
const mockApiClient = {
    authenticate,
    getActiveChallenges,
    getVoteImages,
    submitVotes,
    applyBoost,
    applyBoostToEntry,
    applyTurbo,
    runTurboMiniGame,
    getEligiblePhotos,
    getImageData,
    submitToChallenge,
    getMemberChallenges,
    getBankroll,
    getMyCompletedChallenges,
    claimChallengeResources,
    getMyMissions,
    claimMissionPrize,
    getCurrentMemberProfile,
    searchTagAutocomplete,
    coinsUnlock,
    keyUnlock,
    swapPhoto,
    exposureAutofill,
};

Object.assign(mockApiClient, createMockStrategy(mockApiClient));

module.exports = { mockApiClient };
