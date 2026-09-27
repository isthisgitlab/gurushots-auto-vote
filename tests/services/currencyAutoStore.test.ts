/**
 * Tests for currencyAutoStore.ts — the per-challenge automatic-fill counter
 * behind autoExposureFillMax.
 */

import logger = require('../../src/js/logger');
import type * as currencyAutoStoreModule from '../../src/js/currencyAutoStore';
const { createAutoSpendLedger, createMemoryAutoSpendLedger } =
    require('../../src/js/currencyAutoStore') as typeof currencyAutoStoreModule;
import type { AutoSpendRecord } from '../../src/js/types/stores';
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
        ledger.addFill(1);
        ledger.addFill('1');
        ledger.addFill(2);
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
        ledger.addFill(4);
        expect(Object.keys(store.peek())).toEqual(['4']);
    });

    test('records older than 30 days are pruned on write', () => {
        const store = rawStore(JSON.stringify({ old: { fills: 2, at: Date.now() - 31 * 24 * 3600 * 1000 } }));
        const ledger = createAutoSpendLedger(store);
        expect(ledger.fills('old')).toBe(2);
        ledger.addFill('new');
        expect(store.peek()).toEqual({ new: { fills: 1, at: expect.any(Number) } });
    });
});
