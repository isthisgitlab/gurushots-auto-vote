/**
 * The bodies of the methods `createSettingsFile` (storage.ts) returns: the platform routing and the small synchronous
 * cache updates, over the per-file `state` and the factory's `deps`. The heavy platform work lives in
 * settingsFileCapacitor.ts (Capacitor/headless) and settingsFileNode.ts (fs); this module only routes between them and
 * keeps the cache in step. It never imports storage.ts, so a test's `jest.mock('settings/storage')` keeps ruling over
 * every one of these.
 */

import * as fs from 'node:fs';
import * as runtime from '../runtime';

import { writeAtomicOwnerOnly } from './atomicWrite';
import { areWritesRefused } from './jsonStore';
import { headlessStore } from './storeTransport';
import {
    CORRUPT_SUFFIX,
    hydrateFromPreferences,
    moveToBackupKey,
    restoreAfterFailedMove,
    writeIfAbsentThroughHeadlessStore,
    writeThroughHeadlessStore,
} from './settingsFileCapacitor';
import { hasQuarantinedOnDisk, renameToCorruptBackup, writeIfAbsentOnDisk } from './settingsFileNode';

import type {
    QuarantineResult,
    SettingsFileDeps,
    SettingsFileState,
    WriteIfAbsentResult,
    WriteResult,
} from './storageTypes';

// The time a value was set aside, as part of the name it is kept under.
const setAsideStamp = (): string => new Date().toISOString().replace(/[:.]/g, '-');

// The stored text where it is the app's own to read: the Android window's cache, or the file.
const readHere = (state: SettingsFileState, deps: SettingsFileDeps): string | null => {
    if (runtime.isCapacitor()) return state.cachedJson;
    const file = deps.filePath();
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
};

/**
 * Returns the raw JSON string, or null if not yet written.
 */
export const readRawMethod = (state: SettingsFileState, deps: SettingsFileDeps): string | null => {
    if (runtime.isHeadlessService()) {
        // Background WebView: read from the native bridge backed by the same store the app's
        // @capacitor/preferences uses, so the token and settings stay in sync between app and background.
        state.headlessBase = deps.bridge()?.read() || null;
        return state.headlessBase;
    }
    return readHere(state, deps);
};

/**
 * Writes the raw JSON string. Sync on Electron/CLI (replaced atomically, so a reader or a crash never sees a
 * cut-off file); cache + async write-behind on Capacitor, where `landed` says how the queued write ended.
 *
 * @returns `ok` false when the Android service's native store refused the write; true otherwise (a failed fs write throws)
 */
export const writeMethod = (state: SettingsFileState, deps: SettingsFileDeps, data: string): WriteResult => {
    if (areWritesRefused()) return { ok: false };
    if (runtime.isHeadlessService()) {
        return writeThroughHeadlessStore(state, deps.bridge, deps.rebase, data);
    }
    if (runtime.isCapacitor()) {
        // Update the cache so synchronous reads see the new value immediately, then fire async write-behind
        // to Preferences. Do NOT flip capacitorInitialized here — only initializeAsync owns that flag. If a
        // write happens before initializeAsync resolves and we flipped the flag, initializeAsync would skip
        // its hydration and previously-persisted settings would be lost on the next read of an unwritten key.
        const base = state.cachedJson;
        state.cachedJson = data;
        return { ok: true, landed: deps.queueWrite((stored) => deps.rebase(base, data, stored), true) };
    }
    const file = deps.filePath();
    deps.sweepOnce(file);
    writeAtomicOwnerOnly(file, data);
    return { ok: true };
};

/**
 * Writes the raw JSON string only if nothing is stored yet: the write of an import, which two contexts (the app
 * window and the background service) may both try. On Android the native compare-and-write decides which
 * one is first; the other finds what the first saved (`exists`, with the text) and has nothing to write. On a
 * desktop the caller holds the import lock, so what it found missing is still missing.
 */
