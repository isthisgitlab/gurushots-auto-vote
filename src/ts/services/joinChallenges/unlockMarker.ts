/**
 * The persisted unlock claim (idempotency). A corrupt marker file must not look
 * empty: that would forget a real unlock and let a retry re-charge, so the paid
 * path treats an unreadable file as "cannot verify — do not spend".
 */

import { isPlainObject } from '../../plainObject';
import type { RawJsonStore } from '../../types/stores';
import { errorMessage } from '../../errorMessage';
import * as logger from '../../logger';
import { resolveMemberId } from '../autoFill/memberIdentity';
import { cat } from './shared';
import type { JoinDeps } from './shared';

// Read the marker map, distinguishing "empty/never-written" (ok:true, {}) from
// "unreadable/corrupt" (ok:false). A corrupt file must NOT silently look empty:
// that would forget a real unlock marker and let a retry re-charge. Callers on
// the paid path treat ok:false as "cannot verify — do not spend".
const readUnlockedState = (store: RawJsonStore | null | undefined): { state: Record<string, unknown>; ok: boolean } => {
    if (!store) return { state: {}, ok: true };
    let raw;
    try {
        raw = store.readRaw();
    } catch (error) {
        cat().warning(`could not read join-state: ${errorMessage(error) || error}`, null);
        return { state: {}, ok: false };
    }
    if (!raw) return { state: {}, ok: true };
    try {
        const parsed: unknown = JSON.parse(raw);
        if (isPlainObject(parsed)) {
            return { state: parsed, ok: true };
        }
        cat().warning('join-state file is malformed (not an object) — treating as unreadable', null);
        return { state: {}, ok: false };
    } catch (error) {
        // JSON.parse only ever throws a SyntaxError here (readRaw returns a string).
        cat().warning(`join-state file is corrupt: ${(error as SyntaxError).message}`, null);
        return { state: {}, ok: false };
    }
};

const readUnlocked = (store: RawJsonStore | null | undefined) => readUnlockedState(store).state;

const has = (state: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(state, key);

/**
 * The account whose join this is: its member id, which survives a re-login (a token does not). Null
 * when it cannot be told (no profile read wired in, or the lookup failed).
 */
const markerOwner = (token: string, deps: JoinDeps): Promise<string | null> =>
    deps.getCurrentMemberProfile
        ? resolveMemberId(token, deps.getCurrentMemberProfile, logger, 'join')
        : Promise.resolve(null);

// A marker is keyed `<member id>:<challenge id>`, so a challenge another account left a marker on is
// not one this account has paid for. A marker from before accounts were told apart is keyed by the
// challenge id alone: it stays in force for whoever reads it, which can only err towards not charging
// twice. Without a member id (no profile read wired in: the mock, tests) a marker is the bare id.
const markerKey = (id: string | number, owner: string | null) => (owner ? `${owner}:${id}` : String(id));

/**
 * Whether the account of a PAID join cannot be told although it should be: a real marker store and a
 * profile read are wired in, but the member id did not come. Such a join does nothing paid — it could
 * neither tell whose coins a marker holds nor write a marker that belongs to anyone.
 */
const paidOwnerUnknown = (deps: JoinDeps, owner: string | null): boolean =>
    owner === null && Boolean(deps.joinStateStore) && Boolean(deps.getCurrentMemberProfile);

/** Whether coins were already spent on this challenge by this account (or, bare, by anyone before accounts were told apart). */
const hasMarker = (state: Record<string, unknown>, id: string | number, owner: string | null) =>
    has(state, String(id)) || (owner !== null && has(state, markerKey(id, owner)));

/**
 * Whether this account already paid for the (paid) candidate and only has its submit left: it must
 * be finished whatever the balance or the budget now say, since the charge itself lowered them.
 */
const paidByThisAccount = async (
    challenge: { id?: string | number; join_coins?: number },
    token: string,
    deps: JoinDeps,
): Promise<boolean> => {
    const cost = Number(challenge?.join_coins);
    if (challenge?.id == null || !(cost > 0) || !deps.joinStateStore) return false;
    const owner = await markerOwner(token, deps);
    return !paidOwnerUnknown(deps, owner) && isUnlocked(deps.joinStateStore, challenge.id, owner);
};

const isUnlocked = (store: RawJsonStore | null | undefined, id: string | number, owner: string | null) =>
    hasMarker(readUnlocked(store), id, owner);

// Persist the unlock claim. Returns true on success (or when there is no store
// — mock mode, which spends no real coins). Returns false when a real store
// write fails: the caller MUST NOT spend coins it cannot record, or a crash /
// retry could re-unlock and double-charge.
const markUnlocked = (store: RawJsonStore | null | undefined, id: string | number, owner: string | null): boolean => {
    if (!store) return true;
    try {
        const state = readUnlocked(store);
        state[markerKey(id, owner)] = { unlockedAt: Date.now() };
        store.writeRaw(JSON.stringify(state));
        return true;
    } catch (error) {
        cat().warning(`could not persist unlock marker for ${id}: ${errorMessage(error) || error}`, null);
        return false;
    }
};

const clearUnlocked = (store: RawJsonStore | null | undefined, id: string | number, owner: string | null) => {
    if (!store) return;
    try {
        const state = readUnlocked(store);
        // Only this account's own claim: a bare one may be another account's protection against a second charge.
        const keys = [markerKey(id, owner)].filter((key) => has(state, key));
        if (keys.length > 0) {
            keys.forEach((key) => delete state[key]);
            store.writeRaw(JSON.stringify(state));
        }
    } catch (error) {
        cat().warning(`could not clear unlock marker for ${id}: ${errorMessage(error) || error}`, null);
    }
};

export {
    readUnlockedState,
    markerOwner,
    paidOwnerUnknown,
    paidByThisAccount,
    hasMarker,
    isUnlocked,
    markUnlocked,
    clearUnlocked,
};
