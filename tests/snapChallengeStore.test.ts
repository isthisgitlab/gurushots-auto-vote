/**
 * snapChallengeStore.ts — the persisted record of the challenges ever seen as Snap. It must fail CLOSED: a store that
 * cannot be read reads as unknown (null), never as empty, and is never written over.
 */

jest.mock('../src/ts/runtime', () => ({
    isCapacitor: jest.fn(() => false),
    isHeadlessService: jest.fn(() => false),
}));

const mockFile = {
    initializeAsync: jest.fn(),
    refreshAsync: jest.fn(async () => true),
    flushPendingWrites: jest.fn(async () => {}),
    readRaw: jest.fn((): string | null => '{"7":1}'),
    updateThrough: jest.fn(async (_update: (current: string | null) => string | null) => 'saved' as const),
};
jest.mock('../src/ts/settings/storage', () => ({
    createJsonStore: jest.fn(() => mockFile),
    getSettingsPath: jest.fn(() => '/cfg/settings.json'),
}));

import runtimeModule = require('../src/ts/runtime');
const runtime = jest.mocked(runtimeModule);
import logger = require('../src/ts/logger');
import storageModule = require('../src/ts/settings/storage');
const storage = jest.mocked(storageModule);
import snapStore = require('../src/ts/snapChallengeStore');
import type { CategoryLogger } from '../src/ts/logger';
import type { RawJsonStore, ThroughResult } from '../src/ts/types/stores';
import { invalid } from './helpers/invalid';
import { parseJsonObject } from './helpers/parseJson';

// Captured at require time: tests/setup.ts clears every mock before each test.
const createJsonStoreCalls = [...storage.createJsonStore.mock.calls];

const warning = jest.fn<void, Parameters<CategoryLogger['warning']>>();
beforeEach(() => {
    jest.mocked(logger.withCategory).mockReturnValue(invalid({ warning }));
    runtime.isCapacitor.mockReturnValue(false);
    runtime.isHeadlessService.mockReturnValue(false);
    mockFile.readRaw.mockReturnValue('{"7":1}');
    mockFile.refreshAsync.mockResolvedValue(true);
    mockFile.updateThrough.mockResolvedValue('saved');
});

/** A raw store that has the write-through of createJsonStore: the update sees the current text and may decline. */
const memoryStore = (initial: string | null) => {
    let raw = initial;
    const store: RawJsonStore = {
        readRaw: () => raw,
        writeRaw: (data) => {
            raw = data;
        },
        updateThrough: async (update): Promise<ThroughResult> => {
            const data = update(raw);
            if (data === null) return 'aborted';
            raw = data;
            return 'saved';
        },
    };
    return { store, text: () => raw };
};

describe('store wiring', () => {
    test('uses the platform-aware JSON store, shared with the service, and re-exports its hydrate hook', () => {
        expect(createJsonStoreCalls).toEqual([
            [
                {
                    fileName: 'snapChallenges.json',
                    prefKey: 'gs_snap_challenges',
                    atomic: true,
                    strict: true,
                    shared: true,
                },
            ],
        ]);
        expect(snapStore.initializeSnapChallengesAsync).toBe(mockFile.initializeAsync);
    });

    test('the ledger reads what the store holds, after re-reading it (the window may be behind the service)', async () => {
        await expect(snapStore.snapLedger.read()).resolves.toEqual(new Set(['7']));
        expect(mockFile.refreshAsync).toHaveBeenCalledTimes(1);
    });

    test('a store the app window never filled is unknown, not empty', async () => {
        runtime.isCapacitor.mockReturnValue(true);
        await expect(snapStore.snapLedger.read()).resolves.toBeNull();
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining('the saved Snap challenges have not loaded'),
            null,
        );
    });

    test('a change goes through the store, and not at all on a cache that was never filled', async () => {
        const listing = [{ id: '8', closeTime: Math.floor(Date.now() / 1000) + 1000, snap: true }];
        await snapStore.snapLedger.record(listing);
        expect(mockFile.updateThrough).toHaveBeenCalledTimes(1);
        mockFile.updateThrough.mockClear();
        runtime.isCapacitor.mockReturnValue(true);
        await snapStore.snapLedger.record(listing);
        expect(mockFile.updateThrough).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalledWith('Snap challenges could not be saved', null);
    });

    test('flushing waits for the store’s queued writes', async () => {
        await snapStore.flushSnapChallengeWrites();
        expect(mockFile.flushPendingWrites).toHaveBeenCalledTimes(1);
    });
});

