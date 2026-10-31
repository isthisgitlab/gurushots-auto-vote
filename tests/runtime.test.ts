/**
 * Tests for runtime headless-service detection. The Android background
 * service runs the JS in a bare WebView (no Capacitor runtime) and
 * injects a global flag so the storage + HTTP layers know to use the
 * native bridges instead of @capacitor/preferences / CapacitorHttp.
 *
 * The app-identity/user-data bodies this file pinned when runtime.ts owned
 * them are the node family's paths member now (tests/platforms/node/paths.test.ts,
 * same assertions); runtime keeps the detection helpers and the env readers.
 */

import runtime = require('../src/ts/runtime');

const g = globalThis as typeof globalThis & { __GS_HEADLESS__?: boolean };

describe('runtime.isHeadlessService', () => {
    afterEach(() => {
        delete g.__GS_HEADLESS__;
    });

    test('is false when the native flag is absent', () => {
        expect(runtime.isHeadlessService()).toBe(false);
    });

    test('is true when the native headless flag is injected', () => {
        g.__GS_HEADLESS__ = true;
        expect(runtime.isHeadlessService()).toBe(true);
    });

    test('getPlatform reports "headless" when the flag is set', () => {
        g.__GS_HEADLESS__ = true;
        expect(runtime.getPlatform()).toBe('headless');
    });
});
