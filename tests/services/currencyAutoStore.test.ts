/**
 * Tests for currencyAutoStore.ts — the per-challenge automatic-fill counter
 * behind autoExposureFillMax.
 */

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

    test('corrupt JSON and non-object roots read as empty', () => {
        const warning = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValueOnce(invalid({ warning }));
        expect(createAutoSpendLedger(rawStore('{nope')).fills(1)).toBe(0);
        expect(warning).toHaveBeenCalled();

        const errorWithoutMessage = createAutoSpendLedger(
            invalid({
                readRaw: () => {
                    throw 'plain';
                },
            }),
        );
        expect(errorWithoutMessage.fills(1)).toBe(0);

        expect(createAutoSpendLedger(rawStore('[1,2]')).fills(0)).toBe(0);
        expect(createAutoSpendLedger(rawStore('null')).fills(0)).toBe(0);
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
        expect(ledger.fills('old')).toBe(2);
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

    test('on the desktop the file is the ledger', () => {
        expect(load().fills(1)).toBe(0);
    });
});
