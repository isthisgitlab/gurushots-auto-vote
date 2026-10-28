/**
 * librarySort.ts — the one list of whole-library orders and the guard over it.
 * The mapping values are the wire literals get_photos_private takes; every
 * other name the endpoint accepts silently falls back to date desc there, so
 * the guard must refuse them.
 */

import type * as librarySortModule from '../src/ts/librarySort';
import { invalid } from './helpers/invalid';

const { LIBRARY_ORDERS, isLibraryOrder, isLoadedSort, orderByUploadDate } =
    require('../src/ts/librarySort') as typeof librarySortModule;

describe('LIBRARY_ORDERS', () => {
    test.each([
        ['votes', { order: 'votes', sort: 'desc' }],
        ['newest', { order: 'date', sort: 'desc' }],
        ['oldest', { order: 'date', sort: 'asc' }],
    ])('%s maps to the fixed wire literals %j', (name, wire) => {
        expect(LIBRARY_ORDERS[invalid<keyof typeof LIBRARY_ORDERS>(name)]).toEqual(wire);
    });

    test('carries exactly the three orders (Achievements stays out until asked for)', () => {
        expect(Object.keys(LIBRARY_ORDERS).sort()).toEqual(['newest', 'oldest', 'votes']);
    });
});

describe('isLibraryOrder', () => {
    test.each(['votes', 'newest', 'oldest'])('accepts %s', (order) => {
        expect(isLibraryOrder(order)).toBe(true);
    });

    test.each([
        ['toString'],
        ['constructor'],
        ['hasOwnProperty'],
        ['valueOf'],
        ['__proto__'],
        ['__defineGetter__'],
        ['Votes'],
        [''],
        ['achievements'],
        ['views'],
        ['likes'],
        ['ratio'],
    ])('refuses %j', (value) => {
        expect(isLibraryOrder(value)).toBe(false);
    });

    test.each([[undefined], [null], [7], [{}], [[]]])('refuses the non-string %j', (value) => {
        expect(isLibraryOrder(value)).toBe(false);
    });
});

describe('isLoadedSort', () => {
    test.each(['library', 'ratio', 'likes', 'guruPicks'])('accepts %s', (sort) => {
        expect(isLoadedSort(sort)).toBe(true);
    });

    test.each([['toString'], ['constructor'], ['__proto__'], ['Library'], [''], ['votes'], ['newest']])(
        'refuses %j',
        (value) => {
            expect(isLoadedSort(value)).toBe(false);
        },
    );

    test.each([[undefined], [null], [7], [{}], [[]]])('refuses the non-string %j', (value) => {
        expect(isLoadedSort(value)).toBe(false);
    });
});

describe('orderByUploadDate', () => {
    const photo = (id: string, uploadDate: number | null) => ({ id, uploadDate });

    test('votes returns the input array itself', () => {
        const photos = [photo('a', 100), photo('b', 50)];
        expect(orderByUploadDate(photos, 'votes')).toBe(photos);
    });

    test('newest sorts by upload date descending', () => {
        expect(orderByUploadDate([photo('a', 100), photo('b', 300), photo('c', 200)], 'newest')).toEqual([
            photo('b', 300),
            photo('c', 200),
            photo('a', 100),
        ]);
    });

    test('oldest sorts by upload date ascending', () => {
        expect(orderByUploadDate([photo('a', 100), photo('b', 300), photo('c', 200)], 'oldest')).toEqual([
            photo('a', 100),
            photo('c', 200),
            photo('b', 300),
        ]);
    });

    test.each(['newest', 'oldest'] as const)('%s sorts a photo without an upload date last', (order) => {
        expect(orderByUploadDate([photo('a', null), photo('b', 100), photo('c', null)], order)).toEqual([
            photo('b', 100),
            photo('a', null),
            photo('c', null),
        ]);
    });

    test.each(['newest', 'oldest'] as const)(
        '%s keeps equal dates in the order they arrived (stable sort)',
        (order) => {
            expect(orderByUploadDate([photo('a', 100), photo('b', 100), photo('c', 100)], order)).toEqual([
                photo('a', 100),
                photo('b', 100),
                photo('c', 100),
            ]);
        },
    );

    test('an empty array answers empty: the votes input itself, a date copy', () => {
        const photos: Array<{ id: string; uploadDate: number | null }> = [];
        expect(orderByUploadDate(photos, 'votes')).toBe(photos);
        expect(orderByUploadDate(photos, 'newest')).toHaveLength(0);
        expect(orderByUploadDate(photos, 'oldest')).toHaveLength(0);
    });
});
