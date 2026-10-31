/**
 * The webview family's wipe member: what "Delete all local data" reaches on
 * the app WebView. The stores are Preferences keys (the Capacitor branch of
 * settings/localData.ts), and the caches are emptied, so the result asks the
 * caller for a reload once the user has been told. There is no Electron
 * session to clear (the wipe's clearSession dep answers at once without
 * Electron). The native plugin's wipe is not built here — the plugin global
 * is the shell's to reach — so the shell module passes it in as the required
 * nativeWipe part.
 */

import type { PlatformWipe } from '../../platform/port';

type CapacitorPreferencesModule = typeof import('../../settings/capacitorPreferences');

// Reached at call time: the setup file loads the helpers that import this
// family, so an import-time module graph lands in the setup's registry before
// a test file registers its own mocks, and the test's factory would lose to
// the cached module (platforms/node/index.ts states the reason in full).
const capacitorPreferences = (): CapacitorPreferencesModule =>
    require('../../settings/capacitorPreferences') as CapacitorPreferencesModule;

const createWebviewWipe = (): Omit<PlatformWipe, 'nativeWipe'> => ({
    clearSession: null,
    // The Capacitor branch of localData: `reload` — the caches were emptied and
    // what is stored is only partly gone.
    reloadAfterWipe: true,
    listPreferenceKeys: async () => capacitorPreferences().listPreferenceKeys(),
    removePreferenceKeys: async (keys) => {
        await capacitorPreferences().removePreferenceKeys(keys);
    },
    // The user-data markers are files under the user-data directory, held by
    // desktop processes (a CLI session, the web server, the desktop app); a
    // WebView has no file system to hold or read them, so the checks answer no
    // — as today's fail-soft reads do.
    markers: {
        isCliSessionActive: async () => false,
        isDesktopAppActive: async () => false,
        isWebServerActive: async () => false,
        isMarkerFile: () => false,
    },
});

export { createWebviewWipe };
