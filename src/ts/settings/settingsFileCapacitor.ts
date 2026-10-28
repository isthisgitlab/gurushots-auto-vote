/**
 * The Capacitor half of `createSettingsFile` (storage.ts): the Android headless service's writes (through its native
 * bridge) and the app window's write-behind to @capacitor/preferences — what runs on the queued writes' turns, once
 * the write chain reaches them. The helpers take the per-file `state` object (one is made per `createSettingsFile`
 * call); its write-protocol fields change only through the transitions in settingsFileProtocol.ts. None of them
 * reaches the file object itself, and none of them imports storage.ts, so every `jest.mock('settings/storage')` a
 * test makes keeps ruling over all of this.
 *
 * The dropped-save reporting (`DroppedSaveOps`) is passed in by the factory too: only the configuration reports
 * given-up saves, so the helpers take the ops (or null) rather than reaching the save-dropped state themselves.
 */

import * as logger from '../logger';

import { getCapacitorPreferences } from './capacitorPreferences';
import { compareAndWrite } from '../services/NativeAutovoteBridge';
import { headlessSettingsWrite, headlessStore, keyedSettingsBridge, saveThroughCas } from './storeTransport';
import {
    hydrate,
    noteMovedAside,
    notePersisted,
    restoreCacheToPersisted,
    undoQuarantine,
} from './settingsFileProtocol';

import type { HeadlessSettingsBridge } from './storeTransport';
import type { DroppedSaveOps } from './saveDropped';
import type { SettingsFileState } from './settingsFileProtocol';
import type { QueuedWriteOutcome, SettingsFileOptions, WriteIfAbsentResult, WriteResult } from './storageTypes';

// Saves the text the app window changed (`data`, made from `base`, the cache before the change): only if
// Preferences still holds what was last known of it, else the change is made again on what the background service
// saved since (`update` decides what is saved from what is there). Once the latest write is saved, the cache holds
// the saved text.
const saveThroughCasWith = async (
    state: SettingsFileState,
    prefKey: string,
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
        (expected, text) => compareAndWrite(prefKey, expected, text),
    );
    notePersisted(state, saved, serial);
    return result;
};

/** The body of one queued write's turn: the write is skipped after a discard, else saved, and a save that lands after
 * a given-up one takes the dropped state back (a write issued before the given-up one does not carry its change
 * either). */
export const runQueuedWrite = async (
    state: SettingsFileState,
    prefKey: string,
    dropped: DroppedSaveOps | null,
    update: (stored: string | null) => string | null,
    issuedIn: number,
    serial: number,
): Promise<QueuedWriteOutcome> => {
    if (issuedIn !== state.writeGeneration) return 'failed';
    const result = await saveThroughCasWith(state, prefKey, update, serial);
    if (dropped && serial > dropped.getAfter()) dropped.setDropped(false);
    return result === null ? 'declined' : 'written';
};

/** A queued write that threw: what the cache shows must be what is stored (the change was not saved, and no later
 * write carries it — each carries its own), and a file that reports dropped saves tells the window, so the user can
 * make the change again. */
export const failQueuedWrite = (
    state: SettingsFileState,
    dropped: DroppedSaveOps | null,
    err: unknown,
    issuedIn: number,
    serial: number,
    userChange: boolean,
): QueuedWriteOutcome => {
    logger.withCategory('settings').error('Capacitor preferences write failed:', err);
    if (issuedIn !== state.writeGeneration) return 'failed';
    restoreCacheToPersisted(state, serial);
    if (!dropped) return 'failed';
    dropped.markAfter(state.writeSerial);
    dropped.setDropped(true, dropped.causeOf(err), userChange);
    return 'failed';
};

