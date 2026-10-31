/**
 * The webview family's storage member: the Preferences write-behind the app
 * WebView's stores persist through. The plugin is mocked at
 * settings/capacitorPreferences, and the write-behind of
 * settings/storeTransport.ts runs for real over it, so the members are proven
 * against the pieces they wrap.
 */

const mockValues = new Map<string, string>();
const mockPlugin = {
    get: jest.fn(async ({ key }: { key: string }) => ({ value: mockValues.get(key) ?? null })),
    set: jest.fn(async ({ key, value }: { key: string; value: string }) => {
        mockValues.set(key, value);
    }),
    remove: jest.fn(async ({ key }: { key: string }) => {
        mockValues.delete(key);
    }),
    keys: jest.fn(async () => ({ keys: [...mockValues.keys()] })),
};

jest.mock('../../../src/ts/settings/capacitorPreferences', () => ({
    __esModule: true,
    getCapacitorPreferences: () => mockPlugin,
    listPreferenceKeys: jest.fn(async () => [...mockValues.keys()]),
    removePreferenceKeys: jest.fn(async () => undefined),
}));

import { createWebviewStorage } from '../../../src/ts/platforms/webview/store';

import type { SettingsStoreRef } from '../../../src/ts/platform/port';
import type { CasAnswer } from '../../../src/ts/settings/storeTransport';
import type { QuarantineResult, WriteIfAbsentResult } from '../../../src/ts/settings/storageTypes';

// The family always answers the import write as saved-with-a-landed, and a quarantine on the app WebView as
// moved-to-the-backup-key; the extracts narrow the unions to the variants the tests await.
type SavedWrite = Extract<WriteIfAbsentResult, { outcome: 'saved' }>;
type MovedAside = Extract<QuarantineResult, { ok: true }>;

const store = (prefKey: string): SettingsStoreRef => ({ prefKey, filePath: () => `/data/${prefKey}.json` });
const cas = jest.fn<Promise<CasAnswer> | null, [string, string | null, string]>();

describe('the cache reads and writes', () => {
    test('readRaw answers the cache, null before anything is written', () => {
        const storage = createWebviewStorage(null);
        expect(storage.readRaw(store('gs_cache'))).toBeNull();
        storage.writeRaw(store('gs_cache'), 'DATA', false);
        expect(storage.readRaw(store('gs_cache'))).toBe('DATA');
    });

    test('writeRaw queues the write, and flushed waits for it to land in Preferences', async () => {
        const storage = createWebviewStorage(null);
        storage.writeRaw(store('gs_queue'), 'DATA', false);
        // A second write of the key goes through the write-behind the first one built.
        storage.writeRaw(store('gs_queue'), 'MORE', false);
        await storage.flushed();
        expect(mockValues.get('gs_queue')).toBe('MORE');
    });
});

describe('writeIfAbsent', () => {
    test('an import with nothing stored is saved, and landed says the write persisted', async () => {
        const storage = createWebviewStorage(null);
        const answer = storage.writeIfAbsent(store('gs_import'), 'IMPORT') as SavedWrite;
        await expect(answer.landed).resolves.toBe('written');
        expect(mockValues.get('gs_import')).toBe('IMPORT');
    });

    test('a key the other context saved meanwhile declines the import, and the cache keeps nothing of it', async () => {
        cas.mockResolvedValue({ saved: false, current: 'THERE' });
        const storage = createWebviewStorage(cas);
        const answer = storage.writeIfAbsent(store('gs_import_cas_decline'), 'IMPORT') as SavedWrite;
        await expect(answer.landed).resolves.toBe('declined');
        expect(storage.readRaw(store('gs_import_cas_decline'))).toBeNull();
    });

    test('a write that did not persist is landed as failed', async () => {
        const storage = createWebviewStorage(null);
        mockPlugin.set.mockRejectedValueOnce(new Error('no write'));
        const answer = storage.writeIfAbsent(store('gs_import_fail'), 'IMPORT') as SavedWrite;
        await expect(answer.landed).resolves.toBe('failed');
    });

    test('with a compare-and-write the save goes through it instead of the plugin', async () => {
        cas.mockResolvedValue({ saved: true, current: null });
        const storage = createWebviewStorage(cas);
        const answer = storage.writeIfAbsent(store('gs_cas'), 'IMPORT') as SavedWrite;
        await expect(answer.landed).resolves.toBe('written');
        expect(cas).toHaveBeenCalledWith('gs_cas', null, 'IMPORT');
        expect(mockPlugin.set).not.toHaveBeenCalledWith({ key: 'gs_cas', value: 'IMPORT' });
    });
});

describe('quarantineRaw', () => {
    test('it copies the value under the backup key, removes it from its own, and gives up the queued writes', async () => {
        const storage = createWebviewStorage(null);
        mockValues.set('gs_quar', 'UNUSABLE');
        const moved = storage.quarantineRaw(store('gs_quar'), 'UNUSABLE') as MovedAside;
        expect(moved.path).toMatch(/^gs_quar_corrupt-\d{4}-\d{2}-\d{2}T/);
        await expect(moved.moved).resolves.toBe(true);
        expect(mockValues.has('gs_quar')).toBe(false);
    });

    test('a copy that did not land is moved as false', async () => {
        const storage = createWebviewStorage(null);
        mockPlugin.set.mockRejectedValueOnce(new Error('no backup write'));
        const moved = storage.quarantineRaw(store('gs_quar_fail'), 'UNUSABLE') as MovedAside;
        await expect(moved.moved).resolves.toBe(false);
    });
});

describe('the plugin reads and the write-behind facts', () => {
    test('storedKey reads the key through the plugin, the cache left as it is', async () => {
        const storage = createWebviewStorage(null);
        mockValues.set('gs_stored', 'STORED');
        await expect(storage.storedKey?.('gs_stored')).resolves.toBe('STORED');
        await expect(storage.storedKey?.('gs_absent')).resolves.toBeNull();
        expect(storage.readRaw(store('gs_stored'))).toBeNull();
    });

    test('preferences is the plugin the stores persist through', () => {
        expect(createWebviewStorage(null).preferences?.()).toBe(mockPlugin);
    });

    test('loaded says whether what is stored is known: written keys are, untouched ones are not', () => {
        const storage = createWebviewStorage(null);
        expect(storage.loaded('gs_known')).toBe(false);
        storage.writeRaw(store('gs_known'), 'DATA', false);
        expect(storage.loaded('gs_known')).toBe(true);
    });

    test('location names the key where there is no file', () => {
        expect(createWebviewStorage(null).location(store('gs_loc'))).toBe('gs_loc');
    });
});

describe('the members the app WebView has none of', () => {
    test('no native bridge, no one-step change, no failed reads', () => {
        const storage = createWebviewStorage(null);
        expect(storage.headlessStore()).toBeUndefined();
        expect(storage.cas).toBeNull();
        expect(storage.sharedUpdate).toBeNull();
        expect(storage.readFailed('gs_any')).toBe(false);
    });

    test('hasQuarantined answers the pre-hydration value, and the compare-and-write decides, not a lock', () => {
        const storage = createWebviewStorage(null);
        expect(storage.hasQuarantined(store('gs_any'))).toBe(false);
        expect(storage.lockPolicy).toBe('none');
    });
});

describe('the parts the shell passes in', () => {
    test('the compare-and-write the shell module passes is the storage member’s', () => {
        expect(createWebviewStorage(cas).cas).toBe(cas);
    });
});
