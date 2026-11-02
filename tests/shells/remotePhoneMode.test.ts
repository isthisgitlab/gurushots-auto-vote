/**
 * The bundled remote page's Disconnect (shells/remote/phoneMode.ts): installed only inside the
 * Android app's WebView; clears the stored key, then returns to the app's own document, and a key
 * that could not be cleared leaves the page where it is.
 */

import { invalid } from '../helpers/invalid';

import type { CapacitorGlobals } from '../../src/ts/core/types/capacitor';

const g = globalThis as CapacitorGlobals & { location: unknown };
const assign = jest.fn<void, [string]>();
const load = () =>
    require('../../src/ts/shells/remote/phoneMode') as typeof import('../../src/ts/shells/remote/phoneMode');
const mode = () => require('../../src/ts/core/remote/phoneMode') as typeof import('../../src/ts/core/remote/phoneMode');

describe('the remote page inside the Android app', () => {
    const savedLocation = g.location;
    let nativePromise: jest.Mock<Promise<unknown>, [string, string, object]>;

    beforeEach(() => {
        jest.resetModules();
        nativePromise = jest.fn<Promise<unknown>, [string, string, object]>(async () => undefined);
        g.Capacitor = { isNativePlatform: () => true, nativePromise };
        assign.mockReset();
        g.location = invalid({ assign });
    });

    afterEach(() => {
        delete g.Capacitor;
        g.location = savedLocation;
    });

    test('installs Disconnect, which clears the stored key and returns to the app document', async () => {
        load().installPhoneDisconnect();
        const disconnect = mode().phoneRemoteMode()?.disconnect;
        expect(disconnect).toBeDefined();
        await disconnect?.();
        expect(nativePromise).toHaveBeenCalledWith('Preferences', 'remove', { key: 'gs_remote_access' });
        expect(assign).toHaveBeenCalledWith('/index.html');
    });

    test('Disconnect also forgets the desktop version kept for the loader; a key that could not be cleared keeps it', async () => {
        const removeItem = jest.fn<void, [string]>();
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { removeItem } });
        try {
            nativePromise.mockRejectedValueOnce(new Error('prefs'));
            await expect(load().disconnectFromComputer()).rejects.toThrow('prefs');
            expect(removeItem).not.toHaveBeenCalled();
            await load().disconnectFromComputer();
            expect(removeItem).toHaveBeenCalledWith('gs-remote-desktop-version');
            expect(assign).toHaveBeenCalledWith('/index.html');
        } finally {
            delete (globalThis as { localStorage?: unknown }).localStorage;
        }
    });

    test('a key that cannot be cleared leaves the page in remote mode', async () => {
        nativePromise.mockRejectedValue(new Error('prefs'));
        await expect(load().disconnectFromComputer()).rejects.toThrow('prefs');
        expect(assign).not.toHaveBeenCalled();
    });

    test.each([
        ['a browser tab (no Capacitor)', undefined],
        ['a Capacitor web target', { isNativePlatform: () => false }],
        ['a runtime with no platform probe', {}],
    ])('installs nothing in %s', (_name, capacitor) => {
        if (capacitor === undefined) delete g.Capacitor;
        else g.Capacitor = capacitor;
        const phoneMode = load();
        expect(phoneMode.isAppWebView()).toBe(false);
        phoneMode.installPhoneDisconnect();
        expect(mode().phoneRemoteMode()).toBeNull();
    });
});
