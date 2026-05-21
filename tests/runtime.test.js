/**
 * Tests for runtime headless-service detection. The Android background
 * service runs the JS in a bare WebView (no Capacitor runtime) and
 * injects a global flag so the storage + HTTP layers know to use the
 * native bridges instead of @capacitor/preferences / CapacitorHttp.
 */

const runtime = require('../src/js/runtime');

describe('runtime.isHeadlessService', () => {
    afterEach(() => {
        delete globalThis.__GS_HEADLESS__;
    });

    test('is false when the native flag is absent', () => {
        expect(runtime.isHeadlessService()).toBe(false);
    });

    test('is true when the native headless flag is injected', () => {
        globalThis.__GS_HEADLESS__ = true;
        expect(runtime.isHeadlessService()).toBe(true);
    });

    test('getPlatform reports "headless" when the flag is set', () => {
        globalThis.__GS_HEADLESS__ = true;
        expect(runtime.getPlatform()).toBe('headless');
    });
});