describe('read', () => {
    test('a store never written has no Snap challenges', async () => {
        const { store } = memoryStore(null);
        await expect(snapStore.createSnapLedger(store).read()).resolves.toEqual(new Set());
    });

    test('every stored id is a Snap challenge', async () => {
        const { store } = memoryStore('{"7":1,"8":2}');
        await expect(snapStore.createSnapLedger(store).read()).resolves.toEqual(new Set(['7', '8']));
    });

    test.each([
        ['an empty file', ''],
        ['text that is no JSON', '{"7":'],
        ['JSON that is no object', '["7"]'],
        ['a JSON null', 'null'],
    ])('%s reads as unknown, never as none', async (_label, text) => {
        const { store } = memoryStore(text);
        await expect(snapStore.createSnapLedger(store).read()).resolves.toBeNull();
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('not a JSON object'), null);
    });

    test('a store that throws when read reads as unknown, with the reason', async () => {
        const store: RawJsonStore = {
            readRaw: () => {
                throw new Error('bridge down');
            },
            writeRaw: jest.fn(),
        };
        await expect(snapStore.createSnapLedger(store).read()).resolves.toBeNull();
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('bridge down'), null);
    });

    test('a store that throws a non-error reads as unknown, with the value as text', async () => {
        const store: RawJsonStore = {
            readRaw: () => {
                // eslint-disable-next-line @typescript-eslint/only-throw-error
                throw 'refused';
            },
            writeRaw: jest.fn(),
        };
        await expect(snapStore.createSnapLedger(store).read()).resolves.toBeNull();
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('refused'), null);
    });

    test('a failed re-read is unknown', async () => {
        const { store } = memoryStore('{"7":1}');
        const ledger = snapStore.createSnapLedger(store, async () => false);
        await expect(ledger.read()).resolves.toBeNull();
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('could not be read again'), null);
    });

    test('an unreadable store is said once, and again after it was readable in between', async () => {
        const { store } = memoryStore('oops');
        let broken = true;
        const ledger = snapStore.createSnapLedger({
            readRaw: () => (broken ? store.readRaw() : '{}'),
            writeRaw: jest.fn(),
        });
        await ledger.read();
        await ledger.read();
        expect(warning).toHaveBeenCalledTimes(1);
        broken = false;
        await expect(ledger.read()).resolves.toEqual(new Set());
        broken = true;
        await ledger.read();
        expect(warning).toHaveBeenCalledTimes(2);
    });
});

