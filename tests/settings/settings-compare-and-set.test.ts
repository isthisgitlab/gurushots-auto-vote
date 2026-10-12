/**
 * The Android settings blob has two writers, the app window (Preferences, through the AutoVoteBackground plugin) and the
 * background service (its native bridge). Each saves its change only if the blob still holds what it last read, and
 * makes it again on what the other saved meanwhile, so a toggle made on one side is not lost to the other.
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
import type { CasAnswer } from '../../src/ts/settings/storeTransport';
import loggerModule = require('../../src/ts/logger');
import { invalid } from '../helpers/invalid';

type CompareAndWrite = (call: { key: string; expected: string | null; value: string }) => Promise<CasAnswer>;

const g = globalThis as typeof globalThis & {
    Capacitor?: { isNativePlatform: () => boolean; Plugins?: Record<string, unknown> };
    __GS_HEADLESS__?: boolean;
    AndroidHeadlessStore?: AndroidHeadlessStore;
};
const cat = invalid<{ __cat: { error: jest.Mock<void, [string, ...unknown[]]> } }>(loggerModule).__cat;
const KEY = 'gurushots-settings';

const loadStorage = () => {
    let mod: typeof storageModule | undefined;
    jest.isolateModules(() => {
        mod = require('../../src/ts/settings/storage') as typeof storageModule;
    });
    return mod!;
};

const json = (value: unknown) => JSON.stringify(value, null, 2);
const parse = (text: string | null): unknown => JSON.parse(text ?? 'null');

/** What the native side keeps: the settings text, saved by the compare-and-set both writers go through. */
const nativeStore = (initial: string | null) => {
    const native = {
        value: initial,
        /** The native compare-and-set: saved only while the text is what the caller read. */
        compareAndSet: (expected: string | null, data: string): CasAnswer => {
            if ((native.value ?? '') !== (expected ?? '')) return { saved: false, current: native.value };
            native.value = data;
            return { saved: true, current: null };
        },
    };
    return native;
};

afterEach(() => {
    delete g.Capacitor;
    delete g.__GS_HEADLESS__;
    delete g.AndroidHeadlessStore;
    jest.clearAllMocks();
    mockPreferences.set.mockImplementation(() => Promise.resolve());
    mockPreferences.get.mockImplementation(() => Promise.resolve({ value: null }));
});

