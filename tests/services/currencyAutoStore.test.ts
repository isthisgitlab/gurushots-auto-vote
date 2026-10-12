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
        peek: () => JSON.parse(raw!) as Record<string, AutoSpendRecord>,
    };
};

describe('auto-spend ledger', () => {
    test('counts fills per challenge', () => {
        const ledger = createMemoryAutoSpendLedger();
        expect(ledger.fills(1)).toBe(0);
        ledger.reserveFill(1);
        ledger.reserveFill('1');
        ledger.reserveFill(2);
        expect(ledger.fills('1')).toBe(2);
        expect(ledger.fills(2)).toBe(1);
    });

    test('a value that is no JSON object, or a store that cannot be read, is not an empty ledger: unknown, never written over', () => {
        for (const raw of ['{nope', '[1,2]', 'null', '"x"', '']) {
            const store = rawStore(raw);
            const ledger = createAutoSpendLedger(store);
            expect(ledger.fills(1)).toBe(Number.POSITIVE_INFINITY);
            expect(ledger.reserveFill(1)).toBe(false);
            ledger.releaseFill(1);
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

    test('says once that the fills stopped, naming the reason and never quoting the text, and again after it recovered', () => {
        const warning = jest.fn();
        // One category lookup for each warning said.
        jest.mocked(logger.withCategory)
            .mockReturnValueOnce(invalid({ warning }))
            .mockReturnValueOnce(invalid({ warning }));
        const store = rawStore('{"secret-member:1": nope');
        const ledger = createAutoSpendLedger(store);
        ledger.fills(1);
        ledger.fills(1);
        ledger.reserveFill(1);
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

    test('malformed records read as 0 and are dropped on the next write', () => {
        const store = rawStore(JSON.stringify({ 1: { fills: 'x', at: 1 }, 2: { fills: -1, at: 1 }, 3: null }));
        const ledger = createAutoSpendLedger(store);
        expect(ledger.fills(1)).toBe(0);
        expect(ledger.fills(2)).toBe(0);
        ledger.reserveFill(4);
        expect(Object.keys(store.peek())).toEqual(['4']);
    });

    test('records older than 30 days are pruned on write', () => {
        const store = rawStore(JSON.stringify({ old: { fills: 2, at: Date.now() - 31 * 24 * 3600 * 1000 } }));
        const ledger = createAutoSpendLedger(store);
        // A finished challenge does not count, on read either.
        expect(ledger.fills('old')).toBe(0);
        ledger.reserveFill('new');
        expect(store.peek()).toEqual({ new: { fills: 1, at: expect.any(Number) } });
    });

    test('a fill reserved and not made is taken back, and never below none', () => {
        const ledger = createMemoryAutoSpendLedger();
        ledger.reserveFill(1);
        ledger.reserveFill(1);
        ledger.releaseFill(1);
        expect(ledger.fills(1)).toBe(1);
        ledger.releaseFill(1);
        ledger.releaseFill(1);
        expect(ledger.fills(1)).toBe(0);
    });

    test('a ledger that was not loaded is not an empty one: no count, nothing reserved, nothing written', () => {
        const store = rawStore(JSON.stringify({ 1: { fills: 3, at: Date.now() } }));
        const writeRaw = jest.spyOn(store, 'writeRaw');
        let loaded = false;
        const ledger = createAutoSpendLedger(store, () => loaded);
        expect(ledger.fills(1)).toBe(Number.POSITIVE_INFINITY);
        expect(ledger.reserveFill(1)).toBe(false);
        ledger.releaseFill(1);
        expect(writeRaw).not.toHaveBeenCalled();
        loaded = true;
        expect(ledger.fills(1)).toBe(3);
        expect(ledger.reserveFill(1)).toBe(true);
    });

    test('a release the store refuses leaves the fill counted: a count too high only holds a fill back', () => {
        let writes = 0;
        let raw: string | null = null;
        const ledger = createAutoSpendLedger({
            readRaw: () => raw,
            writeRaw: (data) => {
                if (++writes > 1) throw new Error('Headless gs_auto_spends was not persisted');
                raw = data;
            },
        });
        expect(ledger.reserveFill(1)).toBe(true);
        ledger.releaseFill(1);
        expect(ledger.fills(1)).toBe(1);
    });

    test('a write the store refused is not a reserved fill, and is logged', () => {
        const error = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValue(invalid({ error, warning: jest.fn() }));
        const ledger = createAutoSpendLedger({
            readRaw: () => null,
            writeRaw: () => {
                throw new Error('Headless gs_auto_spends was not persisted');
            },
        });
        expect(ledger.reserveFill(1)).toBe(false);
        expect(error).toHaveBeenCalledWith(expect.stringContaining('was not persisted'), null);
    });
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

    test('on the service a read that threw is not a count of none', () => {
        g.__GS_HEADLESS__ = true;
        g.AndroidHeadlessStore = {
            read: () => null,
            write: jest.fn(),
            readKey: () => {
                throw new Error('bridge down');
            },
            writeKey: jest.fn(() => true),
        };
        const ledger = load();
        expect(ledger.fills(1)).toBe(Number.POSITIVE_INFINITY);
        expect(ledger.reserveFill(1)).toBe(false);
    });

    test('on the service a write the bridge refused is not a reserved fill', () => {
        g.__GS_HEADLESS__ = true;
        g.AndroidHeadlessStore = {
            read: () => null,
            write: jest.fn(),
            readKey: () => null,
            writeKey: jest.fn(() => false),
        };
        const ledger = load();
        expect(ledger.fills(1)).toBe(0);
        expect(ledger.reserveFill(1)).toBe(false);
    });

    test('in the app window a cache that was never filled is not a count of none', () => {
        g.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
        const ledger = load();
        expect(ledger.fills(1)).toBe(Number.POSITIVE_INFINITY);
    });

    test('on the desktop the file is the ledger, replaced whole on every write so a crash cannot leave half of it', () => {
        jest.mocked(fsModule.readdirSync).mockReturnValue([]);
        jest.mocked(fsModule.existsSync).mockReturnValue(false);
        const ledger = load();
        expect(ledger.fills(1)).toBe(0);
        expect(ledger.reserveFill(1)).toBe(true);
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