// The Android background service's write: persist through the native bridge to the shared store, as a change of the
// text this context read — the app window saves the same blob, and what it saved meanwhile is kept (see
// headlessSettingsWrite). The commit is synchronous so a later read() in the same cycle sees the new value.
export const writeThroughHeadlessStore = (
    state: SettingsFileState,
    bridge: () => HeadlessSettingsBridge | undefined,
    rebase: SettingsFileOptions['rebase'],
    data: string,
): WriteResult => {
    try {
        const saved = headlessSettingsWrite(bridge(), rebase, state.headlessBase, data);
        if (saved === null) {
            // The native side says why: the blob is past its size limit, it changed under the write, or the commit failed.
            const why = bridge()?.lastWriteRefusal?.();
            logger
                .withCategory('settings')
                .error(`Headless store refused the settings write${why ? ` (${why})` : ''}`, null);
            return { ok: false };
        }
        state.headlessBase = saved;
    } catch (err) {
        logger.withCategory('settings').error('Headless store write failed:', err);
        return { ok: false };
    }
    return { ok: true };
};

// The Android background service's writeIfAbsent: the native compare-and-write decides which of the two contexts (the
// app window and this service) is first; the other finds what the first saved (`exists`, with the text) and has
// nothing to write.
export const writeIfAbsentThroughHeadlessStore = (
    state: SettingsFileState,
    bridge: () => HeadlessSettingsBridge | undefined,
    data: string,
): WriteIfAbsentResult => {
    try {
        const answer = bridge();
        if (!answer) {
            state.headlessBase = data;
            return { outcome: 'saved' };
        }
        if (answer.write(data) !== false) {
            state.headlessBase = data;
            return { outcome: 'saved' };
        }
        const current = answer.read();
        if (current !== null) {
            state.headlessBase = current;
            return { outcome: 'exists', current };
        }
        logger
            .withCategory('settings')
            .error(`Headless store refused the settings write (${answer.lastWriteRefusal?.() || 'refused'})`, null);
    } catch (err) {
        logger.withCategory('settings').error('Headless store write failed:', err);
    }
    return { outcome: 'failed' };
};

// The backup of an unparseable Capacitor value lives under its key plus this suffix and the time it was set aside (a
// later one never replaces an earlier). Before the time was added it was the suffix alone. Moved here from storage.ts,
// which re-exports it for its importers.
export const CORRUPT_SUFFIX = '_corrupt';

// Async initialization of the app window's file: hydrate the cache from Preferences once, before the window mounts,
// so the synchronous loadSettings call sees what is stored. A read failure leaves an empty cache but still marks the
// file initialized (the factory method keeps the guard; only this owns the initialized flag).
export const hydrateFromPreferences = async (state: SettingsFileState, prefKey: string): Promise<void> => {
    try {
        const prefs = getCapacitorPreferences();
        const { value } = await prefs.get({ key: prefKey });
        hydrate(state, value); // null if no preferences entry exists
        state.hasBackupKey = (await prefs.keys()).keys.some((key) => key.startsWith(`${prefKey}${CORRUPT_SUFFIX}`));
    } catch (err) {
        logger.withCategory('settings').error('Capacitor preferences read failed:', err);
        hydrate(state, null);
    } finally {
        state.capacitorInitialized = true;
    }
};

// The queued move of a damaged value out of the way: copy it to the backup key, remove it from its own key, and
// record that Preferences no longer holds anything for the key (the cache was emptied before the move was queued).
export const moveToBackupKey = async (
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
export const restoreAfterFailedMove = (state: SettingsFileState, hadBackupKey: boolean, err: unknown): boolean => {
    logger.withCategory('settings').error('Capacitor preferences backup write failed:', err);
    undoQuarantine(state, hadBackupKey);
    return false;
};

// The bridge pair this file's reads and writes go through on Android: the background service reaches its key through
// the bridge's own read/write pair; the app window's files go through the keyed calls. Both sides are resolved per
// call, as the factory's inline bridge did.
export const makeFileBridge = (
    dedicatedBridge: boolean,
    prefKey: string,
): (() => HeadlessSettingsBridge | undefined) => {
    if (dedicatedBridge) return () => headlessStore();
    return () => keyedSettingsBridge(prefKey);
};
