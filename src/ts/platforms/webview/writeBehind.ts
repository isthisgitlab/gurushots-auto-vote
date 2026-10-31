/**
 * The ordered write-behind of one Capacitor key, shared by the family's
 * transports (store.ts composes it): writes apply in issue order, and one
 * that fails is logged without breaking the queue; a shared key's saves go
 * through the native compare-and-write and are made again on what the
 * background service saved meanwhile.
 *
 * The wrapped modules are reached at call time for the reasons store.ts's
 * header names (the install must run before the logger loads; the Jest
 * setup's registry must not pre-empt a test file's own mocks).
 */

import type { PreferencesPlugin } from '@capacitor/preferences';
import type { CasAnswer, ThroughResult } from '../../core/types/stores';

type LoggerModule = typeof import('../../core/logger');
type StorageModule = typeof import('../../core/settings/storage');

// See store.ts's header: the wrapped modules, reached at call time.
const logger = (): LoggerModule => require('../../core/logger') as LoggerModule;
// Lazy for both reasons store.ts's header names: this file sits in the shell
// platform modules' static chain and the settings graph reaches the logger,
// which reads platform() at load — the install must run first — and a graph
// loaded in the Jest setup's registry would beat a test file's own mocks.
// The public storage facade carries SaveConflictError; the facade's
// internals are private to it.
const storage = (): StorageModule => require('../../core/settings/storage') as StorageModule;

// The Preferences keys whose cache holds something known: hydrated, refreshed or written.
export const knownKeys = new Set<string>();

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
                    logger().withCategory('settings').error(`Capacitor ${prefKey} write failed:`, error);
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
        logger()
            .withCategory('settings')
            .error(`Capacitor ${prefKey} write-through could not be applied again:`, error);
        return null;
    }
};

// How often a change made against a shared store is made again on what another writer saved meanwhile, before it
// is given up as not saved.
const MAX_ATTEMPTS = 5;

/** The native compare-and-write of one key, null where there is none (see NativeAutovoteBridge.compareAndWrite). */
type CasWrite = (expected: string | null, data: string) => Promise<CasAnswer> | null;

/**
 * Saves the value `update` makes from `start` (what the writer last knew the key to hold): through the native
 * compare-and-write, where there is one, so that it is saved only if the key still holds what it was made from, and is
 * made again, on what the other writer saved meanwhile (up to MAX_ATTEMPTS); else straight to Preferences.
 * `update` may be called more than once, and must make the same change each time.
 *
 * @returns the value saved; null when `update` declined (answered null)
 * @throws when the save was refused, or the key kept changing; whatever `update` throws
 */
const saveThroughCas = async (
    prefKey: string,
    preferences: () => PreferencesPlugin,
    start: string | null,
    update: (current: string | null) => string | null,
    cas?: CasWrite,
): Promise<string | null> => {
    let base = start;
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
    throw new (storage().SaveConflictError)('the key kept changing');
};

/** The mutable side of one key's write-behind: what the queued writes and the reads coordinate through. */
type WriteBehindState = {
    issued: number;
    generation: number;
    lastFailed: boolean;
    intended: string | null;
    queuedText: string;
};

/** What a write-through needs from its write-behind, at call time. */
type UpdateThroughDeps = {
    prefKey: string;
    enqueue: (write: () => Promise<void>) => Promise<WriteOutcome>;
    state: WriteBehindState;
    cache: { get: () => string | null; set: (value: string | null) => void };
    save: (update: (current: string | null) => string | null) => Promise<string | null>;
    intend: (text: string) => void;
    markSaved: () => void;
    knowKey: () => void;
};

// The body of `updateThrough`, moved out of createWriteBehind unchanged: it waits its turn in the queue, makes the
// value from the cache as it is then, and puts it in the cache only once Preferences has it.
const runUpdateThrough = async (
    deps: UpdateThroughDeps,
    update: (current: string | null) => string | null,
): Promise<ThroughResult> => {
    const { prefKey, enqueue, state, cache, save, intend, markSaved, knowKey } = deps;
    let result: ThroughResult = 'aborted';
    const issuedIn = state.generation;
    const outcome = await enqueue(async () => {
        if (issuedIn !== state.generation) return;
        const before = state.issued;
        const data = await save(update);
        if (data === null) return;
        knowKey();
        // A write queued during the save has the newer value, and puts it down on its turn: this change is
        // applied to that one, so that it saves both. One that declines, or throws, leaves that value as it
        // is: this change did not make it.
        if (state.issued === before) {
            intend(data);
            markSaved();
            result = 'saved';
        } else {
            const rebased = applyAgain(prefKey, update, state.queuedText);
            if (rebased !== null) {
                intend(rebased);
                result = 'saved';
            }
        }
        // Only a save moves the counter a read in flight is told by: one that failed changed nothing it could
        // have read over.
        state.issued++;
        cache.set(state.queuedText);
    });
    return outcome.ok ? result : 'failed';
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
const createWriteBehind = (
    prefKey: string,
    strict: boolean,
    preferences: () => PreferencesPlugin,
    cache: { get: () => string | null; set: (value: string | null) => void },
    cas?: CasWrite,
) => {
    const { enqueue, quiet, drained } = createQueue(prefKey);
    const state: WriteBehindState = {
        issued: 0,
        generation: 0,
        lastFailed: false,
        intended: null,
        queuedText: '',
    };
    let latest: Promise<WriteOutcome> = Promise.resolve({ ok: true });
    let queued = 0;
    let flushedAt = 0;
    // The latest value queued or written through (null until one is), and the one a queued write puts down.
    const intend = (text: string) => {
        state.intended = text;
        state.queuedText = text;
    };
    knownKeys.delete(prefKey);
    // The latest queued write was saved: a flush after it reports nothing until another write is queued.
    const markSaved = () => {
        latest = Promise.resolve({ ok: true });
        state.lastFailed = false;
    };
    const knowKey = () => knownKeys.add(prefKey);
    const save = (update: (current: string | null) => string | null): Promise<string | null> =>
        saveThroughCas(prefKey, preferences, cache.get(), update, cas);
    return {
        queue: (data: string) => {
            state.issued++;
            queued++;
            intend(data);
            knowKey();
            const issuedIn = state.generation;
            latest = enqueue(async () => {
                if (issuedIn === state.generation) await preferences().set({ key: prefKey, value: state.queuedText });
            }).then((outcome) => {
                state.lastFailed = !outcome.ok;
                return outcome;
            });
        },
        updateThrough: (update: (current: string | null) => string | null): Promise<ThroughResult> =>
            runUpdateThrough({ prefKey, enqueue, state, cache, save, intend, markSaved, knowKey }, update),
        /**
         * What hydrating or refreshing found in Preferences, with the snapshot it took before reading (0 for the first
         * read).
         */
        confirm: (at: number) => {
            knowKey();
            if (state.intended !== null && (state.issued !== at || state.lastFailed)) cache.set(state.intended);
            // Nothing is under way or unsaved: what was read is what is stored, and what the next write builds on.
            else state.intended = cache.get() ?? state.intended;
        },
        drained: () => ({ at: state.issued, done: drained() }),
        /**
         * Gives up every write still queued (each finds on its turn that it was discarded) and forgets what was
         * intended, so nothing queued or written through before this is put down afterwards. A write already
         * handed to Preferences is not recalled: wait for `flush`, then remove the key.
         */
        discard: () => {
            state.generation++;
            state.intended = null;
            state.queuedText = '';
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

export { createWriteBehind, saveThroughCas };
export type { CasWrite };
