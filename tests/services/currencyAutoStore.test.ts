/**
 * Tests for currencyAutoStore.ts — the per-challenge automatic-fill counter
 * behind autoExposureFillMax.
 */

import fsModule = require('node:fs');
import logger = require('../../src/ts/logger');
import type * as currencyAutoStoreModule from '../../src/ts/currencyAutoStore';
const { createAutoSpendLedger, createMemoryAutoSpendLedger } =
    require('../../src/ts/currencyAutoStore') as typeof currencyAutoStoreModule;
import type { AutoSpendRecord } from '../../src/ts/types/stores';
import { invalid } from '../helpers/invalid';
import { isNumber, isRecordOf, isShape, parseJsonAs } from '../helpers/parseJson';

const rawStore = (initial: string | null) => {
    let raw = initial;
    return {
        readRaw: () => raw,
        writeRaw: (data: string) => {
            raw = data;
        },
        set: (data: string | null) => {
            raw = data;
        },
        raw: () => raw,
        peek: () => parseJsonAs(raw!, isRecordOf(isAutoSpendRecord)),
    };
};

const isAutoSpendRecord = isShape<AutoSpendRecord>({ fills: isNumber, at: isNumber });

describe('auto-spend ledger', () => {
    test('counts fills per challenge', async () => {
        const ledger = createMemoryAutoSpendLedger();
        expect(ledger.fills(1)).toBe(0);
        await ledger.reserveFill(1);
        await ledger.reserveFill('1');
        await ledger.reserveFill(2);
        expect(ledger.fills('1')).toBe(2);
        expect(ledger.fills(2)).toBe(1);
    });

    test('a value that is no JSON object, or a store that cannot be read, is not an empty ledger: unknown, never written over', async () => {
        for (const raw of ['{nope', '[1,2]', 'null', '"x"', '']) {
            const store = rawStore(raw);
            const ledger = createAutoSpendLedger(store);
            expect(ledger.fills(1)).toBe(Number.POSITIVE_INFINITY);
            await expect(ledger.reserveFill(1)).resolves.toBe(false);
            await ledger.releaseFill(1);
            expect(store.raw()).toBe(raw);
        }
        const unreadable = createAutoSpendLedger(
            invalid({
                readRaw: () => {
                    throw 'plain';
                },
            }),
        );
        expect(unreadable.fills(1)).toBe(Number.POSITIVE_INFINITY);
    });

    test('says once that the fills stopped, naming the reason and never quoting the text, and again after it recovered', async () => {
        const warning = jest.fn();
        // One category lookup for each warning said.
        jest.mocked(logger.withCategory)
            .mockReturnValueOnce(invalid({ warning }))
            .mockReturnValueOnce(invalid({ warning }));
        const store = rawStore('{"secret-member:1": nope');
        const ledger = createAutoSpendLedger(store);
        ledger.fills(1);
        ledger.fills(1);
        await ledger.reserveFill(1);
        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith(
            'auto-spend ledger is not valid JSON (SyntaxError) — no automatic fills until it can be read (tries again next cycle)',
            null,
        );
        store.set('{}');
        expect(ledger.fills(1)).toBe(0);
        store.set('[]');
        ledger.fills(1);
        expect(warning).toHaveBeenCalledTimes(2);
        expect(warning).toHaveBeenLastCalledWith(
            'auto-spend ledger is not a JSON object — no automatic fills until it can be read (tries again next cycle)',
            null,
        );
    });

    test('malformed records read as 0 and are dropped on the next write', async () => {
        const store = rawStore(JSON.stringify({ 1: { fills: 'x', at: 1 }, 2: { fills: -1, at: 1 }, 3: null }));
        const ledger = createAutoSpendLedger(store);
        expect(ledger.fills(1)).toBe(0);
        expect(ledger.fills(2)).toBe(0);
        await ledger.reserveFill(4);
        expect(Object.keys(store.peek())).toEqual(['4']);
    });

    test('records older than 30 days are pruned on write', async () => {
        const store = rawStore(JSON.stringify({ old: { fills: 2, at: Date.now() - 31 * 24 * 3600 * 1000 } }));
        const ledger = createAutoSpendLedger(store);
        // A finished challenge does not count, on read either.
        expect(ledger.fills('old')).toBe(0);
        await ledger.reserveFill('new');
        expect(store.peek()).toEqual({ new: { fills: 1, at: expect.any(Number) } });
    });

    test('a fill reserved and not made is taken back, and never below none', async () => {
        const ledger = createMemoryAutoSpendLedger();
        await ledger.reserveFill(1);
        await ledger.reserveFill(1);
        await ledger.releaseFill(1);
        expect(ledger.fills(1)).toBe(1);
        await ledger.releaseFill(1);
        await ledger.releaseFill(1);
        expect(ledger.fills(1)).toBe(0);
    });

    test('a ledger that was not loaded is not an empty one: no count, nothing reserved, nothing written', async () => {
        const store = rawStore(JSON.stringify({ 1: { fills: 3, at: Date.now() } }));
        const writeRaw = jest.spyOn(store, 'writeRaw');
        let loaded = false;
        const ledger = createAutoSpendLedger(store, () => loaded);
        expect(ledger.fills(1)).toBe(Number.POSITIVE_INFINITY);
        await expect(ledger.reserveFill(1)).resolves.toBe(false);
        await ledger.releaseFill(1);
        expect(writeRaw).not.toHaveBeenCalled();
        loaded = true;
        expect(ledger.fills(1)).toBe(3);
        await expect(ledger.reserveFill(1)).resolves.toBe(true);
    });

    test('a release the store refuses leaves the fill counted: a count too high only holds a fill back', async () => {
        let writes = 0;
        let raw: string | null = null;
        const ledger = createAutoSpendLedger({
            readRaw: () => raw,
            writeRaw: (data) => {
                if (++writes > 1) throw new Error('Headless gs_auto_spends was not persisted');
                raw = data;
            },
        });
        await expect(ledger.reserveFill(1)).resolves.toBe(true);
        await ledger.releaseFill(1);
        expect(ledger.fills(1)).toBe(1);
    });

    test('a write the store refused is not a reserved fill, and is logged', async () => {
        const error = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValue(invalid({ error, warning: jest.fn() }));
        const ledger = createAutoSpendLedger({
            readRaw: () => null,
            writeRaw: () => {
                throw new Error('Headless gs_auto_spends was not persisted');
            },
        });
        await expect(ledger.reserveFill(1)).resolves.toBe(false);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('was not persisted'), null);
    });
});

