/**
 * Capacitor entry point. Defers React mount until the bridge is
 * installed (so it exists when the first useSettings hook
 * fires) and settings.initializeAsync has hydrated the in-memory
 * cache from @capacitor/preferences. Then loads App and mounts it.
 *
 * dist/index.html (Capacitor's WebView entry) loads the bundle this
 * file produces, not app-bundle.js. Electron is unaffected; it never
 * loads this entry.
 */

// Tell App.jsx not to auto-mount when imported below. The import
// must happen after this assignment.
globalThis.__capacitorBootstrap = true;

import { installBridge, subscribe } from '../../bridge/capacitor';
import { initializeAsync as initSettings, flushPendingWrites, getSetting } from '../../settings';
import { initializeMetadataAsync, flushMetadataWrites } from '../../metadata';
import { initializeJoinStateAsync, flushJoinStateWrites } from '../../joinStateStore';
import { initializeSwapBackAsync, flushSwapBackWrites } from '../../swapBackStore';
import { initializeAutoSpendAsync, flushAutoSpendWrites } from '../../currencyAutoStore';
import { initializeScenarioStateAsync, flushScenarioStateWrites } from '../../scenarioStateStore';
import { initializeDiagnosticsAsync, flushDiagnosticsWrites } from '../../services/semantic/diagnostics';
import { isCapacitor } from '../../runtime';
import { withCategory } from '../../logger';
import { mountApp } from './App';
import { mountLogin } from './Login';

// Mount Login or App based on whether we have a token. Electron's
// index.js picks this via createLoginWindow vs createMainWindow and
// swaps windows on login/logout; Capacitor has only one WebView so
// we swap React trees and rely on a clean DOM reset between mounts
// (otherwise React's reconciler hits removeChild errors when its
// expected DOM does not match).
const mountForCurrentAuthState = () => {
    let token;
    try {
        token = getSetting('token') || '';
    } catch {
        token = '';
    }
    const container = document.getElementById('root');
    if (container) {
        while (container.firstChild) container.removeChild(container.firstChild);
    }
    if (token) {
        mountApp();
    } else {
        mountLogin();
    }
};

const bootstrap = async () => {
    if (isCapacitor()) {
        installBridge();
        await initSettings();
        // Metadata rides the same platform-aware transport — hydrate its
        // cache too so per-challenge vote metadata survives relaunches.
        await initializeMetadataAsync();
        // Join-state markers (paid-unlock idempotency) ride the same transport;
        // hydrate them so a paid retry after relaunch never re-unlocks (double
        // charge) on Android.
        await initializeJoinStateAsync();
        // Swap-back records (which slot can restore a boosted/turbo'd photo).
        await initializeSwapBackAsync();
        // Automatic exposure-fill counts (the per-challenge fill cap).
        await initializeAutoSpendAsync();
        // Where each challenge is in its user-defined scenario (phase, memory).
        await initializeScenarioStateAsync();
        await initializeDiagnosticsAsync();

        // Settings writes are write-behind (cache now, persist async). When
        // the OS backgrounds or tears down the WebView, push the latest
        // write so it is not lost. Best-effort: the serialized write chain
        // already guarantees order, this just narrows the durability window.
        const flush = () => {
            try {
                flushPendingWrites();
                flushMetadataWrites();
                flushJoinStateWrites();
                flushSwapBackWrites();
                flushAutoSpendWrites();
                flushScenarioStateWrites();
                flushDiagnosticsWrites();
            } catch {
                // never let a teardown handler throw
            }
        };
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) flush();
        });
        globalThis.addEventListener('pagehide', flush);
    }
    // Wire login-success / logout from the bridge to swap mounts.
    // Login.jsx calls the login IPC after a successful auth;
    // App.jsx calls the logout IPC from the navbar's logout button.
    subscribe('login-success', () => mountForCurrentAuthState());
    subscribe('logout', () => mountForCurrentAuthState());

    mountForCurrentAuthState();
};

bootstrap().catch((err) => {
    withCategory('general').error('Capacitor bootstrap failed', err);
    // Still attempt to mount so the user sees a useful error rather
    // than a blank screen. The React tree will surface the failure
    // through normal error boundaries / settings-loading state.
    mountForCurrentAuthState();
});
