/**
 * Tests for entryAgeStore.ts — when each entry entered its challenge, and the
 * photo a boost fill-new is waiting on, behind boostFreshEntryWait.
 */

import logger = require('../../src/js/logger');
import type * as entryAgeStoreModule from '../../src/js/entryAgeStore';
import type { Challenge } from '../../src/js/types/gurushots';
import { invalid } from '../helpers/invalid';
const {
    createEntryAgeLedger,
    createMemoryEntryAgeLedger,
}: typeof entryAgeStoreModule = require('../../src/js/entryAgeStore');

const NOW = 1_800_000_000;

const rawStore = (initial: string | null) => {
    let raw = initial;
    const store = {
        readRaw: () => raw,
        writeRaw: jest.fn((data: string) => {
            raw = data;
        }),
        peek: () => JSON.parse(raw!),
    };
    return store;
};

// A partial challenge: the ledger reads only its id, close time and entries.
const challenge = (id: number, entryIds: string[], closeTime = NOW + 3600) =>
    invalid<Challenge>({
        id,
        close_time: closeTime,
        member: { ranking: { entries: entryIds.map((entryId) => ({ id: entryId })) } },
    });

describe('entry-age ledger', () => {
    test('entries already there on the first sighting have an unknown (0) age; later ones are stamped', () => {
        const ledger = createMemoryEntryAgeLedger();
        ledger.observe(challenge(1, ['a', 'b']), NOW);
        expect(ledger.enteredAt(1, 'a')).toBe(0);
        expect(ledger.enteredAt('1', 'b')).toBe(0);

        ledger.observe(challenge(1, ['a', 'b', 'c']), NOW + 60);
        ledger.observe(challenge(1, ['a', 'b', 'c']), NOW + 120);
        expect(ledger.enteredAt(1, 'c')).toBe(NOW + 60);
        expect(ledger.enteredAt(1, 'zzz')).toBeNull();
        expect(ledger.enteredAt(2, 'a')).toBeNull();
    });

    test('forgets entries that left and writes only when something changed', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.observe(challenge(1, ['a', 'b']), NOW);
        ledger.observe(challenge(1, ['b', 'a']), NOW + 60);
        expect(store.writeRaw).toHaveBeenCalledTimes(1);

        ledger.observe(challenge(1, ['a']), NOW + 120);
        expect(store.writeRaw).toHaveBeenCalledTimes(2);
        expect(store.peek()['1'].entered).toEqual({ a: 0 });
    });

    test('ignores entries without an id and a challenge without one', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.observe(invalid({ close_time: NOW + 60, member: { ranking: { entries: [{ id: 'a' }] } } }), NOW);
        expect(store.writeRaw).not.toHaveBeenCalled();
        ledger.observe(
            invalid({ id: 1, close_time: NOW + 60, member: { ranking: { entries: [{}, { id: '' }] } } }),
            NOW,
        );
        expect(store.peek()['1'].entered).toEqual({});
        ledger.observe(invalid({ id: 2, close_time: NOW + 60 }), NOW);
        expect(store.peek()['2'].entered).toEqual({});
    });

    test('a pending fill-new photo is stamped now, kept while entered, cleared once boosted', () => {
        const ledger = createMemoryEntryAgeLedger();
        expect(ledger.pending(1)).toBeNull();
        ledger.markPending(challenge(1, []), 'fresh', NOW);
        expect(ledger.pending('1')).toBe('fresh');
        expect(ledger.enteredAt(1, 'fresh')).toBe(NOW);

        ledger.observe(challenge(1, ['fresh']), NOW + 60);
        expect(ledger.pending(1)).toBe('fresh');
        expect(ledger.enteredAt(1, 'fresh')).toBe(NOW);

        ledger.clearPending(1, NOW + 120);
        expect(ledger.pending(1)).toBeNull();
        expect(ledger.enteredAt(1, 'fresh')).toBe(NOW);
        ledger.clearPending(1, NOW + 180);
        ledger.clearPending(9, NOW + 180);
        expect(ledger.pending(9)).toBeNull();
    });

    test('a pending photo missing from a lagging listing is kept, with its entry time, for the grace period', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.observe(challenge(1, ['a']), NOW);
        ledger.markPending(challenge(1, ['a']), 'fresh', NOW + 10);
        ledger.observe(challenge(1, ['a']), NOW + 60);
        expect(ledger.pending(1)).toBe('fresh');
        expect(ledger.enteredAt(1, 'fresh')).toBe(NOW + 10);
        const writes = store.writeRaw.mock.calls.length;
        ledger.observe(challenge(1, ['a']), NOW + 120);
        expect(store.writeRaw).toHaveBeenCalledTimes(writes);

        ledger.observe(challenge(1, ['a', 'fresh']), NOW + 180);
        expect(ledger.enteredAt(1, 'fresh')).toBe(NOW + 10);
    });

    test('a pending photo missing past the grace period counts as never entered', () => {
        const ledger = createMemoryEntryAgeLedger();
        ledger.observe(challenge(1, ['a']), NOW);
        ledger.markPending(challenge(1, ['a']), 'fresh', NOW + 10);
        ledger.observe(challenge(1, ['a']), NOW + 611);
        expect(ledger.pending(1)).toBeNull();
        expect(ledger.enteredAt(1, 'fresh')).toBeNull();
    });

    test('closed challenges are pruned on the next write', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.observe(challenge(1, ['a'], NOW + 30), NOW);
        ledger.observe(challenge(2, ['b']), NOW + 60);
        expect(Object.keys(store.peek())).toEqual(['2']);
    });

    test('corrupt JSON, non-object roots and malformed records read as empty', () => {
        const warning = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValueOnce(invalid({ warning }));
        expect(createEntryAgeLedger(rawStore('{nope')).pending(1)).toBeNull();
        expect(warning).toHaveBeenCalled();

        const plainThrow = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValueOnce(invalid({ warning: plainThrow }));
        const throwing = createEntryAgeLedger({
            readRaw: () => {
                throw 'plain';
            },
            writeRaw: jest.fn(),
        });
        expect(throwing.enteredAt(1, 'a')).toBeNull();
        expect(plainThrow).toHaveBeenCalledWith(expect.stringContaining('plain'), null);

        expect(createEntryAgeLedger(rawStore('[]')).pending(1)).toBeNull();
        expect(createEntryAgeLedger(rawStore('null')).pending(1)).toBeNull();
        const malformed = createEntryAgeLedger(
            rawStore(
                JSON.stringify({
                    1: { closeTime: 'soon', entered: {} },
                    2: { closeTime: NOW + 60, entered: [] },
                    3: { closeTime: NOW + 60, entered: null },
                    4: null,
                    5: { closeTime: NOW + 60, entered: { a: NOW }, pending: 'a' },
                }),
            ),
        );
        expect(malformed.enteredAt(1, 'a')).toBeNull();
        expect(malformed.enteredAt(2, 'a')).toBeNull();
        expect(malformed.enteredAt(5, 'a')).toBe(NOW);
        expect(malformed.pending(5)).toBe('a');
    });
});
