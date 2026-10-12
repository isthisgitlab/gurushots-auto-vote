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

// The Preferences keys whose cache holds something known: hydrated, refreshed or written.
const knownKeys = new Set<string>();

/**
 * Whether the cache of one Capacitor key holds something known: what Preferences held (hydrated or refreshed), or what
 * was written since. False after a read that failed and nothing since: the cache is empty because it could not be
 * filled, not because there is nothing.
 */
export const isCacheKnown = (prefKey: string): boolean => knownKeys.has(prefKey);

/** What one write came to: persisted, or the error that said it did not. */
type WriteOutcome = { ok: true } | { ok: false; error: unknown };

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
 * persist.
 *
 * `flush` waits until the queue is quiet, then a `strict` store's flush rejects (with the write's error as its cause)
 * when the latest write did not persist.
 *
 * `updateThrough` is for a write that must not show before it is saved: it waits its turn in the queue, makes the
 * value from the cache as it is then, and puts it in the cache only once Preferences has it. When it fails the cache
 * was never changed, so nothing read, applied or written since has seen it.
 *
 * `intended` is the text last queued or written through: a read that was in flight when it was must not replace it.
 *
 * @param cache - the store's cache (null: nothing is there)
 */
export const createWriteBehind = (
    prefKey: string,
    strict: boolean,
    preferences: () => PreferencesPlugin,
    cache: { get: () => string | null; set: (value: string | null) => void },
) => {
    let chain = Promise.resolve();
    let latest: Promise<WriteOutcome> = Promise.resolve({ ok: true });
    let issued = 0;
    let drainedAt = 0;
    let intended: string | null = null;
    knownKeys.delete(prefKey);
    // Runs one write after the ones before it; what it came to, never a rejection.
    const enqueue = (write: () => Promise<void>): Promise<WriteOutcome> => {
        latest = chain.then(write).then(
            (): WriteOutcome => ({ ok: true }),
            (error: unknown): WriteOutcome => {
                logger.withCategory('settings').error(`Capacitor ${prefKey} write failed:`, error);
                return { ok: false, error };
            },
        );
        chain = latest.then(() => undefined);
        return latest;
    };
    return {
        queue: (data: string) => {
            issued++;
            intended = data;
            knownKeys.add(prefKey);
            void enqueue(() => preferences().set({ key: prefKey, value: data }));
        },
        updateThrough: async (update: (current: string | null) => string): Promise<boolean> => {
            let data = '';
            const outcome = await enqueue(async () => {
                data = update(cache.get());
                await preferences().set({ key: prefKey, value: data });
            });
            if (!outcome.ok) return false;
            issued++;
            intended = data;
            knownKeys.add(prefKey);
            cache.set(data);
            return true;
        },
        /**
         * What hydrating or refreshing found in Preferences. When a write was queued while it was being read, that read
         * may predate it: the cache keeps the latest write.
         */
        confirm: () => {
            knownKeys.add(prefKey);
            if (issued !== drainedAt) cache.set(intended);
        },
        drained: () => {
            drainedAt = issued;
            return chain;
        },
        flush: async () => {
            await untilQuiet(() => chain);
            const outcome = await latest;
            if (strict && !outcome.ok)
                throw new Error(`Capacitor ${prefKey} was not persisted`, { cause: outcome.error });
        },
    };
};
export { headlessStore };
