/**
 * The Android settings blob has two writers, the app window (Preferences, through the AutoVoteBackground plugin) and the
 * background service (its native bridge). Each saves its change only if the blob still holds what it last read, and
 * makes it again on what the other saved meanwhile, so a toggle made on one side is not lost to the other.
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
const KEY = 'gurushots-config';

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
        mockPreferences.get.mockImplementation(({ key }) =>
            Promise.resolve({ value: key === KEY ? native.value : null }),
        );
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
        mockPreferences.get.mockImplementation(({ key }) => Promise.resolve({ value: key === KEY ? '{"a":1}' : null }));
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
        // The save reads once, to make its change on what is stored: the window saves its toggle just after that read.
        const { native } = nativeService(json({ app: { theme: 'dark' } }), (reads) => {
            if (reads === 2) native.value = json({ app: { theme: 'dark', language: 'lv' } });
        });
        jest.isolateModules(() => {
            settings = require('../../src/ts/settings') as typeof settingsModule;
        });
        // Reads made by the first load are not counted against the toggle.
        settings!.loadSettings();
        const before = native.value;
        expect(before).not.toBeNull();

        expect(settings!.saveAppSettings({ checkFrequencyMin: 7 })).toBe(true);

        const { app } = parse(native.value) as { app: Record<string, unknown> };
        expect(app.checkFrequencyMin).toBe(7);
        expect(app.language).toBe('lv');
    });
});

describe('setSetting on the background service', () => {
    test('hands over only the changed key, so what the window saved right after its one read is kept', () => {
        let armed = false;
        let windowText: string | null = null;
        const storedBlob = (language: string) => json({ app: { theme: 'dark', language } });
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
        settings!.loadSettings();
        windowText = json({ app: { theme: 'dark', language: 'lv' } });
        armed = true;
        bridge.read.mockClear();
        bridge.write.mockClear();

        expect(settings!.setSetting('checkFrequencyMin', 7)).toBe(true);

        const { app } = parse(native.value) as { app: Record<string, unknown> };
        expect(app.checkFrequencyMin).toBe(7);
        expect(app.language).toBe('lv');
        // One load, a write refused because the window moved, one read to make the change again, and its write. (The
        // mirror of settings.json cannot start here: this bridge has no keyed calls.)
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
        mockPreferences.get.mockImplementation(({ key }) =>
            Promise.resolve({ value: key === KEY ? native.value : null }),
        );
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

describe('the app window being told that a save was given up', () => {
    const nativeWindow = (initial: string | null) => {
        const native = nativeStore(initial);
        const compareAndWrite = jest.fn<ReturnType<CompareAndWrite>, Parameters<CompareAndWrite>>(
            async ({ expected, value }) => native.compareAndSet(expected, value),
        );
        g.Capacitor = { isNativePlatform: () => true, Plugins: { AutoVoteBackground: { compareAndWrite } } };
        mockPreferences.get.mockImplementation(({ key }) =>
            Promise.resolve({ value: key === KEY ? native.value : null }),
        );
        return { native, compareAndWrite };
    };
    /** The service changing the blob under every attempt of one save. */
    const alwaysConflicting = (
        native: ReturnType<typeof nativeStore>,
        compareAndWrite: jest.MockedFunction<CompareAndWrite>,
    ) => {
        let n = 0;
        compareAndWrite.mockImplementation(async () => {
            native.value = `{"a":1,"n":${++n}}`;
            return { saved: false, current: native.value };
        });
    };

    test('a save that kept conflicting is reported, each one given up after it again, and the next save that lands takes it back', async () => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites, isSaveDropped, onSaveDroppedChange } = loadStorage();
        await initializeAsync();
        const seen: boolean[] = [];
        const listener = jest.fn(() => seen.push(isSaveDropped()));
        onSaveDroppedChange(listener);
        expect(isSaveDropped()).toBe(false);
        const conflicting = compareAndWrite.getMockImplementation();
        alwaysConflicting(native, compareAndWrite);

        storage.writeRaw('{"a":1,"w":1}');
        await flushPendingWrites();
        expect(isSaveDropped()).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);

        // A second one given up while it is already reported is a notice of its own (the window shows it again).
        storage.writeRaw('{"a":1,"w":2}');
        await flushPendingWrites();
        expect(listener).toHaveBeenCalledTimes(2);

        compareAndWrite.mockImplementation(conflicting!);
        storage.writeRaw('{"a":1,"w":3}');
        await flushPendingWrites();
        expect(isSaveDropped()).toBe(false);
        expect(listener).toHaveBeenCalledTimes(3);
        expect(seen).toEqual([true, true, false]);
    });

    test('a save the plugin rejected is reported as well, as a storage failure', async () => {
        const { compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites, isSaveDropped, getSaveDroppedCause } = loadStorage();
        await initializeAsync();
        compareAndWrite.mockRejectedValueOnce(new Error('refused'));

        storage.writeRaw('{"a":1,"w":1}');
        await flushPendingWrites();

        expect(isSaveDropped()).toBe(true);
        expect(getSaveDroppedCause()).toBe('storage');
    });

    test.each([
        ['a save that kept conflicting', 'conflict'],
        ['a blob past the size the native store takes', 'too-large'],
        ['a store that refused the value', 'storage'],
        ['a rejection that carries another code', 'storage'],
        ['a rejection that is no object', 'storage'],
    ] as const)('%s is reported with the cause %s', async (what, cause) => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites, getSaveDroppedCause } = loadStorage();
        await initializeAsync();
        if (cause === 'conflict') alwaysConflicting(native, compareAndWrite);
        else if (cause === 'too-large') {
            compareAndWrite.mockRejectedValueOnce(Object.assign(new Error('too large'), { code: 'too-large' }));
        } else if (what.startsWith('a rejection that carries')) {
            compareAndWrite.mockRejectedValueOnce(Object.assign(new Error('odd'), { code: 'UNAVAILABLE' }));
        } else if (what.startsWith('a rejection that is no')) {
            compareAndWrite.mockRejectedValueOnce('odd');
        } else compareAndWrite.mockRejectedValueOnce(new Error('refused'));

        storage.writeRaw('{"a":1,"w":1}');
        await flushPendingWrites();

        expect(getSaveDroppedCause()).toBe(cause);
    });

    test('a rejection that is a plain Capacitor error object carrying the code is read too', async () => {
        const { compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites, getSaveDroppedCause } = loadStorage();
        await initializeAsync();
        compareAndWrite.mockRejectedValueOnce({ message: 'too large', code: 'too-large' });

        storage.writeRaw('{"a":1,"w":1}');
        await flushPendingWrites();

        expect(getSaveDroppedCause()).toBe('too-large');
    });

    test('every save given up tells the listener, with its own serial, whether or not its cause is the one reported', async () => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const {
            storage,
            initializeAsync,
            flushPendingWrites,
            getSaveDroppedCause,
            getSaveDroppedSerial,
            onSaveDroppedChange,
        } = loadStorage();
        await initializeAsync();
        const listener = jest.fn();
        onSaveDroppedChange(listener);
        alwaysConflicting(native, compareAndWrite);

        storage.writeRaw('{"a":1,"w":1}');
        await flushPendingWrites();
        expect(getSaveDroppedCause()).toBe('conflict');
        expect(listener).toHaveBeenCalledTimes(1);

        compareAndWrite.mockRejectedValueOnce(Object.assign(new Error('too large'), { code: 'too-large' }));
        storage.writeRaw('{"a":1,"w":2}');
        await flushPendingWrites();
        expect(getSaveDroppedCause()).toBe('too-large');
        expect(listener).toHaveBeenCalledTimes(2);
        expect(getSaveDroppedSerial()).toBe(2);

        compareAndWrite.mockRejectedValueOnce(Object.assign(new Error('too large'), { code: 'too-large' }));
        storage.writeRaw('{"a":1,"w":3}');
        await flushPendingWrites();
        expect(getSaveDroppedCause()).toBe('too-large');
        expect(listener).toHaveBeenCalledTimes(3);
        expect(getSaveDroppedSerial()).toBe(3);
    });

    test('a failed save is reported although a later one lands: that one carries only its own change', async () => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites, isSaveDropped } = loadStorage();
        await initializeAsync();
        compareAndWrite.mockRejectedValueOnce(new Error('not saved'));

        storage.writeRaw('{"a":1,"first":1}');
        storage.writeRaw('{"a":1,"first":1,"second":2}');
        await flushPendingWrites();

        expect(isSaveDropped()).toBe(true);
        expect(parse(native.value)).toEqual({ a: 1, second: 2 });

        storage.writeRaw('{"a":1,"second":2,"third":3}');
        await flushPendingWrites();
        expect(isSaveDropped()).toBe(false);
    });

    test('a listener that is replaced is not told, and none is needed', async () => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, flushPendingWrites, isSaveDropped, onSaveDroppedChange } = loadStorage();
        await initializeAsync();
        const first = jest.fn();
        const second = jest.fn();
        onSaveDroppedChange(first);
        onSaveDroppedChange(second);
        alwaysConflicting(native, compareAndWrite);

        storage.writeRaw('{"a":1,"w":1}');
        await flushPendingWrites();
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);

        onSaveDroppedChange(null);
        compareAndWrite.mockImplementation(async ({ expected, value }) => native.compareAndSet(expected, value));
        storage.writeRaw('{"a":1,"w":2}');
        await flushPendingWrites();
        expect(isSaveDropped()).toBe(false);
        expect(second).toHaveBeenCalledTimes(1);
    });

    test('discarding the pending writes forgets it', async () => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const {
            storage,
            initializeAsync,
            flushPendingWrites,
            discardPendingWrites,
            isSaveDropped,
            getSaveDroppedCause,
        } = loadStorage();
        await initializeAsync();
        alwaysConflicting(native, compareAndWrite);
        storage.writeRaw('{"a":1,"w":1}');
        await flushPendingWrites();
        expect(isSaveDropped()).toBe(true);
        expect(getSaveDroppedCause()).toBe('conflict');

        await discardPendingWrites();

        expect(isSaveDropped()).toBe(false);
        expect(getSaveDroppedCause()).toBe('storage');
    });

    test('discarding the pending writes is no notice of its own: the serial stays and the listener is not told', async () => {
        const { native, compareAndWrite } = nativeWindow('{"a":1}');
        const {
            storage,
            initializeAsync,
            flushPendingWrites,
            discardPendingWrites,
            isSaveDropped,
            getSaveDroppedCause,
            getSaveDroppedSerial,
            onSaveDroppedChange,
        } = loadStorage();
        await initializeAsync();
        const listener = jest.fn();
        onSaveDroppedChange(listener);
        alwaysConflicting(native, compareAndWrite);
        storage.writeRaw('{"a":1,"w":1}');
        await flushPendingWrites();
        expect(isSaveDropped()).toBe(true);
        expect(getSaveDroppedSerial()).toBe(1);
        expect(listener).toHaveBeenCalledTimes(1);

        await discardPendingWrites();

        // The discard is the app's own doing: the dropped state goes away, but the given-up save keeps its
        // serial and the window learns nothing new.
        expect(isSaveDropped()).toBe(false);
        expect(getSaveDroppedCause()).toBe('storage');
        expect(getSaveDroppedSerial()).toBe(1);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('a save still queued when the pending writes are discarded puts nothing down and reports nothing', async () => {
        const { compareAndWrite } = nativeWindow('{"a":1}');
        const { storage, initializeAsync, discardPendingWrites, isSaveDropped } = loadStorage();
        await initializeAsync();

        storage.writeRaw('{"a":1,"w":1}');
        await discardPendingWrites();

        expect(compareAndWrite).not.toHaveBeenCalled();
        expect(isSaveDropped()).toBe(false);
    });

    test('through the facade the notice is a settings-save-dropped state at the preference key', async () => {
        const { native, compareAndWrite } = nativeWindow('{"app":{"theme":"light"}}');
        let facade: typeof settingsModule | undefined;
        jest.isolateModules(() => {
            facade = require('../../src/ts/settings') as typeof settingsModule;
        });
        await facade!.initializeAsync();
        const listener = jest.fn();
        facade!.onSettingsSaveDroppedChange(listener);
        expect(facade!.getSettingsSaveDropped()).toBeNull();
        alwaysConflicting(native, compareAndWrite);

        expect(facade!.setSetting('theme', 'dark')).toBe(true);
        await facade!.flushPendingWrites();

        expect(facade!.getSettingsSaveDropped()).toEqual({
            code: 'settings-save-dropped',
            path: KEY,
            cause: 'conflict',
            serial: 1,
        });
        expect(listener).toHaveBeenCalledTimes(1);
        // The setting shows its stored value again.
        expect(facade!.getSetting('theme')).toBe('light');
    });
});
