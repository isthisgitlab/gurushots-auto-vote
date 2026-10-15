/**
 * The settings transport's two guarantees on the Android side: a write the native store
 * refuses is a failed save (not a quiet one), and an unusable stored value is copied to a
 * `_corrupt` preference key and removed from its own, once, before defaults apply.
 * Desktop quarantine (rename) is covered against a real directory in settings-recovery.test.ts.
 */

// No test here may touch the real user-data folder: the path is a made-up one that does not exist.
jest.mock('../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/runtime')>('../../src/ts/runtime'),
    getAppUserDataPath: () => '/nonexistent/gurushots-auto-vote-test-user-data',
}));
jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        withCategory: jest.fn(() => cat),
        __cat: cat,
    };
});
const mockPreferences = {
    set: jest.fn<Promise<void>, [{ key: string; value: string }]>(() => Promise.resolve()),
    get: jest.fn<Promise<{ value: string | null }>, [{ key: string }]>(() => Promise.resolve({ value: null })),
    remove: jest.fn<Promise<void>, [{ key: string }]>(() => Promise.resolve()),
    keys: jest.fn<Promise<{ keys: string[] }>, []>(() => Promise.resolve({ keys: [] })),
};
jest.mock('@capacitor/preferences', () => ({ Preferences: mockPreferences }), { virtual: true });

import type * as storageModule from '../../src/ts/settings/storage';
import type * as settingsModule from '../../src/ts/settings';
import type { AndroidHeadlessStore } from '../../src/ts/types/settings';
import loggerModule = require('../../src/ts/logger');
import { invalid } from '../helpers/invalid';

const g = globalThis as typeof globalThis & {
    Capacitor?: { isNativePlatform: () => boolean };
    __GS_HEADLESS__?: boolean;
    AndroidHeadlessStore?: AndroidHeadlessStore;
};
// The Preferences key an unusable value is kept under: the key, the suffix and the time it was set aside.
const SET_ASIDE_KEY = /^gurushots-config_corrupt-\d{4}-\d{2}-\d{2}T/;
const cat = invalid<{ __cat: { error: jest.Mock<void, [string, ...unknown[]]> } }>(loggerModule).__cat;

const loadStorage = () => {
    let mod: typeof storageModule | undefined;
    jest.isolateModules(() => {
        mod = require('../../src/ts/settings/storage') as typeof storageModule;
    });
    return mod!;
};

afterEach(() => {
    delete g.Capacitor;
    delete g.__GS_HEADLESS__;
    delete g.AndroidHeadlessStore;
    jest.clearAllMocks();
    mockPreferences.keys.mockResolvedValue({ keys: [] });
});

describe('a settings write in the Android background service', () => {
    const withBridge = (write: AndroidHeadlessStore['write']) => {
        g.__GS_HEADLESS__ = true;
        g.AndroidHeadlessStore = { read: () => null, write };
    };

    test.each([[true], [undefined]])('a bridge that answers %p has written it', (answer) => {
        withBridge(jest.fn(() => answer as unknown as void));
        const { storage } = loadStorage();

        expect(storage.writeRaw('{"a":1}')).toBe(true);
        expect(cat.error).not.toHaveBeenCalled();
    });

    test('a bridge that refuses (false) is a failed write, said in the log', () => {
        withBridge(jest.fn(() => false as unknown as void));
        const { storage } = loadStorage();

        expect(storage.writeRaw('{"a":1}')).toBe(false);
        expect(cat.error).toHaveBeenCalledWith('Headless store refused the settings write', null);
    });

    test.each([
        ['too-large', ' (too-large)'],
        ['conflict', ' (conflict)'],
        ['refused', ' (refused)'],
        ['', ''],
    ] as const)('a refusal the bridge explains (%j) says why in the log', (refusal, suffix) => {
        g.__GS_HEADLESS__ = true;
        g.AndroidHeadlessStore = {
            read: () => null,
            write: jest.fn(() => false as unknown as void),
            lastWriteRefusal: () => refusal,
        };
        const { storage } = loadStorage();

        expect(storage.writeRaw('{"a":1}')).toBe(false);
        expect(cat.error).toHaveBeenCalledWith(`Headless store refused the settings write${suffix}`, null);
    });

    test('a bridge that throws is a failed write, said in the log', () => {
        withBridge(() => {
            throw new Error('commit failed');
        });
        const { storage } = loadStorage();

        expect(storage.writeRaw('{"a":1}')).toBe(false);
        expect(cat.error).toHaveBeenCalledWith('Headless store write failed:', expect.any(Error));
    });

    test('with no bridge there is nothing to refuse the write', () => {
        g.__GS_HEADLESS__ = true;
        const { storage } = loadStorage();

        expect(storage.writeRaw('{}')).toBe(true);
    });

    test('a refused write fails the save through the facade, and the stored text is kept', () => {
        let stored: string | null = JSON.stringify({ app: { theme: 'dark' } });
        withBridge(() => false as unknown as void);
        g.AndroidHeadlessStore!.read = () => stored;
        let settings: typeof settingsModule | undefined;
        jest.isolateModules(() => {
            settings = require('../../src/ts/settings') as typeof settingsModule;
        });

        expect(settings!.saveAppSettings({ theme: 'light' })).toBe(false);
        expect(settings!.setSetting('theme', 'light')).toBe(false);
        expect(stored).toBe('{"app":{"theme":"dark"}}');
        stored = null;
    });

    test('cannot set an unusable value aside, so it reports a failure', () => {
        g.__GS_HEADLESS__ = true;
        const { storage } = loadStorage();

        expect(storage.quarantineRaw('{broken')).toEqual({
            ok: false,
            error: 'the background service cannot set an unusable settings value aside',
        });
    });

    test('the location of the settings is the preference key', () => {
        g.__GS_HEADLESS__ = true;
        expect(loadStorage().storage.location()).toBe('gurushots-config');
    });
});

