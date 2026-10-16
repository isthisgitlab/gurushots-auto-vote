/**
 * GuruShots Auto Voter - Mock API client
 *
 * The mock API surface apiFactory selects in mock mode: the mock endpoints
 * (mock/endpoints/*, counterparts to api/*) plus the mock strategy
 * (mock/strategy.ts, counterpart to strategies/real/), which is built over
 * this same object so it calls whatever is on the client at call time.
 */

import { authenticate } from './endpoints/login';
import { getActiveChallenges as getActiveChallengesRaw } from './endpoints/challenges';
import { getVoteImages, submitVotes } from './endpoints/voting';
import { applyBoost, applyBoostToEntry } from './endpoints/boost';
import { applyTurbo, runTurboMiniGame } from './endpoints/turbo';
import {
    getEligiblePhotos,
    getEligiblePhotosWalk,
    getImageData,
    submitToChallenge as submitToChallengeRaw,
} from './endpoints/submissions';
import { getMemberChallenges, getBankroll, coinsUnlock } from './endpoints/join';
import {
    getMyCompletedChallenges,
    claimChallengeResources,
    getMyMissions,
    claimMissionPrize,
} from './endpoints/rewards';
import { getCurrentMemberProfile, searchTagAutocomplete } from './endpoints/tags';
import { keyUnlock, swapPhoto as swapPhotoRaw, exposureAutofill } from './endpoints/currency';
import { createMockStrategy, mockEntryAgeLedger } from './strategy';
import { annotateEntryTimes, withEntryTimes } from '../services/entryTimes';

// What the real strategy does for these (strategies/real): the fetch carries each entry's recorded time, and a
// submit or swap that went in records its exact time. Here, where the client is built, so the mock pass (which reads
// its endpoints off this object) and the factory's captured methods (manual fill, swap) both go through it.
const { submitToChallenge, swapPhoto } = withEntryTimes(
    { submitToChallenge: submitToChallengeRaw, swapPhoto: swapPhotoRaw },
    mockEntryAgeLedger,
);
const getActiveChallenges: typeof getActiveChallengesRaw = async (...args) => {
    const response = await getActiveChallengesRaw(...args);
    await annotateEntryTimes(response, mockEntryAgeLedger);
    return response;
};

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
