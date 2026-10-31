/**
 * The headless family's storage member: the AndroidHeadlessStore bridge the
 * background service's stores persist through. The bridge is the in-memory
 * store of tests/helpers/headlessStore.ts, set and cleared on globalThis the
 * way the service's WebView has it, and the wrapped keyed calls of
 * settings/storeTransport.ts run for real over it.
 */

import { installHeadlessStore, removeHeadlessStore } from '../../helpers/headlessStore';
import { createHeadlessStorage } from '../../../src/ts/platforms/headless/store';

import type { AndroidHeadlessStore } from '../../../src/ts/types/settings';
import type { SettingsStoreRef } from '../../../src/ts/platform/port';

const store = (prefKey: string): SettingsStoreRef => ({ prefKey, filePath: () => `/data/${prefKey}.json` });
const storage = createHeadlessStorage();

let bridge: ReturnType<typeof installHeadlessStore>;

beforeEach(() => {
    bridge = installHeadlessStore();
});

afterEach(() => {
    removeHeadlessStore();
});

describe('the bridge', () => {
    test('headlessStore reads the globalThis bridge at call time', () => {
        expect(storage.headlessStore()).toBe(bridge);
    });
});

describe('the cache reads and writes', () => {
    test('readRaw reads the key through the bridge', () => {
        bridge.keys.set('gs_head_a', 'STORED');
        expect(storage.readRaw(store('gs_head_a'))).toBe('STORED');
    });

    test('an absent key answers the cache, and a write leaves the cache behind', () => {
        const bareBridge: AndroidHeadlessStore = { read: () => null, write: () => true };
        (globalThis as typeof globalThis & { AndroidHeadlessStore?: AndroidHeadlessStore }).AndroidHeadlessStore =
            bareBridge;
        expect(storage.readRaw(store('gs_head_b'))).toBeNull();
        storage.writeRaw(store('gs_head_b'), 'DATA', false);
        expect(storage.readRaw(store('gs_head_b'))).toBe('DATA');
    });

    test('writeRaw writes the key through the bridge', () => {
        storage.writeRaw(store('gs_head_c'), 'DATA', false);
        expect(bridge.keys.get('gs_head_c')).toBe('DATA');
    });
});

describe('writeIfAbsent', () => {
    test('an import with nothing stored is saved through the keyed compare-and-write', () => {
        const answer = storage.writeIfAbsent(store('gs_head_imp'), 'IMPORT');
        expect(answer).toEqual({ outcome: 'saved' });
        expect(bridge.keys.get('gs_head_imp')).toBe('IMPORT');
        expect(storage.readRaw(store('gs_head_imp'))).toBe('IMPORT');
    });

    test('a store that is not empty answers exists with the stored text', () => {
        bridge.keys.set('gs_head_imp', 'THERE');
        expect(storage.writeIfAbsent(store('gs_head_imp'), 'IMPORT')).toEqual({ outcome: 'exists', current: 'THERE' });
    });

    test('without a bridge the import fails', () => {
        removeHeadlessStore();
        expect(storage.writeIfAbsent(store('gs_head_imp'), 'IMPORT')).toEqual({ outcome: 'failed' });
    });
});

describe('a read that failed', () => {
    test('readFailed remembers it, and loaded says the store does not hold what is stored', () => {
        bridge.readKey = () => {
            throw new Error('bridge read failed');
        };
        expect(storage.readRaw(store('gs_head_fail'))).toBeNull();
        expect(storage.readFailed('gs_head_fail')).toBe(true);
        expect(storage.loaded('gs_head_fail')).toBe(false);
    });

    test('a read that did not fail leaves the store loaded', () => {
        expect(storage.loaded('gs_head_ok')).toBe(true);
    });
});

describe('a shared key', () => {
    test('sharedUpdate is the keyed compare-and-write', () => {
        expect(storage.sharedUpdate?.('gs_head_shared', () => 'SHARED')).toBe('saved');
        expect(bridge.keys.get('gs_head_shared')).toBe('SHARED');
    });
});

describe('the members the service has none of', () => {
    test('no plugin, no compare-and-write slot, no re-read, and the quarantine is refused', () => {
        expect(storage.preferences).toBeNull();
        expect(storage.storedKey).toBeNull();
        expect(storage.cas).toBeNull();
        expect(storage.quarantineRaw(store('gs_head_q'), 'UNUSABLE')).toEqual({
            ok: false,
            error: 'the background service cannot set an unusable settings value aside',
        });
    });

    test('the key is where the store lives, nothing is queued, no backup is known, and no lock decides', () => {
        expect(storage.location(store('gs_head_loc'))).toBe('gs_head_loc');
        expect(storage.hasQuarantined(store('gs_head_loc'))).toBe(false);
        expect(storage.lockPolicy).toBe('none');
    });

    test('flushed resolves at once', async () => {
        await expect(storage.flushed()).resolves.toBeUndefined();
    });
});