describe('auto-spend ledger — caps are held where the count is written', () => {
    test('a reserve with a cap refuses once the count has reached it, as it stands when the write is made', async () => {
        const store = rawStore(null);
        const ledger = createAutoSpendLedger(store);
        await expect(ledger.reserveFill(1, { max: 2 })).resolves.toBe(true);
        await expect(ledger.reserveFill(1, { max: 2 })).resolves.toBe(true);
        await expect(ledger.reserveFill(1, { max: 2 })).resolves.toBe(false);
        expect(ledger.fills(1)).toBe(2);
    });

    test('a count another context saved after the caller looked is not spent past: the cap is checked on what is stored', async () => {
        const store = rawStore(null);
        const ledger = createAutoSpendLedger(store);
        // What the caller saw before deciding to spend.
        expect(ledger.fills(1)).toBe(0);
        // The other context counts its fill.
        store.set(JSON.stringify({ 1: { fills: 1, at: Date.now() } }));
        await expect(ledger.reserveFill(1, { max: 1 })).resolves.toBe(false);
        expect(store.peek()['1'].fills).toBe(1);
    });

    test('two reserves made together count once each, never twice for the same fill, and never past the cap', async () => {
        // A store that saves behind a moment, as the app does, one write after another.
        let raw: string | null = null;
        let queue: Promise<unknown> = Promise.resolve();
        const store = {
            readRaw: () => raw,
            writeRaw: (data: string) => {
                raw = data;
            },
            updateThrough: (update: (current: string | null) => string | null) => {
                const run = queue.then(async () => {
                    await Promise.resolve();
                    const data = update(raw);
                    if (data === null) return 'aborted' as const;
                    raw = data;
                    return 'saved' as const;
                });
                queue = run;
                return run;
            },
        };
        const ledger = createAutoSpendLedger(store);
        const [a, b, c] = await Promise.all([
            ledger.reserveFill(1, { max: 2 }),
            ledger.reserveFill(1, { max: 2 }),
            ledger.reserveFill(1, { max: 2 }),
        ]);
        expect([a, b, c].filter(Boolean)).toHaveLength(2);
        expect(ledger.fills(1)).toBe(2);
    });

    test('a release for a challenge with no count leaves it at none', async () => {
        const ledger = createMemoryAutoSpendLedger();
        await ledger.releaseFill('never-counted');
        expect(ledger.fills('never-counted')).toBe(0);
    });

    test('the progress of a mission is kept with its count, and survives a release', async () => {
        const store = rawStore(null);
        const ledger = createAutoSpendLedger(store);
        expect(ledger.lastProgress('mission:5')).toBeNull();
        await ledger.reserveFill('mission:5', { progress: 2 });
        expect(ledger.lastProgress('mission:5')).toBe(2);
        await ledger.reserveFill('mission:5');
        expect(ledger.lastProgress('mission:5')).toBe(2);
        await ledger.releaseFill('mission:5');
        expect(ledger.fills('mission:5')).toBe(1);
        expect(ledger.lastProgress('mission:5')).toBe(2);
    });

    test('a record with a progress that is not a number is not a record', async () => {
        const store = rawStore(JSON.stringify({ 'mission:5': { fills: 1, at: Date.now(), progress: 'x' } }));
        const ledger = createAutoSpendLedger(store);
        expect(ledger.fills('mission:5')).toBe(0);
        expect(ledger.lastProgress('mission:5')).toBeNull();
    });

    test('a ledger that cannot be trusted has no progress to say', () => {
        expect(createAutoSpendLedger(rawStore('[]')).lastProgress('mission:5')).toBeNull();
    });

    test('a write the store reports as failed is logged and is not a reserved fill', async () => {
        const error = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValue(invalid({ error, warning: jest.fn() }));
        const ledger = createAutoSpendLedger({
            readRaw: () => null,
            writeRaw: jest.fn(),
            updateThrough: async () => 'failed' as const,
        });
        await expect(ledger.reserveFill(1)).resolves.toBe(false);
        expect(error).toHaveBeenCalledWith('auto-spend ledger not written', null);
    });

    test.each(['[1]', '{nope'])(
        'a ledger that stops being readable while a write waits (%s) is not written over',
        async (text) => {
            const store = rawStore(null);
            const ledger = createAutoSpendLedger({
                readRaw: () => store.raw(),
                writeRaw: store.writeRaw,
                updateThrough: async (update) => {
                    // By its turn the stored text is no JSON object.
                    store.set(text);
                    const data = update(store.raw());
                    return data === null ? 'aborted' : 'saved';
                },
            });
            await expect(ledger.reserveFill(1)).resolves.toBe(false);
            expect(store.raw()).toBe(text);
        },
    );
});

