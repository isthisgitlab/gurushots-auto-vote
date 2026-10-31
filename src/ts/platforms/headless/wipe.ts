/**
 * The headless family's wipe member: what "Delete all local data" reaches
 * from the background service. It reaches nothing here, and nothing reaches
 * it: the wipe runs in the app's processes (settings/localData.ts is not
 * loaded headless), and the service's own native stores are wiped by its
 * native side. The bridge takes no key enumeration or removal
 * (AndroidHeadlessStore), so the store-key members are null, and there is no
 * session and no reload (the service is not Capacitor; localData asks no
 * reload of it).
 */

import type { PlatformWipe } from '../../platform/port';

const createHeadlessWipe = (): PlatformWipe => ({
    clearSession: null,
    nativeWipe: async () => null,
    reloadAfterWipe: false,
    listPreferenceKeys: null,
    removePreferenceKeys: null,
    // No user-data markers here: the desktop processes that hold them never
    // run in this service WebView, and its stores are the native bridge's.
    markers: {
        isCliSessionActive: async () => false,
        isDesktopAppActive: async () => false,
        isWebServerActive: async () => false,
        isMarkerFile: () => false,
    },
});

export { createHeadlessWipe };
