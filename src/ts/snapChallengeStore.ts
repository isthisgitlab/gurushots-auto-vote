/**
 * The challenges whose turbo has ever been reported as Snap. A challenge seen as Snap stays Snap: GuruShots later
 * reports it as classic (the Snap was withdrawn, its session died, a won Snap's next game), and the classic game must
 * never earn a turbo that was meant to be Snap. strategies/real/activeChallenges keeps the mode of every id here at
 * 'snap', so only the Snap runner ever plays it.
 *
 * Shape: `{ "<challengeId>": <ms the challenge was first seen as Snap> }`. An id leaves the file once it is missing
 * from a successful, non-empty active list (the challenge is over).
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
         * The ids ever seen as Snap, read from what is stored now; null when that cannot be told (fail closed: the
         * caller plays nothing as classic).
         */
        read: async (): Promise<ReadonlySet<string> | null> => {
            if (refresh && !(await refresh())) return unreadable('the stored value could not be read again');
            const state = readState();
            return state ? new Set(Object.keys(state)) : null;
        },

        /**
         * Records `seen` (ids reported as Snap now) and drops every id that is not in `active`, in one atomic change
         * on what is stored. Nothing is dropped for an empty `active` (a failed or empty list says nothing of what is
         * over), and nothing is written over an unreadable store or when nothing changes.
         */
        record: async (seen: readonly string[], active: readonly string[]): Promise<void> => {
            const activeIds = new Set(active);
            const result = await throughStore(store, (current) => {
                const state = parseState(current);
                if (!state) return null;
                let changed = false;
                for (const id of seen) {
                    if (Object.hasOwn(state, id)) continue;
                    state[id] = Date.now();
                    changed = true;
                }
                if (activeIds.size > 0) {
                    for (const id of Object.keys(state)) {
                        if (activeIds.has(id)) continue;
                        delete state[id];
                        changed = true;
                    }
                }
                return changed ? JSON.stringify(state) : null;
            });
            if (result === 'failed') cat().warning('Snap challenges could not be saved', null);
        },
    };
};

const snapLedger = createSnapLedger(snapChallengeStore, snapChallengeFile.refreshAsync);

export const initializeSnapChallengesAsync = snapChallengeFile.initializeAsync;
export const flushSnapChallengeWrites = (): Promise<void> => snapChallengeFile.flushPendingWrites();
export { createSnapLedger, snapLedger };
