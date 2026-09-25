/**
 * Tests for swapBackStore.js — the ledger of slots whose original photo was
 * swapped out while boosted/turbo'd (the API's swap history has no such flag).
 */

const { createLedger, createMemoryLedger } = require('../../src/js/swapBackStore');

const boosted = { id: 'A', member_id: 'm', boosted: true };
const turboed = { id: 'A', member_id: 'm', turbo: true };
const plain = { id: 'A', member_id: 'm' };

describe('onSwapped', () => {
    test('a boosted photo swapped out starts a record on its replacement', () => {
        const ledger = createMemoryLedger();
        ledger.onSwapped(7, boosted, 'B');
        expect(ledger.list(7)).toEqual([
            expect.objectContaining({ currentId: 'B', previousId: 'A', previousMemberId: 'm', kind: 'boost' }),
        ]);
    });

    test("a turbo'd photo records kind turbo", () => {
        const ledger = createMemoryLedger();
        ledger.onSwapped(7, turboed, 'B');
        expect(ledger.list(7)[0].kind).toBe('turbo');
    });

    test('a plain photo swapped out records nothing', () => {
        const ledger = createMemoryLedger();
        ledger.onSwapped(7, plain, 'B');
        expect(ledger.list(7)).toEqual([]);
    });

    test('the record follows the slot when the replacement is swapped again', () => {
        const ledger = createMemoryLedger();
        ledger.onSwapped(7, boosted, 'B');
        ledger.onSwapped(7, { id: 'B' }, 'C');
        expect(ledger.list(7)).toEqual([expect.objectContaining({ currentId: 'C', previousId: 'A' })]);
    });

    test('a plain swap that puts the original back in drops its record', () => {
        const ledger = createMemoryLedger();
        ledger.onSwapped(7, boosted, 'B');
        ledger.onSwapped(7, { id: 'B' }, 'A');
        expect(ledger.list(7)).toEqual([]);
    });

    test('challenges are kept apart; ids compare as strings', () => {
        const ledger = createMemoryLedger();
        ledger.onSwapped(7, boosted, 'B');
        expect(ledger.list('7')).toHaveLength(1);
        expect(ledger.list(8)).toEqual([]);
    });
});

test('remove drops the record for that slot', () => {
    const ledger = createMemoryLedger();
    ledger.onSwapped(7, boosted, 'B');
    ledger.remove(7, 'B');
    expect(ledger.list(7)).toEqual([]);
});

test('records older than 30 days are pruned on the next write', () => {
    const realNow = Date.now;
    try {
        const ledger = createMemoryLedger();
        ledger.onSwapped(7, boosted, 'B');
        Date.now = () => realNow() + 31 * 24 * 60 * 60 * 1000;
        ledger.onSwapped(8, boosted, 'X');
        expect(ledger.list(7)).toEqual([]);
        expect(ledger.list(8)).toHaveLength(1);
    } finally {
        Date.now = realNow;
    }
});

test('a corrupt store reads as empty instead of throwing', () => {
    const ledger = createLedger({ readRaw: () => '{not json', writeRaw: jest.fn() });
    expect(ledger.list(7)).toEqual([]);
});

describe('defensive reads and writes', () => {
    const logger = require('../../src/js/logger');

    test.each([['[]'], ['null'], ['5'], ['"str"']])('a non-object JSON root (%s) reads as empty', (raw) => {
        const ledger = createLedger({ readRaw: () => raw, writeRaw: jest.fn() });
        expect(ledger.list(7)).toEqual([]);
    });

    test('a store that throws a non-Error value still reads as empty and logs the value', () => {
        const warning = jest.fn();
        logger.withCategory.mockReturnValueOnce({ warning });
        const ledger = createLedger({
            readRaw: () => {
                throw 'disk gone';
            },
            writeRaw: jest.fn(),
        });
        expect(ledger.list(7)).toEqual([]);
        expect(warning).toHaveBeenCalledWith('swap-back ledger unreadable: disk gone', null);
    });

    test('a non-array challenge bucket is dropped on the next write', () => {
        let raw = JSON.stringify({
            7: 'junk',
            8: [{ currentId: 'X', previousId: 'Y', kind: 'boost', at: Date.now() }],
        });
        const ledger = createLedger({
            readRaw: () => raw,
            writeRaw: (data) => {
                raw = data;
            },
        });
        expect(ledger.list(7)).toEqual([]);
        ledger.onSwapped(9, plain, 'B');
        expect(Object.keys(JSON.parse(raw))).toEqual(['8']);
    });

    test('only the record on the swapped slot moves; others are untouched', () => {
        const ledger = createMemoryLedger();
        ledger.onSwapped(7, { id: 'A', boosted: true }, 'B');
        ledger.onSwapped(7, { id: 'P', turbo: true }, 'Q');
        ledger.onSwapped(7, { id: 'B' }, 'C');
        const byPrev = Object.fromEntries(ledger.list(7).map((r) => [r.previousId, r.currentId]));
        expect(byPrev).toEqual({ A: 'C', P: 'Q' });
    });

    test('an entry without member_id records an empty previousMemberId', () => {
        const ledger = createMemoryLedger();
        ledger.onSwapped(7, { id: 'A', boosted: true }, 'B');
        expect(ledger.list(7)[0].previousMemberId).toBe('');
    });
});
