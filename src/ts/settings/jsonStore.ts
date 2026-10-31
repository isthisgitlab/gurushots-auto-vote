/**
 * The generic platform-aware JSON store (createJsonStore) the app's other stores are made with, and the switch that
 * makes every one of them refuse writes while local data is deleted. The platform work — the cache, the queue and the
 * native bridge of each family — is the JsonStoreTransport the platform's storage member builds per store
 * (src/ts/platform/port.ts); this wrapper keeps the refuse-writes registry, the discard listeners and the public store
 * surface, and never tests which family it has.
 */

import * as path from 'node:path';
import * as logger from '../logger';
import { installedPlatform, platform } from '../platform/port';
import { getSettingsPath } from './userDataPaths';
import type { JsonStoreTransport, SettingsStoreRef } from '../platform/port';
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
 * change holds the settings lock around the whole. The node and headless families run it over their own read/write
 * operations (a desktop's write is made when this returns; the service's through its bridge).
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
    // `read-write` is the atomic store's sweep rule: the temp files an earlier crash left beside the file are swept
    // before the first read or write, once per file path. A store that is not atomic never sweeps.
    const ref: SettingsStoreRef = {
        prefKey,
        filePath: () => path.join(path.dirname(getSettingsPath()), fileName),
        sweep: atomic ? 'read-write' : 'none',
    };
    // The transport is built as the store is created, where a platform stands. A module imported where none is
    // installed (a renderer bundle reaches these stores, and no port is installed there) builds it on the store's
    // first use.
    let transport: JsonStoreTransport | null = null;
    const of = (): JsonStoreTransport => (transport ??= platform().storage.jsonStore(ref, { strict, shared }));
    const installed = installedPlatform();
    if (installed) transport = installed.storage.jsonStore(ref, { strict, shared });
    const discardListeners: Array<() => void> = [];

    const store = {
        /**
         * Raw JSON string, or null when never written.
         */
        readRaw: (): string | null => of().readRaw(),
        /**
         * Sync on Electron/CLI; cache + ordered write-behind on Capacitor; native keyed bridge on headless.
         */
        writeRaw: (data: string) => {
            if (writesRefused) return;
            of().writeRaw(data);
        },
        /** Hydrate the Capacitor cache once at boot. No-op elsewhere. */
        initializeAsync: () => of().hydrate(),
        /**
         * Re-read what is stored into the cache — for a store the Android
         * background service (a separate JS context) also writes. Waits for this context's own queued writes first,
         * so none is lost. No-op off the Capacitor app WebView.
         *
         * @returns false when the read failed (the cache is as it was); a decision that must not rest on a stale cache
         *   (a paid one) refuses then
         */
        refreshAsync: () => of().reread(),
        /**
         * `updateThrough` where the store is read and written in one step (a desktop, the background service): the
         * write is made when this returns, and its outcome is the answer. Null where the write is only queued (the
         * Android app window): use `updateThrough`.
         */
        updateNow: (update: (current: string | null) => string | null): ThroughResult | null => {
            if (writesRefused) return 'failed';
            return of().updateNow(update);
        },
        /** Writes a value made from the current one that nothing reads before it is saved (see RawJsonStore). */
        updateThrough: (update: (current: string | null) => string | null): Promise<ThroughResult> => {
            if (writesRefused) return Promise.resolve('failed');
            const now = of().updateNow(update);
            return now === null ? of().updateThrough(update) : Promise.resolve(now);
        },
        /**
         * What is stored now, where the cache of the Android app window may be behind it (the background service
         * writes the key too): read from Preferences, the cache left as it is. The same as `readRaw` elsewhere.
         */
        peekStored: () => of().peekStored(),
        /**
         * Await to guarantee the write-behind queue has drained. A `strict` store rejects when a write since the last
         * flush did not persist, so a caller that waits for it can tell.
         */
        flushPendingWrites: () => of().flush(),
        /** fs path (Electron/CLI) — for debug/info surfaces. */
        getFilePath: ref.filePath,
        /** Calls `listener` whenever the store is discarded (local data deleted), for a ledger holding changes in memory. */
        onDiscard: (listener: () => void) => {
            discardListeners.push(listener);
        },
    };
    createdStores.push({
        discard: () => {
            of().discard();
            for (const listener of discardListeners) listener();
        },
        // A flush that reports a write which did not persist is of no interest to a store being deleted.
        settled: () =>
            of()
                .flush()
                .catch(() => undefined),
    });
    return store;
};

export { areWritesRefused, createJsonStore, discardStores, refuseWrites, resumeWrites, settleStores, writeNow };