describe('flushing the ledger on teardown', () => {
    test('a write that did not persist is logged (the store name only), and the flush never rejects', async () => {
        const error = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValueOnce(invalid({ error }));
        let flushPendingWrites!: () => Promise<void>;
        jest.isolateModules(() => {
            jest.doMock('../../src/ts/settings/storage', () => ({
                createJsonStore: jest.fn(() => ({
                    readRaw: () => null,
                    writeRaw: jest.fn(),
                    initializeAsync: jest.fn(),
                    flushPendingWrites: jest.fn(async () => {
                        throw new Error('Capacitor gs_auto_spends was not persisted');
                    }),
                })),
            }));
            flushPendingWrites = (require('../../src/ts/currencyAutoStore') as typeof currencyAutoStoreModule)
                .flushAutoSpendWrites;
        });
        jest.dontMock('../../src/ts/settings/storage');
        await expect(flushPendingWrites()).resolves.toBeUndefined();
        expect(error).toHaveBeenCalledWith('auto-spend writes were not persisted', null);
    });
});

describe('whether the ledger of the real store can be trusted', () => {
    const g = globalThis as typeof globalThis & {
        Capacitor?: unknown;
        __GS_HEADLESS__?: boolean;
        AndroidHeadlessStore?: unknown;
    };
    afterEach(() => {
        delete g.Capacitor;
        delete g.__GS_HEADLESS__;
        delete g.AndroidHeadlessStore;
    });
    const load = () => {
        let ledger!: typeof import('../../src/ts/currencyAutoStore').autoSpendLedger;
        jest.isolateModules(() => {
            ledger = (require('../../src/ts/currencyAutoStore') as typeof currencyAutoStoreModule).autoSpendLedger;
        });
        return ledger;
    };

    test('on the service a read that threw is not a count of none', async () => {
        g.__GS_HEADLESS__ = true;
        g.AndroidHeadlessStore = {
            read: () => null,
            write: jest.fn(),
            readKey: () => {
                throw new Error('bridge down');
            },
            writeKey: jest.fn(() => true),
            compareAndWriteKey: jest.fn(() => true),
        };
        const ledger = load();
        expect(ledger.fills(1)).toBe(Number.POSITIVE_INFINITY);
        await expect(ledger.reserveFill(1)).resolves.toBe(false);
    });

    test('on the service a write the bridge refused is not a reserved fill', async () => {
        g.__GS_HEADLESS__ = true;
        g.AndroidHeadlessStore = {
            read: () => null,
            write: jest.fn(),
            readKey: () => null,
            writeKey: jest.fn(() => false),
            compareAndWriteKey: jest.fn(() => false),
        };
        const ledger = load();
        expect(ledger.fills(1)).toBe(0);
        await expect(ledger.reserveFill(1)).resolves.toBe(false);
    });

    test('on the service a count is saved by the native compare-and-write, made again on what the app window saved meanwhile', async () => {
        let stored: string | null = JSON.stringify({ 2: { fills: 1, at: Date.now() } });
        const compareAndWriteKey = jest.fn((_key: string, expected: string, data: string) => {
            if (expected !== (stored ?? '')) return false;
            stored = data;
            return true;
        });
        g.__GS_HEADLESS__ = true;
        // The window saves a fill of its own between the service's read of the key and its save.
        let reads = 0;
        g.AndroidHeadlessStore = {
            read: () => null,
            write: jest.fn(),
            readKey: () => {
                const seen = stored;
                // The first read is the ledger's own look; the second is the change's.
                if (++reads === 2) stored = JSON.stringify({ 2: { fills: 2, at: Date.now() } });
                return seen;
            },
            writeKey: jest.fn(() => false),
            compareAndWriteKey,
        };
        const ledger = load();
        await expect(ledger.reserveFill(1)).resolves.toBe(true);
        const saved = parseJsonAs(stored!, isRecordOf(isAutoSpendRecord));
        expect(saved['1'].fills).toBe(1);
        expect(saved['2'].fills).toBe(2);
    });

    test('in the app window a cache that was never filled is not a count of none', () => {
        g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
        const ledger = load();
        expect(ledger.fills(1)).toBe(Number.POSITIVE_INFINITY);
    });

    test('on the desktop the file is the ledger, replaced whole on every write so a crash cannot leave half of it', async () => {
        jest.mocked(fsModule.readdirSync).mockReturnValue([]);
        jest.mocked(fsModule.existsSync).mockReturnValue(false);
        const ledger = load();
        expect(ledger.fills(1)).toBe(0);
        await expect(ledger.reserveFill(1)).resolves.toBe(true);
        // Written to a temporary file and renamed over it.
        expect(fsModule.renameSync).toHaveBeenCalledWith(
            expect.stringContaining('autoSpends.json.'),
            expect.stringContaining('autoSpends.json'),
        );
    });

    test('what the user is told to do about a ledger that cannot be trusted depends on where it is kept', () => {
        const warning = jest.fn();
        const said = () => (warning.mock.calls.at(-1) as [string] | undefined)?.[0] ?? '';
        jest.mocked(fsModule.readdirSync).mockReturnValue([]);
        jest.mocked(fsModule.existsSync).mockReturnValue(true);
        jest.mocked(fsModule.readFileSync).mockReturnValue('{cut short');
        jest.mocked(logger.withCategory).mockReturnValue(invalid({ warning, error: jest.fn() }));
        load().fills(1);
        expect(said()).toMatch(/delete .*autoSpends\.json to start the fill count over\)$/);
        g.Capacitor = { isNativePlatform: () => true };
        load().fills(1);
        expect(said()).toMatch(/\(tries again next cycle\)$/);
    });
});
