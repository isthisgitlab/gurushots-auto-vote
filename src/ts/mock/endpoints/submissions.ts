/**
 * Mock counterpart to api/submissions.ts: the photo library, the per-photo
 * record, and the challenge submit.
 */

import * as logger from '../../logger';
import { LIBRARY_BATCH_PHOTOS } from '../../settings/limits';
import { simulateApiResponse, mockMethod } from '../simulate';
import { buildLibraryPhotos, buildImageStats } from '../photoLibrary';
import type * as submissionsModule from '../../api/submissions';

import type { LibraryOrder } from '../../librarySort';
import type { LibraryPhoto } from '../../types/gurushots';

/** What the mock library serves: a library photo whose votes and upload date are always set (the fixture guarantees them). */
type MockLibraryPhoto = LibraryPhoto & { labels: string[]; votes: number; upload_date: number };

/**
 * Reorder the mock library the way the live endpoint's `order`+`sort` pair
 * does: votes by the mock's vote count, newest/oldest by upload date. An
 * absent order sorts votes desc, as the real server's own default does; only
 * `'default'` (the API's own order, no sort sent) keeps the fixture order.
 */
const orderedBy = (items: MockLibraryPhoto[], order?: LibraryOrder | 'default') => {
    if (order === 'default') return items;
    const byDate = order === 'newest' || order === 'oldest';
    const key = (item: MockLibraryPhoto) => (byDate ? item.upload_date : item.votes);
    const sorted = [...items].sort((a, b) => key(b) - key(a));
    return order === 'oldest' ? sorted.reverse() : sorted;
};

/**
 * Simulate fetching the user's challenge-eligible photo library.
 * Mirrors /rest/get_photos_private; returns the mock library
 * (mock/photoLibrary.ts).
 *
 * When options.search is a non-empty string, mirror the server's
 * library filter by returning only items carrying that exact tag
 * (case-insensitive) — so the auto-fill search path and its
 * unfiltered fallback can both be exercised in mock mode.
 */
const getEligiblePhotos: typeof submissionsModule.getEligiblePhotos = mockMethod(
    {
        name: 'getEligiblePhotos',
        tokenArg: 1,
        debug: (challengeId) => {
            logger.withCategory('challenges').debug(`Challenge ID: ${challengeId}`, null);
        },
        noTokenMessage: 'No token provided, returning empty',
        onNoToken: () => [],
    },
    async (challengeId, token, options = {}) => {
        const items = buildLibraryPhotos(Math.floor(Date.now() / 1000));
        await simulateApiResponse({}, 400);
        const search = typeof options.search === 'string' ? options.search.trim().toLowerCase() : '';
        if (search === '') {
            return orderedBy(items, options.order);
        }
        // EXACT tag match, matching the live endpoint. get_photos_private
        // answers "staircase" with 23 photos but "stair" and "stairs" with
        // none — it is a tag lookup, not a text search, which is the whole
        // reason tagResolver exists.
        return orderedBy(
            items.filter((item) => item.labels.some((label) => label.toLowerCase() === search)),
            options.order,
        );
    },
);

/** The walk's normalized start offset: a safe non-negative number, else 0. */
const mockStart = (options: { start?: number }): number =>
    typeof options.start === 'number' && Number.isSafeInteger(options.start) && options.start >= 0 ? options.start : 0;

/**
 * Simulate the library walk. Without `maxKept` the mock library is read in one
 * go: a walk always gets all of `found` and is never truncated, and
 * `nextStart` is `start` plus every row the read consumed (`found.length`),
 * whatever `skip` left out — a continuation re-reads nothing. The default
 * batch (`maxKept === LIBRARY_BATCH_PHOTOS`, the handler's `keep ??` default)
 * serves ONE page of 4 rows from `start` per call, so the batched "load more"
 * flow can be exercised page by page (`truncated` stays true while rows remain
 * past the page). Any other `maxKept` (a Refresh/Retry extent) is a count of
 * KEPT photos: pages of 4 rows are read from `start` until that many photos
 * were kept or the rows ran out — the real walk's batch rule in miniature. The
 * page that reaches the extent is kept whole and ends the read with
 * `truncated: true`; a short page means the rows ran out, so `truncated` is
 * false there even when the extent was also reached; rows `skip` leaves out do
 * not count toward the extent but ride along in `skipped`. `nextStart`
 * advances by the pages read, in multiples of 4 from `start`; `counts` is not
 * simulated. Without a token the walk says it read nothing AND was cut short,
 * so no caller can conclude a photo is missing from the library, and
 * `nextStart` is the caller's own normalized `start`: nothing was read, so a
 * continuation re-reads from the same offset.
 */
