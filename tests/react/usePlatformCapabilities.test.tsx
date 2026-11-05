import { renderHook } from '@testing-library/preact';
import { isNativePlatform, usePlatformCapabilities } from '@/api/usePlatformCapabilities';
import { UpdateDialog } from '@/components/app/UpdateDialog';
import { TranslationProvider } from '@/contexts/TranslationContext';
import { UpdateProvider } from '@/contexts/UpdateContext';
import { render as renderWithProviders } from '@testing-library/preact';
import { markPlatformKind } from '../../src/ts/core/platform/kind';
import { resetPlatformKind } from '../helpers/platformKind';

afterEach(resetPlatformKind);

describe('platform capabilities', () => {
    test('an unmarked page (the Electron renderer, or a browser before the web bridge installs) has none of the Android-only ones', () => {
        expect(isNativePlatform()).toBe(false);
        const { result } = renderHook(() => usePlatformCapabilities());
        expect(result.current).toEqual({
            inAppLogs: false,
            batteryGuidance: false,
            backgroundService: false,
            settingsFile: true,
            relaunchesAfterWipe: true,
            showsLogout: true,
            showsLocalDataWipe: true,
            showsUpdateInstall: true,
            showsRemoteAccessSection: true,
            viewPrefsLocal: false,
        });
    });

    test('a page the web bridge marked does not relaunch after a wipe', () => {
        markPlatformKind('web');
        const { result } = renderHook(() => usePlatformCapabilities());
        expect(result.current.relaunchesAfterWipe).toBe(false);
        expect(result.current.settingsFile).toBe(true);
    });

    test('the Android app gets the in-app logs, the battery guidance and the background service', () => {
        markPlatformKind('capacitor');
        expect(isNativePlatform()).toBe(true);
        const { result, rerender } = renderHook(() => usePlatformCapabilities());
        expect(result.current).toEqual({
            inAppLogs: true,
            batteryGuidance: true,
            backgroundService: true,
            settingsFile: false,
            relaunchesAfterWipe: true,
            showsLogout: true,
            showsLocalDataWipe: true,
            showsUpdateInstall: true,
            showsRemoteAccessSection: false,
            viewPrefsLocal: false,
        });
        // Fixed for the life of the page: the same object on every render.
        const first = result.current;
        rerender();
        expect(result.current).toBe(first);
    });

    test('a remote screen has the relayed log stream and none of the desktop powers', () => {
        markPlatformKind('remote');
        const { result } = renderHook(() => usePlatformCapabilities());
        expect(result.current).toEqual({
            inAppLogs: true,
            batteryGuidance: false,
            backgroundService: false,
            settingsFile: false,
            relaunchesAfterWipe: false,
            showsLogout: false,
            showsLocalDataWipe: false,
            showsUpdateInstall: false,
            showsRemoteAccessSection: false,
            viewPrefsLocal: true,
        });
    });

    test('the remote kind shows no update dialog: updates happen on the computer', () => {
        markPlatformKind('remote');
        const { container } = renderWithProviders(
            <TranslationProvider>
                <UpdateProvider>
                    <UpdateDialog />
                </UpdateProvider>
            </TranslationProvider>,
        );
        expect(container.textContent).toBe('');
    });
});
