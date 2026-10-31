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

const createNodeWipe = (): PlatformWipe => ({
    clearSession: null,
    nativeWipe: async () => null,
    reloadAfterWipe: false,
    listPreferenceKeys: null,
    removePreferenceKeys: null,
});

export { createNodeWipe };