const getEligiblePhotosWalk: typeof submissionsModule.getEligiblePhotosWalk = mockMethod(
    {
        name: 'getEligiblePhotosWalk',
        tokenArg: 1,
        debug: (challengeId) => {
            logger.withCategory('challenges').debug(`Challenge ID: ${challengeId}`, null);
        },
        noTokenMessage: 'No token provided, returning empty',
        onNoToken: (_challengeId, _token, options = {}) => ({
            items: [],
            truncated: true,
            nextStart: mockStart(options),
        }),
    },
    async (challengeId, token, options = {}) => {
        const items = buildLibraryPhotos(Math.floor(Date.now() / 1000));
        await simulateApiResponse({}, 400);
        const search = typeof options.search === 'string' ? options.search.trim().toLowerCase() : '';
        // The same exact-tag filter as the mock getEligiblePhotos search, and
        // the same order semantics.
        const found = orderedBy(
            search === '' ? items : items.filter((item) => item.labels.some((l) => l.toLowerCase() === search)),
            options.order,
        );
        const start = mockStart(options);
        const { skip, maxKept } = options;
        if (maxKept === LIBRARY_BATCH_PHOTOS) {
            // The default batch: ONE mock page of 4 rows.
            const rows = found.slice(start, start + 4);
            return {
                items: skip ? rows.filter((item) => !skip(item)) : rows,
                ...(skip ? { skipped: rows.filter((item) => skip(item)).map((item) => String(item.id)) } : {}),
                truncated: start + 4 < found.length,
                nextStart: start + 4,
            };
        }
        if (maxKept !== undefined) {
            // A Refresh/Retry extent: keep reading pages of 4 rows from
            // `start` until maxKept photos were kept or the rows ran out.
            const items: typeof found = [];
            const skippedIds: string[] = [];
            let offset = start;
            let truncated = false;
            while (offset < found.length) {
                const rows = found.slice(offset, offset + 4);
                for (const item of rows) {
                    if (skip?.(item)) skippedIds.push(String(item.id));
                    else items.push(item);
                }
                offset += 4;
                // A short page means the rows ran out; it wins over the extent,
                // like the real walk's short-page exit.
                if (rows.length < 4) break;
                if (items.length >= maxKept) {
                    truncated = true;
                    break;
                }
            }
            return {
                items,
                ...(skip ? { skipped: skippedIds } : {}),
                truncated,
                nextStart: offset,
            };
        }
        if (!skip) return { items: found, truncated: false, nextStart: start + found.length };
        // The photos the caller leaves out are reported, as the real walk does.
        // nextStart counts the rows READ, not the kept ones: a full read
        // consumed every row, whatever skip left out.
        return {
            items: found.filter((item) => !skip(item)),
            truncated: false,
            skipped: found.filter((item) => skip(item)).map((item) => String(item.id)),
            nextStart: start + found.length,
        };
    },
);

/**
 * Simulate the per-photo record. Mirrors /rest/get_image_data, which is
 * where the REAL popularity signals live: the library endpoint above
 * returns votes=0 and no achievements for every photo on the live API, so
 * auto-fill enriches candidates from here before ranking them.
 */
const getImageData: typeof submissionsModule.getImageData = mockMethod(
    {
        name: 'getImageData',
        tokenArg: 1,
        debug: (imageId) => {
            logger.withCategory('challenges').debug(`Image ID: ${imageId}`, null);
        },
        noTokenMessage: 'No token provided, returning null',
        onNoToken: () => null,
    },
    async (imageId) => {
        const stats = buildImageStats();
        await simulateApiResponse({}, 150);
        const key = String(imageId);
        // Own-property check: a lookup for "__proto__"/"constructor" on a
        // plain object literal resolves up the prototype chain and would
        // return a truthy non-entry.
        if (!Object.prototype.hasOwnProperty.call(stats, key)) return null;
        return { id: key, ...stats[key] };
    },
);

/**
 * Simulate submitting one or more photos to a challenge. Mirrors
 * /rest/submit_to_challenge; returns { ok, raw }.
 */
const submitToChallenge: typeof submissionsModule.submitToChallenge = mockMethod(
    {
        name: 'submitToChallenge',
        tokenArg: 2,
        debug: (challengeId, imageIds) => {
            logger
                .withCategory('challenges')
                .debug(
                    `Challenge ID: ${challengeId}, photos: ${Array.isArray(imageIds) ? imageIds.join(',') : 'invalid'}`,
                    null,
                );
        },
        onNoToken: () => ({ ok: false, raw: null }),
    },
    async (challengeId, imageIds) => {
        if (!Array.isArray(imageIds) || imageIds.length === 0) {
            return { ok: false, raw: { success: false, error: 'No image_ids provided' } };
        }
        await simulateApiResponse({}, 600);
        // Fixture 900005 submits-fail after a successful unlock so the
        // charged-pending-submit path is reachable in a live mock session.
        if (String(challengeId) === '900005') {
            return { ok: false, raw: { success: false, error: 'mock submit failure' } };
        }
        return {
            ok: true,
            raw: {
                success: true,
                challenge_id: Number(challengeId),
                member_challenge_count: 5,
                join: false,
                show_join_message: false,
            },
        };
    },
);

export { getEligiblePhotos, getEligiblePhotosWalk, getImageData, submitToChallenge };
