/**
 * Join flow shared types, the in-process in-flight set and the logger category.
 */

import * as logger from '../../logger';
import type { rankVisually } from '../visionVerifier';
import type { ActiveChallengesResponse } from '../../types/gurushots';
import type { RawJsonStore } from '../../types/stores';
import type { JoinReason } from '../../types/join';
import type * as joinApi from '../../api/join';
import type * as submissionsApi from '../../api/submissions';
import type * as tagsApi from '../../api/tags';
import type * as joinStateStore from '../../joinStateStore';

/**
 * The join flow's endpoints and state (documented in the joinChallenges.ts header).
 */
export interface JoinDeps {
    getMemberChallenges: typeof joinApi.getMemberChallenges;
    getBankroll: typeof joinApi.getBankroll;
    coinsUnlock: typeof joinApi.coinsUnlock;
    submitToChallenge: typeof submissionsApi.submitToChallenge;
    getEligiblePhotos: typeof submissionsApi.getEligiblePhotos;
    /** Without it, a chosen photo missing from the themed fetch is not looked for. */
    getEligiblePhotosWalk?: typeof submissionsApi.getEligiblePhotosWalk;
    searchTagAutocomplete?: typeof tagsApi.searchTagAutocomplete;
    getCurrentMemberProfile?: typeof tagsApi.getCurrentMemberProfile;
    /** The joined challenges, to count the turbos a turbo mission can still win (Join Early for Missions). */
    getActiveChallenges?: (token: string) => Promise<ActiveChallengesResponse>;
    /** null in mock mode */
    joinStateStore?: RawJsonStore | null;
    /** absent in mock mode */
    acquireUnlockLock?: typeof joinStateStore.acquireUnlockLock;
    /**
     * Reads the claims again from where they are saved (the Android app window, whose cache the background service
     * writes behind); false when that failed. Awaited before a claim is read to decide a spend, which is refused when
     * it failed. A claim is changed through the store's atomic `updateThrough`, not from this read. Absent where one
     * process owns the file.
     */
    refreshJoinState?: () => Promise<boolean>;
    /** test seam over the visual re-rank */
    rankVisually?: typeof rankVisually;
}

/**
 * One join's result. `charged` is coins spent THIS call; `maybeCharged` is the cost of an unlock that got no
 * answer, which may or may not have been spent (a pass counts it against its budget and balance, and does not
 * report it as charged).
 */
type JoinOutcome = {
    status: string;
    charged: number;
    maybeCharged?: number;
    /** The balance before a payment that is not confirmed, for the user to check against GuruShots. */
    coinsBefore?: number;
    imageId?: string;
    reason?: JoinReason;
};

/**
 * A persisted unlock claim as one join reads it: where it is stored, whether its payment is unconfirmed (an
 * unlock that got no answer), and whether it is a bare one from before
 * accounts were told apart (whose coins it holds is unknown). `coinsBefore` is the balance the caller had just before
 * the unlock, kept for the user to compare with GuruShots; nothing decides on it. `joined`: the join it was for has
 * succeeded; it stays as the proof of that, for a process that read the open list before, until pruning removes it.
 */
type Claim = { key: string; unconfirmed: boolean; legacy: boolean; joined: boolean; coinsBefore: number | null };

/**
 * The claim a join continues from (null: none), and the coins this call spent unlocking.
 */
type UnlockState = { charged: number; alreadyUnlocked: boolean; claim: Claim | null };

/**
 * The manual single join's result.
 */
type JoinSingleResult = {
    status: string;
    challengeId: string | number;
    cost: number;
    coins?: number;
    imageId?: string;
    reason?: JoinReason;
    coinsBefore?: number;
};

// Shared across the manual handler and the automatic pass IN THIS PROCESS so the
// two cannot double-spend the same challenge. Module-level = one Set per process;
// cross-process racing is bounded by the persisted claim and the unlock lock (performJoin.ts).
const inFlight: Set<string> = new Set();

const cat = () => logger.withCategory('join');

/**
 * The cross-process unlock lock of one challenge, or (`internal`) one of the app's own such as the claims file's
 * (always granted where none is wired in: mock mode).
 */
const lockFor = (deps: JoinDeps, id: string | number, internal = false): { ok: boolean; release: () => void } =>
    deps.acquireUnlockLock ? deps.acquireUnlockLock(id, { internal }) : { ok: true, release: () => {} };

export { inFlight, cat, lockFor };
export type { Claim, JoinOutcome, UnlockState, JoinSingleResult };
