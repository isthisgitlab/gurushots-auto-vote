/**
 * Join flow shared types, the in-process in-flight set and the logger category.
 */

import * as logger from '../../logger';
import type { rankVisually } from '../visionVerifier';
import type { ActiveChallengesResponse } from '../../types/gurushots';
import type { RawJsonStore } from '../../types/stores';
import type * as joinApi from '../../api/join';
import type * as submissionsApi from '../../api/submissions';
import type * as tagsApi from '../../api/tags';
import type * as joinStateStore from '../../joinStateStore';

/**
 * The join flow's endpoints and state (see the header).
 */
export interface JoinDeps {
    getMemberChallenges: typeof joinApi.getMemberChallenges;
    getBankroll: typeof joinApi.getBankroll;
    coinsUnlock: typeof joinApi.coinsUnlock;
    submitToChallenge: typeof submissionsApi.submitToChallenge;
    getEligiblePhotos: typeof submissionsApi.getEligiblePhotos;
    searchTagAutocomplete?: typeof tagsApi.searchTagAutocomplete;
    getCurrentMemberProfile?: typeof tagsApi.getCurrentMemberProfile;
    /** The joined challenges, to count the turbos a turbo mission can still win (Join Early for Missions). */
    getActiveChallenges?: (token: string) => Promise<ActiveChallengesResponse>;
    /** null in mock mode */
    joinStateStore?: RawJsonStore | null;
    /** absent in mock mode */
    acquireUnlockLock?: typeof joinStateStore.acquireUnlockLock;
    /** test seam over the visual re-rank */
    rankVisually?: typeof rankVisually;
}

/**
 * One join's result. `charged` is coins spent THIS call.
 */
type JoinOutcome = { status: string; charged: number; imageId?: string };

type UnlockState = { charged: number; alreadyUnlocked: boolean };

/** A caught value, read only for its message.
 */
/**
 * The manual single join's result.
 */
type JoinSingleResult = {
    status: string;
    challengeId: string | number;
    cost: number;
    coins?: number;
    imageId?: string;
};

// Shared across the manual handler and the automatic pass IN THIS PROCESS so the
// two cannot double-spend the same challenge. Module-level = one Set per process;
// cross-process racing is bounded by the persisted claim (see header residual).
const inFlight: Set<string> = new Set();

const cat = () => logger.withCategory('join');

export { inFlight, cat };
export type { JoinOutcome, UnlockState, JoinSingleResult };
