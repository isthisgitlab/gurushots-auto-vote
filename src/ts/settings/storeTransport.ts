/**
 * The Android and Capacitor side of createJsonStore (settings/storage.ts): keyed reads and writes through the native
 * bridge of the background service, and the ordered write-behind of the app's Preferences.
 */

import * as logger from '../logger';
import * as runtime from '../runtime';
import type { PreferencesPlugin } from '@capacitor/preferences';
import type { AndroidHeadlessStore } from '../types/settings';
import type { RawJsonStore, ThroughResult } from '../types/stores';

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

/**
 * Whether a store that other work trusts holds what is saved. The service's read through the bridge can fail; the
 * app window's cache is filled by a start-up read that can; and a store that could not be filled is empty because of
 * that, not because nothing was saved. Everywhere else the store is the file itself. Ask after the store was read: a
 * read that failed says so only once it was made.
 */
export const storeLoaded = (prefKey: string): boolean =>
    runtime.isHeadlessService() ? !failedReads.has(prefKey) : !runtime.isCapacitor() || knownKeys.has(prefKey);

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

// A write-through's change made again on a newer value; null when it declines, or throws (logged).
const applyAgain = (
    prefKey: string,
    update: (current: string | null) => string | null,
    newer: string,
): string | null => {
    try {
        return update(newer);
    } catch (error) {
        logger.withCategory('settings').error(`Capacitor ${prefKey} write-through could not be applied again:`, error);
        return null;
    }
};

// How often a change made against a shared store is made again on what another writer saved meanwhile, before it
// is given up as not saved.
const MAX_ATTEMPTS = 5;

/** What the native compare-and-write answered: saved, or not because the key had changed (and what it holds). */
export type CasAnswer = { saved: boolean; current: string | null };

/**
 * A change of a key that the background service writes too, made in the service's own context: read the key through
 * the bridge, make the new value from it, and save it only if the key still holds what was read (the native side
 * takes one lock for both contexts). A key that changed meanwhile is read again and the change made again on it.
 * `update` may be called more than once, and must make the same change each time.
 *
 * @returns `saved`; `aborted` (`update` answered null); `failed` (no bridge, a refused or failed save, or a key that
 *   kept changing)
 */
export const headlessUpdate = (prefKey: string, update: (current: string | null) => string | null): ThroughResult => {
    try {
        const bridge = headlessStore();
        if (!bridge?.readKey || !bridge.compareAndWriteKey) throw new Error('no bridge to change through');
        let current = bridge.readKey(prefKey);
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const data = update(current);
            if (data === null) return 'aborted';
            if (bridge.compareAndWriteKey(prefKey, current ?? '', data)) return 'saved';
            const now = bridge.readKey(prefKey);
            // Nothing changed under it, or what is there is the value just offered (a refused save that the bridge's own
            // memory still shows): the save itself was refused, and trying again will not help.
            if (now === current || now === data) throw new Error('the bridge refused the value');
            current = now;
        }
        throw new Error('the key kept changing');
    } catch (error) {
        logger.withCategory('settings').error(`Headless ${prefKey} could not be changed:`, error);
        return 'failed';
    }
};

/**
 * Writes to `target` a text made from its current one, saved before anything can read it where that takes a moment (the
 * Android app: see RawJsonStore.updateThrough); `update` answers null to write nothing.
 */
