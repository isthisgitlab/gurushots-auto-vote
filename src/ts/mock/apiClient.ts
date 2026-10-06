/**
 * GuruShots Auto Voter - Mock API client
 *
 * The mock API surface apiFactory selects in mock mode: the mock endpoints
 * (mock/endpoints/*, counterparts to api/*) plus the mock strategy
 * (mock/strategy.ts, counterpart to strategies/real/), which is built over
 * this same object so it calls whatever is on the client at call time.
 */

import { authenticate } from './endpoints/login';
import { getActiveChallenges } from './endpoints/challenges';
import { getVoteImages, submitVotes } from './endpoints/voting';
import { applyBoost, applyBoostToEntry } from './endpoints/boost';
import { applyTurbo, runTurboMiniGame } from './endpoints/turbo';
import { getEligiblePhotos, getEligiblePhotosWalk, getImageData, submitToChallenge } from './endpoints/submissions';
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
 * The mock endpoints the mock strategy composes over.
 */
const endpoints = {
    authenticate,
    getActiveChallenges,
    getVoteImages,
    submitVotes,
    applyBoost,
    applyBoostToEntry,
    applyTurbo,
    runTurboMiniGame,
    getEligiblePhotos,
    getEligiblePhotosWalk,
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

export type MockEndpoints = typeof endpoints;

// Same object, now also carrying the strategy methods.
const mockApiClient = Object.assign(endpoints, createMockStrategy(endpoints));

export { mockApiClient };
