/**
 * The generic platform-aware JSON store (createJsonStore) the app's other stores are made with, and the switch that
 * makes every one of them refuse writes while local data is deleted.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as logger from '../logger';
import * as runtime from '../runtime';
import { sweepStaleTemps, writeAtomicOwnerOnly } from './atomicWrite';
import { getCapacitorPreferences } from './capacitorPreferences';
import { writeOwnerOnly } from './ownerOnlyWrite';
import { createWriteBehind, headlessUpdate, readHeadlessKey, writeHeadlessKey } from './storeTransport';
import { getSettingsPath } from './userDataPaths';
import { compareAndWrite } from '../services/NativeAutovoteBridge';
import type { ThroughResult } from '../types/stores';

// Set by refuseWrites until resumeWrites: every store refuses writes, so nothing is created again while
// local data is being deleted.
let writesRefused = false;
// Every store createJsonStore made, for discardStores to reach.
const createdStores: Array<{ discard: () => void; settled: () => Promise<void> }> = [];

/** Whether writes are refused (local data is being deleted). */
const areWritesRefused = (): boolean => writesRefused;

/** Makes every store refuse writes. */
const refuseWrites = () => {
    writesRefused = true;
};

/** Lets the stores write again (a local-data wipe that did not finish). */
const resumeWrites = () => {
    writesRefused = false;
};

/** Gives up every write still queued in a createJsonStore store and empties its cache. */
const discardStores = () => {
    for (const store of createdStores) store.discard();
};

/** Resolves once the writes the stores already handed to Preferences have landed. */
const settleStores = async (): Promise<void> => {
    await Promise.all(createdStores.map((store) => store.settled()));
};

// How many times a change is made again on what another process wrote while it was being made.
const WRITE_ATTEMPTS = 3;

/**
 * Writes a value made from a store's current one at once (not behind a cache); `failed` when the write threw. The value
 * is written only if the store still holds what it was made from (read again just before the write): when another
 * process changed it meanwhile, the change is made again on that. This narrows the window in which a concurrent write
 * is overwritten and does not close it: the second read and the write are two steps, so a caller that must not lose a
 * change holds the settings lock around the whole.
 */
const writeNow = (
    prefKey: string,
    store: { readRaw: () => string | null; writeRaw: (data: string) => void },
    update: (current: string | null) => string | null,
): ThroughResult => {
    try {
        for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
            const current = store.readRaw();
            const data = update(current);
            if (data === null) return 'aborted';
            if (store.readRaw() !== current) continue;
            store.writeRaw(data);
            return 'saved';
        }
        logger.withCategory('settings').error(`${prefKey} kept changing under the write, so it was not made`, null);
        return 'failed';
    } catch (err) {
        logger.withCategory('settings').error(`${prefKey} write failed:`, err);
        return 'failed';
    }
};

/**
 * Generic platform-aware JSON store — the same transport pattern the
 * settings store above uses, packaged for other stores (metadata.ts).
 *
 *   - Electron/CLI: synchronous fs at userData/<fileName>, left at mode
 *     0o600 after every write (replaced atomically, by temp file and rename, when `atomic`) (userData JSON can carry tokens/state that
 *     other local users have no business reading).
 *   - Capacitor app WebView: hydrate-once cache (initializeAsync) +
 *     ordered async write-behind to @capacitor/preferences under prefKey.
 *   - Android headless service: the native keyed preference bridge persists
 *     supported stores; unsupported keys retain their per-cycle memory cache.
 */
