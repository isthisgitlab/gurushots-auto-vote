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
import type { Claim, JoinDeps } from './shared';

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

// A claim this young is never pruned for a challenge missing from the list (see pruneClosedClaims).
const CLAIM_PRUNE_MIN_AGE_MS = 6 * 60 * 60 * 1000;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The claim this account's join of the challenge continues from: its own keyed one, else a bare one from before
 * accounts were told apart (it counts for every account). Null when there is none.
 */
const findClaim = (state: Record<string, unknown>, id: string | number, owner: string | null): Claim | null => {
    const key = markerKey(id, owner);
    const bare = String(id);
    const found = has(state, key) ? key : has(state, bare) ? bare : null;
    if (found === null) return null;
    const value = state[found];
    return { key: found, unconfirmed: isPlainObject(value) && value.unconfirmed === true, legacy: found !== key };
};

const claimOf = (store: RawJsonStore | null | undefined, id: string | number, owner: string | null) =>
    findClaim(readUnlocked(store), id, owner);

/**
 * Whether this account already paid for the (paid) candidate and only has its submit left: it must
 * be finished whatever the balance or the budget now say, since the charge itself lowered them. An
 * unconfirmed claim stands like any other until a paid submit that used it succeeds, or the user forgets it.
 */
const paidByThisAccount = async (
    challenge: { id?: string | number; join_coins?: number },
    token: string,
    deps: JoinDeps,
): Promise<boolean> => {
    const cost = Number(challenge?.join_coins);
    if (challenge?.id == null || !(cost > 0) || !deps.joinStateStore) return false;
    const owner = await markerOwner(token, deps);
    return !paidOwnerUnknown(deps, owner) && claimOf(deps.joinStateStore, challenge.id, owner) !== null;
};

/**
 * Reads the claims, lets `change` edit them and writes them back. Nothing is written when the file cannot be
 * read (an unreadable file read as empty would wipe every other claim on the next write); false then, and when
 * the write fails. `change` answers whether it changed anything. A store of none (mock mode) changes nothing and
 * succeeds. Failures are logged by challenge id only.
 */
const changeClaims = (
    store: RawJsonStore | null | undefined,
    what: string,
    change: (state: Record<string, unknown>) => boolean,
): boolean => {
    if (!store) return true;
    const { state, ok } = readUnlockedState(store);
    if (!ok) {
        cat().warning(`could not ${what}: join-state is unreadable — nothing written`, null);
        return false;
    }
    try {
        if (change(state)) store.writeRaw(JSON.stringify(state));
        return true;
    } catch (error) {
        cat().warning(`could not ${what}: ${errorMessage(error) || error}`, null);
        return false;
    }
};

// The challenge id of a stored claim key (`<member id>:<challenge id>`, or the bare id).
const idOfKey = (key: string) => key.slice(key.lastIndexOf(':') + 1);

// Persist the unlock claim. Returns true on success (or when there is no store
// — mock mode, which spends no real coins). Returns false when the file cannot be read or a real store
// write fails: the caller MUST NOT spend coins it cannot record, or a crash /
// retry could re-unlock and double-charge.
const markUnlocked = (store: RawJsonStore | null | undefined, id: string | number, owner: string | null): boolean =>
    changeClaims(store, `persist unlock marker for ${id}`, (state) => {
        state[markerKey(id, owner)] = { unlockedAt: Date.now() };
        return true;
    });

/** The unlock got no answer: the claim stays, flagged unconfirmed. */
const markUnconfirmed = (store: RawJsonStore | null | undefined, id: string | number, owner: string | null): void => {
    changeClaims(store, `flag the unlock marker for ${id} as unconfirmed`, (state) => {
        const claim = state[markerKey(id, owner)];
        if (!isPlainObject(claim)) return false;
        state[markerKey(id, owner)] = { ...claim, unconfirmed: true };
        return true;
    });
};

/**
 * Removes one claim, by the key it is stored under. Never a claim that was not read as the one in use: a bare
 * one may be another account's protection against a second charge.
 */
const clearUnlocked = (store: RawJsonStore | null | undefined, key: string): void => {
    changeClaims(store, `clear unlock marker for ${idOfKey(key)}`, (state) => {
        if (!has(state, key)) return false;
        delete state[key];
        return true;
    });
};

/**
 * What the user may forget: this account's claim for the challenge when it is still unconfirmed, or a bare
 * one from before accounts were told apart. Never a confirmed claim (its coins are known to be taken), and never
 * a bare one while the account has its own claim for the challenge.
 *
 * @returns 'forgotten', 'nothing-to-forget' (no claim, or only a confirmed one), or 'unreadable'
 */
const forgetClaim = (
    store: RawJsonStore | null | undefined,
    id: string | number,
    owner: string | null,
): 'forgotten' | 'nothing-to-forget' | 'unreadable' => {
    let forgotten = false;
    const done = changeClaims(store, `forget the unlock marker for ${id}`, (state) => {
        const claim = findClaim(state, id, owner);
        if (!claim || !(claim.unconfirmed || claim.legacy)) return false;
        delete state[claim.key];
        forgotten = true;
        return true;
    });
    if (!done) return 'unreadable';
    return forgotten ? 'forgotten' : 'nothing-to-forget';
};

/**
 * Drops the claims of this account whose challenge is no longer open, so joinState.json does not grow for
 * ever. Only from a successful, non-empty open list (an empty one is never trusted, like the open-list memory
 * of the settings facade), and only the claims keyed by this account: the list is this account's, so a challenge
 * missing from it says nothing about another account's claim on it, and a bare claim from before accounts were
 * told apart may be another's too. An account that cannot be told prunes nothing. A claim younger than
 * CLAIM_PRUNE_MIN_AGE_MS is kept whatever the list says: it may belong to a join under way that the list,
 * read a moment earlier, could not have known about.
 *
 * @param open - the open list the join code just read successfully
 */
const pruneClosedClaims = async (
    open: ReadonlyArray<{ id?: string | number } | null>,
    token: string,
    deps: JoinDeps,
): Promise<void> => {
    const store = deps.joinStateStore;
    const openIds = new Set(open.flatMap((c) => (c?.id == null ? [] : [String(c.id)])));
    if (!store || openIds.size === 0 || Object.keys(readUnlocked(store)).length === 0) return;
    const owner = await markerOwner(token, deps);
    if (paidOwnerUnknown(deps, owner)) return;
    const now = Date.now();
    const closed = (key: string, claim: unknown) => {
        const sep = key.lastIndexOf(':');
        const own = owner === null ? sep === -1 : key.startsWith(`${owner}:`);
        const at = isPlainObject(claim) ? claim.unlockedAt : undefined;
        const old = isFiniteNumber(at) && now - at >= CLAIM_PRUNE_MIN_AGE_MS;
        return own && old && !openIds.has(key.slice(sep + 1));
    };
    changeClaims(store, 'prune the unlock markers', (state) => {
        const stale = Object.keys(state).filter((key) => closed(key, state[key]));
        stale.forEach((key) => delete state[key]);
        if (stale.length > 0)
            cat().debug(`dropped ${stale.length} unlock claim(s) of challenges that are no longer open`, null);
        return stale.length > 0;
    });
};

export {
    readUnlockedState,
    markerKey,
    findClaim,
    claimOf,
    pruneClosedClaims,
    markUnconfirmed,
    forgetClaim,
    markerOwner,
    paidOwnerUnknown,
    paidByThisAccount,
    markUnlocked,
    clearUnlocked,
};
