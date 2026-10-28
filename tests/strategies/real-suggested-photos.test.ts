/**
 * Tests for strategies/real/suggestedPhotos.ts — the one-slot cache of the
 * library photo ids the WEB active-challenge read suggests per un-joined
 * challenge. A token change (or an empty token) drops it, a store landing for
 * a token the latest read did not start for is discarded, and only 32-hex ids
 * are kept, twenty per challenge at most.
 */

import type * as suggestedPhotosModule from '../../src/ts/strategies/real/suggestedPhotos';

let beginSuggestedPhotos: typeof suggestedPhotosModule.beginSuggestedPhotos;
let storeSuggestedPhotos: typeof suggestedPhotosModule.storeSuggestedPhotos;
let getSuggestedPhotoIds: typeof suggestedPhotosModule.getSuggestedPhotoIds;

// A 32-character lowercase-hex library photo id ('…01', '…02', …).
const photoId = (n: number): string => n.toString(16).padStart(32, '0');
const suggestions = (...entries: Array<[string | number, string[]]>): Map<string, string[]> =>
    new Map(entries.map(([id, ids]) => [String(id), ids]));

beforeEach(() => {
    jest.resetModules();
    ({ beginSuggestedPhotos, storeSuggestedPhotos, getSuggestedPhotoIds } =
        require('../../src/ts/strategies/real/suggestedPhotos') as typeof suggestedPhotosModule);
});

describe('getSuggestedPhotoIds', () => {
    test('a fresh process starts empty', async () => {
        await expect(getSuggestedPhotoIds('tok', 7)).resolves.toEqual([]);
    });

    test('reads back what a store kept, per challenge and id kind', async () => {
        beginSuggestedPhotos('tok');
        storeSuggestedPhotos('tok', suggestions(['7', [photoId(1), photoId(2)]], [8, [photoId(3)]]));

        await expect(getSuggestedPhotoIds('tok', '7')).resolves.toEqual([photoId(1), photoId(2)]);
        await expect(getSuggestedPhotoIds('tok', 8)).resolves.toEqual([photoId(3)]);
        await expect(getSuggestedPhotoIds('tok', 9)).resolves.toEqual([]);
    });

    test('an empty token reads as nothing, whatever is cached', async () => {
        beginSuggestedPhotos('tok');
        storeSuggestedPhotos('tok', suggestions([7, [photoId(1)]]));

        await expect(getSuggestedPhotoIds('', 7)).resolves.toEqual([]);
    });
});

describe('storeSuggestedPhotos', () => {
    test('replaces the previous read for the same token', async () => {
        beginSuggestedPhotos('tok');
        storeSuggestedPhotos('tok', suggestions([7, [photoId(1)]]));
        // A second read for the same token notes it and replaces, not appends.
        beginSuggestedPhotos('tok');
        storeSuggestedPhotos('tok', suggestions([7, [photoId(2)]], [8, [photoId(3)]]));

        await expect(getSuggestedPhotoIds('tok', 7)).resolves.toEqual([photoId(2)]);
        await expect(getSuggestedPhotoIds('tok', 8)).resolves.toEqual([photoId(3)]);
    });

    test('keeps only 32-hex ids', async () => {
        beginSuggestedPhotos('tok');
        // photoId(0xab) uppercased carries hex letters, so the case check is real.
        storeSuggestedPhotos(
            'tok',
            suggestions([7, [photoId(1), 'NOTHEX', photoId(0xab).toUpperCase(), '', photoId(3)]]),
        );

        await expect(getSuggestedPhotoIds('tok', 7)).resolves.toEqual([photoId(1), photoId(3)]);
    });

    test('keeps at most twenty ids per challenge', async () => {
        beginSuggestedPhotos('tok');
        storeSuggestedPhotos(
            'tok',
            suggestions(
                [7, Array.from({ length: 25 }, (_v, i) => photoId(i + 1))],
                [8, Array.from({ length: 20 }, (_v, i) => photoId(i + 1))],
            ),
        );

        await expect(getSuggestedPhotoIds('tok', 7)).resolves.toEqual(
            Array.from({ length: 20 }, (_v, i) => photoId(i + 1)),
        );
        await expect(getSuggestedPhotoIds('tok', 8)).resolves.toEqual(
            Array.from({ length: 20 }, (_v, i) => photoId(i + 1)),
        );
    });

    test('a store for a token the latest read did not start for is discarded', async () => {
        beginSuggestedPhotos('A');
        // B's read started after A's; A's web result landing late must not win.
        beginSuggestedPhotos('B');
        storeSuggestedPhotos('A', suggestions([7, [photoId(1)]]));

        await expect(getSuggestedPhotoIds('A', 7)).resolves.toEqual([]);
        await expect(getSuggestedPhotoIds('B', 7)).resolves.toEqual([]);
    });

    test('a store before any read started is discarded', async () => {
        storeSuggestedPhotos('tok', suggestions([7, [photoId(1)]]));

        await expect(getSuggestedPhotoIds('tok', 7)).resolves.toEqual([]);
    });

    test('an empty token stores nothing', async () => {
        beginSuggestedPhotos('');
        storeSuggestedPhotos('', suggestions([7, [photoId(1)]]));

        await expect(getSuggestedPhotoIds('', 7)).resolves.toEqual([]);
    });
});

describe('token changes', () => {
    test('a different token drops the previous slot', async () => {
        beginSuggestedPhotos('A');
        storeSuggestedPhotos('A', suggestions([7, [photoId(1)]]));

        beginSuggestedPhotos('B');
        await expect(getSuggestedPhotoIds('A', 7)).resolves.toEqual([]);
        await expect(getSuggestedPhotoIds('B', 7)).resolves.toEqual([]);

        // B's own read fills the fresh slot.
        storeSuggestedPhotos('B', suggestions([7, [photoId(2)]]));
        await expect(getSuggestedPhotoIds('B', 7)).resolves.toEqual([photoId(2)]);
    });

    test('an empty token (signed out) drops the slot', async () => {
        beginSuggestedPhotos('tok');
        storeSuggestedPhotos('tok', suggestions([7, [photoId(1)]]));

        beginSuggestedPhotos('');
        await expect(getSuggestedPhotoIds('tok', 7)).resolves.toEqual([]);
    });

    test('a failed read leaves the cache standing for the same token', async () => {
        beginSuggestedPhotos('tok');
        storeSuggestedPhotos('tok', suggestions([7, [photoId(1)]]));

        // The next read begins (same token) but its web read fails: no store happens.
        beginSuggestedPhotos('tok');
        await expect(getSuggestedPhotoIds('tok', 7)).resolves.toEqual([photoId(1)]);
    });
});
