/**
 * The Android and Capacitor side of createJsonStore (settings/storage.ts): keyed reads and writes through the native
 * bridge of the background service, and the ordered write-behind of the app's Preferences.
 */

import * as logger from '../logger';
import type { PreferencesPlugin } from '@capacitor/preferences';
import type { AndroidHeadlessStore } from '../types/settings';
import type { ThroughResult } from '../types/stores';

/**
 * The Android headless-service bridge, read at call time (absent everywhere
 * else).
 */
const headlessStore = (): AndroidHeadlessStore | undefined =>
    (globalThis as typeof globalThis & { AndroidHeadlessStore?: AndroidHeadlessStore }).AndroidHeadlessStore;

// The keys whose latest read through the bridge failed (it threw, or a strict store has no bridge to read through).
const failedReads = new Set<string>();

/**
 * Whether the latest read of a key through the bridge failed. The value it answered then (the cache) says nothing of
 * what is stored, so a strict store whose read failed is not loaded: its owner must not read it as empty.
 */
export const headlessReadFailed = (prefKey: string): boolean => failedReads.has(prefKey);

/**
 * Reads one key through the native bridge. A key that is not there answers null, which is the caller's cached value; a
 * read that threw is a failed one (see headlessReadFailed), and so is a strict store's read where there is no bridge.
 */
export const readHeadlessKey = (prefKey: string, fallback: string | null, strict: boolean): string | null => {
    try {
        const bridge = headlessStore();
        if (strict && !bridge?.readKey) throw new Error('no bridge to read through');
        // aislop-ignore-next-line ai-slop/hidden-fallback -- an absent key is the caller's cached value; the read contract
        const value = bridge?.readKey?.(prefKey) ?? fallback;
        failedReads.delete(prefKey);
        return value;
    } catch (err) {
        // Said when it first fails, not on every read after it: the service reads the key many times a pass.
        if (!failedReads.has(prefKey)) logger.withCategory('settings').error(`Headless ${prefKey} read failed:`, err);
        failedReads.add(prefKey);
        // aislop-ignore-next-line ai-slop/hidden-fallback -- logged via the settings logger; failedReads says it failed
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
 * One key's ordered queue of writes: each runs after the ones before it, and says what it came to (never a rejection:
 * a failed write is logged and the queue goes on).
 */
const createQueue = (prefKey: string) => {
    let chain = Promise.resolve();
    return {
        enqueue: (write: () => Promise<void>): Promise<WriteOutcome> => {
            const done = chain.then(write).then(
                (): WriteOutcome => ({ ok: true }),
                (error: unknown): WriteOutcome => {
                    logger.withCategory('settings').error(`Capacitor ${prefKey} write failed:`, error);
                    return { ok: false, error };
                },
            );
            chain = done.then(() => undefined);
            return done;
        },
        quiet: () => untilQuiet(() => chain),
        drained: () => chain,
    };
};

/**
 * The ordered write-behind of one Capacitor key: writes apply in issue order, and one that fails is logged without
 * breaking the queue. Every write holds the whole value, and a queued write puts down `intended` on its turn, the
 * latest value queued or written through: what a write built earlier held can never overwrite a later one, and a
 * read (a refresh) never changes what is put down.
 *
 * `flush` waits until the queue is quiet, then a `strict` store's flush rejects (with the write's error as its cause)
 * when the latest queued write did not persist, to every flush that was waiting when it failed; one that starts after
 * the failure was reported does not report it again, unless another write was queued.
 *
 * `updateThrough` is for a write that must not show before it is saved: it waits its turn in the queue, makes the
 * value from the cache as it is then (`update` answers null to write nothing), and puts it in the cache only once
 * Preferences has it. When it fails the cache was never changed, so nothing read, applied or written since has seen
 * it, and it is not a queued write: a flush does not report it.
 *
 * A read takes a snapshot first (`drained`) and gives it back to `confirm`: a write queued or written through since,
 * or a strict store's queued write that did not persist, means the read may not hold what was written, and the cache
 * keeps `intended`.
 *
 * @param cache - the store's cache (null: nothing is there)
 */
export const createWriteBehind = (
    prefKey: string,
    strict: boolean,
    preferences: () => PreferencesPlugin,
    cache: { get: () => string | null; set: (value: string | null) => void },
) => {
    const { enqueue, quiet, drained } = createQueue(prefKey);
    let latest: Promise<WriteOutcome> = Promise.resolve({ ok: true });
    let lastFailed = false;
    let issued = 0;
    let queued = 0;
    let flushedAt = 0;
    // Only read once something was queued or written through, which is what sets it.
    let intended = '';
    knownKeys.delete(prefKey);
    return {
        queue: (data: string) => {
            issued++;
            queued++;
            intended = data;
            knownKeys.add(prefKey);
            latest = enqueue(() => preferences().set({ key: prefKey, value: intended })).then((outcome) => {
                lastFailed = !outcome.ok;
                return outcome;
            });
        },
        updateThrough: async (update: (current: string | null) => string | null): Promise<ThroughResult> => {
            let result: ThroughResult = 'aborted';
            const outcome = await enqueue(async () => {
                const data = update(cache.get());
                if (data === null) return;
                await preferences().set({ key: prefKey, value: data });
                issued++;
                intended = data;
                lastFailed = false;
                knownKeys.add(prefKey);
                cache.set(data);
                result = 'saved';
            });
            return outcome.ok ? result : 'failed';
        },
        /**
         * What hydrating or refreshing found in Preferences, with the snapshot it took before reading (0 for the first
         * read).
         */
        confirm: (at: number) => {
            knownKeys.add(prefKey);
            if (issued !== at || (strict && lastFailed)) cache.set(intended);
        },
        drained: () => ({ at: issued, done: drained() }),
        flush: async () => {
            const reportedAt = flushedAt;
            await quiet();
            const outcome = await latest;
            flushedAt = queued;
            if (strict && queued > reportedAt && !outcome.ok)
                throw new Error(`Capacitor ${prefKey} was not persisted`, { cause: outcome.error });
        },
    };
};
export { headlessStore };
