/**
 * The Android and Capacitor side of createJsonStore (settings/storage.ts): keyed reads and writes through the native
 * bridge of the background service, and the ordered write-behind of the app's Preferences.
 */

import * as logger from '../logger';
import type { PreferencesPlugin } from '@capacitor/preferences';
import type { AndroidHeadlessStore } from '../types/settings';

/**
 * The Android headless-service bridge, read at call time (absent everywhere
 * else).
 */
const headlessStore = (): AndroidHeadlessStore | undefined =>
    (globalThis as typeof globalThis & { AndroidHeadlessStore?: AndroidHeadlessStore }).AndroidHeadlessStore;

export const readHeadlessKey = (prefKey: string, fallback: string | null): string | null => {
    try {
        // aislop-ignore-next-line ai-slop/hidden-fallback -- an absent key is the caller's cached value; the read contract
        return headlessStore()?.readKey?.(prefKey) ?? fallback;
    } catch (err) {
        logger.withCategory('settings').error(`Headless ${prefKey} read failed:`, err);
        // aislop-ignore-next-line ai-slop/hidden-fallback -- logged via the settings logger; the caller's cached value is the read contract
        return fallback;
    }
};

/**
 * Writes one key through the native bridge. The bridge answers `false` when it did not persist the value (a
 * refused key, a value that is no JSON, a failed commit). A write that was not passes quietly, except for a `strict`
 * store, which throws, and which takes nothing but a `true` for a write that was (no bridge, or none that answers,
 * is not one).
 */
export const writeHeadlessKey = (prefKey: string, data: string, strict: boolean): void => {
    const answer = ((): boolean | void => {
        try {
            return headlessStore()?.writeKey?.(prefKey, data);
        } catch (err) {
            logger.withCategory('settings').error(`Headless ${prefKey} write failed:`, err);
            return false;
        }
    })();
    if (strict && answer !== true) throw new Error(`Headless ${prefKey} was not persisted`);
};

// The Preferences keys whose strict store takes a failed write out of its cache again (see createWriteBehind), and
// those whose cache holds something known: hydrated, refreshed or written.
const rolledBackKeys = new Set<string>();
const knownKeys = new Set<string>();

/**
 * Opts one Capacitor key in to having a failed write taken out of its cache again, so that what the store reads back
 * is only what reached storage. For a store whose cache is a request that must not take effect unless it was saved;
 * a store whose cache is the record of something already done (a spend marker) keeps its latest value instead.
 */
export const rollBackFailedWrites = (prefKey: string): void => {
    rolledBackKeys.add(prefKey);
};

/**
 * Whether the cache of one Capacitor key holds something known: what Preferences held (hydrated or refreshed), or what
 * was written since. False after a read that failed and nothing since: the cache is empty because it could not be
 * filled, not because there is nothing.
 */
export const isCacheKnown = (prefKey: string): boolean => knownKeys.has(prefKey);

/** What one write came to: persisted, or the error that said it did not (and whether the cache went back from it). */
type WriteOutcome = { ok: true } | { ok: false; error: unknown; rolledBack: boolean };

// Waits for a queue that writes may still be added to, until it is quiet.
const untilQuiet = async (current: () => Promise<void>): Promise<void> => {
    let seen: Promise<void>;
    do {
        seen = current();
        await seen;
    } while (seen !== current());
};

/**
 * The ordered write-behind of one Capacitor key: writes apply in issue order, and one that fails is logged without
 * breaking the queue. Every write holds the whole value, so a failed write is made up for by a later one that did
 * persist, unless the cache was put back from it.
 *
 * `flush` judges the write that was last when it was called, not the store: waits until the queue is quiet, then a
 * `strict` store's flush rejects (with the write's error as its cause) when that write did not persist. A flush with no
 * write since the previous one has nothing to judge, so an old failure is never held against a later write.
 *
 * A `strict` store that opted in (rollBackFailedWrites) has its cache put back, when its latest write fails, to what is
 * known to be persisted: a value that did not reach storage is not read back, applied, or written along with a later one.
 *
 * Besides the counters it keeps the text last queued (`intended`) and the text known to be in Preferences (`persisted`).
 *
 * @param setCache - sets the store's cache (null: nothing is there)
 */
export const createWriteBehind = (
    prefKey: string,
    strict: boolean,
    preferences: () => PreferencesPlugin,
    setCache: (value: string | null) => void,
) => {
    let chain = Promise.resolve();
    let latest: Promise<WriteOutcome> = Promise.resolve({ ok: true });
    let issued = 0;
    let drainedAt = 0;
    let flushedAt = 0;
    let intended: string | null = null;
    let persisted: string | null = null;
    knownKeys.delete(prefKey);
    return {
        queue: (data: string) => {
            const mine = ++issued;
            intended = data;
            knownKeys.add(prefKey);
            latest = chain
                .then(() => preferences().set({ key: prefKey, value: data }))
                .then(
                    (): WriteOutcome => {
                        persisted = data;
                        return { ok: true };
                    },
                    (error: unknown): WriteOutcome => {
                        logger.withCategory('settings').error(`Capacitor ${prefKey} write failed:`, error);
                        const rolledBack = strict && mine === issued && rolledBackKeys.has(prefKey);
                        if (rolledBack) setCache(persisted);
                        return { ok: false, error, rolledBack };
                    },
                );
            chain = latest.then(() => undefined);
        },
        /**
         * What hydrating or refreshing found in Preferences. When a write was queued while it was being read, that read
         * may predate it: the cache keeps the latest write, and what is persisted is not known from it.
         */
        confirm: (value: string | null) => {
            knownKeys.add(prefKey);
            if (issued !== drainedAt) return setCache(intended);
            persisted = value;
        },
        drained: () => {
            drainedAt = issued;
            return chain;
        },
        flush: async () => {
            const own = latest;
            const fresh = issued > flushedAt;
            flushedAt = issued;
            await untilQuiet(() => chain);
            const outcome = await own;
            if (!strict || !fresh || outcome.ok) return;
            if (!outcome.rolledBack && (await latest).ok) return;
            throw new Error(`Capacitor ${prefKey} was not persisted`, { cause: outcome.error });
        },
    };
};
export { headlessStore };