export const throughStore = async (
    target: RawJsonStore,
    update: (current: string | null) => string | null,
): Promise<ThroughResult> => {
    if (target.updateThrough) return target.updateThrough(update);
    const data = update(target.readRaw());
    if (data === null) return 'aborted';
    target.writeRaw(data);
    return 'saved';
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
 * Preferences has it. Where the key is shared with the background service (`cas`: the native compare-and-write, null
 * where there is none) the value is saved only if the key still holds what it was made from, and is made again on
 * what the service saved meanwhile (up to MAX_ATTEMPTS). A write queued while it is being saved gets its change as
 * well (`update` is called again on that newer value, and must make the same change: `aborted` when it declines or
 * throws, in which case the first value had already been saved, and was visible for a moment, until the queued write
 * put its own down — no caller of a write-through key queues writes); and a queued write that failed before it, which
 * it was built on, is no longer one a flush reports. When it fails the cache was never changed, so nothing read,
 * applied or written since has seen it, and it is not a queued write: a flush does not report it.
 *
 * A read takes a snapshot first (`drained`) and gives it back to `confirm`: a write queued or written through since,
 * or a queued write that did not persist, means the read may not hold what was written, and the cache keeps
 * `intended`. (The stores that only hydrate are never queued from the window, so for them this changes nothing; it
 * is for the store the window writes: the scenario state, where an unsaved spend marker must not be read over.)
 *
 * @param cache - the store's cache (null: nothing is there)
 */
export const createWriteBehind = (
    prefKey: string,
    strict: boolean,
    preferences: () => PreferencesPlugin,
    cache: { get: () => string | null; set: (value: string | null) => void },
    cas?: (expected: string | null, data: string) => Promise<CasAnswer> | null,
) => {
    const { enqueue, quiet, drained } = createQueue(prefKey);
    let latest: Promise<WriteOutcome> = Promise.resolve({ ok: true });
    let lastFailed = false;
    let issued = 0;
    let queued = 0;
    let flushedAt = 0;
    // The latest value queued or written through (null until one is), and the one a queued write puts down.
    let intended: string | null = null;
    let queuedText = '';
    // Bumped by `discard`: a queued write from before it finds the number changed on its turn and puts nothing down.
    let generation = 0;
    const intend = (text: string) => {
        intended = text;
        queuedText = text;
    };
    knownKeys.delete(prefKey);
    // The value the write-through makes from the cache and saves: through the native compare-and-write, where there is
    // one, else straight to Preferences. Null: `update` declined.
    const save = async (update: (current: string | null) => string | null): Promise<string | null> => {
        let base = cache.get();
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
            const data = update(base);
            if (data === null) return null;
            const answer = cas?.(base, data) ?? null;
            if (answer === null) {
                await preferences().set({ key: prefKey, value: data });
                return data;
            }
            const { saved, current } = await answer;
            if (saved) return data;
            base = current;
        }
        throw new Error('the key kept changing');
    };
    return {
        queue: (data: string) => {
            issued++;
            queued++;
            intend(data);
            knownKeys.add(prefKey);
            const issuedIn = generation;
            latest = enqueue(async () => {
                if (issuedIn === generation) await preferences().set({ key: prefKey, value: queuedText });
            }).then((outcome) => {
                lastFailed = !outcome.ok;
                return outcome;
            });
        },
        updateThrough: async (update: (current: string | null) => string | null): Promise<ThroughResult> => {
            let result: ThroughResult = 'aborted';
            const issuedIn = generation;
            const outcome = await enqueue(async () => {
                if (issuedIn !== generation) return;
                const before = issued;
                const data = await save(update);
                if (data === null) return;
                knownKeys.add(prefKey);
                // A write queued during the save has the newer value, and puts it down on its turn: this change is
                // applied to that one, so that it saves both. One that declines, or throws, leaves that value as it
                // is: this change did not make it.
                if (issued === before) {
                    intend(data);
                    latest = Promise.resolve({ ok: true });
                    lastFailed = false;
                    result = 'saved';
                } else {
                    const rebased = applyAgain(prefKey, update, queuedText);
                    if (rebased !== null) {
                        intend(rebased);
                        result = 'saved';
                    }
                }
                // Only a save moves the counter a read in flight is told by: one that failed changed nothing it could
                // have read over.
                issued++;
                cache.set(queuedText);
            });
            return outcome.ok ? result : 'failed';
        },
        /**
         * What hydrating or refreshing found in Preferences, with the snapshot it took before reading (0 for the first
         * read).
         */
        confirm: (at: number) => {
            knownKeys.add(prefKey);
            if (intended !== null && (issued !== at || lastFailed)) cache.set(intended);
            // Nothing is under way or unsaved: what was read is what is stored, and what the next write builds on.
            else intended = cache.get() ?? intended;
        },
        drained: () => ({ at: issued, done: drained() }),
        /**
         * Gives up every write still queued (each finds on its turn that it was discarded) and forgets what was
         * intended, so nothing queued or written through before this is put down afterwards. A write already
         * handed to Preferences is not recalled: wait for `flush`, then remove the key.
         */
        discard: () => {
            generation++;
            intended = null;
            queuedText = '';
            knownKeys.delete(prefKey);
        },
        flush: async () => {
            const reportedAt = flushedAt;
            await quiet();
            // Taken together, with nothing awaited between: a write queued after is not one this flush reports.
            const [target, upTo] = [latest, queued];
            const outcome = await target;
            flushedAt = Math.max(flushedAt, upTo);
            if (strict && upTo > reportedAt && !outcome.ok)
                throw new Error(`Capacitor ${prefKey} was not persisted`, { cause: outcome.error });
        },
    };
};
export { headlessStore };
