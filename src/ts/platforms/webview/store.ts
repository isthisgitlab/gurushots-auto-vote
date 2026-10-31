/**
 * The webview family's storage member: the @capacitor/preferences transport
 * of the app WebView. `jsonStore` and `settingsFile` build one transport
 * object per store over the Preferences plugin (reached through
 * ./capacitorPreferences): the hydrate-once cache and the ordered
 * write-behind (./storeTransport's moved queue — writes apply in issue
 * order, a queued write puts down the latest intended value, and a read
 * snapshot never lets an unsaved value be read over), the compare-and-write
 * of a shared key through the shell's `cas` part, and the settings file's
 * write protocol (./settingsFileProtocol) with its quarantine to a backup
 * key. `updateNow` answers null — the window's writes are queued-only; use
 * `updateThrough`.
 *
 * The plugin module is inert at load (it resolves the plugin lazily), and
 * every other wrapped module is reached at call time: the node project's
 * setup file loads the test helpers that import this family, so a module
 * graph loaded at import time would land in the setup's registry before a
 * test file registers its own mocks (platforms/node/index.ts states the
 * reason in full).
 */

import { getCapacitorPreferences } from './capacitorPreferences';
import {
    beginQuarantine,
    discard,
    hydrate,
    issueQueuedWrite,
    noteMovedAside,
    notePersisted,
    restoreCacheToPersisted,
    stageWrite,
    undoQuarantine,
} from './settingsFileProtocol';

import type { PreferencesPlugin } from '@capacitor/preferences';
import type {
    JsonStoreTransport,
    PlatformCas,
    PlatformStorage,
    SettingsFileTransport,
    SettingsFileWiring,
    SettingsStoreRef,
} from '../../platform/port';
import type { DroppedSaveOps } from '../../settings/saveDropped';
import type { QueuedWriteOutcome } from '../../settings/storageTypes';
import type { CasAnswer, ThroughResult } from '../../types/stores';
import type { SettingsFileState } from './settingsFileProtocol';

type LoggerModule = typeof import('../../logger');
type StorageModule = typeof import('../../settings/storage');

// See the header: the wrapped modules, reached at call time.
const logger = (): LoggerModule => require('../../logger') as LoggerModule;
// Lazy for both reasons the header names: this file sits in the shell
// platform modules' static chain and the settings graph reaches the logger,
// which reads platform() at load — the install must run first — and a graph
// loaded in the Jest setup's registry would beat a test file's own mocks.
// The public storage facade carries CORRUPT_SUFFIX (its wipe inventory names
// the same keys) and SaveConflictError; the facade's internals are private
// to it.
const storage = (): StorageModule => require('../../settings/storage') as StorageModule;

// The Preferences keys whose cache holds something known: hydrated, refreshed or written.
const knownKeys = new Set<string>();

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
    const save = (update: (current: string | null) => string | null): Promise<string | null> =>
        saveThroughCas(prefKey, preferences, cache.get(), update, cas);
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

// Saves the text the app window changed (`data`, made from `base`, the cache before the change): only if
// Preferences still holds what was last known of it, else the change is made again on what the background service
// saved since (`update` decides what is saved from what is there). Once the latest write is saved, the cache holds
// the saved text. The compare-and-write is the shell's `cas` part (the native bridge; without one it saves straight
// to Preferences).
const saveThroughCasWith = async (
    state: SettingsFileState,
    prefKey: string,
    cas: CasWrite | undefined,
    update: (stored: string | null) => string | null,
    serial: number,
): Promise<string | null> => {
    let saved = state.persistedJson;
    const result = await saveThroughCas(
        prefKey,
        getCapacitorPreferences,
        state.persistedJson,
        (stored) => {
            const next = update(stored);
            saved = next ?? stored;
            return next;
        },
        cas,
    );
    notePersisted(state, saved, serial);
    return result;
};

/** The body of one queued write's turn: the write is skipped after a discard, else saved, and a save that lands after
 * a given-up one takes the dropped state back (a write issued before the given-up one does not carry its change
 * either). */
const runQueuedWrite = async (
    state: SettingsFileState,
    prefKey: string,
    dropped: DroppedSaveOps | null,
    cas: CasWrite | undefined,
    update: (stored: string | null) => string | null,
    issuedIn: number,
    serial: number,
): Promise<QueuedWriteOutcome> => {
    if (issuedIn !== state.writeGeneration) return 'failed';
    const result = await saveThroughCasWith(state, prefKey, cas, update, serial);
    if (dropped && serial > dropped.getAfter()) dropped.setDropped(false);
    return result === null ? 'declined' : 'written';
};

