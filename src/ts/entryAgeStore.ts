/**
 * When each entry of a challenge entered it, so a boost can wait until its target
 * photo has been in the challenge for `boostFreshEntryWait` (a boost spent on a
 * photo the moment it is entered gets few votes). The API reports no entry time,
 * so the app records one: a photo the app submits is stamped at the submit; any
 * other entry at the first challenge fetch (a refresh, a pass, the CLI) that shows it.
 *
 * Also remembers the photo a boost fill-new submitted and is waiting on
 * (`pending`), so the next pass boosts that photo instead of submitting another.
 *
 * Shape, keyed by challenge id:
 *   { "<challengeId>": { closeTime, entered: { "<imageId>": unixSec }, pending, uncertain, exact, observed, firstSeen, pinSubmitFailed } }
 * An `entered` time of 0 means "already there when the app first saw the
 * challenge" (or its submit time was never recorded) — its age is unknown, so it never holds a boost. An id in `exact`
 * went in through the app (its time is the submit); any other time is the first
 * fetch that showed the entry, so the entry went in at or before it. The UI
 * shows both, and shows an entry of unknown age (0) as the record's `firstSeen`, the first fetch that showed the
 * challenge's entries, also "or earlier" (observeAll, services/entryTimes).
 *
 * Same platform-aware transport as currencyAutoStore, so on Capacitor its cache
 * MUST be hydrated at boot (initializeEntryAgesAsync, wired in Capacitor.tsx).
 * The store is shared with the Android background service: every write is a
 * read-modify-write through the store (throughStore), and the ledger reads its
 * own writes before they have landed (the app window saves behind a cache).
 * Mock mode uses createMemoryEntryAgeLedger() and never touches the file.
 */

import type { EntryTimes, RawJsonStore } from './types/stores';
import type { Challenge } from './types/gurushots';
import { createJsonStore } from './settings/storage';
import { createStateLog } from './entryAgeStateLog';
import type { State } from './entryAgeStateLog';
import { createMemoryRawJsonStore } from './parseUntrustedJson';
import { finiteOr } from './numbers';
import {
    knownTimes,
    observeChallenges,
    pendingEdit,
    pinSubmitFailedEdit,
    submittedEdit,
    uncertainEdit,
    withRecord,
} from './entryAgeRecords';

// `shared`: the Android background service records entries too (gs_entry_ages is on its native allow-list), and each
// change is saved by the native compare-and-write so that neither context erases the other's.
const entryAgeStore = createJsonStore({
    fileName: 'entryAges.json',
    prefKey: 'gs_entry_ages',
    atomic: true,
    shared: true,
});

/**
 * The Boost-pinned-submit latch methods, over the ledger's read and mark write.
 */
const pinSubmitLatch = (read: () => State, write: (edit: (state: State) => State | null) => void) => ({
    /**
     * Record that the photo pinned for Boost could not be submitted for this Boost window (a definitive
     * failure): the Boost-pinned submit stops trying until the window ends or the pin changes. The rest of
     * the record — pending, exact, uncertain — is left as it is.
     * @param now - Unix seconds
     */
    markPinSubmitFailed: (challenge: Challenge, imageId: string | number, boostDeadline: number, now: number) => {
        write((state) => pinSubmitFailedEdit(state, challenge, imageId, boostDeadline, now));
    },

    /**
     * Whether the Boost-pinned-submit failure latch is set for this challenge, photo and Boost window: all
     * three must match what was stored.
     */
    pinSubmitFailed: (challengeId: string | number, imageId: string | number, boostDeadline: number): boolean => {
        const latch = read()[String(challengeId)]?.pinSubmitFailed;
        return latch != null && latch.imageId === String(imageId) && latch.boostDeadline === boostDeadline;
    },
});

/**
 * Ledger over a raw-JSON store ({readRaw, writeRaw}); see createStateLog for how its writes reach the store.
 *
 * @param refreshStore - re-reads the stored value where the cache can be behind it (the app window); true when it did
 */