describe('an unusable settings value in the Android app (Preferences)', () => {
    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });

    test('is copied to the _corrupt key, removed from its own, and the cache is emptied', async () => {
        mockPreferences.get.mockImplementation(({ key }) =>
            Promise.resolve({ value: key === 'gurushots-config' ? '{broken' : null }),
        );
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();
        expect(storage.readRaw()).toBe('{broken');

        expect(storage.quarantineRaw('{broken')).toEqual({ ok: true, path: expect.stringMatching(SET_ASIDE_KEY) });
        await flushPendingWrites();

        expect(storage.readRaw()).toBeNull();
        expect(mockPreferences.set).toHaveBeenCalledWith({
            key: expect.stringMatching(SET_ASIDE_KEY),
            value: '{broken',
        });
        expect(mockPreferences.remove).toHaveBeenCalledWith({ key: 'gurushots-config' });
        expect(mockPreferences.set.mock.invocationCallOrder[0]).toBeLessThan(
            mockPreferences.remove.mock.invocationCallOrder[0],
        );
    });

    test('a save made right after is ordered after the backup, so the new value is what stays', async () => {
        const { storage, flushPendingWrites } = loadStorage();

        storage.quarantineRaw('{broken');
        expect(storage.writeRaw('{"theme":"dark"}')).toBe(true);
        await flushPendingWrites();

        const calls = [
            ...mockPreferences.set.mock.calls.map(([call]) => ['set', call.key] as const),
            ...mockPreferences.remove.mock.calls.map(([call]) => ['remove', call.key] as const),
        ];
        expect(calls).toEqual(
            expect.arrayContaining([
                ['set', expect.stringMatching(SET_ASIDE_KEY)],
                ['remove', 'gurushots-config'],
                ['set', 'gurushots-config'],
            ]),
        );
        const lastWrite = mockPreferences.set.mock.invocationCallOrder.at(-1)!;
        expect(lastWrite).toBeGreaterThan(mockPreferences.remove.mock.invocationCallOrder[0]);
        expect(storage.readRaw()).toBe('{"theme":"dark"}');
    });

    test('every value set aside gets a key of its own, so a later one never replaces an earlier', async () => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
        try {
            const { storage, flushPendingWrites } = loadStorage();

            const first = storage.quarantineRaw('{"first":1}');
            jest.advanceTimersByTime(1000);
            const second = storage.quarantineRaw('{"second":2}');
            await flushPendingWrites();

            expect(first.ok && second.ok && first.path !== second.path).toBe(true);
            expect(mockPreferences.set).toHaveBeenCalledWith({
                key: first.ok ? first.path : '',
                value: '{"first":1}',
            });
            expect(mockPreferences.set).toHaveBeenCalledWith({
                key: second.ok ? second.path : '',
                value: '{"second":2}',
            });
        } finally {
            jest.useRealTimers();
        }
    });

    test('a value set aside in an earlier run is found when the window hydrates', async () => {
        mockPreferences.keys.mockResolvedValue({ keys: ['gurushots-config_corrupt-2026-01-01T00-00-00-000Z'] });
        const { storage, legacyStorage, initializeAsync } = loadStorage();

        await initializeAsync();

        expect(storage.hasQuarantined()).toBe(true);
        expect(legacyStorage.hasQuarantined()).toBe(false);
    });

    test('a failed backup write is logged, never thrown', async () => {
        mockPreferences.set.mockRejectedValueOnce(new Error('disk full'));
        const { storage, flushPendingWrites } = loadStorage();

        expect(storage.quarantineRaw('{broken').ok).toBe(true);
        await flushPendingWrites();

        expect(cat.error).toHaveBeenCalledWith('Capacitor preferences backup write failed:', expect.any(Error));
        expect(mockPreferences.remove).not.toHaveBeenCalled();
    });

    test('through the facade: defaults apply, the notice is kept, and saving works', async () => {
        mockPreferences.get.mockImplementation(({ key }) =>
            Promise.resolve({ value: key === 'gurushots-config' ? '{broken' : null }),
        );
        let settings: typeof settingsModule | undefined;
        jest.isolateModules(() => {
            settings = require('../../src/ts/settings') as typeof settingsModule;
        });
        await settings!.initializeAsync();

        expect(settings!.loadSettings()).toEqual(settings!.getDefaultSettings());
        expect(settings!.getSettingsRecovery()).toEqual({
            code: 'settings-corrupt',
            path: expect.stringMatching(SET_ASIDE_KEY),
            blocking: false,
        });
        expect(settings!.setSetting('theme', 'dark')).toBe(true);
        expect(settings!.getSetting('theme')).toBe('dark');
        await settings!.flushPendingWrites();
        expect(mockPreferences.set).toHaveBeenCalledWith({
            key: 'gurushots-config',
            value: expect.stringContaining('"dark"'),
        });
    });

    test('the location of the settings is the preference key', () => {
        expect(loadStorage().storage.location()).toBe('gurushots-config');
    });
});