/** A queued write that threw: what the cache shows must be what is stored (the change was not saved, and no later
 * write carries it — each carries its own), and a file that reports dropped saves tells the window, so the user can
 * make the change again. */
const failQueuedWrite = (
    state: SettingsFileState,
    dropped: DroppedSaveOps | null,
    err: unknown,
    issuedIn: number,
    serial: number,
    userChange: boolean,
): QueuedWriteOutcome => {
    logger().withCategory('settings').error('Capacitor preferences write failed:', err);
    if (issuedIn !== state.writeGeneration) return 'failed';
    restoreCacheToPersisted(state, serial);
    if (!dropped) return 'failed';
    dropped.markAfter(state.writeSerial);
    dropped.setDropped(true, dropped.causeOf(err), userChange);
    return 'failed';
};

// Async initialization of the app window's file: hydrate the cache from Preferences once, before the window mounts,
// so the synchronous loadSettings call sees what is stored. A read failure leaves an empty cache but still marks the
// file initialized (the transport keeps the guard; only this owns the initialized flag).
const hydrateFromPreferences = async (state: SettingsFileState, prefKey: string): Promise<void> => {
    try {
        const prefs = getCapacitorPreferences();
        const { value } = await prefs.get({ key: prefKey });
        hydrate(state, value); // null if no preferences entry exists
        state.hasBackupKey = (await prefs.keys()).keys.some((key) =>
            key.startsWith(`${prefKey}${storage().CORRUPT_SUFFIX}`),
        );
    } catch (err) {
        logger().withCategory('settings').error('Capacitor preferences read failed:', err);
        hydrate(state, null);
    } finally {
        state.capacitorInitialized = true;
    }
};

// The queued move of a damaged value out of the way: copy it to the backup key, remove it from its own key, and
// record that Preferences no longer holds anything for the key (the cache was emptied before the move was queued).
const moveToBackupKey = async (
    state: SettingsFileState,
    prefKey: string,
    backupKey: string,
    raw: string,
): Promise<boolean> => {
    const preferences = getCapacitorPreferences();
    await preferences.set({ key: backupKey, value: raw });
    await preferences.remove({ key: prefKey });
    noteMovedAside(state);
    return true;
};

// The move failed — the value was not moved: Preferences still holds it, the cache shows what is stored again (a
// write queued meanwhile, a restore, cannot change what is stored over the damaged value, and must not be shown in
// place of it), and there is no copy of it.
const restoreAfterFailedMove = (state: SettingsFileState, hadBackupKey: boolean, err: unknown): boolean => {
    logger().withCategory('settings').error('Capacitor preferences backup write failed:', err);
    undoQuarantine(state, hadBackupKey);
    return false;
};

// The time a value was set aside, as part of the name it is kept under.
const setAsideStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

// The generic JSON store's Preferences transport. `flags.shared` marks a key
// the background service writes too: its saves go through the shell's `cas`
// part (the native compare-and-write, null where the build has none), so a
// change is saved only while the key still holds what it was made from.
const jsonStoreTransport = (
    ref: SettingsStoreRef,
    flags: { strict: boolean; shared: boolean },
    cas: PlatformCas | null,
): JsonStoreTransport => {
    let cachedJson: string | null = null;
    const cache = {
        get: () => cachedJson,
        set: (value: string | null) => {
            cachedJson = value;
        },
    };
    const writes = createWriteBehind(
        ref.prefKey,
        flags.strict,
        getCapacitorPreferences,
        cache,
        // The native compare-and-write of the key (the shell's part); a build without one saves straight to
        // Preferences, as the bridge's own no-plugin answer did.
        flags.shared ? (expected, data) => cas?.(ref.prefKey, expected, data) ?? null : undefined,
    );
    let initialized = false;
    return {
        readRaw: () => cachedJson,
        writeRaw: (data) => {
            cachedJson = data;
            writes.queue(data);
        },
        hydrate: async () => {
            if (initialized) return;
            try {
                const { value } = await getCapacitorPreferences().get({ key: ref.prefKey });
                cachedJson = value;
                writes.confirm(0);
            } catch (err) {
                logger().withCategory('settings').error(`Capacitor ${ref.prefKey} read failed:`, err);
                cachedJson = null;
            } finally {
                initialized = true;
            }
        },
        reread: async () => {
            // Waits for this context's own queued writes first, so none is lost.
            const { at, done } = writes.drained();
            await done;
            try {
                const { value } = await getCapacitorPreferences().get({ key: ref.prefKey });
                cachedJson = value;
                writes.confirm(at);
                initialized = true;
                return true;
            } catch (err) {
                logger().withCategory('settings').error(`Capacitor ${ref.prefKey} refresh failed:`, err);
                return false;
            }
        },
        // The write is only queued here: `updateThrough` is the way to make a change.
        updateNow: () => null,
        updateThrough: writes.updateThrough,
        // What is stored now, the cache left as it is — it may be behind it (the background service writes the key too).
        peekStored: async () => (await getCapacitorPreferences().get({ key: ref.prefKey })).value,
        flush: () => writes.flush(),
        discard: () => {
            writes.discard();
            cachedJson = null;
        },
    };
};

