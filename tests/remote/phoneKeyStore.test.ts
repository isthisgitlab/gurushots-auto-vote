/**
 * The Android remote mode's stored pairing key: read, write and clear go through the native
 * bridge's `nativePromise` against the one Preferences key `gs_remote_access`, so the bundled
 * remote page (which registers no plugin) and the app's own document share it.
 */

import { clearStoredKey, readStoredKey, storeKey } from '../../src/ts/core/remote/phoneKeyStore';

import type { CapacitorGlobals } from '../../src/ts/core/types/capacitor';

const g = globalThis as CapacitorGlobals;
const KEY = 'a'.repeat(43);

describe('the phone key store', () => {
    let nativePromise: jest.Mock<Promise<unknown>, [string, string, object]>;

    beforeEach(() => {
        nativePromise = jest.fn<Promise<unknown>, [string, string, object]>();
        g.Capacitor = { isNativePlatform: () => true, nativePromise };
    });

    afterEach(() => {
        delete g.Capacitor;
    });

    test('reads a historical raw stored key as a v1 target from the Preferences key the wipe knows', async () => {
        nativePromise.mockResolvedValue({ value: KEY });
        await expect(readStoredKey()).resolves.toEqual({ kind: 'key', key: KEY, linkVersion: 1 });
        expect(nativePromise).toHaveBeenCalledWith('Preferences', 'get', { key: 'gs_remote_access' });
    });

    test('reads a versioned stored target and preserves its version', async () => {
        nativePromise.mockResolvedValue({ value: `2:${KEY}` });
        await expect(readStoredKey()).resolves.toEqual({ kind: 'key', key: KEY, linkVersion: 2 });
    });

    test('reads the highest supported stored link version without reclassifying it', async () => {
        nativePromise.mockResolvedValue({ value: `999:${KEY}` });
        await expect(readStoredKey()).resolves.toEqual({ kind: 'key', key: KEY, linkVersion: 999 });
    });

    test.each([{ value: null }, {}, null])('%j reads as no key stored', async (answer) => {
        nativePromise.mockResolvedValue(answer);
        await expect(readStoredKey()).resolves.toEqual({ kind: 'none' });
    });

    test.each([
        { value: 'not-a-key' },
        { value: 42 },
        { value: '' },
        { value: `0:${KEY}` },
        { value: `01:${KEY}` },
        { value: `1000:${KEY}` },
        { value: `2:not-a-key` },
    ])('%j reads as an invalid stored value', async (a) => {
        nativePromise.mockResolvedValue(a);
        await expect(readStoredKey()).resolves.toEqual({ kind: 'invalid' });
    });

    test('a refused read rejects: the caller decides what an unknown state means', async () => {
        nativePromise.mockRejectedValue(new Error('plugin refused'));
        await expect(readStoredKey()).rejects.toThrow('plugin refused');
    });

    test('stores and clears the key under the same Preferences key', async () => {
        nativePromise.mockResolvedValue(undefined);
        await storeKey(KEY, 2);
        await clearStoredKey();
        expect(nativePromise).toHaveBeenNthCalledWith(1, 'Preferences', 'set', {
            key: 'gs_remote_access',
            value: `2:${KEY}`,
        });
        expect(nativePromise).toHaveBeenNthCalledWith(2, 'Preferences', 'remove', { key: 'gs_remote_access' });
    });

    test('a document with no native bridge rejects every call', async () => {
        g.Capacitor = { isNativePlatform: () => true };
        await expect(readStoredKey()).rejects.toThrow('No native bridge');
        await expect(storeKey(KEY, 2)).rejects.toThrow('No native bridge');
        await expect(clearStoredKey()).rejects.toThrow('No native bridge');
        delete g.Capacitor;
        await expect(clearStoredKey()).rejects.toThrow('No native bridge');
    });
});