describe('record', () => {
    const NOW_SEC = 1_800_000_000;
    const DAY_MS = 24 * 60 * 60 * 1000;
    // A challenge of the list reported as Snap now / as anything else, closing at `closeTime` (unix seconds).
    const snap = (id: string, closeTime: number) => ({ id, closeTime, snap: true });
    const listed = (id: string, closeTime: number) => ({ id, closeTime, snap: false });
    const stateOf = (text: string | null) => parseJsonObject(text ?? '');

    let now: jest.SpyInstance<number, []>;
    beforeEach(() => {
        now = jest.spyOn(Date, 'now').mockReturnValue(NOW_SEC * 1000);
    });
    afterEach(() => now.mockRestore());

    test('writes each challenge seen as Snap with its close_time', async () => {
        const { store, text } = memoryStore(null);
        await snapStore
            .createSnapLedger(store)
            .record([snap('7', NOW_SEC + 10), snap('8', NOW_SEC + 20), listed('9', 5)]);
        expect(stateOf(text())).toEqual({ '7': NOW_SEC + 10, '8': NOW_SEC + 20 });
    });

    test('a Snap without a usable close_time is stored as the ms it was first seen, and is not rewritten', async () => {
        const { store, text } = memoryStore(null);
        const ledger = snapStore.createSnapLedger(store);
        await ledger.record([snap('7', NaN), snap('8', 0), snap('9', 1e12)]);
        expect(stateOf(text())).toEqual({ '7': NOW_SEC * 1000, '8': NOW_SEC * 1000, '9': NOW_SEC * 1000 });
        now.mockReturnValue(NOW_SEC * 1000 + 5000);
        await ledger.record([snap('7', NaN)]);
        expect(stateOf(text())['7']).toBe(NOW_SEC * 1000);
    });

    test('a recorded id seen with a different close_time takes it; an unusable one changes nothing', async () => {
        const { store, text } = memoryStore(`{"7":${NOW_SEC + 10}}`);
        const ledger = snapStore.createSnapLedger(store);
        await ledger.record([listed('7', NaN), listed('7', 0), listed('7', 1e12)]);
        expect(stateOf(text())['7']).toBe(NOW_SEC + 10);
        await ledger.record([listed('7', NOW_SEC + 500), listed('8', NOW_SEC + 500)]);
        expect(stateOf(text())).toEqual({ '7': NOW_SEC + 500 });
    });

    test('nothing is written when nothing changes', async () => {
        const { store } = memoryStore(`{"7":${NOW_SEC + 10}}`);
        const updateThrough = jest.spyOn(store, 'updateThrough' as never);
        const writeRaw = jest.spyOn(store, 'writeRaw');
        await snapStore.createSnapLedger(store).record([snap('7', NOW_SEC + 10)]);
        expect(updateThrough).toHaveBeenCalledTimes(1);
        expect(writeRaw).not.toHaveBeenCalled();
    });

    test('an id is forgotten only once its challenge has been closed for an hour', async () => {
        const { store, text } = memoryStore(`{"7":${NOW_SEC - 3600},"8":${NOW_SEC - 3601}}`);
        await snapStore.createSnapLedger(store).record([]);
        expect(stateOf(text())).toEqual({ '7': NOW_SEC - 3600 });
    });

    test('an id still in the list is forgotten when its challenge closed more than an hour ago', async () => {
        const { store, text } = memoryStore(`{"7":${NOW_SEC + 100},"8":${NOW_SEC + 100}}`);
        await snapStore.createSnapLedger(store).record([listed('7', NOW_SEC - 4000), listed('8', NOW_SEC + 100)]);
        expect(stateOf(text())).toEqual({ '8': NOW_SEC + 100 });
    });

    test('a challenge already over is not recorded when it is seen as Snap', async () => {
        const { store, text } = memoryStore(null);
        await snapStore.createSnapLedger(store).record([snap('7', NOW_SEC - 4000)]);
        expect(text()).toBeNull();
    });

    test('an id missing from the list stays while its challenge is open, however many lists lack it', async () => {
        const { store, text } = memoryStore(`{"7":${NOW_SEC + 100}}`);
        const ledger = snapStore.createSnapLedger(store);
        for (let read = 0; read < 10; read++) await ledger.record([listed('8', NOW_SEC + 5)]);
        await ledger.record([]);
        expect(stateOf(text())).toEqual({ '7': NOW_SEC + 100 });
    });

    test('a first-seen ms entry is converted when its challenge is seen', async () => {
        const { store, text } = memoryStore(`{"7":${NOW_SEC * 1000 - 1000}}`);
        await snapStore.createSnapLedger(store).record([listed('7', NOW_SEC + 500)]);
        expect(stateOf(text())).toEqual({ '7': NOW_SEC + 500 });
    });

    test('a first-seen ms entry is kept for 30 days unseen, then forgotten', async () => {
        const { store, text } = memoryStore(`{"7":${NOW_SEC * 1000}}`);
        const ledger = snapStore.createSnapLedger(store);
        now.mockReturnValue(NOW_SEC * 1000 + 30 * DAY_MS);
        await ledger.record([]);
        expect(stateOf(text())).toEqual({ '7': NOW_SEC * 1000 });
        now.mockReturnValue(NOW_SEC * 1000 + 30 * DAY_MS + 1);
        await ledger.record([]);
        expect(stateOf(text())).toEqual({});
    });

    test.each([
        ['null', 'null'],
        ['true', 'true'],
        ['an empty string', '""'],
        ['an array', '[]'],
        ['text', '"soon"'],
    ])('a stored value that is %s is never forgotten', async (_label, value) => {
        const { store, text } = memoryStore(`{"7":${value}}`);
        await snapStore.createSnapLedger(store).record([]);
        expect(text()).toBe(`{"7":${value}}`);
    });

    test('an unreadable store is never written over', async () => {
        const { store, text } = memoryStore('{"7":');
        await snapStore.createSnapLedger(store).record([snap('8', NOW_SEC + 10)]);
        expect(text()).toBe('{"7":');
    });

    test('a store without a write-through is changed by a plain read and write', async () => {
        let raw: string | null = `{"7":${NOW_SEC + 10}}`;
        const store: RawJsonStore = {
            readRaw: () => raw,
            writeRaw: (data) => {
                raw = data;
            },
        };
        await snapStore.createSnapLedger(store).record([snap('8', NOW_SEC + 20)]);
        expect(Object.keys(stateOf(raw))).toEqual(['7', '8']);
    });

    test('a change that was not saved is said', async () => {
        const store: RawJsonStore = {
            readRaw: () => null,
            writeRaw: jest.fn(),
            updateThrough: async () => 'failed',
        };
        await snapStore.createSnapLedger(store).record([snap('8', NOW_SEC + 10)]);
        expect(warning).toHaveBeenCalledWith('Snap challenges could not be saved', null);
    });

    test('a change that was not saved is said once, and again after one was saved', async () => {
        let outcome: ThroughResult = 'failed';
        const store: RawJsonStore = {
            readRaw: () => null,
            writeRaw: jest.fn(),
            updateThrough: async () => outcome,
        };
        const ledger = snapStore.createSnapLedger(store);
        const listing = [snap('8', NOW_SEC + 10)];
        await ledger.record(listing);
        await ledger.record(listing);
        expect(warning).toHaveBeenCalledTimes(1);
        outcome = 'aborted';
        await ledger.record(listing);
        await ledger.record(listing);
        expect(warning).toHaveBeenCalledTimes(1);
        outcome = 'saved';
        await ledger.record(listing);
        outcome = 'failed';
        await ledger.record(listing);
        expect(warning).toHaveBeenCalledTimes(2);
    });
});