const createEntryAgeLedger = (store: RawJsonStore, refreshStore?: () => Promise<boolean>) => {
    const { read, write: writeChange, refresh } = createStateLog(store, refreshStore);
    const observing = (edit: (state: State) => State | null) => writeChange('observe', edit);
    const write = (edit: (state: State) => State | null) => writeChange('mark', edit);
    return {
        /**
         * Record the current entries of `challenge`. Writes only when something changed.
         * @param now - Unix seconds
         */
        observe: (challenge: Challenge, now: number) => {
            observing((state) => observeChallenges(state, [challenge], now));
        },

        /**
         * Record the entries of every challenge of one fetch with at most one write, and answer when each entry
         * went in: per challenge id, per entry id. An entry of unknown age is answered with the record's `firstSeen`
         * (not exact: it was there by then).
         * @param now - Unix seconds
         */
        observeAll: (challenges: readonly Challenge[], now: number): EntryTimes => {
            const before = read();
            const after = observeChallenges(before, challenges, now);
            if (after) observing((state) => observeChallenges(state, challenges, now));
            return knownTimes(after ?? before, challenges);
        },

        /**
         * Re-read the stored value where the cache of the app window can be behind it (the service wrote it), before
         * a read that wants the service's marks. A read that fails is logged and the cache stays.
         */
        refresh,

        /**
         * When the entry entered the challenge (Unix seconds), 0 when that is
         * unknown, null when the entry isn't recorded.
         */
        enteredAt: (challengeId: string | number, imageId: string | number): number | null => {
            const at = read()[String(challengeId)]?.entered[String(imageId)];
            return finiteOr(at, null);
        },

        /**
         * The photo a boost fill-new submitted and is waiting to boost, if any.
         */
        pending: (challengeId: string | number): string | null => read()[String(challengeId)]?.pending ?? null,

        isUncertain: (challengeId: string | number, imageId: string | number): boolean =>
            read()[String(challengeId)]?.uncertain?.includes(String(imageId)) === true,

        markUncertain: (challenge: Challenge, imageId: string | number, now: number) => {
            write((state) => uncertainEdit(state, challenge, String(imageId), now));
        },

        /**
         * Record a photo a boost fill-new just submitted: entered `now` (exactly), and the
         * one the boost is waiting on.
         * @param now - Unix seconds
         */
        markPending: (challenge: Challenge, imageId: string | number, now: number) => {
            write((state) => pendingEdit(state, challenge, String(imageId), now));
        },

        /**
         * Record photos the app just submitted (a fill, a join, a swap): each entered `now`, exactly. A challenge
         * no fetch has seen yet gets a record that the next fetch completes.
         * @param now - Unix seconds
         */
        markSubmitted: (challengeId: string | number, imageIds: readonly (string | number)[], now: number) => {
            write((state) => submittedEdit(state, String(challengeId), imageIds.map(String), now));
        },

        /**
         * The boost landed (or gave up): stop waiting on the pending photo `imageId`. Only that photo: a clear made
         * again after a failed write must not erase a pending photo another context set meanwhile.
         * @param now - Unix seconds
         */
        clearPending: (challengeId: string | number, imageId: string | number, now: number) => {
            write((state) => {
                const record = state[String(challengeId)];
                if (record?.pending !== String(imageId)) return null;
                return withRecord(state, String(challengeId), { ...record, pending: null }, now);
            });
        },

        ...pinSubmitLatch(read, write),
    };
};

/** Ledger over an in-memory store — mock mode, tests. */
const createMemoryEntryAgeLedger = () => createEntryAgeLedger(createMemoryRawJsonStore());

const entryAgeLedger = createEntryAgeLedger(entryAgeStore, entryAgeStore.refreshAsync);

export const initializeEntryAgesAsync = entryAgeStore.initializeAsync;
export const flushEntryAgeWrites = entryAgeStore.flushPendingWrites;
export { entryAgeLedger, createEntryAgeLedger, createMemoryEntryAgeLedger };
