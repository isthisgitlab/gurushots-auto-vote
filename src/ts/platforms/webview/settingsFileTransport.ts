/**
 * The settings file's Preferences transport of the app WebView (the family's
 * `settingsFile` member, composed by store.ts): the cache, the write queue
 * and the write protocol — the state's write-protocol fields change only
 * through the transitions in ./settingsFileProtocol — with each queued write
 * saved as a compare-and-write, its quarantine to a backup key, and the
 * hydrate-once from Preferences.
 *
 * The wrapped modules are reached at call time for the reasons store.ts's
 * header names (the install must run before the logger loads; the Jest
 * setup's registry must not pre-empt a test file's own mocks).
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
import { saveThroughCas, type CasWrite } from './writeBehind';

import type {
    PlatformCas,
    SettingsFileTransport,
    SettingsFileWiring,
    SettingsStoreRef,
} from '../../core/platform/port';
import type { DroppedSaveOps } from '../../core/settings/saveDropped';
import type { QueuedWriteOutcome } from '../../core/settings/storageTypes';
import type { SettingsFileState } from './settingsFileProtocol';

type LoggerModule = typeof import('../../core/logger');
type StorageModule = typeof import('../../core/settings/storage');

// See store.ts's header: the wrapped modules, reached at call time.
const logger = (): LoggerModule => require('../../core/logger') as LoggerModule;
// Lazy for both reasons store.ts's header names: this file sits in the shell
// platform modules' static chain and the settings graph reaches the logger,
// which reads platform() at load — the install must run first — and a graph
// loaded in the Jest setup's registry would beat a test file's own mocks.
// The public storage facade carries CORRUPT_SUFFIX (its wipe inventory names
// the same keys); the facade's internals are private to it.
const storage = (): StorageModule => require('../../core/settings/storage') as StorageModule;

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

export { settingsFileTransport };
