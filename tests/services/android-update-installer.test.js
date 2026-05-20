/**
 * AndroidUpdateInstaller routes APK download+install to the native
 * ApkInstaller Capacitor plugin when present (in-app download + system
 * installer), and falls back to opening the URL in the browser otherwise.
 * The native Kotlin is verified on-device; here we cover the JS routing.
 */

jest.mock('../../src/js/runtime', () => ({ isCapacitor: jest.fn(() => true) }));

const runtime = require('../../src/js/runtime');
const { downloadAndInstall } = require('../../src/js/services/AndroidUpdateInstaller');

describe('AndroidUpdateInstaller', () => {
    let originalCapacitor;
    let originalOpen;

    beforeEach(() => {
        runtime.isCapacitor.mockReturnValue(true);
        originalCapacitor = globalThis.Capacitor;
        originalOpen = globalThis.open;
    });

    afterEach(() => {
        globalThis.Capacitor = originalCapacitor;
        globalThis.open = originalOpen;
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
});
