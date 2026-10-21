/**
 * Tests for entryAgeStore.ts — when each entry entered its challenge, and the
 * photo a boost fill-new is waiting on, behind boostFreshEntryWait.
 */

import logger = require('../../src/ts/logger');
import type * as entryAgeStoreModule from '../../src/ts/entryAgeStore';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { EntryAgeRecord, ThroughResult } from '../../src/ts/types/stores';
import { invalid } from '../helpers/invalid';
import {
    isArrayOf,
    isBoolean,
    isNumber,
    isRecordOf,
    isShape,
    isString,
    nullable,
    optional,
    parseJsonAs,
} from '../helpers/parseJson';
const { createEntryAgeLedger, createMemoryEntryAgeLedger } =
    require('../../src/ts/entryAgeStore') as typeof entryAgeStoreModule;

const NOW = 1_800_000_000;

const isEntryAgeRecord = isShape<EntryAgeRecord>({
    closeTime: isNumber,
    entered: isRecordOf(isNumber),
    pending: nullable(isString),
    uncertain: optional(isArrayOf(isString)),
    exact: isArrayOf(isString),
    observed: isBoolean,
    firstSeen: isNumber,
});

const rawStore = (initial: string | null) => {
    let raw = initial;
    const store = {
        readRaw: () => raw,
        writeRaw: jest.fn((data: string) => {
            raw = data;
        }),
        peek: () => parseJsonAs(raw!, isRecordOf(isEntryAgeRecord)),
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

        ledger.clearPending(1, 'fresh', NOW + 120);
        expect(ledger.pending(1)).toBeNull();
        expect(ledger.enteredAt(1, 'fresh')).toBe(NOW);
        ledger.clearPending(1, 'fresh', NOW + 180);
        ledger.clearPending(9, 'fresh', NOW + 180);
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

    test('remembers uncertain auto-submitted entries and prunes them after removal', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.observe(challenge(1, ['manual']), NOW);
        ledger.markUncertain(challenge(1, ['manual']), 'auto', NOW + 10);
        ledger.markUncertain(challenge(1, ['manual']), 'auto', NOW + 10);
        expect(ledger.isUncertain(1, 'auto')).toBe(true);
        expect(ledger.isUncertain(1, 'manual')).toBe(false);
        expect(store.peek()['1'].uncertain).toEqual(['auto']);

        ledger.observe(challenge(1, ['manual']), NOW + 60);
        expect(ledger.isUncertain(1, 'auto')).toBe(true);
        ledger.observe(challenge(1, ['manual', 'auto']), NOW + 120);
        expect(ledger.isUncertain(1, 'auto')).toBe(true);
        ledger.observe(challenge(1, ['manual']), NOW + 800);
        expect(ledger.isUncertain(1, 'auto')).toBe(false);
    });

    test('can record uncertainty before any entry snapshot exists', () => {
        const ledger = createMemoryEntryAgeLedger();
        ledger.markUncertain(challenge(2, []), 'fresh', NOW);
        expect(ledger.isUncertain(2, 'fresh')).toBe(true);
        expect(ledger.enteredAt(2, 'fresh')).toBe(NOW);
    });

    test('bounds and validates persisted uncertain ids', () => {
        const ledger = createEntryAgeLedger(
            rawStore(
                JSON.stringify({
                    1: {
                        closeTime: NOW + 3600,
                        entered: {},
                        pending: null,
                        uncertain: [
                            123,
                            'safe',
                            ...Array.from({ length: 63 }, (_, index) => `id-${index}`),
                            'beyond-cap',
                        ],
                    },
                }),
            ),
        );
        expect(ledger.isUncertain(1, 'safe')).toBe(true);
        expect(ledger.isUncertain(1, 'beyond-cap')).toBe(false);
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
        // A fixed reason: the message of a parse error quotes the text, which holds member and image ids.
        expect(warning).toHaveBeenCalledWith('entry-age ledger unreadable (not JSON)', null);

        const plainThrow = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValueOnce(invalid({ warning: plainThrow }));
        const throwing = createEntryAgeLedger({
            readRaw: () => {
                throw 'plain';
            },
            writeRaw: jest.fn(),
        });
        expect(throwing.enteredAt(1, 'a')).toBeNull();
        expect(plainThrow).toHaveBeenCalledWith('entry-age ledger unreadable (read failed: not an error)', null);

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

    test('a pending id that is not a non-empty string reads as none', () => {
        const stored = (pending: unknown) =>
            createEntryAgeLedger(
                rawStore(JSON.stringify({ 1: { closeTime: NOW + 60, entered: { a: NOW }, pending } })),
            ).pending(1);
        expect(stored(12)).toBeNull();
        expect(stored('')).toBeNull();
        expect(stored(['a'])).toBeNull();
        expect(stored(undefined)).toBeNull();
        expect(stored('a')).toBe('a');
    });

    test('a listing with no entries does not replace a record that has some; one that has none takes it', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.observe(listing(1, ['a', 'b']), NOW);
        ledger.observe(listing(1, []), NOW + 60);
        expect(Object.keys(store.peek()['1'].entered).sort()).toEqual(['a', 'b']);
        ledger.observe(listing(2, []), NOW + 60);
        expect(store.peek()['2'].entered).toEqual({});
        ledger.observe(listing(2, ['c']), NOW + 120);
        // The challenge had been seen with none, so an entry that appears is new.
        expect(store.peek()['2'].entered).toEqual({ c: NOW + 120 });
    });
});