describe('the app window saving the settings', () => {
    const withPlugin = (compareAndWrite: jest.MockedFunction<CompareAndWrite>) => {
        g.Capacitor = { isNativePlatform: () => true, Plugins: { AutoVoteBackground: { compareAndWrite } } };
    };
    const nativeWindow = (initial: string | null) => {
        const native = nativeStore(initial);
        const compareAndWrite = jest.fn<ReturnType<CompareAndWrite>, Parameters<CompareAndWrite>>(
            async ({ expected, value }) => native.compareAndSet(expected, value),
        );
        withPlugin(compareAndWrite);
        mockPreferences.get.mockImplementation(() => Promise.resolve({ value: native.value }));
        return { native, compareAndWrite };
    };

    test('saves through the native compare-and-write, expecting what it hydrated', async () => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();

        expect(storage.writeRaw('{"a":2}')).toBe(true);
        await flushPendingWrites();

        expect(compareAndWrite).toHaveBeenCalledTimes(1);
        expect(compareAndWrite).toHaveBeenCalledWith({ key: KEY, expected: '{"a":1}', value: '{"a":2}' });
        expect(native.value).toBe('{"a":2}');
        expect(storage.readRaw()).toBe('{"a":2}');
        expect(mockPreferences.set).not.toHaveBeenCalled();
    });

    test('a blob the service changed meanwhile is read from the answer, and the change made again on it', async () => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();
        native.value = '{"a":1,"service":2}';

        storage.writeRaw('{"a":1,"window":3}');
        await flushPendingWrites();

        expect(compareAndWrite).toHaveBeenCalledTimes(2);
        expect(parse(native.value)).toEqual({ a: 1, service: 2, window: 3 });
        // The cache shows what is stored now, the service's change included.
        expect(storage.readRaw()).toBe(native.value);
        expect(cat.error).not.toHaveBeenCalled();
    });

    test('a save conflicting more than once still succeeds while it is within the retry bound', async () => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();
        native.value = '{"a":1,"s1":1}';
        compareAndWrite.mockImplementationOnce(async () => {
            native.value = '{"a":1,"s1":1,"s2":2}';
            return { saved: false, current: '{"a":1,"s1":1}' };
        });

        storage.writeRaw('{"a":1,"w":1}');
        await flushPendingWrites();

        expect(compareAndWrite).toHaveBeenCalledTimes(3);
        expect(parse(native.value)).toEqual({ a: 1, s1: 1, s2: 2, w: 1 });
        expect(cat.error).not.toHaveBeenCalled();
    });

    test('writes queued together each carry their own change onto what the service saved, in order', async () => {
        const { native } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();
        native.value = '{"a":1,"service":9}';

        storage.writeRaw('{"a":1,"x":1}');
        storage.writeRaw('{"a":1,"x":1,"y":2}');
        // Reads in between see the window's own latest text, as before.
        expect(storage.readRaw()).toBe('{"a":1,"x":1,"y":2}');
        await flushPendingWrites();

        expect(parse(native.value)).toEqual({ a: 1, service: 9, x: 1, y: 2 });
        expect(storage.readRaw()).toBe(native.value);
    });

    test('a key that kept changing exhausts the retries: the save is logged as failed, and the cache shows what is stored', async () => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();
        let n = 0;
        compareAndWrite.mockImplementation(async () => {
            native.value = `{"a":1,"n":${++n}}`;
            return { saved: false, current: native.value };
        });

        expect(storage.writeRaw('{"a":1,"w":1}')).toBe(true);
        expect(storage.readRaw()).toBe('{"a":1,"w":1}');
        await flushPendingWrites();

        expect(compareAndWrite).toHaveBeenCalledTimes(5);
        expect(cat.error).toHaveBeenCalledWith('Capacitor preferences write failed:', expect.any(Error));
        expect(parse(native.value)).toEqual({ a: 1, n: 5 });
        // Not what was asked for: nothing claims a save that did not happen.
        expect(storage.readRaw()).toBe('{"a":1}');
    });

    test('a stored blob that is unreadable is not overwritten', async () => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();
        native.value = '{broken';

        storage.writeRaw('{"a":1,"w":1}');
        await flushPendingWrites();

        expect(compareAndWrite).toHaveBeenCalledTimes(1);
        expect(native.value).toBe('{broken');
        expect(cat.error).toHaveBeenCalledWith('Capacitor preferences write failed:', expect.any(Error));
        expect(storage.readRaw()).toBe('{"a":1}');
    });

    test('a write the plugin rejects is logged and does not stop the next; the next carries only its own change', async () => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();
        compareAndWrite.mockRejectedValueOnce(new Error('not saved'));

        storage.writeRaw('{"a":1,"lost":1}');
        storage.writeRaw('{"a":1,"lost":1,"kept":2}');
        await flushPendingWrites();

        expect(cat.error).toHaveBeenCalledWith('Capacitor preferences write failed:', expect.any(Error));
        expect(parse(native.value)).toEqual({ a: 1, kept: 2 });
        expect(storage.readRaw()).toBe(native.value);
    });

    test('without the native plugin the text is put down in Preferences, against what was hydrated', async () => {
        g.Capacitor = { isNativePlatform: () => true };
        mockPreferences.get.mockResolvedValue({ value: '{"a":1}' });
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();

        storage.writeRaw('{"a":2}');
        await flushPendingWrites();

        expect(mockPreferences.set).toHaveBeenCalledWith({ key: KEY, value: '{"a":2}' });
        expect(storage.readRaw()).toBe('{"a":2}');
    });

    test('a hydration that failed leaves nothing known, so the first save expects nothing and is made on what is stored', async () => {
        const { native, compareAndWrite } = nativeWindow('{"stored":1}');
        mockPreferences.get.mockRejectedValueOnce(new Error('unavailable'));
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();

        storage.writeRaw('{"w":1}');
        await flushPendingWrites();

        expect(compareAndWrite).toHaveBeenNthCalledWith(1, { key: KEY, expected: null, value: '{"w":1}' });
        expect(parse(native.value)).toEqual({ stored: 1, w: 1 });
    });

    test('a failed write that discarding gave up on leaves the (emptied) cache alone', async () => {
        const { compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, discardPendingWrites } = loadStorage();
        await initializeAsync();
        let fail: (error: Error) => void = () => {};
        compareAndWrite.mockImplementationOnce(() => new Promise<CasAnswer>((_resolve, reject) => (fail = reject)));

        storage.writeRaw('{"a":2}');
        await Promise.resolve();
        const discarding = discardPendingWrites();
        fail(new Error('late'));
        await discarding;

        expect(storage.readRaw()).toBeNull();
    });

    test('a failed write that the stored value being set aside outran does not bring the old value back', async () => {
        const { native, compareAndWrite } = nativeWindow('{broken');
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();
        let fail: (error: Error) => void = () => {};
        compareAndWrite.mockImplementationOnce(() => new Promise<CasAnswer>((_resolve, reject) => (fail = reject)));

        storage.writeRaw('{"a":2}');
        await Promise.resolve();
        storage.quarantineRaw('{broken');
        fail(new Error('late'));
        await flushPendingWrites();

        expect(storage.readRaw()).toBeNull();
        expect(native.value).toBe('{broken');
    });

    test('after the stored value was set aside the next save expects nothing', async () => {
        const { compareAndWrite } = nativeWindow('{broken');
        const { storage, initializeAsync, flushPendingWrites } = loadStorage();
        await initializeAsync();

        storage.quarantineRaw('{broken');
        storage.writeRaw('{"a":1}');
        await flushPendingWrites();

        expect(compareAndWrite).toHaveBeenCalledWith({ key: KEY, expected: null, value: '{"a":1}' });
    });
});

