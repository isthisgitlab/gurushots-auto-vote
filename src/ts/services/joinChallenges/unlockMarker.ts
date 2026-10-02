/**
 * The persisted unlock claim (idempotency).
 */

import { isPlainObject } from '../../plainObject';
import type { RawJsonStore } from '../../types/stores';
import { errorMessage } from '../../errorMessage';
import { cat } from './shared';

// ---- persisted unlock marker (idempotency) ----

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

const isUnlocked = (store: RawJsonStore | null | undefined, id: string | number) =>
    Object.prototype.hasOwnProperty.call(readUnlocked(store), String(id));

// Persist the unlock claim. Returns true on success (or when there is no store
// — mock mode, which spends no real coins). Returns false when a real store
// write fails: the caller MUST NOT spend coins it cannot record, or a crash /
// retry could re-unlock and double-charge.
const markUnlocked = (store: RawJsonStore | null | undefined, id: string | number): boolean => {
    if (!store) return true;
    try {
        const state = readUnlocked(store);
        state[String(id)] = { unlockedAt: Date.now() };
        store.writeRaw(JSON.stringify(state));
        return true;
    } catch (error) {
        cat().warning(`could not persist unlock marker for ${id}: ${errorMessage(error) || error}`, null);
        return false;
    }
};

const clearUnlocked = (store: RawJsonStore | null | undefined, id: string | number) => {
    if (!store) return;
    try {
        const state = readUnlocked(store);
        if (Object.prototype.hasOwnProperty.call(state, String(id))) {
            delete state[String(id)];
            store.writeRaw(JSON.stringify(state));
        }
    } catch (error) {
        cat().warning(`could not clear unlock marker for ${id}: ${errorMessage(error) || error}`, null);
    }
};

export { readUnlockedState, isUnlocked, markUnlocked, clearUnlocked };
