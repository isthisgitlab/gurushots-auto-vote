/**
 * Tests for currencyAutoStore.js — the per-challenge automatic-fill counter
 * behind autoExposureFillMax.
 */

const logger = require('../../src/js/logger');
const { createAutoSpendLedger, createMemoryAutoSpendLedger } = require('../../src/js/currencyAutoStore');

const rawStore = (initial) => {
    let raw = initial;
    return {
        readRaw: () => raw,
        writeRaw: (data) => {
            raw = data;
        },
        peek: () => JSON.parse(raw),
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
        logger.withCategory.mockReturnValueOnce({ warning });
        expect(createAutoSpendLedger(rawStore('{nope')).fills(1)).toBe(0);
        expect(warning).toHaveBeenCalled();

        const errorWithoutMessage = createAutoSpendLedger({
            readRaw: () => {
                throw 'plain';
            },
        });
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