describe('ids seen in this process', () => {
    const NOW_SEC = 1_800_000_000;
    let now: jest.SpyInstance<number, []>;
    beforeEach(() => {
        now = jest.spyOn(Date, 'now').mockReturnValue(NOW_SEC * 1000);
    });
    afterEach(() => now.mockRestore());

    /** A store that saves only while `saves` is true; a change it cannot save answers `failed`. */
    const flaky = (initial: string | null) => {
        let raw = initial;
        const control = { saves: false, store: (text: string) => (raw = text) };
        const store: RawJsonStore = {
            readRaw: () => raw,
            writeRaw: jest.fn(),
            updateThrough: async (update): Promise<ThroughResult> => {
                const data = update(raw);
                if (data === null) return 'aborted';
                if (!control.saves) return 'failed';
                raw = data;
                return 'saved';
            },
        };
        return { store, control, text: () => raw };
    };

    test('an id whose save failed still reads as Snap', async () => {
        const { store } = flaky('{}');
        const ledger = snapStore.createSnapLedger(store);
        await ledger.record([{ id: '8', closeTime: NOW_SEC + 100, snap: true }]);
        await expect(ledger.read()).resolves.toEqual(new Set(['8']));
    });

    test('it is saved with the next change, with the close_time the list gave since', async () => {
        const { store, control, text } = flaky('{}');
        const ledger = snapStore.createSnapLedger(store);
        await ledger.record([{ id: '8', closeTime: NOW_SEC + 100, snap: true }]);
        control.saves = true;
        await ledger.record([{ id: '8', closeTime: NOW_SEC + 200, snap: false }]);
        expect(parseJsonObject(text() ?? '')).toEqual({ '8': NOW_SEC + 200 });
    });

    test('what this process holds replaces an earlier value another writer saved', async () => {
        const { store, control, text } = flaky('{}');
        const ledger = snapStore.createSnapLedger(store);
        await ledger.record([{ id: '8', closeTime: NOW_SEC + 100, snap: true }]);
        // Another writer saved an expired value for the id; it is not left to delete it.
        control.store(`{"8":${NOW_SEC - 4000}}`);
        control.saves = true;
        await ledger.record([]);
        expect(parseJsonObject(text() ?? '')).toEqual({ '8': NOW_SEC + 100 });
    });

    test('a later value another writer saved is kept', async () => {
        const { store, control, text } = flaky('{}');
        const ledger = snapStore.createSnapLedger(store);
        await ledger.record([{ id: '8', closeTime: NOW_SEC + 100, snap: true }]);
        control.store(`{"8":${NOW_SEC + 300}}`);
        control.saves = true;
        await ledger.record([]);
        expect(parseJsonObject(text() ?? '')).toEqual({ '8': NOW_SEC + 300 });
    });

    test('they are not told when the stored record is unreadable (still unknown)', async () => {
        const { store } = flaky('oops');
        const ledger = snapStore.createSnapLedger(store);
        await ledger.record([{ id: '8', closeTime: NOW_SEC + 100, snap: true }]);
        await expect(ledger.read()).resolves.toBeNull();
    });

    test('an id is forgotten once its challenge has been closed for an hour', async () => {
        const { store } = flaky('{}');
        const ledger = snapStore.createSnapLedger(store);
        await ledger.record([{ id: '8', closeTime: NOW_SEC + 100, snap: true }]);
        now.mockReturnValue((NOW_SEC + 100 + 3600) * 1000);
        await ledger.record([]);
        await expect(ledger.read()).resolves.toEqual(new Set(['8']));
        now.mockReturnValue((NOW_SEC + 100 + 3601) * 1000);
        await ledger.record([]);
        await expect(ledger.read()).resolves.toEqual(new Set());
    });
});