// A listing as a fetch reports it: entries with their account, and when the member joined.
type ListedEntry = string | { id: string; member_id?: string };
const listing = (id: number, entries: ListedEntry[], options: { closeTime?: number; joined?: number } = {}) =>
    invalid<Challenge>({
        id,
        close_time: options.closeTime ?? NOW + 3600,
        member: {
            time_joined: options.joined,
            ranking: { entries: entries.map((entry) => (typeof entry === 'string' ? { id: entry } : entry)) },
        },
    });

describe('entry times: exact and approximate', () => {
    test('a submit is recorded as exact and the first fetch after it keeps that time', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.markSubmitted(1, ['x'], NOW);
        expect(ledger.enteredAt(1, 'x')).toBe(NOW);
        const times = ledger.observeAll([listing(1, ['a', 'x'])], NOW + 60);
        // The submit is exact; the other entry was there by this first fetch.
        expect(times).toEqual({
            '1': { x: { at: NOW, exact: true }, a: { at: NOW + 60, exact: false } },
        });
        expect(store.peek()['1']).toMatchObject({ observed: true, firstSeen: NOW + 60 });
    });

    test('an entry first shown by a later fetch gets that fetch time; one already there is shown as first seen, with its age unknown', () => {
        const ledger = createMemoryEntryAgeLedger();
        expect(ledger.observeAll([listing(1, ['a'])], NOW)).toEqual({ '1': { a: { at: NOW, exact: false } } });
        expect(ledger.enteredAt(1, 'a')).toBe(0);
        expect(ledger.observeAll([listing(1, ['a', 'b'])], NOW + 60)).toEqual({
            '1': { a: { at: NOW, exact: false }, b: { at: NOW + 60, exact: false } },
        });
        expect(ledger.observeAll([listing(1, ['a', 'b'])], NOW + 120)).toEqual({
            '1': { a: { at: NOW, exact: false }, b: { at: NOW + 60, exact: false } },
        });
        // The age that holds a boost is unchanged: unknown for the old entry, the sighting for the new one.
        expect(ledger.enteredAt(1, 'a')).toBe(0);
        expect(ledger.enteredAt(1, 'b')).toBe(NOW + 60);
    });

    test('the only entry of a challenge first seen is shown as first seen: the join time says nothing of a photo swapped in since', () => {
        const ledger = createMemoryEntryAgeLedger();
        expect(ledger.observeAll([listing(1, ['a'], { joined: NOW - 500 })], NOW)).toEqual({
            '1': { a: { at: NOW, exact: false } },
        });
        expect(ledger.enteredAt(1, 'a')).toBe(0);
        // Seen again, the first sighting stays: it is not moved to a later fetch.
        expect(ledger.observeAll([listing(1, ['a'], { joined: NOW - 500 })], NOW + 60)).toEqual({
            '1': { a: { at: NOW, exact: false } },
        });
    });

    test('a record a submit made before any fetch leaves the other entries unknown and its placeholder close time is replaced', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.markSubmitted(1, ['x'], NOW);
        expect(store.peek()['1']).toMatchObject({ observed: false, closeTime: NOW + 31 * 86400 });
        const times = ledger.observeAll([listing(1, ['a', 'b', 'x'], { closeTime: NOW + 3600 })], NOW + 60);
        expect(times).toEqual({
            '1': {
                x: { at: NOW, exact: true },
                a: { at: NOW + 60, exact: false },
                b: { at: NOW + 60, exact: false },
            },
        });
        // Their ages are unknown, though they are shown: the first fetch is their time, "or earlier".
        expect(store.peek()['1']).toMatchObject({ observed: true, closeTime: NOW + 3600, firstSeen: NOW + 60 });
        expect(ledger.enteredAt(1, 'a')).toBe(0);
    });

    test('a stored field the shape no longer holds loads without a notice and is gone from the next write', () => {
        // A file written by a build that still kept the entries' account: the record reads as it
        // would have without the field, and the next write stores it without it.
        const store = rawStore(
            JSON.stringify({
                1: {
                    closeTime: NOW + 3600,
                    entered: { a: NOW },
                    pending: null,
                    exact: [],
                    memberId: 'me',
                    observed: true,
                    firstSeen: NOW,
                },
            }),
        );
        const ledger = createEntryAgeLedger(store);
        expect(ledger.enteredAt(1, 'a')).toBe(NOW);
        ledger.markUncertain(listing(1, ['a']), 'u', NOW + 60);
        const record = store.peek()['1'];
        expect(record).not.toHaveProperty('memberId');
        expect(record.uncertain).toEqual(['u']);
    });

    test('an exact photo missing from a lagging listing keeps its time and flag for the grace, then goes', () => {
        const ledger = createMemoryEntryAgeLedger();
        ledger.observe(listing(1, ['a']), NOW);
        ledger.markSubmitted(1, ['x'], NOW + 10);
        expect(ledger.observeAll([listing(1, ['a'])], NOW + 100)).toEqual({ '1': { a: { at: NOW, exact: false } } });
        expect(ledger.enteredAt(1, 'x')).toBe(NOW + 10);
        expect(ledger.observeAll([listing(1, ['a', 'x'])], NOW + 200)).toEqual({
            '1': { a: { at: NOW, exact: false }, x: { at: NOW + 10, exact: true } },
        });
        ledger.observe(listing(1, ['a']), NOW + 300);
        ledger.observe(listing(1, ['a']), NOW + 700);
        expect(ledger.enteredAt(1, 'x')).toBeNull();
        // Back after the grace it is an entry like any other: first seen now, not exact.
        expect(ledger.observeAll([listing(1, ['a', 'x'])], NOW + 800)).toEqual({
            '1': { a: { at: NOW, exact: false }, x: { at: NOW + 800, exact: false } },
        });
    });

    test('a photo swapped out and back within the grace gets the new time', () => {
        const ledger = createMemoryEntryAgeLedger();
        ledger.observe(listing(1, ['a']), NOW);
        ledger.markSubmitted(1, ['b'], NOW + 10);
        ledger.observe(listing(1, ['a', 'b']), NOW + 20);
        ledger.markSubmitted(1, ['c'], NOW + 60);
        ledger.markSubmitted(1, ['b'], NOW + 120);
        expect(ledger.observeAll([listing(1, ['a', 'b'])], NOW + 130)).toEqual({
            '1': { a: { at: NOW, exact: false }, b: { at: NOW + 120, exact: true } },
        });
    });

    test('markPending and markUncertain keep an earlier exact time and the exact flag', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.observe(listing(1, ['a']), NOW);
        ledger.markSubmitted(1, ['x'], NOW + 10);
        ledger.markUncertain(listing(1, ['a', 'x']), 'x', NOW + 50);
        expect(ledger.enteredAt(1, 'x')).toBe(NOW + 10);
        expect(store.peek()['1'].exact).toEqual(['x']);
        ledger.markPending(listing(1, ['a', 'x']), 'p', NOW + 60);
        expect(store.peek()['1'].exact).toEqual(['x', 'p']);
        expect(store.peek()['1'].entered).toEqual({ a: 0, x: NOW + 10, p: NOW + 60 });
        expect(ledger.pending(1)).toBe('p');
        // An unknown (0) time stays unknown.
        ledger.markUncertain(listing(1, ['a']), 'a', NOW + 70);
        expect(ledger.enteredAt(1, 'a')).toBe(0);
    });

    test('markPending and markUncertain on a challenge no fetch saw make a record the next fetch completes', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.markPending(listing(1, []), 'p', NOW);
        ledger.markUncertain(listing(2, []), 'u', NOW);
        expect(store.peek()['1']).toMatchObject({ observed: false, exact: ['p'], pending: 'p' });
        expect(store.peek()['2']).toMatchObject({ observed: false, exact: [], uncertain: ['u'] });
        expect(ledger.observeAll([listing(1, ['a', 'p'])], NOW + 5)).toEqual({
            '1': { p: { at: NOW, exact: true }, a: { at: NOW + 5, exact: false } },
        });
    });

    test('a file from before the exact times reads with the fields it lacks', () => {
        const store = rawStore(
            JSON.stringify({ 1: { closeTime: NOW + 3600, entered: { a: NOW }, pending: null, uncertain: ['a'] } }),
        );
        const ledger = createEntryAgeLedger(store);
        expect(ledger.observeAll([listing(1, ['a'])], NOW + 60)).toEqual({ '1': { a: { at: NOW, exact: false } } });
        // Its entries were there by this fetch: the record takes it as the first sighting, once.
        expect(store.writeRaw).toHaveBeenCalledTimes(1);
        expect(store.peek()['1'].firstSeen).toBe(NOW + 60);
        ledger.observeAll([listing(1, ['a'])], NOW + 120);
        expect(store.writeRaw).toHaveBeenCalledTimes(1);
        expect(store.peek()['1'].firstSeen).toBe(NOW + 60);
    });

    test('an old record gets the smallest fetch sighting it holds as its first fetch: the unknown-age entries were there before it', () => {
        const store = rawStore(
            JSON.stringify({
                1: { closeTime: NOW + 3600, entered: { a: 0, b: NOW - 500, c: NOW - 200 }, pending: null },
            }),
        );
        const ledger = createEntryAgeLedger(store);
        expect(ledger.observeAll([listing(1, ['a', 'b', 'c'])], NOW)).toEqual({
            '1': {
                a: { at: NOW - 500, exact: false },
                b: { at: NOW - 500, exact: false },
                c: { at: NOW - 200, exact: false },
            },
        });
        expect(store.peek()['1'].firstSeen).toBe(NOW - 500);
        expect(ledger.enteredAt(1, 'a')).toBe(0);
    });

    test('the earliest stamp of an old record is taken even when it belongs to an entry the fetch no longer lists', () => {
        const store = rawStore(
            JSON.stringify({
                1: { closeTime: NOW + 3600, entered: { a: 0, gone: NOW - 900, c: NOW - 200 }, pending: null },
            }),
        );
        const ledger = createEntryAgeLedger(store);
        expect(ledger.observeAll([listing(1, ['a', 'c'])], NOW)).toEqual({
            '1': { a: { at: NOW - 900, exact: false }, c: { at: NOW - 200, exact: false } },
        });
        expect(store.peek()['1'].firstSeen).toBe(NOW - 900);
    });

    test('an old record whose positive times are all app submits (exact or uncertain) falls back to the fetch time', () => {
        const store = rawStore(
            JSON.stringify({
                1: {
                    closeTime: NOW + 3600,
                    entered: { a: 0, x: NOW - 500, u: NOW - 400 },
                    pending: null,
                    exact: ['x'],
                    uncertain: ['u'],
                },
            }),
        );
        const ledger = createEntryAgeLedger(store);
        expect(ledger.observeAll([listing(1, ['a', 'x', 'u'])], NOW + 60)).toMatchObject({
            '1': { a: { at: NOW + 60, exact: false }, x: { at: NOW - 500, exact: true } },
        });
        expect(store.peek()['1'].firstSeen).toBe(NOW + 60);
        // A record with nothing positive at all too.
        const empty = createEntryAgeLedger(
            rawStore(JSON.stringify({ 1: { closeTime: NOW + 3600, entered: { a: 0, b: 'soon' }, pending: null } })),
        );
        expect(empty.observeAll([listing(1, ['a'])], NOW + 60)).toEqual({ '1': { a: { at: NOW + 60, exact: false } } });
    });

    test.each<[string, unknown, number]>([
        ['a number', NOW - 300, NOW - 300],
        ['a numeric string', String(NOW - 300), 0],
        ['a negative number', -5, 0],
        ['NaN (stored as null)', Number.NaN, 0],
        ['null', null, 0],
        ['a missing value', undefined, 0],
    ])('a stored firstSeen that is %s reads as the clamped value', (_label, stored, expected) => {
        const store = rawStore(
            JSON.stringify({ 1: { closeTime: NOW + 3600, entered: { a: 0 }, pending: null, firstSeen: stored } }),
        );
        // A write that does not observe carries the field on as it was read.
        createEntryAgeLedger(store).markSubmitted(1, ['x'], NOW);
        expect(store.peek()['1'].firstSeen).toBe(expected);
    });

    test.each<[string, unknown, number]>([
        ['a number', NOW - 300, NOW - 300],
        ['a numeric string', String(NOW - 300), NOW + 60],
        ['a negative number', -5, NOW + 60],
        ['NaN (stored as null)', Number.NaN, NOW + 60],
        ['null', null, NOW + 60],
        ['a missing value', undefined, NOW + 60],
        ['zero', 0, NOW + 60],
    ])('a stored firstSeen that is %s is kept only when it is a positive number', (_label, stored, expected) => {
        const store = rawStore(
            JSON.stringify({ 1: { closeTime: NOW + 3600, entered: { a: 0 }, pending: null, firstSeen: stored } }),
        );
        // A second entry makes the observation a change, so the record is written out.
        createEntryAgeLedger(store).observe(listing(1, ['a', 'b']), NOW + 60);
        expect(store.peek()['1'].firstSeen).toBe(expected);
    });

    test('an entry the record does not hold shows no time: the record is held to 64 entries', () => {
        const ledger = createMemoryEntryAgeLedger();
        const many = Array.from({ length: 70 }, (_, index) => `m${index}`);
        const times = ledger.observeAll([listing(1, many)], NOW);
        expect(Object.keys(times['1'])).toHaveLength(64);
        expect(times['1'].m0).toEqual({ at: NOW, exact: false });
    });

    test('a first sighting at time 0 has nothing to show', () => {
        expect(createMemoryEntryAgeLedger().observeAll([listing(1, ['a'])], 0)).toEqual({});
    });

    test('bounds and validates persisted exact ids', () => {
        const ids = Array.from({ length: 70 }, (_, index) => `id-${index}`);
        const store = rawStore(
            JSON.stringify({
                1: {
                    closeTime: NOW + 3600,
                    entered: Object.fromEntries(ids.map((id) => [id, NOW])),
                    pending: null,
                    exact: [7, ...ids],
                    observed: 'yes',
                },
            }),
        );
        const ledger = createEntryAgeLedger(store);
        ledger.markUncertain(listing(1, []), 'u', NOW);
        const record = store.peek()['1'];
        expect(record.exact).toHaveLength(63);
        expect(record.exact.every((id) => id.startsWith('id-'))).toBe(true);
        expect(record.observed).toBe(true);
    });

    test('a record keeps at most 64 entered ids: the listing first, then pending, then exact', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        const listed = Array.from({ length: 60 }, (_, index) => `l${index}`);
        const exactIds = Array.from({ length: 10 }, (_, index) => `x${index}`);
        ledger.markPending(listing(1, []), 'p', NOW);
        ledger.markSubmitted(1, exactIds, NOW + 1);
        ledger.observe(listing(1, listed), NOW + 2);
        const record = store.peek()['1'];
        expect(Object.keys(record.entered)).toHaveLength(64);
        expect(listed.every((id) => id in record.entered)).toBe(true);
        expect(record.entered.p).toBe(NOW);
        expect(record.pending).toBe('p');
        expect(record.exact).toHaveLength(4);
        expect(record.exact.every((id) => id in record.entered)).toBe(true);
    });

    test('a submit of more photos than a record holds keeps the newest first', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        const many = Array.from({ length: 70 }, (_, index) => `m${index}`);
        ledger.markSubmitted(1, many, NOW);
        const record = store.peek()['1'];
        expect(Object.keys(record.entered)).toHaveLength(64);
        expect(record.exact).toHaveLength(64);
        ledger.markUncertain(listing(1, []), 'u', NOW);
        expect(store.peek()['1'].exact).toHaveLength(64);
    });

    test('observeAll reads once and writes at most once for any number of challenges', () => {
        const store = rawStore(null);
        const readRaw = jest.spyOn(store, 'readRaw');
        const ledger = createEntryAgeLedger(store);
        const fetched = [listing(1, ['a']), listing(2, ['b']), invalid<Challenge>({ close_time: NOW + 60 })];
        ledger.observeAll(fetched, NOW);
        expect(store.writeRaw).toHaveBeenCalledTimes(1);
        // The read for the answer, and the one the write makes from the stored value.
        expect(readRaw).toHaveBeenCalledTimes(2);
        ledger.observeAll(fetched, NOW + 1);
        expect(store.writeRaw).toHaveBeenCalledTimes(1);
    });
});

