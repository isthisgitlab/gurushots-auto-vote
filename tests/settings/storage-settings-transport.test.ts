/**
 * The settings transport's two guarantees on the Android side: a write the native store
 * refuses is a failed save (not a quiet one), and an unusable stored value is copied to a
 * `_corrupt` preference key and removed from its own, once, before defaults apply.
 * Desktop quarantine (rename) is covered against a real directory in settings-recovery.test.ts.
 */

jest.mock('../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/runtime')>('../../src/ts/runtime'),
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
        let stored: string | null = JSON.stringify({ theme: 'dark' });
        withBridge(() => false as unknown as void);
        g.AndroidHeadlessStore!.read = () => stored;
        let settings: typeof settingsModule | undefined;
        jest.isolateModules(() => {
            settings = require('../../src/ts/settings') as typeof settingsModule;
        });

        expect(settings!.saveSettings({ theme: 'light' })).toBe(false);
        expect(settings!.setSetting('theme', 'light')).toBe(false);
        expect(stored).toBe('{"theme":"dark"}');
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
        expect(loadStorage().storage.settingsLocation()).toBe('gurushots-settings');
    });
});

describe('an unusable settings value in the Android app (Preferences)', () => {
    beforeEach(() => {
        g.Capacitor = { isNativePlatform: () => true };
    });

    test('is copied to the _corrupt key, removed from its own, and the cache is emptied', async () => {
        mockPreferences.get.mockResolvedValue({ value: '{broken' });
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();
        expect(storage.readRaw()).toBe('{broken');

        expect(storage.quarantineRaw('{broken')).toEqual({ ok: true, path: 'gurushots-settings_corrupt' });
        await flushPendingWrites();

        expect(storage.readRaw()).toBeNull();
        expect(mockPreferences.set).toHaveBeenCalledWith({ key: 'gurushots-settings_corrupt', value: '{broken' });
        expect(mockPreferences.remove).toHaveBeenCalledWith({ key: 'gurushots-settings' });
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
                ['set', 'gurushots-settings_corrupt'],
                ['remove', 'gurushots-settings'],
                ['set', 'gurushots-settings'],
            ]),
        );
        const lastWrite = mockPreferences.set.mock.invocationCallOrder.at(-1)!;
        expect(lastWrite).toBeGreaterThan(mockPreferences.remove.mock.invocationCallOrder[0]);
        expect(storage.readRaw()).toBe('{"theme":"dark"}');
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
        mockPreferences.get.mockResolvedValue({ value: '{broken' });
        let settings: typeof settingsModule | undefined;
        jest.isolateModules(() => {
            settings = require('../../src/ts/settings') as typeof settingsModule;
        });
        await settings!.initializeAsync();

        expect(settings!.loadSettings()).toEqual(settings!.getDefaultSettings());
        expect(settings!.getSettingsRecovery()).toEqual({
            code: 'settings-corrupt',
            path: 'gurushots-settings_corrupt',
        });
        expect(settings!.setSetting('theme', 'dark')).toBe(true);
        expect(settings!.getSetting('theme')).toBe('dark');
        await settings!.flushPendingWrites();
        expect(mockPreferences.set).toHaveBeenCalledWith({
            key: 'gurushots-settings',
            value: expect.stringContaining('"dark"'),
        });
    });

    test('the location of the settings is the preference key', () => {
        expect(loadStorage().storage.settingsLocation()).toBe('gurushots-settings');
    });
});
