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
        await snapStore.snapLedger.record(['8'], ['7', '8']);
        expect(mockFile.updateThrough).toHaveBeenCalledTimes(1);
        mockFile.updateThrough.mockClear();
        runtime.isCapacitor.mockReturnValue(true);
        await snapStore.snapLedger.record(['8'], ['7', '8']);
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
    test('writes each id seen as Snap with the time it was first seen', async () => {
        const { store, text } = memoryStore(null);
        const before = Date.now();
        await snapStore.createSnapLedger(store).record(['7', '8'], ['7', '8', '9']);
        const state = parseJsonObject(text() ?? '');
        expect(Object.keys(state)).toEqual(['7', '8']);
        expect(Number(state['7'])).toBeGreaterThanOrEqual(before);
    });

    test('an id already there keeps the time it was first seen', async () => {
        const { store, text } = memoryStore('{"7":5}');
        await snapStore.createSnapLedger(store).record(['7', '8'], ['7', '8']);
        expect(parseJsonObject(text() ?? '')['7']).toBe(5);
        expect(Object.keys(parseJsonObject(text() ?? ''))).toEqual(['7', '8']);
    });

    test('ids missing from a successful active list are dropped, the others kept', async () => {
        const { store, text } = memoryStore('{"7":1,"8":2,"9":3}');
        await snapStore.createSnapLedger(store).record([], ['8', '10']);
        expect(parseJsonObject(text() ?? '')).toEqual({ '8': 2 });
    });

    test('nothing is dropped for an empty active list', async () => {
        const { store, text } = memoryStore('{"7":1}');
        await snapStore.createSnapLedger(store).record([], []);
        expect(text()).toBe('{"7":1}');
    });

    test('an empty active list still records what was seen', async () => {
        const { store, text } = memoryStore('{"7":1}');
        await snapStore.createSnapLedger(store).record(['8'], []);
        expect(Object.keys(parseJsonObject(text() ?? ''))).toEqual(['7', '8']);
    });

    test('nothing is written when nothing changes', async () => {
        const { store } = memoryStore('{"7":1}');
        const updateThrough = jest.spyOn(store, 'updateThrough' as never);
        const writeRaw = jest.spyOn(store, 'writeRaw');
        await snapStore.createSnapLedger(store).record(['7'], ['7']);
        expect(updateThrough).toHaveBeenCalledTimes(1);
        expect(writeRaw).not.toHaveBeenCalled();
    });

    test('an unreadable store is never written over', async () => {
        const { store, text } = memoryStore('{"7":');
        await snapStore.createSnapLedger(store).record(['8'], ['8']);
        expect(text()).toBe('{"7":');
    });

    test('a store without a write-through is changed by a plain read and write', async () => {
        let raw: string | null = '{"7":1}';
        const store: RawJsonStore = {
            readRaw: () => raw,
            writeRaw: (data) => {
                raw = data;
            },
        };
        await snapStore.createSnapLedger(store).record(['8'], ['7', '8']);
        expect(Object.keys(parseJsonObject(raw ?? ''))).toEqual(['7', '8']);
    });

    test('a change that was not saved is said', async () => {
        const store: RawJsonStore = {
            readRaw: () => null,
            writeRaw: jest.fn(),
            updateThrough: async () => 'failed',
        };
        await snapStore.createSnapLedger(store).record(['8'], ['8']);
        expect(warning).toHaveBeenCalledWith('Snap challenges could not be saved', null);
    });
});
