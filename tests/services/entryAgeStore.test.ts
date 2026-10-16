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
    memberId: nullable(isString),
    observed: isBoolean,
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
        expect(times).toEqual({ '1': { x: { at: NOW, exact: true } } });
        expect(store.peek()['1'].observed).toBe(true);
    });

    test('an entry first shown by a later fetch gets that fetch time, approximately; an old one stays unknown', () => {
        const ledger = createMemoryEntryAgeLedger();
        expect(ledger.observeAll([listing(1, ['a'])], NOW)).toEqual({});
        expect(ledger.observeAll([listing(1, ['a', 'b'])], NOW + 60)).toEqual({
            '1': { b: { at: NOW + 60, exact: false } },
        });
        expect(ledger.observeAll([listing(1, ['a', 'b'])], NOW + 120)).toEqual({
            '1': { b: { at: NOW + 60, exact: false } },
        });
    });

    test('the only entry of a challenge first seen goes in when the member joined (approximately)', () => {
        const ledger = createMemoryEntryAgeLedger();
        expect(ledger.observeAll([listing(1, ['a'], { joined: NOW - 500 })], NOW)).toEqual({
            '1': { a: { at: NOW - 500, exact: false } },
        });
        // Two entries: which one joining submitted is not known.
        expect(ledger.observeAll([listing(2, ['a', 'b'], { joined: NOW - 500 })], NOW)).toEqual({});
        expect(ledger.observeAll([listing(3, ['a'], { joined: 0 })], NOW)).toEqual({});
    });

    test('a record a submit made before any fetch leaves the other entries unknown and its placeholder close time is replaced', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.markSubmitted(1, ['x'], NOW);
        expect(store.peek()['1']).toMatchObject({ observed: false, memberId: null, closeTime: NOW + 31 * 86400 });
        const times = ledger.observeAll([listing(1, ['a', 'b', 'x'], { closeTime: NOW + 3600 })], NOW + 60);
        expect(times).toEqual({ '1': { x: { at: NOW, exact: true } } });
        expect(store.peek()['1']).toMatchObject({ observed: true, closeTime: NOW + 3600 });
        expect(ledger.enteredAt(1, 'a')).toBe(0);
    });

    test('a record of another account is a first sighting; a missing account on either side keeps the times', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.observe(listing(1, [{ id: 'a', member_id: 'me' }]), NOW);
        ledger.observe(
            listing(1, [
                { id: 'a', member_id: 'me' },
                { id: 'b', member_id: 'me' },
            ]),
            NOW + 60,
        );
        expect(ledger.enteredAt(1, 'b')).toBe(NOW + 60);
        expect(store.peek()['1'].memberId).toBe('me');
        // A listing that names no account leaves the record's account, and the times.
        ledger.observe(listing(1, ['a', 'b', 'c']), NOW + 120);
        expect(store.peek()['1'].memberId).toBe('me');
        expect(ledger.enteredAt(1, 'b')).toBe(NOW + 60);
        expect(ledger.enteredAt(1, 'c')).toBe(NOW + 120);
        // Another account's listing: nothing is known of when its entries went in.
        ledger.observe(
            listing(1, [
                { id: 'b', member_id: 'other' },
                { id: 'z', member_id: 'other' },
            ]),
            NOW + 180,
        );
        expect(store.peek()['1'].memberId).toBe('other');
        expect(ledger.enteredAt(1, 'b')).toBe(0);
        expect(ledger.enteredAt(1, 'z')).toBe(0);
    });

    test('a record without an account takes the listing account and keeps the times', () => {
        const store = rawStore(null);
        const ledger = createEntryAgeLedger(store);
        ledger.observe(listing(1, ['a']), NOW);
        ledger.observe(listing(1, ['a', 'b']), NOW + 60);
        ledger.observe(
            listing(1, [
                { id: 'a', member_id: 'me' },
                { id: 'b', member_id: 'me' },
            ]),
            NOW + 120,
        );
        expect(store.peek()['1'].memberId).toBe('me');
        expect(ledger.enteredAt(1, 'b')).toBe(NOW + 60);
    });

    test('an exact photo missing from a lagging listing keeps its time and flag for the grace, then goes', () => {
        const ledger = createMemoryEntryAgeLedger();
        ledger.observe(listing(1, ['a']), NOW);
        ledger.markSubmitted(1, ['x'], NOW + 10);
        expect(ledger.observeAll([listing(1, ['a'])], NOW + 100)).toEqual({});
        expect(ledger.enteredAt(1, 'x')).toBe(NOW + 10);
        expect(ledger.observeAll([listing(1, ['a', 'x'])], NOW + 200)).toEqual({
            '1': { x: { at: NOW + 10, exact: true } },
        });
        ledger.observe(listing(1, ['a']), NOW + 300);
        ledger.observe(listing(1, ['a']), NOW + 700);
        expect(ledger.enteredAt(1, 'x')).toBeNull();
        // Back after the grace it is an entry like any other: first seen now, not exact.
        expect(ledger.observeAll([listing(1, ['a', 'x'])], NOW + 800)).toEqual({
            '1': { x: { at: NOW + 800, exact: false } },
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
            '1': { b: { at: NOW + 120, exact: true } },
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
        expect(ledger.observeAll([listing(1, ['a', 'p'])], NOW + 5)).toEqual({ '1': { p: { at: NOW, exact: true } } });
    });

    test('a file from before the exact times reads with the fields it lacks', () => {
        const store = rawStore(
            JSON.stringify({ 1: { closeTime: NOW + 3600, entered: { a: NOW }, pending: null, uncertain: ['a'] } }),
        );
        const ledger = createEntryAgeLedger(store);
        expect(ledger.observeAll([listing(1, ['a'])], NOW + 60)).toEqual({ '1': { a: { at: NOW, exact: false } } });
        expect(store.writeRaw).not.toHaveBeenCalled();
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
                    memberId: 12,
                    observed: 'yes',
                },
            }),
        );
        const ledger = createEntryAgeLedger(store);
        ledger.markUncertain(listing(1, []), 'u', NOW);
        const record = store.peek()['1'];
        expect(record.exact).toHaveLength(63);
        expect(record.exact.every((id) => id.startsWith('id-'))).toBe(true);
        expect(record.memberId).toBeNull();
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
        ledger.clearPending(1, NOW + 63);
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
        ledger.markSubmitted(1, ['first'], NOW);
        ledger.markSubmitted(1, ['second'], NOW + 1);
        store.land(0, 'failed');
        await flush();
        store.land(1);
        await flush();
        expect(ledger.enteredAt(1, 'first')).toBe(NOW);
        expect(ledger.enteredAt(1, 'second')).toBe(NOW + 1);
        expect(store.stored()).not.toContain('first');
        expect(store.stored()).toContain('second');
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
        expect(ledger.pending(1)).toBeNull();
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
        expect(warning).toHaveBeenLastCalledWith(expect.stringContaining('boom'), null);
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
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('no preferences'), null);
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
        expect(warning).toHaveBeenCalledWith(expect.stringContaining('late failure'), null);
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
});