describe('the background service saving the settings', () => {
    /** The native bridge: `write` saves only while the settings are what `read` last answered. */
    const nativeService = (initial: string | null, onRead?: (reads: number) => void) => {
        const native = nativeStore(initial);
        let lastRead: string | null = null;
        let reads = 0;
        const bridge = {
            read: jest.fn<string | null, []>(() => {
                lastRead = native.value;
                const answer = native.value;
                onRead?.(++reads);
                return answer;
            }),
            write: jest.fn<boolean, [string]>((data) => {
                const answer = native.compareAndSet(lastRead, data);
                if (answer.saved) lastRead = data;
                return answer.saved;
            }),
        };
        g.__GS_HEADLESS__ = true;
        g.AndroidHeadlessStore = bridge;
        return { native, bridge };
    };

    test('a save the window did not touch is written at once', () => {
        const { native, bridge } = nativeService('{"a":1}');
        const { storage } = loadStorage();

        expect(storage.readRaw()).toBe('{"a":1}');
        expect(storage.writeRaw('{"a":2}')).toBe(true);

        expect(bridge.write).toHaveBeenCalledTimes(1);
        expect(native.value).toBe('{"a":2}');
    });

    test('a blob the window changed since the read is read again and the change made again on it', () => {
        const { native, bridge } = nativeService('{"a":1}');
        const { storage } = loadStorage();
        storage.readRaw();
        native.value = '{"a":1,"window":2}';

        expect(storage.writeRaw('{"a":1,"service":3}')).toBe(true);

        expect(bridge.write).toHaveBeenCalledTimes(2);
        expect(parse(native.value)).toEqual({ a: 1, window: 2, service: 3 });
        expect(cat.error).not.toHaveBeenCalled();
    });

    test('the text saved is the base of the next write, with no read in between', () => {
        const { native, bridge } = nativeService('{"a":1}');
        const { storage } = loadStorage();
        storage.readRaw();

        expect(storage.writeRaw('{"a":1,"b":1}')).toBe(true);
        expect(storage.writeRaw('{"a":1,"b":1,"c":1}')).toBe(true);

        expect(bridge.write).toHaveBeenCalledTimes(2);
        expect(native.value).toBe('{"a":1,"b":1,"c":1}');
    });

    test('a key that kept changing fails the save, said in the log, and nothing of the service is saved', () => {
        const { native, bridge } = nativeService('{"a":1}');
        const { storage } = loadStorage();
        storage.readRaw();
        let n = 0;
        bridge.write.mockImplementation(() => {
            native.value = `{"a":1,"n":${++n}}`;
            return false;
        });

        expect(storage.writeRaw('{"a":1,"service":1}')).toBe(false);

        expect(bridge.write).toHaveBeenCalledTimes(5);
        expect(cat.error).toHaveBeenCalledWith('Headless store write failed:', expect.any(Error));
        expect(parse(native.value)).toEqual({ a: 1, n: 5 });
    });

    test('a stored blob that is unreadable is not overwritten', () => {
        const { native, bridge } = nativeService('{"a":1}');
        const { storage } = loadStorage();
        storage.readRaw();
        native.value = '{broken';

        expect(storage.writeRaw('{"a":1,"service":1}')).toBe(false);

        expect(bridge.write).toHaveBeenCalledTimes(1);
        expect(native.value).toBe('{broken');
        expect(cat.error).toHaveBeenCalledWith('Headless store write failed:', expect.any(Error));
    });

    test('a refusal with nothing changed is not retried', () => {
        const { bridge } = nativeService('{"a":1}');
        bridge.write.mockReturnValue(false);
        const { storage } = loadStorage();
        storage.readRaw();

        expect(storage.writeRaw('{"a":2}')).toBe(false);

        expect(bridge.write).toHaveBeenCalledTimes(1);
        expect(cat.error).toHaveBeenCalledWith('Headless store refused the settings write', null);
    });

    test('through the facade: a toggle that the window saved right after the service read is kept', () => {
        let settings: typeof settingsModule | undefined;
        // setSetting reads, then reads again to merge: the window saves its toggle just after that second read.
        const { native } = nativeService(json({ theme: 'dark' }), (reads) => {
            if (reads === 2) native.value = json({ theme: 'dark', language: 'lv' });
        });
        jest.isolateModules(() => {
            settings = require('../../src/ts/settings') as typeof settingsModule;
        });
        // Reads made by the first load are not counted against the toggle.
        settings!.loadSettings();
        const before = native.value;
        expect(before).not.toBeNull();

        expect(settings!.saveSettings({ checkFrequencyMin: 7 })).toBe(true);

        const saved = parse(native.value) as Record<string, unknown>;
        expect(saved.checkFrequencyMin).toBe(7);
        expect(saved.language).toBe('lv');
    });
});

