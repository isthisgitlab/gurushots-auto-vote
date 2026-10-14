/**
 * The photo-library listing cache: per account (by token hash) and per challenge, expiring after
 * LIBRARY_FRESH_MS, capped, with a newest-of-all listing kept for previews, frozen entries and copied answers.
 */

import type * as libraryCacheModule from '../../src/ts/services/libraryCache';

type Debug = jest.Mock<void, [string, unknown]>;

jest.mock('../../src/ts/logger', () => {
    const level = { debug: jest.fn() };
    return { withCategory: jest.fn(() => level), __level: level };
});

const {
    readFresh,
    readLatest,
    writeListing,
    dropContext,
    dropEpoch,
    clearLibraryCache,
    LIBRARY_FRESH_MS,
    MAX_LIBRARY_ENTRIES,
} = require('../../src/ts/services/libraryCache') as typeof libraryCacheModule;
const { __level: log } = require('../../src/ts/logger') as { __level: { debug: Debug } };

const T0 = 1_000_000;

const listingAt = (readAtMs: number, id = 'a'): libraryCacheModule.TimedListing => ({
    photos: [{ id, labels: ['Pink'], allowed: true, message: 'ok', uploadDate: 5 }],
    memberId: 'm',
    wonIds: ['w1'],
    wonCount: 1,
    truncated: false,
    allowedKnown: true,
    readAtMs,
});

const photoIds = (listing: libraryCacheModule.TimedListing | null) => listing?.photos.map((photo) => photo.id);

beforeEach(() => {
    jest.clearAllMocks();
    clearLibraryCache();
});

describe('keys', () => {
    test('an account’s listings are kept apart from another account’s, by token', () => {
        writeListing('token-1', '5', listingAt(T0, 'one'), T0);
        writeListing('token-2', '5', listingAt(T0, 'two'), T0);
        expect(photoIds(readFresh('token-1', '5', T0))).toEqual(['one']);
        expect(photoIds(readFresh('token-2', '5', T0))).toEqual(['two']);
        expect(readFresh('token-3', '5', T0)).toBeNull();
    });

    test('the no-challenge key is its own: not a challenge named “none”, and an id is the same as a number', () => {
        writeListing('t', null, listingAt(T0, 'plain'), T0);
        writeListing('t', 'none', listingAt(T0, 'named'), T0);
        writeListing('t', 7, listingAt(T0, 'seven'), T0);
        expect(photoIds(readFresh('t', null, T0))).toEqual(['plain']);
        expect(photoIds(readFresh('t', 'none', T0))).toEqual(['named']);
        expect(photoIds(readFresh('t', '7', T0))).toEqual(['seven']);
    });

    test('a key never holds the token', () => {
        writeListing('secret-token-value', '5', listingAt(T0), T0);
        expect(JSON.stringify(log.debug.mock.calls)).not.toContain('secret-token-value');
    });
});

describe('expiry', () => {
    test('an entry answers up to, but not at, LIBRARY_FRESH_MS after its read began', () => {
        writeListing('t', '5', listingAt(T0), T0);
        expect(readFresh('t', '5', T0 + LIBRARY_FRESH_MS - 1)).not.toBeNull();
        expect(readFresh('t', '5', T0 + LIBRARY_FRESH_MS)).toBeNull();
        // Once evicted it is gone for good, whatever the clock says.
        expect(readFresh('t', '5', T0)).toBeNull();
    });

    test('a write evicts every entry that has expired', () => {
        writeListing('t', '1', listingAt(T0), T0);
        writeListing('t', '2', listingAt(T0 + 1000), T0 + 1000);
        writeListing('t', '3', listingAt(T0 + LIBRARY_FRESH_MS), T0 + LIBRARY_FRESH_MS);
        expect(readFresh('t', '1', T0 + LIBRARY_FRESH_MS)).toBeNull();
        expect(readFresh('t', '2', T0 + LIBRARY_FRESH_MS)).not.toBeNull();
    });

    test('the age is from when the read began, not from when it was kept', () => {
        writeListing('t', '5', listingAt(T0), T0 + 20_000);
        expect(readFresh('t', '5', T0 + LIBRARY_FRESH_MS - 1)).not.toBeNull();
        expect(readFresh('t', '5', T0 + LIBRARY_FRESH_MS)).toBeNull();
    });
});

describe('the cap', () => {
    test('holds MAX_LIBRARY_ENTRIES, dropping the one read longest ago whatever the order of the writes', () => {
        const reads = [50, 10, 40, 30, 20, 60];
        reads.forEach((offset, i) => writeListing('t', String(i), listingAt(T0 + offset), T0 + 100));
        expect(MAX_LIBRARY_ENTRIES).toBe(reads.length);
        writeListing('t', 'new', listingAt(T0 + 70), T0 + 100);
        // The entry read at +10 is the oldest.
        expect(readFresh('t', '1', T0 + 100)).toBeNull();
        for (const key of ['0', '2', '3', '4', '5', 'new']) expect(readFresh('t', key, T0 + 100)).not.toBeNull();
    });

    test('writing a challenge again replaces its entry instead of adding one', () => {
        for (let i = 0; i < MAX_LIBRARY_ENTRIES; i += 1) writeListing('t', String(i), listingAt(T0 + i), T0 + 100);
        writeListing('t', '0', listingAt(T0 + 90, 'again'), T0 + 100);
        for (let i = 0; i < MAX_LIBRARY_ENTRIES; i += 1) expect(readFresh('t', String(i), T0 + 100)).not.toBeNull();
        expect(photoIds(readFresh('t', '0', T0 + 100))).toEqual(['again']);
    });
});

