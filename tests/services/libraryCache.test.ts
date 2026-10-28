/**
 * The photo-library listing cache: per challenge and per usage, expiring after
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
    dropChallenge,
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
    nextStart: 100,
    allowedKnown: true,
    readAtMs,
});

const photoIds = (listing: libraryCacheModule.TimedListing | null) => listing?.photos.map((photo) => photo.id);

beforeEach(() => {
    jest.clearAllMocks();
    clearLibraryCache();
});

describe('keys', () => {
    test('a challenge’s submit and swap listings are kept apart, and submit is the default', () => {
        writeListing('5', listingAt(T0, 'submit-photo'), undefined, T0);
        expect(photoIds(readFresh('5', 'swap', T0))).toBeUndefined();
        writeListing('5', listingAt(T0, 'swap-photo'), 'swap', T0);
        expect(photoIds(readFresh('5', undefined, T0))).toEqual(['submit-photo']);
        expect(photoIds(readFresh('5', 'submit', T0))).toEqual(['submit-photo']);
        expect(photoIds(readFresh('5', 'swap', T0))).toEqual(['swap-photo']);
    });

    test('the newest listing, kept for previews, is served whichever usage it was read for', () => {
        writeListing('5', listingAt(T0, 'swap-photo'), 'swap', T0);
        expect(readFresh('5', 'submit', T0)).toBeNull();
        expect(photoIds(readLatest())).toEqual(['swap-photo']);
    });

    test('the no-challenge key is its own: not a challenge named “none”, and an id is the same as a number', () => {
        writeListing(null, listingAt(T0, 'plain'), 'submit', T0);
        writeListing('none', listingAt(T0, 'named'), 'submit', T0);
        writeListing(7, listingAt(T0, 'seven'), 'submit', T0);
        expect(photoIds(readFresh(null, 'submit', T0))).toEqual(['plain']);
        expect(photoIds(readFresh('none', 'submit', T0))).toEqual(['named']);
        expect(photoIds(readFresh('7', 'submit', T0))).toEqual(['seven']);
    });
});

describe('expiry', () => {
    test('an entry answers up to, but not at, LIBRARY_FRESH_MS after its read began', () => {
        writeListing('5', listingAt(T0), 'submit', T0);
        expect(readFresh('5', 'submit', T0 + LIBRARY_FRESH_MS - 1)).not.toBeNull();
        expect(readFresh('5', 'submit', T0 + LIBRARY_FRESH_MS)).toBeNull();
        // Once evicted it is gone for good, whatever the clock says.
        expect(readFresh('5', 'submit', T0)).toBeNull();
    });

    test('a write evicts every entry that has expired', () => {
        writeListing('1', listingAt(T0), 'submit', T0);
        writeListing('2', listingAt(T0 + 1000), 'submit', T0 + 1000);
        writeListing('3', listingAt(T0 + LIBRARY_FRESH_MS), 'submit', T0 + LIBRARY_FRESH_MS);
        expect(readFresh('1', 'submit', T0 + LIBRARY_FRESH_MS)).toBeNull();
        expect(readFresh('2', 'submit', T0 + LIBRARY_FRESH_MS)).not.toBeNull();
    });

    test('the age is from when the read began, not from when it was kept', () => {
        writeListing('5', listingAt(T0), 'submit', T0 + 20_000);
        expect(readFresh('5', 'submit', T0 + LIBRARY_FRESH_MS - 1)).not.toBeNull();
        expect(readFresh('5', 'submit', T0 + LIBRARY_FRESH_MS)).toBeNull();
    });
});

describe('the cap', () => {
    test('holds MAX_LIBRARY_ENTRIES, dropping the one read longest ago whatever the order of the writes', () => {
        // Read times in a scrambled order (5 and 12 share no factor, so every offset 10..120 appears once).
        const reads = Array.from({ length: MAX_LIBRARY_ENTRIES }, (_, i) => (((i * 5) % MAX_LIBRARY_ENTRIES) + 1) * 10);
        reads.forEach((offset, i) => writeListing(String(i), listingAt(T0 + offset), 'submit', T0 + 200));
        writeListing('new', listingAt(T0 + 130), 'submit', T0 + 200);
        const oldest = String(reads.indexOf(10));
        expect(readFresh(oldest, 'submit', T0 + 200)).toBeNull();
        const kept = [...reads.keys()].map(String).filter((key) => key !== oldest);
        for (const key of [...kept, 'new']) expect(readFresh(key, 'submit', T0 + 200)).not.toBeNull();
    });

    test('counts a challenge’s submit and swap listings as two entries, and drops the oldest of the pairs', () => {
        for (let i = 0; i < MAX_LIBRARY_ENTRIES / 2; i += 1) {
            writeListing(String(i), listingAt(T0 + 2 * i), 'submit', T0 + 100);
            writeListing(String(i), listingAt(T0 + 2 * i + 1), 'swap', T0 + 100);
        }
        writeListing('new', listingAt(T0 + 50), 'swap', T0 + 100);
        // The submit listing of challenge 0 is the oldest pair; its swap listing survives.
        expect(readFresh('0', 'submit', T0 + 100)).toBeNull();
        expect(readFresh('0', 'swap', T0 + 100)).not.toBeNull();
        expect(readFresh('1', 'submit', T0 + 100)).not.toBeNull();
        expect(readFresh('new', 'swap', T0 + 100)).not.toBeNull();
    });

    test('writing a challenge again replaces its entry instead of adding one', () => {
        for (let i = 0; i < MAX_LIBRARY_ENTRIES; i += 1) writeListing(String(i), listingAt(T0 + i), 'submit', T0 + 100);
        writeListing('0', listingAt(T0 + 90, 'again'), 'submit', T0 + 100);
        for (let i = 0; i < MAX_LIBRARY_ENTRIES; i += 1)
            expect(readFresh(String(i), 'submit', T0 + 100)).not.toBeNull();
        expect(photoIds(readFresh('0', 'submit', T0 + 100))).toEqual(['again']);
    });
});

describe('the newest listing', () => {
    test('is the one read most recently for any challenge, and outlives eviction', () => {
        writeListing('1', listingAt(T0, 'old'), 'submit', T0);
        writeListing('2', listingAt(T0 + 5000, 'new'), 'submit', T0 + 5000);
        writeListing('3', listingAt(T0 + 1000, 'late-write-of-an-older-read'), 'submit', T0 + 6000);
        expect(photoIds(readLatest())).toEqual(['new']);
        expect(readFresh('2', 'submit', T0 + 5000 + LIBRARY_FRESH_MS)).toBeNull();
        expect(photoIds(readLatest())).toEqual(['new']);
    });

    test('outlives a drop of its challenge', () => {
        writeListing('1', listingAt(T0, 'kept'), 'submit', T0);
        dropContext('1');
        expect(readFresh('1', 'submit', T0)).toBeNull();
        expect(photoIds(readLatest())).toEqual(['kept']);
    });

    test('is empty once everything is cleared', () => {
        writeListing('1', listingAt(T0), 'submit', T0);
        clearLibraryCache();
        expect(readLatest()).toBeNull();
        expect(readFresh('1', 'submit', T0)).toBeNull();
    });
});

describe('drops', () => {
    test('a drop forgets that challenge’s entry only, and moves the epoch each time', () => {
        writeListing('1', listingAt(T0, 'one'), 'submit', T0);
        writeListing('2', listingAt(T0, 'two'), 'submit', T0);
        const before = dropEpoch();
        dropContext('1');
        expect(readFresh('1', 'submit', T0)).toBeNull();
        expect(readFresh('2', 'submit', T0)).not.toBeNull();
        expect(dropEpoch()).toBe(before + 1);
        dropContext('1');
        expect(dropEpoch()).toBe(before + 2);
    });

    test('a drop forgets the challenge of every usage, and leaves the others', () => {
        writeListing('5', listingAt(T0, 'submit'), 'submit', T0);
        writeListing('5', listingAt(T0, 'swap'), 'swap', T0);
        writeListing('15', listingAt(T0, 'other'), 'swap', T0);
        dropContext('5');
        expect(readFresh('5', 'submit', T0)).toBeNull();
        expect(readFresh('5', 'swap', T0)).toBeNull();
        expect(readFresh('15', 'swap', T0)).not.toBeNull();
    });

    test('dropping a challenge by its id clears both usages, and leaves 15 alone when dropping 5', () => {
        for (const usage of ['submit', 'swap'] as const) {
            writeListing('5', listingAt(T0, 'five'), usage, T0);
            writeListing('15', listingAt(T0, 'fifteen'), usage, T0);
        }
        dropChallenge(5);
        expect(readFresh('5', 'submit', T0)).toBeNull();
        expect(readFresh('5', 'swap', T0)).toBeNull();
        expect(readFresh('15', 'submit', T0)).not.toBeNull();
        expect(readFresh('15', 'swap', T0)).not.toBeNull();
    });

    test('writes and reads leave the epoch alone', () => {
        const before = dropEpoch();
        writeListing('1', listingAt(T0), 'submit', T0);
        readFresh('1', 'submit', T0);
        readLatest();
        expect(dropEpoch()).toBe(before);
    });

    test('any drop moves it, whichever challenge’s: a read in flight writes nothing after it', () => {
        const before = dropEpoch();
        dropContext('1');
        dropContext(null);
        expect(dropEpoch()).toBe(before + 2);
    });

    test('it only ever rises, however many drops there are, and clearing the cache does not wind it back', () => {
        const before = dropEpoch();
        for (let i = 0; i < 300; i += 1) dropContext(String(i));
        expect(dropEpoch()).toBe(before + 300);
        clearLibraryCache();
        expect(dropEpoch()).toBe(before + 300);
    });
});

describe('copies', () => {
    test('what a caller does to the listing it wrote, or to an answer, never reaches what is kept', () => {
        const written = listingAt(T0);
        writeListing('5', written, 'submit', T0);
        written.photos[0].labels.push('mutated');
        written.photos.push({ id: 'extra', labels: [], allowed: true, message: null, uploadDate: null });
        written.wonIds.push('extra');
        const first = readFresh('5', 'submit', T0);
        first?.photos[0].labels.push('mutated');
        first?.photos.pop();
        first?.wonIds.push('extra');
        const latest = readLatest();
        latest?.photos.pop();
        for (const answer of [readFresh('5', 'submit', T0), readLatest()]) {
            expect(answer?.photos).toEqual([
                { id: 'a', labels: ['Pink'], allowed: true, message: 'ok', uploadDate: 5 },
            ]);
            expect(answer?.wonIds).toEqual(['w1']);
        }
    });

    test('nextStart round-trips through a write and a read, frozen against mutation', () => {
        writeListing('5', { ...listingAt(T0), nextStart: 250 }, 'submit', T0);
        expect(readFresh('5', 'submit', T0)?.nextStart).toBe(250);
        expect(readLatest()?.nextStart).toBe(250);
        const answer = readFresh('5', 'submit', T0);
        if (answer) answer.nextStart = 0;
        expect(readFresh('5', 'submit', T0)?.nextStart).toBe(250);
    });
});

describe('logging', () => {
    test('says only what happened, never an id, a label or a key', () => {
        writeListing('challenge-5', listingAt(T0, 'photo-id-1'), 'submit', T0);
        dropContext('challenge-5');
        expect(log.debug.mock.calls).toEqual([
            ['Library cache: stored', null],
            ['Library cache: dropped', null],
        ]);
    });
});