// The app window on Android: a write is only in the cache once it is saved, and is saved behind a queue.
const windowStore = (initial: string | null) => {
    let cache = initial;
    const queue: Array<{ update: (current: string | null) => string | null; settle: (r: ThroughResult) => void }> = [];
    const listeners: Array<() => void> = [];
    return {
        readRaw: () => cache,
        writeRaw: jest.fn((data: string) => {
            cache = data;
        }),
        updateThrough: jest.fn(
            (update: (current: string | null) => string | null) =>
                new Promise<ThroughResult>((settle) => queue.push({ update, settle })),
        ),
        onDiscard: (listener: () => void) => {
            listeners.push(listener);
        },
        /** Saves the nth queued write on the cache as it is now (or settles it as `failed`/`aborted` without saving). */
        land: (index = 0, outcome: ThroughResult = 'saved') => {
            const { update, settle } = queue[index];
            if (outcome === 'saved') {
                const data = update(cache);
                if (data !== null) cache = data;
            }
            settle(outcome);
        },
        /** What a refresh brings in: the service saved something. */
        serviceWrote: (data: string) => {
            cache = data;
        },
        discard: () => listeners.forEach((listener) => listener()),
        stored: () => cache,
    };
};
// Routes the ledger's warnings to a spy until `restore` puts the shared logger mock back.
const captureWarnings = () => {
    const warning = jest.fn();
    const withCategory = jest.mocked(logger.withCategory);
    const original = withCategory.getMockImplementation();
    withCategory.mockImplementation(() => invalid({ warning }));
    return {
        warning,
        restore: () => {
            if (original) withCategory.mockImplementation(original);
        },
    };
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('entry-age ledger on the Android app window', () => {
    test('a write is read back at once, before its save has landed', () => {
        const store = windowStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.observe(listing(1, ['a']), NOW);
        ledger.observe(listing(1, ['a', 'b']), NOW + 60);
        expect(ledger.enteredAt(1, 'b')).toBe(NOW + 60);
        ledger.markUncertain(listing(1, ['a', 'b']), 'b', NOW + 61);
        expect(ledger.isUncertain(1, 'b')).toBe(true);
        ledger.markPending(listing(1, ['a', 'b']), 'p', NOW + 62);
        expect(ledger.pending(1)).toBe('p');
        ledger.clearPending(1, 'p', NOW + 63);
        expect(ledger.pending(1)).toBeNull();
        expect(store.stored()).toBeNull();
        expect(store.updateThrough).toHaveBeenCalledTimes(5);
        expect(store.writeRaw).not.toHaveBeenCalled();
    });

    test('once saved, the value is what the cache holds, and the change is not applied twice over it', async () => {
        const store = windowStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.observe(listing(1, ['a', 'x']), NOW);
        ledger.markSubmitted(1, ['x'], NOW);
        store.land(0);
        // Saved, not yet forgotten: a change that holds already makes no further change.
        expect(ledger.enteredAt(1, 'a')).toBe(0);
        store.land(1);
        await flush();
        expect(ledger.enteredAt(1, 'x')).toBe(NOW);
        store.serviceWrote(JSON.stringify({}));
        expect(ledger.enteredAt(1, 'x')).toBeNull();
    });

    test('two overlapping writes keep the later change visible while the earlier one settles or retries', async () => {
        const store = windowStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.observe(listing(1, ['a']), NOW);
        ledger.markSubmitted(1, ['x'], NOW + 10);
        // The service saved a record of its own before either landed.
        store.serviceWrote(
            JSON.stringify({
                2: {
                    closeTime: NOW + 3600,
                    entered: { s: NOW },
                    pending: null,
                    exact: ['s'],
                    memberId: null,
                    observed: false,
                },
            }),
        );
        expect(ledger.enteredAt(2, 's')).toBe(NOW);
        expect(ledger.enteredAt(1, 'x')).toBe(NOW + 10);
        store.land(0);
        await flush();
        expect(ledger.enteredAt(1, 'x')).toBe(NOW + 10);
        expect(ledger.enteredAt(2, 's')).toBe(NOW);
        store.land(1);
        await flush();
        expect(ledger.enteredAt(1, 'x')).toBe(NOW + 10);
        expect(ledger.enteredAt(2, 's')).toBe(NOW);
        expect(ledger.enteredAt(1, 'a')).toBe(0);
    });

    test('an earlier write failing while a later one saves keeps both changes in memory, and only the later is saved', async () => {
        const store = windowStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.markSubmitted(1, ['early'], NOW);
        ledger.markSubmitted(1, ['late'], NOW + 1);
        store.land(0, 'failed');
        await flush();
        store.land(1);
        await flush();
        expect(ledger.enteredAt(1, 'early')).toBe(NOW);
        expect(ledger.enteredAt(1, 'late')).toBe(NOW + 1);
        expect(store.stored()).not.toContain('early');
        expect(store.stored()).toContain('late');
    });

    test('a failed write stays applied until a refresh that succeeds; the caller never throws', async () => {
        const store = windowStore(null);
        const refresh = jest.fn(async () => true);
        const ledger = createEntryAgeLedger(store, refresh);
        expect(() => ledger.markPending(listing(1, []), 'p', NOW)).not.toThrow();
        store.land(0, 'failed');
        await flush();
        expect(ledger.pending(1)).toBe('p');
        await ledger.refresh();
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    test('at a refresh that succeeds a failed mark is made again on the fresh value, and a failed observation is dropped', async () => {
        const store = windowStore(null);
        const ledger = createEntryAgeLedger(store, async () => true);
        ledger.observe(listing(1, ['a']), NOW);
        ledger.markPending(listing(2, []), 'p', NOW);
        ledger.markSubmitted(3, ['x'], NOW);
        ledger.markUncertain(listing(4, []), 'u', NOW);
        ledger.clearPending(2, 'p', NOW + 1);
        for (let index = 0; index < 5; index++) store.land(index, 'failed');
        await flush();
        expect(store.updateThrough).toHaveBeenCalledTimes(5);
        // The service saved a record of its own while the window's writes were failing.
        store.serviceWrote(
            JSON.stringify({
                9: {
                    closeTime: NOW + 3600,
                    entered: { s: 0 },
                    pending: null,
                    exact: [],
                    memberId: null,
                    observed: true,
                },
            }),
        );

        await ledger.refresh();

        // The four marks were issued again (not the observation), and read at once.
        expect(store.updateThrough).toHaveBeenCalledTimes(9);
        expect(ledger.pending(2)).toBeNull();
        expect(ledger.enteredAt(2, 'p')).toBe(NOW);
        expect(ledger.enteredAt(3, 'x')).toBe(NOW);
        expect(ledger.isUncertain(4, 'u')).toBe(true);
        expect(ledger.enteredAt(1, 'a')).toBeNull();
        expect(ledger.enteredAt(9, 's')).toBe(0);
        // Landing them saves the fresh value with the marks made on it.
        for (let index = 5; index < 9; index++) store.land(index);
        await flush();
        const saved = parseJsonAs(store.stored()!, isRecordOf(isEntryAgeRecord));
        expect(Object.keys(saved).sort()).toEqual(['2', '3', '4', '9']);
        expect(saved['2'].pending).toBeNull();
    });

    test('a mark after a failed one is made again with it, in order: a pending photo that was cleared stays cleared', async () => {
        const store = windowStore(null);
        const ledger = createEntryAgeLedger(store, async () => true);
        ledger.markPending(listing(1, []), 'p', NOW);
        // The boost lands and gives up on the photo while the mark is unsaved.
        ledger.clearPending(1, 'p', NOW + 5);
        store.land(0, 'failed');
        // Against a value that never got the photo, the clear changes nothing.
        store.land(1, 'aborted');
        await flush();
        expect(ledger.pending(1)).toBeNull();

        await ledger.refresh();

        expect(store.updateThrough).toHaveBeenCalledTimes(4);
        expect(ledger.pending(1)).toBeNull();
        store.land(2);
        store.land(3);
        await flush();
        expect(ledger.pending(1)).toBeNull();
        expect(parseJsonAs(store.stored()!, isRecordOf(isEntryAgeRecord))['1']).toMatchObject({ pending: null });
        // Nothing is kept any more: the log holds no failed change.
        store.serviceWrote('{}');
        expect(ledger.enteredAt(1, 'p')).toBeNull();
    });

    test('a mark still in flight while a refresh runs is made again with the failed one, in order', async () => {
        const store = windowStore(null);
        let finishRefresh: (read: boolean) => void = () => {};
        const ledger = createEntryAgeLedger(store, () => new Promise<boolean>((resolve) => (finishRefresh = resolve)));
        ledger.markPending(listing(1, []), 'p', NOW);
        store.land(0, 'failed');
        await flush();

        const refreshing = ledger.refresh();
        // The boost lands and gives up on the photo while the refresh reads Preferences.
        ledger.clearPending(1, 'p', NOW + 5);
        expect(ledger.pending(1)).toBeNull();
        finishRefresh(true);
        await refreshing;

        // Both are made again on the fresh value, the clear after the mark; the clear that was in flight is theirs now.
        expect(store.updateThrough).toHaveBeenCalledTimes(4);
        expect(ledger.pending(1)).toBeNull();
        store.land(1, 'aborted');
        store.land(2);
        store.land(3);
        await flush();
        expect(ledger.pending(1)).toBeNull();
        expect(parseJsonAs(store.stored()!, isRecordOf(isEntryAgeRecord))['1']).toMatchObject({ pending: null });
    });

    test('a clear names its photo: it does not erase another pending photo, as a clear made again could', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.markPending(listing(1, []), 'service-photo', NOW);
        ledger.clearPending(1, 'p', NOW + 5);
        expect(ledger.pending(1)).toBe('service-photo');
        ledger.clearPending(1, 'service-photo', NOW + 6);
        expect(ledger.pending(1)).toBeNull();
    });

    test('marks that landed after a failed one are not kept once it is gone, and without one they never are', async () => {
        const store = windowStore(null);
        const ledger = createEntryAgeLedger(store, async () => true);
        ledger.markSubmitted(1, ['x'], NOW);
        store.land(0);
        await flush();
        store.serviceWrote('{}');
        // It landed with no failed mark in the log: it is not replayed.
        await ledger.refresh();
        expect(store.updateThrough).toHaveBeenCalledTimes(1);
        expect(ledger.enteredAt(1, 'x')).toBeNull();
    });

    test('a failed write stays applied through a refresh that fails, which is logged', async () => {
        const store = windowStore(null);
        const { warning, restore } = captureWarnings();
        const ledger = createEntryAgeLedger(
            store,
            jest.fn().mockResolvedValueOnce(false).mockRejectedValueOnce('boom'),
        );
        ledger.markPending(listing(1, []), 'p', NOW);
        store.land(0, 'failed');
        await flush();
        await ledger.refresh();
        await ledger.refresh();
        restore();
        expect(ledger.pending(1)).toBe('p');
        expect(warning).toHaveBeenCalledTimes(2);
        // The kind of error, not its message.
        expect(warning).toHaveBeenLastCalledWith(
            'entry-age ledger not refreshed (not an error) — using the cached copy',
            null,
        );
    });

    test('a refresh without a store to refresh does nothing', async () => {
        await expect(createMemoryEntryAgeLedger().refresh()).resolves.toBeUndefined();
    });

    test('a declined write (aborted) is not kept applied', async () => {
        const store = windowStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.markPending(listing(1, []), 'p', NOW);
        store.land(0, 'aborted');
        await flush();
        expect(ledger.pending(1)).toBeNull();
    });

    test('a wipe of local data clears what is waiting, so nothing is applied or written back after it', async () => {
        const store = windowStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.markPending(listing(1, []), 'p', NOW);
        expect(ledger.pending(1)).toBe('p');
        store.discard();
        expect(ledger.pending(1)).toBeNull();
        store.land(0, 'aborted');
        await flush();
        expect(ledger.pending(1)).toBeNull();
    });

    test('a write that rejects is logged and forgotten', async () => {
        const { warning, restore } = captureWarnings();
        const store = { ...windowStore(null), updateThrough: jest.fn().mockRejectedValue(new Error('no preferences')) };
        const ledger = createEntryAgeLedger(store);
        ledger.markPending(listing(1, []), 'p', NOW);
        await flush();
        restore();
        expect(warning).toHaveBeenCalledWith('entry-age ledger not written (Error)', null);
        expect(ledger.pending(1)).toBeNull();
    });

    test('a change that throws when applied is skipped and logged, and the rest still read', () => {
        const store = windowStore(null);
        const ledger = createEntryAgeLedger(store);
        let broken = false;
        const flaky = invalid<Challenge>({
            id: 1,
            get close_time() {
                if (broken) throw new Error('late failure');
                return NOW + 3600;
            },
        });
        ledger.markPending(flaky, 'p', NOW);
        ledger.markSubmitted(1, ['x'], NOW + 1);
        expect(ledger.pending(1)).toBe('p');
        broken = true;
        const { warning, restore } = captureWarnings();
        expect(ledger.enteredAt(1, 'x')).toBe(NOW + 1);
        restore();
        // The kind of error, not its message.
        expect(warning).toHaveBeenCalledWith('entry-age change not applied (Error)', null);
    });
});

describe('entry-age ledger over a store that writes at once', () => {
    test('a write made by updateNow is not kept; one that failed stays applied', () => {
        let raw: string | null = null;
        const results: Array<ThroughResult | null> = ['saved', 'failed', null];
        const store = {
            readRaw: () => raw,
            writeRaw: (data: string) => {
                raw = data;
            },
            updateNow: jest.fn((update: (current: string | null) => string | null) => {
                const result = results.shift() ?? null;
                if (result === 'saved') raw = update(raw);
                return result;
            }),
        };
        const ledger = createEntryAgeLedger(store);
        ledger.markPending(listing(1, []), 'p', NOW);
        expect(ledger.pending(1)).toBe('p');
        raw = null;
        expect(ledger.pending(1)).toBeNull();
        ledger.markPending(listing(2, []), 'q', NOW);
        expect(ledger.pending(2)).toBe('q');
        // Where the write is only queued (null), the store is written through throughStore.
        ledger.markPending(listing(3, []), 'r', NOW);
        expect(ledger.pending(3)).toBe('r');
    });

    test('a mark that failed at once is made again at a refresh that succeeds', async () => {
        let raw: string | null = null;
        const results: Array<ThroughResult | null> = ['failed', 'saved'];
        const store = {
            readRaw: () => raw,
            writeRaw: jest.fn(),
            updateNow: jest.fn((update: (current: string | null) => string | null) => {
                const result = results.shift() ?? null;
                if (result === 'saved') raw = update(raw);
                return result;
            }),
        };
        const ledger = createEntryAgeLedger(store, async () => true);
        ledger.markPending(listing(1, []), 'p', NOW);
        expect(raw).toBeNull();
        expect(ledger.pending(1)).toBe('p');

        await ledger.refresh();

        expect(store.updateNow).toHaveBeenCalledTimes(2);
        expect(raw).toContain('"pending":"p"');
        expect(ledger.pending(1)).toBe('p');
    });

    test('marks made after a failed one that landed at once are made again with it', async () => {
        let raw: string | null = null;
        const results: Array<ThroughResult | null> = ['failed', 'saved', 'saved', 'saved'];
        const store = {
            readRaw: () => raw,
            writeRaw: jest.fn(),
            updateNow: jest.fn((update: (current: string | null) => string | null) => {
                const result = results.shift() ?? null;
                if (result === 'saved') raw = update(raw) ?? raw;
                return result;
            }),
        };
        const ledger = createEntryAgeLedger(store, async () => true);
        ledger.markPending(listing(1, []), 'p', NOW);
        ledger.clearPending(1, 'p', NOW + 5);
        expect(ledger.pending(1)).toBeNull();

        await ledger.refresh();

        expect(store.updateNow).toHaveBeenCalledTimes(4);
        expect(ledger.pending(1)).toBeNull();
        expect(raw).toContain('"pending":null');
    });
});