describe('the newest listing', () => {
    test('is the one read most recently for any challenge, and outlives eviction', () => {
        writeListing('t', '1', listingAt(T0, 'old'), T0);
        writeListing('t', '2', listingAt(T0 + 5000, 'new'), T0 + 5000);
        writeListing('t', '3', listingAt(T0 + 1000, 'late-write-of-an-older-read'), T0 + 6000);
        expect(photoIds(readLatest('t'))).toEqual(['new']);
        expect(readFresh('t', '2', T0 + 5000 + LIBRARY_FRESH_MS)).toBeNull();
        expect(photoIds(readLatest('t'))).toEqual(['new']);
    });

    test('outlives a drop of its challenge', () => {
        writeListing('t', '1', listingAt(T0, 'kept'), T0);
        dropContext('t', '1');
        expect(readFresh('t', '1', T0)).toBeNull();
        expect(photoIds(readLatest('t'))).toEqual(['kept']);
    });

    test('belongs to one account: another’s write replaces it, and a stranger gets none', () => {
        writeListing('a', '1', listingAt(T0, 'a-photo'), T0);
        expect(readLatest('b')).toBeNull();
        writeListing('b', '1', listingAt(T0 - 5000, 'b-photo'), T0);
        expect(photoIds(readLatest('b'))).toEqual(['b-photo']);
        expect(readLatest('a')).toBeNull();
    });

    test('is empty once everything is cleared', () => {
        writeListing('t', '1', listingAt(T0), T0);
        clearLibraryCache();
        expect(readLatest('t')).toBeNull();
        expect(readFresh('t', '1', T0)).toBeNull();
    });
});

describe('drops', () => {
    test('a drop forgets that challenge’s entry only, and moves the epoch each time', () => {
        writeListing('t', '1', listingAt(T0, 'one'), T0);
        writeListing('t', '2', listingAt(T0, 'two'), T0);
        const before = dropEpoch();
        dropContext('t', '1');
        expect(readFresh('t', '1', T0)).toBeNull();
        expect(readFresh('t', '2', T0)).not.toBeNull();
        expect(dropEpoch()).toBe(before + 1);
        dropContext('t', '1');
        expect(dropEpoch()).toBe(before + 2);
    });

    test('writes and reads leave the epoch alone', () => {
        const before = dropEpoch();
        writeListing('t', '1', listingAt(T0), T0);
        readFresh('t', '1', T0);
        readLatest('t');
        expect(dropEpoch()).toBe(before);
    });

    test('any drop moves it, whichever account’s or challenge’s: a read in flight writes nothing after it', () => {
        const before = dropEpoch();
        dropContext('a', '1');
        dropContext('b', null);
        expect(dropEpoch()).toBe(before + 2);
    });

    test('it only ever rises, however many drops there are, and clearing the cache does not wind it back', () => {
        const before = dropEpoch();
        for (let i = 0; i < 300; i += 1) dropContext('t', String(i));
        expect(dropEpoch()).toBe(before + 300);
        clearLibraryCache();
        expect(dropEpoch()).toBe(before + 300);
    });
});

describe('copies', () => {
    test('what a caller does to the listing it wrote, or to an answer, never reaches what is kept', () => {
        const written = listingAt(T0);
        writeListing('t', '5', written, T0);
        written.photos[0].labels.push('mutated');
        written.photos.push({ id: 'extra', labels: [], allowed: true, message: null, uploadDate: null });
        written.wonIds.push('extra');
        const first = readFresh('t', '5', T0);
        first?.photos[0].labels.push('mutated');
        first?.photos.pop();
        first?.wonIds.push('extra');
        const latest = readLatest('t');
        latest?.photos.pop();
        for (const answer of [readFresh('t', '5', T0), readLatest('t')]) {
            expect(answer?.photos).toEqual([
                { id: 'a', labels: ['Pink'], allowed: true, message: 'ok', uploadDate: 5 },
            ]);
            expect(answer?.wonIds).toEqual(['w1']);
        }
    });
});

describe('logging', () => {
    test('says only what happened, never an id, a label or a key', () => {
        writeListing('t', 'challenge-5', listingAt(T0, 'photo-id-1'), T0);
        dropContext('t', 'challenge-5');
        expect(log.debug.mock.calls).toEqual([
            ['Library cache: stored', null],
            ['Library cache: dropped', null],
        ]);
    });
});