// The settings file's Preferences transport: the cache, the write queue and the write protocol (the state's
// write-protocol fields change only through the transitions in ./settingsFileProtocol).
const settingsFileTransport = (
    ref: SettingsStoreRef,
    wiring: SettingsFileWiring,
    cas: PlatformCas | null,
): SettingsFileTransport => {
    const state: SettingsFileState = {
        capacitorInitialized: false,
        cachedJson: null,
        hasBackupKey: false,
        persistedJson: null,
        writeChain: Promise.resolve(),
        writeGeneration: 0,
        writeSerial: 0,
    };
    const dropped = wiring.droppedSaves;
    const rebase = wiring.rebase;
    // The compare-and-write of the key, the shell's part: the native bridge, where the build has one.
    const compareAndWrite: CasWrite | undefined = (expected, data) => cas?.(ref.prefKey, expected, data) ?? null;
    // Queues the write of a change of the cache: after the writes before it, as a compare-and-write. The bodies
    // that run on a queued write's turn are runQueuedWrite and failQueuedWrite.
    const queueWrite = (
        update: (stored: string | null) => string | null,
        userChange: boolean,
    ): Promise<QueuedWriteOutcome> => {
        const issuedIn = state.writeGeneration;
        const serial = issueQueuedWrite(state);
        const ended = state.writeChain
            .then(() => runQueuedWrite(state, ref.prefKey, dropped, compareAndWrite, update, issuedIn, serial))
            .catch((err: unknown) => failQueuedWrite(state, dropped, err, issuedIn, serial, userChange));
        state.writeChain = ended.then(() => undefined);
        return ended;
    };
    return {
        readRaw: () => state.cachedJson,
        write: (data) => {
            // Update the cache so synchronous reads see the new value immediately, then fire async write-behind
            // to Preferences. Do NOT flip capacitorInitialized here — only hydration owns that flag. If a write
            // happens before hydration resolves and the flag flipped, hydration would be skipped and
            // previously-persisted settings would be lost on the next read of an unwritten key.
            const base = state.cachedJson;
            stageWrite(state, data);
            return { ok: true, landed: queueWrite((stored) => rebase(base, data, stored), true) };
        },
        writeIfAbsent: (data) => {
            // The cache shows the import at once; if the service saved first, the compare-and-write finds its text
            // and the cache takes that (`declined`). Whether it landed is for `landed` to say.
            stageWrite(state, data);
            return { outcome: 'saved', landed: queueWrite((stored) => (stored === null ? data : null), false) };
        },
        location: () => ref.prefKey,
        isLoaded: () => state.capacitorInitialized,
        isPersisted: () => state.cachedJson === state.persistedJson,
        hasQuarantined: () => state.hasBackupKey,
        quarantineRaw: (raw) => {
            const backupKey = `${ref.prefKey}${storage().CORRUPT_SUFFIX}-${setAsideStamp()}`;
            const hadBackupKey = beginQuarantine(state);
            // The move gets its own serial, so a write issued before it does not touch the emptied cache on its turn.
            issueQueuedWrite(state);
            const moved = state.writeChain
                .then(() => moveToBackupKey(state, ref.prefKey, backupKey, raw))
                .catch((err: unknown) => restoreAfterFailedMove(state, hadBackupKey, err));
            state.writeChain = moved.then(() => undefined);
            return { ok: true, path: backupKey, moved };
        },
        hydrate: async () => {
            if (state.capacitorInitialized) return;
            await hydrateFromPreferences(state, ref.prefKey);
        },
        flush: () => state.writeChain,
        discard: async () => {
            discard(state);
            await state.writeChain;
        },
    };
};

const createWebviewStorage = (cas: PlatformCas | null): PlatformStorage => ({
    jsonStore: (ref, flags) => jsonStoreTransport(ref, flags, cas),
    settingsFile: (ref, wiring) => settingsFileTransport(ref, wiring, cas),
    // The window's cache is filled by a start-up read that can fail, and a store that could not be filled is empty
    // because of that, not because nothing was saved. Ask after the store was read: a read that failed says so only
    // once it was made.
    loaded: (key) => knownKeys.has(key),
    // The native compare-and-write of each key decides; there is no file lock.
    lockPolicy: 'none',
});

export { createWebviewStorage };