export const writeIfAbsentMethod = (
    state: SettingsFileState,
    deps: SettingsFileDeps,
    data: string,
): WriteIfAbsentResult => {
    if (areWritesRefused()) return { outcome: 'failed' };
    if (runtime.isHeadlessService()) {
        return writeIfAbsentThroughHeadlessStore(state, deps.bridge, data);
    }
    if (runtime.isCapacitor()) {
        // The cache shows the import at once; if the service saved first, the compare-and-write finds its text
        // and the cache takes that (`declined`). Whether it landed is for `landed` to say.
        state.cachedJson = data;
        return {
            outcome: 'saved',
            landed: deps.queueWrite((stored) => (stored === null ? data : null), false),
        };
    }
    return writeIfAbsentOnDisk(deps.filePath(), data);
};

/** Where the file lives, for a message: the file, or the preference key where there is no file. */
export const locationMethod = (deps: SettingsFileDeps): string =>
    runtime.isHeadlessService() || runtime.isCapacitor() ? deps.prefKey : deps.filePath();

/**
 * Whether what a read answers is what is stored: false only where the answer is a cache that has not been
 * filled yet (the app window before initializeAsync resolved) or no bridge answers (the Android service).
 */
export const isLoadedMethod = (state: SettingsFileState): boolean => {
    if (runtime.isHeadlessService()) return headlessStore() !== undefined;
    if (runtime.isCapacitor()) return state.capacitorInitialized;
    return true;
};

/**
 * Whether what a read answers is stored: false only in the Android app window while a write of its own, queued
 * and not landed yet, is what the cache shows (it is stored when it lands, and the cache goes back to what is
 * stored when it fails).
 */
export const isPersistedMethod = (state: SettingsFileState): boolean =>
    !runtime.isCapacitor() || runtime.isHeadlessService() || state.cachedJson === state.persistedJson;

/**
 * Whether an unusable copy of this file was set aside earlier (`<file>.corrupt-<time>`; on Capacitor a
 * `<key>_corrupt…` preference, which the window learns when it hydrates, and the service cannot see).
 */
export const hasQuarantinedMethod = (state: SettingsFileState, deps: SettingsFileDeps): boolean => {
    if (runtime.isHeadlessService()) return false;
    if (runtime.isCapacitor()) return state.hasBackupKey;
    return hasQuarantinedOnDisk(deps.filePath);
};

/**
 * Moves a value that cannot be used out of the way, so the next save does not overwrite it: the file is
 * renamed to `<file>.corrupt-<time>` (Electron/CLI); the Preferences value is copied to
 * `<key>_corrupt-<time>`, then removed from its own key, and the cache emptied (Capacitor). The Android
 * service cannot do either, so it reports a failure and the caller refuses to save.
 */
export const quarantineRawMethod = (
    state: SettingsFileState,
    deps: SettingsFileDeps,
    raw: string,
): QuarantineResult => {
    if (runtime.isHeadlessService()) {
        return { ok: false, error: 'the background service cannot set an unusable settings value aside' };
    }
    if (runtime.isCapacitor()) {
        const backupKey = `${deps.prefKey}${CORRUPT_SUFFIX}-${setAsideStamp()}`;
        state.cachedJson = null;
        const hadBackupKey = state.hasBackupKey;
        state.hasBackupKey = true;
        ++state.writeSerial;
        const moved = state.writeChain
            .then(() => moveToBackupKey(state, deps.prefKey, backupKey, raw))
            .catch((err: unknown) => restoreAfterFailedMove(state, hadBackupKey, err));
        state.writeChain = moved.then(() => undefined);
        return { ok: true, path: backupKey, moved };
    }
    const file = deps.filePath();
    return renameToCorruptBackup(file, `${file}.corrupt-${setAsideStamp()}`);
};

/**
 * Async initialization for Capacitor builds: hydrates the cache from Preferences. No-op elsewhere.
 */
export const initializeAsyncMethod = async (state: SettingsFileState, deps: SettingsFileDeps): Promise<void> => {
    if (!runtime.isCapacitor() || runtime.isHeadlessService() || state.capacitorInitialized) return;
    await hydrateFromPreferences(state, deps.prefKey);
};

/** Gives up every write still queued and empties the caches. */
export const discardMethod = async (state: SettingsFileState): Promise<void> => {
    state.writeGeneration++;
    state.cachedJson = null;
    state.persistedJson = null;
    state.hasBackupKey = false;
    await state.writeChain;
};
