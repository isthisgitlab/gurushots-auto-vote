/**
 * AndroidUpdateInstaller routes APK download+install to the native
 * ApkInstaller Capacitor plugin when present (in-app download + system
 * installer), and falls back to opening the URL in the browser otherwise.
 * The native Kotlin is verified on-device; here we cover the JS routing.
 */

jest.mock('../../src/js/runtime', () => ({ isCapacitor: jest.fn(() => true) }));

const runtime = require('../../src/js/runtime');
const logger = require('../../src/js/logger');
const { downloadAndInstall } = require('../../src/js/services/AndroidUpdateInstaller');

describe('AndroidUpdateInstaller', () => {
    let originalCapacitor;
    let originalOpen;
    let originalLocation;

    beforeEach(() => {
        runtime.isCapacitor.mockReturnValue(true);
        originalCapacitor = globalThis.Capacitor;
        originalOpen = globalThis.open;
        originalLocation = globalThis.location;
    });

    afterEach(() => {
        globalThis.Capacitor = originalCapacitor;
        globalThis.open = originalOpen;
        globalThis.location = originalLocation;
    });

    test('uses the native ApkInstaller plugin when available and forwards progress', async () => {
        const dl = jest.fn().mockResolvedValue({ success: true });
        const remove = jest.fn();
        const addListener = jest.fn().mockResolvedValue({ remove });
        globalThis.Capacitor = { Plugins: { ApkInstaller: { downloadAndInstall: dl, addListener } } };
        const onProgress = jest.fn();

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', version: '1.2.3', onProgress });

        expect(dl).toHaveBeenCalledWith({ url: 'https://x/app.apk', version: '1.2.3' });
        expect(addListener).toHaveBeenCalledWith('downloadProgress', expect.any(Function));
        expect(res.success).toBe(true);
        expect(remove).toHaveBeenCalled();
    });

    test('falls back to the browser when the native plugin is absent', async () => {
        globalThis.Capacitor = { Plugins: {} };
        globalThis.open = jest.fn();

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', version: '1.2.3' });

        expect(globalThis.open).toHaveBeenCalledWith('https://x/app.apk', '_blank');
        expect(res.success).toBe(true);
    });

    test('returns an error when no download URL is provided', async () => {
        const res = await downloadAndInstall({});
        expect(res.success).toBe(false);
    });

    test('is a no-op outside Capacitor', async () => {
        runtime.isCapacitor.mockReturnValue(false);
        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk' });
        expect(res.success).toBe(false);
    });

    test('forwards native progress events to onProgress and tolerates a handle without remove()', async () => {
        let listener;
        const addListener = jest.fn(async (_event, cb) => {
            listener = cb;
            return {};
        });
        const dl = jest.fn(async () => {
            listener({ percent: 42 });
            return { success: false, error: 'user cancelled' };
        });
        globalThis.Capacitor = { Plugins: { ApkInstaller: { downloadAndInstall: dl, addListener } } };
        const onProgress = jest.fn();

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', onProgress });

        expect(onProgress).toHaveBeenCalledWith({ percent: 42 });
        // No version given -> native plugin receives an empty string.
        expect(dl).toHaveBeenCalledWith({ url: 'https://x/app.apk', version: '' });
        expect(res).toEqual({ success: false, version: undefined, error: 'user cancelled' });
    });

    test('skips the listener when no onProgress is given and treats a missing result as success', async () => {
        const addListener = jest.fn();
        const dl = jest.fn().mockResolvedValue(undefined);
        globalThis.Capacitor = { Plugins: { ApkInstaller: { downloadAndInstall: dl, addListener } } };

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', version: '2.0.0' });

        expect(addListener).not.toHaveBeenCalled();
        expect(res).toEqual({ success: true, version: '2.0.0' });
    });

    test('falls back to the browser when the native install throws, even if listener cleanup throws', async () => {
        const error = jest.fn();
        logger.withCategory.mockReturnValueOnce({ error });
        const remove = jest.fn(() => {
            throw new Error('already removed');
        });
        const addListener = jest.fn().mockResolvedValue({ remove });
        const dl = jest.fn().mockRejectedValue(new Error('disk full'));
        const browserOpen = jest.fn();
        globalThis.Capacitor = {
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
        globalThis.Capacitor = {
            Plugins: {
                Browser: {
                    open: () => {
                        throw new Error('no activity');
                    },
                },
            },
        };
        globalThis.open = jest.fn();

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', version: '1.0.0' });

        expect(globalThis.open).toHaveBeenCalledWith('https://x/app.apk', '_blank');
        expect(res.viaFallback).toBe(true);
    });

    test('navigates location.href when window.open is unavailable', async () => {
        globalThis.Capacitor = undefined;
        globalThis.open = undefined;
        globalThis.location = { href: 'app://index' };

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk', version: '1.0.0' });

        expect(globalThis.location.href).toBe('https://x/app.apk');
        expect(res).toEqual({ success: true, version: '1.0.0', viaFallback: true });
    });

    test('reports failure when there is no way to open the URL', async () => {
        globalThis.Capacitor = undefined;
        globalThis.open = undefined;
        delete globalThis.location;

        const res = await downloadAndInstall({ downloadUrl: 'https://x/app.apk' });

        expect(res).toEqual({ success: false, error: 'No mechanism to open the download URL' });
    });
});
