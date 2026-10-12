import { renderHook } from '@testing-library/preact';
import { isNativePlatform, usePlatformCapabilities } from '@/api/usePlatformCapabilities';
import type { RendererGlobals } from '../../src/ts/types/capacitor';

const g = globalThis as RendererGlobals;

afterEach(() => {
    delete g.Capacitor;
    delete (g as { webShell?: true }).webShell;
});

describe('platform capabilities', () => {
    test('a desktop or browser page (no Capacitor runtime) has none of the Android-only ones', () => {
        expect(isNativePlatform()).toBe(false);
        const { result } = renderHook(() => usePlatformCapabilities());
        expect(result.current).toEqual({
            inAppLogs: false,
            batteryGuidance: false,
            backgroundService: false,
            settingsFile: true,
            relaunchesAfterWipe: true,
        });
    });

    test('a page the web bridge installed does not relaunch after a wipe', () => {
        (g as { webShell?: true }).webShell = true;
        const { result } = renderHook(() => usePlatformCapabilities());
        expect(result.current.relaunchesAfterWipe).toBe(false);
        expect(result.current.settingsFile).toBe(true);
    });

    test('a Capacitor web target is not native', () => {
        g.Capacitor = { isNativePlatform: () => false };
        expect(isNativePlatform()).toBe(false);
        expect(renderHook(() => usePlatformCapabilities()).result.current.inAppLogs).toBe(false);
    });

    test('a runtime without the probe is not native', () => {
        g.Capacitor = {};
        expect(isNativePlatform()).toBe(false);
    });

    test('the Android app gets the in-app logs, the battery guidance and the background service', () => {
        g.Capacitor = { isNativePlatform: () => true };
        expect(isNativePlatform()).toBe(true);
        const { result, rerender } = renderHook(() => usePlatformCapabilities());
        expect(result.current).toEqual({
            inAppLogs: true,
            batteryGuidance: true,
            backgroundService: true,
            settingsFile: false,
            relaunchesAfterWipe: true,
        });
        // Fixed for the life of the page: the same object on every render.
        const first = result.current;
        rerender();
        expect(result.current).toBe(first);
    });
});
