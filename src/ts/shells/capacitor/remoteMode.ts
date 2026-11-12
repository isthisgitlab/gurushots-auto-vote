/**
 * The Android app's remote mode: the "Control my computer" paste entry and the
 * startup decision. The pairing key lives in the app's Preferences under the
 * desktop pairing store's key (`gs_remote_access`), so the wipe clears it with
 * the rest of the local data. Entering stops the background service and clears
 * the persisted running flag first — no local voter may survive into or after
 * remote mode — then stores the key and hands the WebView to the bundled
 * remote loader (`/remote/index.html`, which the APK carries with the
 * versioned pages). The document this module runs in mounts nothing after that.
 */

import * as logger from '../../core/logger';
import * as settings from '../../core/settings';
import { installPhoneRemoteMode } from '../../core/remote/phoneMode';
import { readStoredKey, storeKey } from '../../core/remote/phoneKeyStore';
import { parsePairingLink } from '../../core/remote/pairingKey';
import { LINK_VERSION } from '../../core/remote/protocol';
import { stop as stopNativeService } from './NativeAutovoteBridge';

import type { RemoteModeEntry } from '../../core/remote/phoneMode';

/** The bundled remote loader document (scripts/build-react.ts stages it under dist/remote/). */
const BUNDLED_LOADER_PATH = '/remote/index.html';

/**
 * The pairing key stored for the remote mode, or null when the app is not in remote mode and the
 * normal app mounts. A read the native bridge refused, and a stored value that is not a key, leave
 * the state unknown or unusable: both start the normal mode (local voting is off in remote mode's
 * wake, so nothing votes) and are said once in the log.
 */
const readStoredPairingKey = async (): Promise<{ key: string; linkVersion: number } | null> => {
    try {
        const stored = await readStoredKey();
        if (stored.kind === 'key') return { key: stored.key, linkVersion: stored.linkVersion };
        if (stored.kind === 'none') return null;
    } catch {
        // A read the native bridge refused: the state is unknown, said below.
    }
    logger.withCategory('general').warning('Stored remote-access key could not be read; the app starts in normal mode');
    return null;
};

/** Navigates this WebView to the bundled remote loader with the key in its fragment. */
const loadBundledRemoteLoader = ({ key, linkVersion }: { key: string; linkVersion: number }): void => {
    globalThis.location.assign(`${BUNDLED_LOADER_PATH}#k=${key}&v=${linkVersion}`);
};

/**
 * Enters remote mode from a pasted pairing link: the background service is
 * stopped, the persisted running flag is cleared (and flushed, so nothing of it
 * can come back), the key is stored, and the WebView moves to the bundled
 * remote page. Every step answers refusal while the state it leaves behind is
 * not the one remote mode needs — the app then stays in normal mode.
 */
const enterRemoteMode = async (link: string): Promise<RemoteModeEntry> => {
    const target = parsePairingLink(link);
    if (target === null) return { success: false, error: 'bad-link' };
    if (target.linkVersion < LINK_VERSION) return { success: false, error: 'update-computer' };
    if (target.linkVersion > LINK_VERSION) return { success: false, error: 'update-phone' };
    // The service stops first: remote mode and a local voter never run at once. A call that
    // came back with an error left the service's state unknown, so entering is refused.
    const stopped = await stopNativeService();
    if (stopped.available && 'error' in stopped) return { success: false, error: 'service-stop' };
    // The flag is what a later relaunch resumes from: cleared and flushed before the key is
    // stored, so no crash in between can leave remote mode with a resumable voter.
    if (!settings.setSetting('autovoteRunning', false)) return { success: false, error: 'settings' };
    try {
        await settings.flushPendingWrites();
    } catch {
        return { success: false, error: 'settings' };
    }
    try {
        await storeKey(target.key, target.linkVersion);
    } catch {
        return { success: false, error: 'storage' };
    }
    loadBundledRemoteLoader(target);
    return { success: true };
};

/**
 * Installs the paste entry for the document's React app. Called by the Capacitor
 * entry after the stored key said the app is not in remote mode; everything the
 * entry needs runs in this document.
 */
const installRemoteModeEntry = (): void => {
    installPhoneRemoteMode({ enter: enterRemoteMode });
};

export { enterRemoteMode, installRemoteModeEntry, loadBundledRemoteLoader, readStoredPairingKey };
