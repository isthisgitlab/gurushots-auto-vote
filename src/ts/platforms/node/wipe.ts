/**
 * The node family's wipe member: what "Delete all local data" reaches on a
 * desktop. The stores are files the wipe removes from the user-data directory
 * itself (the fs branch of settings/localData.ts), so there is no native
 * plugin wipe (localData nativeWipe answers null without one), no Preferences
 * keys to list or remove, no caches emptied (no reload asked for), and no
 * session — the Electron shell's platform module provides clearSession, which
 * ElectronPlatform requires.
 */

import type { PlatformWipe } from '../../platform/port';

type CliSessionLockModule = typeof import('../../settings/cliSessionLock');

// Reached at call time (see index.ts for why): the markers live in the
// user-data directory, so reading them pulls the settings-side graph.
const cliSessionLock = (): CliSessionLockModule => require('../../settings/cliSessionLock') as CliSessionLockModule;

const createNodeWipe = (): PlatformWipe => ({
    clearSession: null,
    nativeWipe: async () => null,
    reloadAfterWipe: false,
    listPreferenceKeys: null,
    removePreferenceKeys: null,
    // The user-data markers a wipe must respect are cliSessionLock's (the
    // platform:node module that holds and reads them).
    markers: {
        isCliSessionActive: () => cliSessionLock().isCliSessionActive(),
        isDesktopAppActive: () => cliSessionLock().isDesktopAppActive(),
        isWebServerActive: () => cliSessionLock().isWebServerActive(),
        isMarkerFile: (name) =>
            cliSessionLock().MARKER_NAME_RE.test(name) || name === cliSessionLock().APP_LOCK_FILE_NAME,
    },
});

export { createNodeWipe };
