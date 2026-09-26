// @ts-check
/**
 * GuruShots Auto Voter - Mock API client
 *
 * The mock API surface apiFactory selects in mock mode: the mock endpoints
 * (mock/endpoints/*, counterparts to api/*) plus the mock strategy
 * (mock/strategy.js, counterpart to strategies/real/), which is built over
 * this same object so it calls whatever is on the client at call time.
 */

import { authenticate } from './endpoints/login';
import { getActiveChallenges } from './endpoints/challenges';
import { getVoteImages, submitVotes } from './endpoints/voting';
import { applyBoost, applyBoostToEntry } from './endpoints/boost';
import { applyTurbo, runTurboMiniGame } from './endpoints/turbo';
import { getEligiblePhotos, getImageData, submitToChallenge } from './endpoints/submissions';
import { getMemberChallenges, getBankroll, coinsUnlock } from './endpoints/join';
import {
    getMyCompletedChallenges,
    claimChallengeResources,
    getMyMissions,
    claimMissionPrize,
} from './endpoints/rewards';
import { getCurrentMemberProfile, searchTagAutocomplete } from './endpoints/tags';
import { keyUnlock, swapPhoto, exposureAutofill } from './endpoints/currency';
import { createMockStrategy } from './strategy';

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

export { mockApiClient };
