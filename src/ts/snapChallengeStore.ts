/**
 * The challenges whose turbo has ever been reported as Snap. A challenge seen as Snap stays Snap: GuruShots later
 * reports it as classic (the Snap was withdrawn, its session died, a won Snap's next game), and the classic game must
 * never earn a turbo that was meant to be Snap. strategies/real/activeChallenges keeps the mode of every id here at
 * 'snap', so only the Snap runner ever plays it.
 *
 * Shape: `{ "<challengeId>": <the challenge's close_time, unix seconds> }`. An id leaves the file once its challenge
 * has been closed for an hour, whether or not a list still has it; a challenge that is merely missing from a list is
 * kept. A challenge seen as Snap without a usable close_time is stored as the ms it was first seen (a value above
 * FIRST_SEEN_MS_FLOOR): the next list that has the challenge replaces it with its close_time, and one never listed again
 * is forgotten 30 days after it. Every id seen as Snap in this process also holds in memory and is saved again with
 * the next change, so a save that failed does not let a classic game earn that turbo.
 *
 * Same platform-aware transport as joinStateStore, so on Capacitor its cache MUST be hydrated at boot
 * (initializeSnapChallengesAsync, wired in Capacitor.tsx). The store is `shared`: the Android app window and the
 * background service both record, each change is saved by the native compare-and-write so that neither erases the
 * other's, and the window re-reads the stored value before it decides. It fails CLOSED: a store that cannot be read
 * (the bridge threw, the start-up read failed, the text is no JSON object) reads as unknown, never as empty, and the
 * caller then plays no classic turbo (read() answers null); an unreadable store is never written over. Deleting local
 * data clears a damaged one. The real read is the only user: mock mode never touches it.
 */

import type { RawJsonStore } from './types/stores';
import * as logger from './logger';
import { createJsonStore } from './settings/storage';
import { storeLoaded, throughStore } from './settings/storeTransport';
import { isPlainObject } from './plainObject';
import { errorMessage } from './errorMessage';

const SNAP_CHALLENGES_KEY = 'gs_snap_challenges';
// `strict`: a record the service's native bridge did not persist is not silently lost. `shared`: see above.
const snapChallengeFile = createJsonStore({
    fileName: 'snapChallenges.json',
    prefKey: SNAP_CHALLENGES_KEY,
    atomic: true,
    strict: true,
    shared: true,
});

// A store that could not be read throws when read (so that the ledger reads it as unknown, never as no Snap
// challenges: a pin forgotten lets a classic game earn a Snap turbo), and is not changed on a cache that was never filled.
const snapChallengeStore = {
    ...snapChallengeFile,
    readRaw: (): string | null => {
        const raw = snapChallengeFile.readRaw();
        if (!storeLoaded(SNAP_CHALLENGES_KEY)) throw new Error('the saved Snap challenges have not loaded');
        return raw;
    },
    updateThrough: (update: (current: string | null) => string | null) =>
        storeLoaded(SNAP_CHALLENGES_KEY) ? snapChallengeFile.updateThrough(update) : Promise.resolve('failed' as const),
};

const cat = () => logger.withCategory('turbo');

// How long after its close_time a challenge's id is forgotten.
const CLOSED_GRACE_SEC = 3600;
// A stored value above this is the ms an id was first seen, not a close_time in seconds (that is 1e11 s: year 5138).
const FIRST_SEEN_MS_FLOOR = 1e11;
const FIRST_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A challenge of the active list, as the record sees it. `snap`: its turbo is reported as Snap now. */
type ListedChallenge = { id: string; closeTime: number; snap: boolean };

const isCloseTime = (value: number): boolean => Number.isFinite(value) && value > 0 && value < FIRST_SEEN_MS_FLOOR;

/** The ms from which the challenge a stored value stands for counts as over; never for a value that is no number. */
const expiresAt = (value: unknown): number => {
    if (typeof value !== 'number') return Infinity;
    return value > FIRST_SEEN_MS_FLOOR ? value + FIRST_SEEN_TTL_MS : (value + CLOSED_GRACE_SEC) * 1000;
};

const isOver = (value: unknown, nowMs: number): boolean => expiresAt(value) < nowMs;

