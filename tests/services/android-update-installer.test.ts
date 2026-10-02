/**
 * AndroidUpdateInstaller routes APK download+install to the native
 * ApkInstaller Capacitor plugin when present (in-app download + system
 * installer), and falls back to opening the URL in the browser otherwise.
 * The native Kotlin is verified on-device; here we cover the JS routing.
 */

jest.mock('../../src/ts/runtime', () => ({ isCapacitor: jest.fn(() => true) }));

import runtimeModule = require('../../src/ts/runtime');
const runtime = jest.mocked(runtimeModule);
import logger = require('../../src/ts/logger');
import type * as AndroidUpdateInstallerModule from '../../src/ts/services/AndroidUpdateInstaller';
const { downloadAndInstall } =
    require('../../src/ts/services/AndroidUpdateInstaller') as typeof AndroidUpdateInstallerModule;
import type { ApkInstallerPlugin, CapacitorGlobals } from '../../src/ts/types/capacitor';
import { invalid } from '../helpers/invalid';

// The globals the installer reads; open and location are removed on purpose to reach the last fallbacks.
type InstallerGlobals = Omit<CapacitorGlobals, 'open' | 'location'> & {
    open?: Window['open'];
    location?: Pick<Location, 'href'>;
};
const g = globalThis as InstallerGlobals;

describe('AndroidUpdateInstaller', () => {
    let originalCapacitor: InstallerGlobals['Capacitor'];
    let originalOpen: InstallerGlobals['open'];
    let originalLocation: InstallerGlobals['location'];

    beforeEach(() => {
        runtime.isCapacitor.mockReturnValue(true);
        originalCapacitor = g.Capacitor;
        originalOpen = g.open;
        originalLocation = g.location;
    });

    afterEach(() => {
        g.Capacitor = originalCapacitor;
        g.open = originalOpen;
        g.location = originalLocation;
    });

    test('uses the native ApkInstaller plugin when available and forwards progress', async () => {
        const dl = jest.fn().mockResolvedValue({ success: true });
        const remove = jest.fn();
        const addListener = jest.fn().mockResolvedValue({ remove });
        g.Capacitor = { Plugins: { ApkInstaller: { downloadAndInstall: dl, addListener } } };
        const onProgress = jest.fn();

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', version: '1.2.3', onProgress });

        expect(dl).toHaveBeenCalledWith({ url: 'https://x/app.apk', version: '1.2.3' });
        expect(addListener).toHaveBeenCalledWith('downloadProgress', expect.any(Function));
        expect(res.success).toBe(true);
        expect(remove).toHaveBeenCalled();
    });

    test('falls back to the browser when the native plugin is absent', async () => {
        g.Capacitor = { Plugins: {} };
        g.open = jest.fn();

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', version: '1.2.3' });

        expect(g.open).toHaveBeenCalledWith('https://x/app.apk', '_blank');
        expect(res.success).toBe(true);
    });

    test('returns an error when no download URL is provided', async () => {
        const res = await downloadAndInstall(invalid({}));
        expect(res.success).toBe(false);
    });

    test('is a no-op outside Capacitor', async () => {
        runtime.isCapacitor.mockReturnValue(false);
        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk' });
        expect(res.success).toBe(false);
    });

    test('forwards native progress events to onProgress and tolerates a handle without remove()', async () => {
        let listener: Parameters<NonNullable<ApkInstallerPlugin['addListener']>>[1];
        const addListener = jest.fn(async (_event: 'downloadProgress', cb: typeof listener) => {
            listener = cb;
            return invalid<{ remove: () => Promise<void> }>({});
        });
        const dl = jest.fn(async () => {
            listener({ percent: 42 });
            return { success: false, error: 'user cancelled' };
        });
        g.Capacitor = { Plugins: { ApkInstaller: { downloadAndInstall: dl, addListener } } };
        const onProgress = jest.fn();

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', onProgress });

        expect(onProgress).toHaveBeenCalledWith({ percent: 42 });
        // No version given -> native plugin receives an empty string.
        expect(dl).toHaveBeenCalledWith({ url: 'https://x/app.apk', version: '' });
        expect(res).toEqual({ success: false, version: undefined, error: 'user cancelled' });
    });

    test('a native failure without a message still reports why', async () => {
        const dl = jest.fn().mockResolvedValue({ success: false });
        g.Capacitor = { Plugins: { ApkInstaller: { downloadAndInstall: dl } } };

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', version: '2.0.0' });

        expect(res).toEqual({ success: false, version: '2.0.0', error: 'The installer reported a failure' });
    });

    test('skips the listener when no onProgress is given and treats a missing result as success', async () => {
        const addListener = jest.fn();
        const dl = jest.fn().mockResolvedValue(undefined);
        g.Capacitor = { Plugins: { ApkInstaller: { downloadAndInstall: dl, addListener } } };

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', version: '2.0.0' });

        expect(addListener).not.toHaveBeenCalled();
        expect(res).toEqual({ success: true, version: '2.0.0' });
    });

    test('falls back to the browser when the native install throws, even if listener cleanup throws', async () => {
        const error = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValueOnce(invalid({ error }));
        const remove = jest.fn(() => {
            throw new Error('already removed');
        });
        const addListener = jest.fn().mockResolvedValue({ remove });
        const dl = jest.fn().mockRejectedValue(new Error('disk full'));
        const browserOpen = jest.fn();
        g.Capacitor = {
            Plugins: { ApkInstaller: { downloadAndInstall: dl, addListener }, Browser: { open: browserOpen } },
        };

        const res = await downloadAndInstall({
            downloadUrl: 'https://x/app.apk',
            version: '1.0.0',
            onProgress: jest.fn(),
        });

        expect(error).toHaveBeenCalledWith('Native APK install failed; falling back to browser', expect.any(Error));
        expect(remove).toHaveBeenCalled();
        expect(browserOpen).toHaveBeenCalledWith({ url: 'https://x/app.apk' });
        expect(res).toEqual({ success: true, version: '1.0.0', viaFallback: true });
    });

    test('falls through to window.open when the Browser plugin throws', async () => {
        g.Capacitor = {
            Plugins: {
                Browser: {
                    open: () => {
                        throw new Error('no activity');
                    },
                },
            },
        };
        g.open = jest.fn();

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', version: '1.0.0' });

        expect(g.open).toHaveBeenCalledWith('https://x/app.apk', '_blank');
        expect(res).toMatchObject({ success: true, viaFallback: true });
    });

    test('navigates location.href when window.open is unavailable', async () => {
        g.Capacitor = undefined;
        g.open = undefined;
        g.location = { href: 'app://index' };

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', version: '1.0.0' });

        expect(g.location!.href).toBe('https://x/app.apk');
        expect(res).toEqual({ success: true, version: '1.0.0', viaFallback: true });
    });

    test('reports failure when there is no way to open the URL', async () => {
        g.Capacitor = undefined;
        g.open = undefined;
        delete g.location;

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk' });

        expect(res).toEqual({ success: false, error: 'No mechanism to open the download URL' });
    });
});
