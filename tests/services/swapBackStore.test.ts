/**
 * Tests for swapBackStore.ts — the ledger of slots whose original photo was
 * swapped out while boosted/turbo'd (the API's swap history has no such flag).
 */

import type * as swapBackStoreModule from '../../src/ts/swapBackStore';
import type * as loggerModule from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';
import { parseJsonObject } from '../helpers/parseJson';

const { createLedger, createMemoryLedger } = require('../../src/ts/swapBackStore') as typeof swapBackStoreModule;

const boosted = { id: 'A', member_id: 'm', boosted: true };
const turboed = { id: 'A', member_id: 'm', turbo: true };
const picked = { id: 'A', member_id: 'm', guru_pick: true };
const boostedAndPicked = { id: 'A', member_id: 'm', boosted: true, guru_pick: true };
const turboedAndPicked = { id: 'A', member_id: 'm', turbo: true, guru_pick: true };
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

    test('a guru-picked photo records kind guruPick', () => {
        const ledger = createMemoryLedger();
        ledger.onSwapped(7, picked, 'B');
        expect(ledger.list(7)).toEqual([
            expect.objectContaining({ currentId: 'B', previousId: 'A', previousMemberId: 'm', kind: 'guruPick' }),
        ]);
    });

    test("a boosted and a turbo'd photo that also carry a pick record the boost/turbo only", () => {
        const ledger = createMemoryLedger();
        ledger.onSwapped(7, boostedAndPicked, 'B');
        ledger.onSwapped(8, turboedAndPicked, 'B');
        expect(ledger.list(7)[0].kind).toBe('boost');
        expect(ledger.list(8)[0].kind).toBe('turbo');
    });

    test('a truthy non-boolean guru_pick is no pick; a plain photo records nothing', () => {
        const ledger = createMemoryLedger();
        ledger.onSwapped(7, { id: 'A', guru_pick: 1 }, 'B');
        ledger.onSwapped(7, plain, 'C');
        expect(ledger.list(7)).toEqual([]);
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
    const logger = require('../../src/ts/logger') as typeof loggerModule;

    test.each([['[]'], ['null'], ['5'], ['"str"']])('a non-object JSON root (%s) reads as empty', (raw) => {
        const ledger = createLedger({ readRaw: () => raw, writeRaw: jest.fn() });
        expect(ledger.list(7)).toEqual([]);
    });

    test('a store that throws a non-Error value still reads as empty and logs the value', () => {
        const warning = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValueOnce(invalid({ warning }));
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
        expect(Object.keys(parseJsonObject(raw))).toEqual(['8']);
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

    test('a guruPick record survives write() and list(), an unknown kind is dropped', () => {
        let raw = '';
        const ledger = createLedger({
            readRaw: () => raw,
            writeRaw: (data) => {
                raw = data;
            },
        });
        ledger.onSwapped(7, picked, 'B');
        // A second ledger over the stored text reads the guruPick record back.
        expect(createLedger({ readRaw: () => raw, writeRaw: jest.fn() }).list(7)).toEqual([
            expect.objectContaining({ currentId: 'B', previousId: 'A', kind: 'guruPick' }),
        ]);
        // A hand-written unknown kind reads as nothing.
        raw = JSON.stringify({ 8: [{ currentId: 'X', previousId: 'Y', kind: 'vibe', at: Date.now() }] });
        expect(ledger.list(8)).toEqual([]);
    });
});