/**
 * The stored text as an object of ids; null when it is not one (a file that is empty, no JSON, or not an object).
 * A store never written reads as none.
 */
const parseState = (raw: string | null): Record<string, unknown> | null => {
    if (raw === null) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        return isPlainObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
};

/**
 * Ledger over a raw-JSON store. `refresh` re-reads a store another context may have changed (the Android app window's
 * cache); it answers false when that failed.
 */
const createSnapLedger = (store: RawJsonStore, refresh?: () => Promise<boolean>) => {
    // Said when the store turns unreadable, not on every pass after it.
    let unreadableLogged = false;
    // Said when a save fails, not on every pass after it, until a save succeeds again.
    let saveFailedLogged = false;
    // Ids seen as Snap in this process with what is stored for them, saved or not: they hold even when the save failed.
    const seenThisRun = new Map<string, number>();

    const unreadable = (why: string): null => {
        if (!unreadableLogged) {
            cat().warning(`Snap challenges unreadable (${why}); no classic turbo is played until they are`, null);
            unreadableLogged = true;
        }
        return null;
    };

    const readState = (): Record<string, unknown> | null => {
        let raw: string | null;
        try {
            raw = store.readRaw();
        } catch (error) {
            return unreadable(errorMessage(error) ?? String(error));
        }
        const state = parseState(raw);
        if (!state) return unreadable('not a JSON object');
        unreadableLogged = false;
        return state;
    };

    return {
        /**
         * The ids ever seen as Snap, read from what is stored now plus those seen in this process; null when the
         * stored ones cannot be told (fail closed: the caller plays nothing as classic).
         */
        read: async (): Promise<ReadonlySet<string> | null> => {
            if (refresh && !(await refresh())) return unreadable('the stored value could not be read again');
            const state = readState();
            return state ? new Set([...Object.keys(state), ...seenThisRun.keys()]) : null;
        },

        /**
         * Records every challenge of the active list that is reported as Snap, keeps the close_time of every recorded
         * one in step with the list, and drops every id whose challenge has been closed for an hour, in one atomic
         * change on what is stored. Nothing is written over an unreadable store or when nothing changes.
         */
        record: async (listing: readonly ListedChallenge[]): Promise<void> => {
            const nowMs = Date.now();
            for (const { id, closeTime, snap } of listing) {
                if (isCloseTime(closeTime) && seenThisRun.has(id)) seenThisRun.set(id, closeTime);
                else if (snap && !seenThisRun.has(id)) seenThisRun.set(id, isCloseTime(closeTime) ? closeTime : nowMs);
            }
            for (const [id, value] of seenThisRun) if (isOver(value, nowMs)) seenThisRun.delete(id);
            const result = await throughStore(store, (current) => {
                const state = parseState(current);
                if (!state) return null;
                let changed = false;
                // What this process holds wins over an earlier value another writer saved (a longer close_time).
                for (const [id, value] of seenThisRun) {
                    if (Object.hasOwn(state, id) && expiresAt(value) <= expiresAt(state[id])) continue;
                    state[id] = value;
                    changed = true;
                }
                for (const { id, closeTime } of listing) {
                    if (!Object.hasOwn(state, id) || !isCloseTime(closeTime) || state[id] === closeTime) continue;
                    state[id] = closeTime;
                    changed = true;
                }
                for (const [id, value] of Object.entries(state)) {
                    if (!isOver(value, nowMs)) continue;
                    delete state[id];
                    changed = true;
                }
                return changed ? JSON.stringify(state) : null;
            });
            if (result === 'failed') {
                if (!saveFailedLogged) cat().warning('Snap challenges could not be saved', null);
                saveFailedLogged = true;
            } else if (result === 'saved') {
                saveFailedLogged = false;
            }
        },
    };
};

const snapLedger = createSnapLedger(snapChallengeStore, snapChallengeFile.refreshAsync);

export const initializeSnapChallengesAsync = snapChallengeFile.initializeAsync;
export const flushSnapChallengeWrites = (): Promise<void> => snapChallengeFile.flushPendingWrites();
export type { ListedChallenge };
export { createSnapLedger, snapLedger };
