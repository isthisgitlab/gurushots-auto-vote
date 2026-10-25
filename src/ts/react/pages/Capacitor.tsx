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

import type { RendererGlobals } from '../../types/capacitor';

// Tell App.tsx not to auto-mount when imported below. The import
// must happen after this assignment.
(globalThis as RendererGlobals).__capacitorBootstrap = true;

import { installBridge, seedBridgeProfiles, subscribe } from '../../bridge/capacitor';
import { getSetting } from '../../settings';
import { flushLocalStores, initializeLocalStores } from '../../localStores';
import { isCapacitor } from '../../runtime';
import { withCategory } from '../../logger';
import { mountForToken } from './mountForToken';

// Mount Login or App based on whether we have a token.
const mountForCurrentAuthState = () => {
    let hasToken;
    try {
        hasToken = !!getSetting('token');
    } catch {
        hasToken = false;
    }
    mountForToken(hasToken);
};

const bootstrap = async () => {
    if (isCapacitor()) {
        installBridge();
        // The local stores hydrate through localStores (one list; see it): the settings come first, and seeding
        // reads and writes the settings, so the bridge's profiles are seeded between that and the other stores;
        // the mount waits for all of them.
        await initializeLocalStores(seedBridgeProfiles);

        // Settings writes are write-behind (cache now, persist async). When
        // the OS backgrounds or tears down the WebView, push the latest
        // write so it is not lost. Best-effort: the serialized write chain
        // already guarantees order, this just narrows the durability window.
        const flush = () => {
            void flushLocalStores();
        };
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) flush();
        });
        globalThis.addEventListener('pagehide', flush);
    }
    // Wire login-success / logout from the bridge to swap mounts.
    // Login.tsx calls the login IPC after a successful auth;
    // App.tsx calls the logout IPC from the navbar's logout button.
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
