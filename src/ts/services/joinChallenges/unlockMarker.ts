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
import { sanitizeLogString } from '../../logger/sanitize';
import { cat, lockFor } from './shared';
import type { Claim, JoinDeps } from './shared';
import type { ForgetStatus } from '../../types/join';

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
    // Never written reads as null. An empty file is not a claims file: every write is a whole JSON object (and a
    // file that is replaced atomically is never seen half written), so an empty one is a write cut short by
    // something that does not write atomically — it may have held a claim, and is not read as having none.
    if (raw === null || raw === undefined) return { state: {}, ok: true };
    if (raw.trim() === '') {
        cat().warning('join-state file is empty — treating as unreadable', null);
        return { state: {}, ok: false };
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (isPlainObject(parsed)) {
            return { state: parsed, ok: true };
        }
        cat().warning('join-state file is malformed (not an object) — treating as unreadable', null);
        return { state: {}, ok: false };
    } catch (error) {
        // JSON.parse only ever throws a SyntaxError here (readRaw returns a string).
        cat().warning(`join-state file is corrupt: ${errorMessage(error)}`, null);
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
// A claim this old is dropped whoever's it is: no challenge lives that long.
const CLAIM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The claim this account's join of the challenge continues from: its own keyed one, else a bare one from before
 * accounts were told apart (it counts for every account). Null when there is none.
 */
const findClaim = (state: Record<string, unknown>, id: string | number, owner: string | null): Claim | null => {
    const key = markerKey(id, owner);
    // A key with a colon is some account's own (`<member id>:<challenge id>`), never a bare one.
    const bare = String(id);
    const found = has(state, key) ? key : has(state, bare) && !bare.includes(':') ? bare : null;
    if (found === null) return null;
    const value = state[found];
    const before = isPlainObject(value) ? value.coinsBefore : undefined;
    return {
        key: found,
        unconfirmed: isPlainObject(value) && value.unconfirmed === true,
        legacy: found !== key,
        joined: isPlainObject(value) && isFiniteNumber(value.joinedAt),
        coinsBefore: isFiniteNumber(before) ? before : null,
    };
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

// The claims file is one file for every challenge, so a change of it is read-modify-write of the whole: two processes
// changing different challenges would drop one of the changes. It is changed only under this lock, held briefly.
const STATE_LOCK_ID = 'joinstate';
// The wait blocks the calling thread (changing a claim is synchronous), so it is short on purpose: the file is
// changed rarely and held for a few milliseconds, a held lock means another process is in the middle of a change,
// and a join that cannot record its claim in half a second fails safe (nothing is spent) instead of waiting longer.
const STATE_LOCK_WAIT_MS = 500;
const STATE_LOCK_STEP_MS = 10;

const sleepSync = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * The lock of the claims file, waited for a moment when another process holds it. Null when it could not be had.
 */
const acquireStateLock = (deps: JoinDeps, waitMs: number): { release: () => void } | null => {
    const deadline = Date.now() + waitMs;
    for (;;) {
        const lock = lockFor(deps, STATE_LOCK_ID);
        if (lock.ok) return lock;
        if (Date.now() >= deadline) return null;
        sleepSync(STATE_LOCK_STEP_MS);
    }
};

/**
 * How a change of the claims file ended: `done` (written, or nothing to write), `locked` (the file's lock could not be
 * had in a moment) or `failed` (the file is unreadable, or the write failed).
 */
type Changed = 'done' | 'locked' | 'failed';

/**
 * Reads the claims, lets `change` edit them and writes them back, under the claims-file lock. Nothing is written
 * when the file cannot be read (an unreadable file read as empty would wipe every other claim on the next write)
 * or the lock cannot be had in a moment. `change` answers whether it changed anything. A store of none (mock mode)
 * changes nothing and succeeds. Failures are logged by challenge id only.
 */
const changeClaims = (
    deps: JoinDeps,
    what: string,
    change: (state: Record<string, unknown>) => boolean,
    waitMs = STATE_LOCK_WAIT_MS,
): Changed => {
    const store = deps.joinStateStore;
    if (!store) return 'done';
    const lock = acquireStateLock(deps, waitMs);
    if (!lock) {
        cat().warning(`could not ${what}: join-state is locked by another process — nothing written`, null);
        return 'locked';
    }
    try {
        const { state, ok } = readUnlockedState(store);
        if (!ok) {
            cat().warning(`could not ${what}: join-state is unreadable — nothing written`, null);
            return 'failed';
        }
        if (change(state)) store.writeRaw(JSON.stringify(state));
        return 'done';
    } catch (error) {
        cat().warning(`could not ${what}: ${errorMessage(error) || error}`, null);
        // aislop-ignore-next-line ai-slop/hidden-fallback -- logged just above; 'failed' is the typed outcome every caller handles
        return 'failed';
    } finally {
        lock.release();
    }
};

// The challenge id of a stored claim key (`<member id>:<challenge id>`, or the bare id).
const idOfKey = (key: string) => key.slice(key.lastIndexOf(':') + 1);

// Persist the unlock claim — only when this account has none for the challenge yet (own or bare), decided inside
// the same locked read-modify-write that writes it, so two holders of the challenge's lock cannot both record one.
// Returns true on success (or when there is no store — mock mode, which spends no real coins). Returns false when
// the file cannot be read, a claim is there already, the file's lock cannot be had or a real store write fails: the
// caller MUST NOT spend coins it cannot record, or a crash / retry could re-unlock and double-charge.
const markUnlocked = (
    deps: JoinDeps,
    id: string | number,
    owner: string | null,
    coinsBefore: number | null,
): boolean => {
    let recorded = false;
    const done = changeClaims(deps, `persist unlock marker for ${sanitizeLogString(id)}`, (state) => {
        if (findClaim(state, id, owner) !== null) return false;
        state[markerKey(id, owner)] = {
            unlockedAt: Date.now(),
            ...(isFiniteNumber(coinsBefore) ? { coinsBefore } : {}),
        };
        recorded = true;
        return true;
    });
    return !deps.joinStateStore || (done === 'done' && recorded);
};

/**
 * The unlock got no answer: the claim stays, flagged unconfirmed.
 *
 * @returns whether the flag is on the claim now: a claim that could not be flagged reads as a confirmed one
 */
const markUnconfirmed = (deps: JoinDeps, id: string | number, owner: string | null): boolean => {
    let flagged = false;
    const done = changeClaims(deps, `flag the unlock marker for ${sanitizeLogString(id)} as unconfirmed`, (state) => {
        const claim = state[markerKey(id, owner)];
        if (!isPlainObject(claim)) return false;
        state[markerKey(id, owner)] = { ...claim, unconfirmed: true };
        flagged = true;
        return true;
    });
    return !deps.joinStateStore || (done === 'done' && flagged);
};

/**
 * Removes one claim, by the key it is stored under. Never a claim that was not read as the one in use: a bare
 * one may be another account's protection against a second charge.
 *
 * @returns how the change ended: `done` means the claim is gone (or was never there)
 */
const clearUnlocked = (deps: JoinDeps, key: string, waitMs?: number): Changed =>
    changeClaims(
        deps,
        `clear unlock marker for ${sanitizeLogString(idOfKey(key))}`,
        (state) => {
            if (!has(state, key)) return false;
            delete state[key];
            return true;
        },
        waitMs,
    );

/**
 * The join the claim was for succeeded: the claim stays, marked joined, so a process that read the open list
 * before it (and then spent a while picking a photo) finds the proof under the lock and does not unlock again. It
 * is never forgettable, and pruning removes it once its challenge has left the list.
 */
const markJoined = (deps: JoinDeps, key: string): void => {
    changeClaims(deps, `mark the unlock marker for ${sanitizeLogString(idOfKey(key))} as joined`, (state) => {
        const claim = state[key];
        if (!isPlainObject(claim)) return false;
        // `unconfirmed: undefined` is left out of the JSON: a join that went through has no payment left to doubt.
        state[key] = { ...claim, unconfirmed: undefined, joinedAt: Date.now() };
        return true;
    });
};

type ForgetResult = Extract<ForgetStatus, 'forgotten' | 'nothing-to-forget' | 'legacy-record' | 'busy' | 'unreadable'>;

/**
 * What the user may forget: this account's claim for the challenge when it is still unconfirmed. Never a confirmed
 * claim (its coins are known to be taken). A bare claim from before accounts were told apart is never forgotten
 * either: it may be ANOTHER account's protection against a second charge, and nothing on this device can tell
 * whose. It clears by itself (a paid submit that used it succeeds, or it passes CLAIM_MAX_AGE_MS).
 *
 * @returns 'forgotten', 'nothing-to-forget' (no claim, or only a confirmed one), 'legacy-record' (a bare claim),
 *   'busy' (the claims file is locked by another process) or 'unreadable'
 */
const forgetClaim = (deps: JoinDeps, id: string | number, owner: string | null): ForgetResult => {
    let result: ForgetResult = 'nothing-to-forget';
    const done = changeClaims(deps, `forget the unlock marker for ${sanitizeLogString(id)}`, (state) => {
        const claim = findClaim(state, id, owner);
        if (!claim) return false;
        if (claim.legacy) {
            result = 'legacy-record';
            return false;
        }
        if (!claim.unconfirmed) return false;
        delete state[claim.key];
        result = 'forgotten';
        return true;
    });
    if (done === 'locked') return 'busy';
    return done === 'done' ? result : 'unreadable';
};

/**
 * Drops claims that have outlived their use, so joinState.json does not grow for ever:
 *   - any claim, bare or of any account, older than CLAIM_MAX_AGE_MS (unless it is this account's own keyed claim
 *     of a challenge in the list just read): no challenge lives that long, and it ends the keeping of other
 *     accounts' records (and balances) for good. A bare claim is never kept by the list: that this account can see
 *     the challenge says nothing about whose the bare claim is;
 *   - this account's own claims whose challenge is no longer open, from a successful, non-empty open list (an
 *     empty one is never trusted, like the open-list memory of the settings facade). The list is this account's, so
 *     a challenge missing from it says nothing about another account's claim on it, nor about a bare claim.
 * A claim's age counts from its join once it has joined. An account that cannot be told prunes by age only. A claim
 * younger than CLAIM_PRUNE_MIN_AGE_MS is kept whatever
 * the list says: it may belong to a join under way that the list, read a moment earlier, could not have known of.
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
    const ownerKnown = !paidOwnerUnknown(deps, owner);
    const now = Date.now();
    const age = (claim: unknown) => {
        const at = isPlainObject(claim) ? (claim.joinedAt ?? claim.unlockedAt) : undefined;
        return isFiniteNumber(at) ? now - at : null;
    };
    const droppable = (key: string, claim: unknown) => {
        const claimAge = age(claim);
        if (claimAge === null) return false;
        const sep = key.lastIndexOf(':');
        const own = owner === null ? sep === -1 : key.startsWith(`${owner}:`);
        const open = own && openIds.has(key.slice(sep + 1));
        // Age alone never removes this account's own keyed claim of a challenge it can still join: that is its
        // protection. A bare claim has no such protection: the list says nothing about whose it is.
        if (claimAge >= CLAIM_MAX_AGE_MS) return sep === -1 || !open;
        return ownerKnown && own && claimAge >= CLAIM_PRUNE_MIN_AGE_MS && !open;
    };
    // A challenge whose unlock lock another process holds is mid-join: its claim is left alone.
    const held: Array<{ release: () => void }> = [];
    let dropped = 0;
    try {
        const done = changeClaims(deps, 'prune the unlock markers', (state) => {
            const stale = Object.keys(state)
                .filter((key) => droppable(key, state[key]))
                .filter((key) => {
                    const lock = lockFor(deps, idOfKey(key));
                    if (lock.ok) held.push(lock);
                    return lock.ok;
                });
            stale.forEach((key) => delete state[key]);
            dropped = stale.length;
            return stale.length > 0;
        });
        if (done === 'done' && dropped > 0) {
            cat().debug(`dropped ${dropped} unlock claim(s) that are no longer needed`, null);
        }
    } finally {
        held.forEach((lock) => lock.release());
    }
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
    markJoined,
    clearUnlocked,
};
