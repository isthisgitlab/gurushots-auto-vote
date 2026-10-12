import { useMemo } from 'react';

import type { RendererGlobals } from '../../types/capacitor';

/**
 * Whether the page runs inside the native Android app. Asks the Capacitor runtime's platform probe — calling it, not
 * just checking it exists, excludes a Capacitor web target — without importing the Node-flavoured runtime module into
 * the browser bundle. The one place the renderer reads the Capacitor global; components go through
 * usePlatformCapabilities.
 */
export const isNativePlatform = (): boolean => (globalThis as RendererGlobals).Capacitor?.isNativePlatform?.() === true;

/**
 * What the current platform offers the UI, so no component branches on the platform itself.
 */
export type PlatformCapabilities = {
    /** an in-app log viewer is needed: Android has no menu to open the Logs window from */
    inAppLogs: boolean;
    /** the user has to exempt the app from battery optimisation for unattended voting to survive */
    batteryGuidance: boolean;
    /** the app has a native background service whose state is kept on the device */
    backgroundService: boolean;
};

/**
 * The capabilities of the platform the renderer runs on. Fixed for the life of the page.
 */
export function usePlatformCapabilities(): PlatformCapabilities {
    return useMemo(() => {
        const native = isNativePlatform();
        return { inAppLogs: native, batteryGuidance: native, backgroundService: native };
    }, []);
}
