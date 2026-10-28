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
import { clearTokenUnlessStayingLoggedIn } from '../../services/auth';
import { getStatus } from '../../services/NativeAutovoteBridge';
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

const clearLeftoverToken = async (): Promise<void> => {
    try {
        // Stay and token are read before the native round-trip, so a stay-on or
        // token-less launch never calls the plugin. Off this entry's native
        // platform the unhydrated stores read as defaults (no token), so the
        // gate skips silently — the read never throws (a failing read is
        // answered with defaults, not an error).
        const leftover = getSetting('token');
        if (getSetting('stayLoggedIn') || !leftover) return;
        const status = await getStatus();
        // `running` is the persisted armed flag of the background auto-vote
        // service (it holds across force-stop and reboot), not process
        // liveness: an armed service is the token's designed consumer, so the
        // token stays. A getStatus call the plugin rejected carries `error` —
        // the field's presence, message-less or not — and the state it would
        // have read is unknown, so the token stays until a launch where the
        // call succeeds. `available: false` (no plugin) errs toward clearing:
        // no plugin means no service could ever have been armed.
        if (status.available && (status.running || 'error' in status)) {
            // The unreadable state is anomalous — the call itself failed — so it says so at warning
            // level; an armed service keeping its token is normal operation and stays at info.
            if ('error' in status) {
                withCategory('authentication').warning(
                    'Kept the saved login token because background auto-vote state could not be read',
                    null,
                );
            } else {
                withCategory('authentication').info(
                    'Kept the saved login token because background auto-vote is armed',
                    null,
                );
            }
            return;
        }
        if (await clearTokenUnlessStayingLoggedIn()) {
            withCategory('authentication').info(
                'Cleared a saved token left by an earlier run (Stay Logged In is off)',
                null,
            );
        }
    } catch (error) {
        withCategory('authentication').error('Failed to clear a leftover token at startup:', error);
    }
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

    // With Stay Logged In off, a token an earlier run left behind (a crash or
    // an OS kill skips every exit path) is cleared before the mount decision
    // reads the token — so the mount never races the clear. Runs once here,
    // never in the event-driven remounts: a fresh login with stay off must
    // never be cleared.
    await clearLeftoverToken();

    mountForCurrentAuthState();
};

bootstrap().catch((err) => {
    withCategory('general').error('Capacitor bootstrap failed', err);
    // Still attempt to mount so the user sees a useful error rather
    // than a blank screen. The React tree will surface the failure
    // through normal error boundaries / settings-loading state.
    mountForCurrentAuthState();
});
