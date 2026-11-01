import { useMemo } from 'react';

import { platformKind } from '../../core/platform/kind';

/**
 * Whether the page runs inside the native Android app. platformKind() is the single source of truth for the
 * renderer's platform: the shell bridges mark the kind when they expose window.api — the Capacitor one only after
 * the runtime probes native (calling it, not just checking it exists, excludes a Capacitor web target) — so this
 * never reads the Capacitor global itself. Components go through usePlatformCapabilities.
 */
export const isNativePlatform = (): boolean => platformKind() === 'capacitor';

/**
 * What the current platform offers the UI, so no component branches on the platform itself.
 */
export type PlatformCapabilities = {
    /** an in-app log viewer is needed: Android has no menu to open the Logs window from (the remote page is fed by the relayed log stream) */
    inAppLogs: boolean;
    /** the user has to exempt the app from battery optimisation for unattended voting to survive */
    batteryGuidance: boolean;
    /** the app has a native background service whose state is kept on the device */
    backgroundService: boolean;
    /** the settings are a file the user can open (desktop, web shell), not app-private storage */
    settingsFile: boolean;
    /** the app starts again by itself after "Delete all local data" (the web shell's server stops instead) */
    relaunchesAfterWipe: boolean;
    /** the sign-out button exists here */
    showsLogout: boolean;
    /** "Delete all local data" runs here */
    showsLocalDataWipe: boolean;
    /** updates are downloaded and installed here */
    showsUpdateInstall: boolean;
    /** the Settings "Remote access" section exists here (the desktop app is what gets paired to) */
    showsRemoteAccessSection: boolean;
};

/**
 * The capabilities of the platform the renderer runs on. The kind the bridge marked is fixed for the life of the
 * page.
 */
export function usePlatformCapabilities(): PlatformCapabilities {
    return useMemo(() => {
        const native = isNativePlatform();
        const remote = platformKind() === 'remote';
        return {
            inAppLogs: native || remote,
            batteryGuidance: native,
            backgroundService: native,
            settingsFile: !native && !remote,
            relaunchesAfterWipe: platformKind() !== 'web' && !remote,
            showsLogout: !remote,
            showsLocalDataWipe: !remote,
            showsUpdateInstall: !remote,
            showsRemoteAccessSection: platformKind() === 'electron',
        };
    }, []);
}