const createJsonStore = ({
    fileName,
    prefKey,
    atomic = false,
    strict = false,
    shared = false,
}: {
    fileName: string;
    prefKey: string;
    /** replace the file atomically on every write (temp file + rename), for a store read outside any lock */
    atomic?: boolean;
    /** a write the Android service's native bridge did not persist throws, instead of passing quietly */
    strict?: boolean;
    /** the Android service writes this key too: `updateThrough` saves by the native compare-and-write, so no change is erased */
    shared?: boolean;
}) => {
    let initialized = false;
    let cachedJson: string | null = null;
    const cache = {
        get: () => cachedJson,
        set: (value: string | null) => {
            cachedJson = value;
        },
    };
    const writes = createWriteBehind(
        prefKey,
        strict,
        getCapacitorPreferences,
        cache,
        shared ? (expected, data) => compareAndWrite(prefKey, expected, data) : undefined,
    );
    let swept = false;
    const discardListeners: Array<() => void> = [];

    const filePath = () => path.join(path.dirname(getSettingsPath()), fileName);
    // The first read or write of an atomic store's file clears the temp files an earlier crash left beside it.
    const sweepOnce = () => {
        if (!atomic || swept) return;
        swept = true;
        sweepStaleTemps(filePath());
    };

    const store = {
        /**
         * Raw JSON string, or null when never written.
         */
        readRaw: (): string | null => {
            if (runtime.isHeadlessService()) {
                return readHeadlessKey(prefKey, cachedJson, strict);
            }
            if (runtime.isCapacitor()) {
                return cachedJson;
            }
            sweepOnce();
            const p = filePath();
            if (!fs.existsSync(p)) return null;
            return fs.readFileSync(p, 'utf8');
        },
        /**
         * Sync on Electron/CLI; cache + ordered write-behind on Capacitor; native keyed bridge on headless.
         */
        writeRaw: (data: string) => {
            if (writesRefused) return;
            if (runtime.isHeadlessService()) {
                // Only a write that is confirmed is read back: a failed first write leaves nothing to read.
                writeHeadlessKey(prefKey, data, strict);
                cachedJson = data;
                return;
            }
            if (runtime.isCapacitor()) {
                cachedJson = data;
                writes.queue(data);
                return;
            }
            sweepOnce();
            (atomic ? writeAtomicOwnerOnly : writeOwnerOnly)(filePath(), data);
        },
        /** Hydrate the Capacitor cache once at boot. No-op elsewhere. */
        initializeAsync: async () => {
            if (!runtime.isCapacitor() || runtime.isHeadlessService() || initialized) return;
            try {
                const { value } = await getCapacitorPreferences().get({ key: prefKey });
                cachedJson = value;
                writes.confirm(0);
            } catch (err) {
                logger.withCategory('settings').error(`Capacitor ${prefKey} read failed:`, err);
                cachedJson = null;
            } finally {
                initialized = true;
            }
        },
        /**
         * Re-read the Capacitor preference into the cache — for a store the
         * Android background service (a separate JS context) also writes.
         * Waits for this context's own queued writes first, so none is lost.
         * No-op off the Capacitor app WebView.
         *
         * @returns false when the read failed (the cache is as it was); a decision that must not rest on a stale cache
         *   (a paid one) refuses then
         */
        refreshAsync: async (): Promise<boolean> => {
            if (!runtime.isCapacitor() || runtime.isHeadlessService()) return true;
            const { at, done } = writes.drained();
            await done;
            try {
                const { value } = await getCapacitorPreferences().get({ key: prefKey });
                cachedJson = value;
                writes.confirm(at);
                initialized = true;
                return true;
            } catch (err) {
                logger.withCategory('settings').error(`Capacitor ${prefKey} refresh failed:`, err);
                return false;
            }
        },
        /**
         * `updateThrough` where the store is read and written in one step (a desktop, the background service): the
         * write is made when this returns, and its outcome is the answer. Null where the write is only queued (the
         * Android app window): use `updateThrough`.
         */
        updateNow: (update: (current: string | null) => string | null): ThroughResult | null => {
            if (writesRefused) return 'failed';
            if (runtime.isHeadlessService() && shared) return headlessUpdate(prefKey, update);
            return runtime.isCapacitor() && !runtime.isHeadlessService() ? null : writeNow(prefKey, store, update);
        },
        /** Writes a value made from the current one that nothing reads before it is saved (see RawJsonStore). */
        updateThrough: (update: (current: string | null) => string | null): Promise<ThroughResult> => {
            const now = store.updateNow(update);
            return now === null ? writes.updateThrough(update) : Promise.resolve(now);
        },
        /**
         * What is stored now, where the cache of the Android app window may be behind it (the background service
         * writes the key too): read from Preferences, the cache left as it is. The same as `readRaw` elsewhere.
         */
        peekStored: async (): Promise<string | null> =>
            runtime.isCapacitor() && !runtime.isHeadlessService()
                ? (await getCapacitorPreferences().get({ key: prefKey })).value
                : store.readRaw(),
        /**
         * Await to guarantee the write-behind queue has drained. A `strict` store rejects when a write since the last
         * flush did not persist, so a caller that waits for it can tell.
         */
        flushPendingWrites: () => writes.flush(),
        /** fs path (Electron/CLI) — for debug/info surfaces. */
        getFilePath: filePath,
        /** Calls `listener` whenever the store is discarded (local data deleted), for a ledger holding changes in memory. */
        onDiscard: (listener: () => void) => {
            discardListeners.push(listener);
        },
    };
    createdStores.push({
        discard: () => {
            writes.discard();
            cachedJson = null;
            for (const listener of discardListeners) listener();
        },
        // A flush that reports a write which did not persist is of no interest to a store being deleted.
        settled: () => writes.flush().catch(() => undefined),
    });
    return store;
};

export { areWritesRefused, createJsonStore, discardStores, refuseWrites, resumeWrites, settleStores };
