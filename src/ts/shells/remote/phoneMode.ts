/**
 * The Android remote mode's Disconnect, installed by the remote page entry when
 * the page runs inside the Android app's WebView: the stored pairing key is
 * cleared from the app's Preferences (the key the startup decision reads), and
 * the WebView returns to the app's own document, which mounts the normal mode
 * with local voting off. A browser tab has no app Preferences, so nothing is
 * installed there and the UI shows no Disconnect. The logger is not used here:
 * this document has no log sink of its own.
 */

import { installPhoneRemoteMode } from '../../core/remote/phoneMode';
import { clearStoredKey } from '../../core/remote/phoneKeyStore';
import { clearLinkVersion } from '../../core/remote/linkVersion';

import type { CapacitorGlobals } from '../../core/types/capacitor';

/** The app's own document, where the normal mode runs (Capacitor's webDir root). */
const APP_DOCUMENT_PATH = '/index.html';

/** Whether this page runs inside the Android app's WebView: the Capacitor runtime probes native. */
const isAppWebView = (): boolean => {
    const cap = (globalThis as CapacitorGlobals).Capacitor;
    return cap != null && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform() === true;
};

/**
 * Leaves remote mode: the stored key goes (and the link version kept with it), then the WebView moves to the app's
 * own document. Rejects when the key could not be cleared — the WebView stays
 * put, because a navigation back would only land in remote mode again.
 */
const disconnectFromComputer = async (): Promise<void> => {
    await clearStoredKey();
    clearLinkVersion();
    globalThis.location.assign(APP_DOCUMENT_PATH);
};

/** Installs Disconnect when this remote page runs inside the Android app. */
const installPhoneDisconnect = (): void => {
    if (!isAppWebView()) return;
    installPhoneRemoteMode({ disconnect: disconnectFromComputer });
};

export { installPhoneDisconnect, disconnectFromComputer, isAppWebView };