describe('setSetting on the background service', () => {
    test('hands over only the changed key, so what the window saved right after its one read is kept', () => {
        let armed = false;
        let windowText: string | null = null;
        const storedBlob = (language: string) => json({ theme: 'dark', language });
        const native = nativeStore(storedBlob('en'));
        let lastRead: string | null = null;
        const bridge = {
            read: jest.fn<string | null, []>(() => {
                lastRead = native.value;
                const answer = native.value;
                if (armed) {
                    armed = false;
                    // The window saves its toggle right after the service's read.
                    native.value = windowText;
                }
                return answer;
            }),
            write: jest.fn<boolean, [string]>((data) => {
                const answer = native.compareAndSet(lastRead, data);
                if (answer.saved) lastRead = data;
                return answer.saved;
            }),
        };
        g.__GS_HEADLESS__ = true;
        g.AndroidHeadlessStore = bridge;
        let settings: typeof settingsModule | undefined;
        jest.isolateModules(() => {
            settings = require('../../src/ts/settings') as typeof settingsModule;
        });
        // The first load migrates the stored blob; what the window saves next is on top of the migrated one.
        settings!.loadSettings();
        const migrated = parse(native.value) as Record<string, unknown>;
        windowText = json({ ...migrated, language: 'lv' });
        armed = true;
        bridge.read.mockClear();
        bridge.write.mockClear();

        expect(settings!.setSetting('checkFrequencyMin', 7)).toBe(true);

        const saved = parse(native.value) as Record<string, unknown>;
        expect(saved.checkFrequencyMin).toBe(7);
        expect(saved.language).toBe('lv');
        // One load, a write refused because the window moved, one read to make the change again, and its write.
        expect(bridge.read).toHaveBeenCalledTimes(2);
        expect(bridge.write).toHaveBeenCalledTimes(2);
    });
});

describe('both writers saving different settings at once', () => {
    test('the window and the service each keep the other’s change, whichever saves first', async () => {
        const native = nativeStore(json({ a: 1 }));
        let lastRead: string | null = null;
        g.AndroidHeadlessStore = {
            read: () => {
                lastRead = native.value;
                return native.value;
            },
            write: (data) => {
                const answer = native.compareAndSet(lastRead, data);
                if (answer.saved) lastRead = data;
                return answer.saved;
            },
        };
        g.Capacitor = {
            isNativePlatform: () => true,
            Plugins: {
                AutoVoteBackground: {
                    compareAndWrite: async ({ expected, value }: { expected: string | null; value: string }) =>
                        native.compareAndSet(expected, value),
                },
            },
        };
        mockPreferences.get.mockImplementation(() => Promise.resolve({ value: native.value }));
        const window = loadStorage();
        const service = loadStorage();
        await window.initializeAsync();

        // The window toggles one setting (its save is behind the cache) and the service another, before the window's
        // save runs.
        window.storage.writeRaw(json({ a: 1, window: 'on' }));
        g.__GS_HEADLESS__ = true;
        service.storage.readRaw();
        expect(service.storage.writeRaw(json({ a: 1, service: 'on' }))).toBe(true);
        delete g.__GS_HEADLESS__;
        await window.flushPendingWrites();
        expect(parse(native.value)).toEqual({ a: 1, window: 'on', service: 'on' });

        // The service read before the window saved; its change is made again on the window's.
        g.__GS_HEADLESS__ = true;
        service.storage.readRaw();
        delete g.__GS_HEADLESS__;
        window.storage.writeRaw(json({ a: 1, window: 'off', service: 'on' }));
        await window.flushPendingWrites();
        g.__GS_HEADLESS__ = true;
        expect(service.storage.writeRaw(json({ a: 1, window: 'on', service: 'off' }))).toBe(true);

        expect(parse(native.value)).toEqual({ a: 1, window: 'off', service: 'off' });
    });
});
