/**
 * Mock counterpart to api/submissions.js: the photo library, the per-photo
 * record, and the challenge submit.
 */

const logger = require('../../logger');
const { simulateApiResponse, mockMethod } = require('../simulate');
const { buildLibraryPhotos, buildImageStats } = require('../photoLibrary');

/**
 * Simulate fetching the user's challenge-eligible photo library.
 * Mirrors /rest/get_photos_private; returns the mock library
 * (mock/photoLibrary.js).
 *
 * When options.search is a non-empty string, mirror the server's
 * library filter by returning only items carrying that exact tag
 * (case-insensitive) — so the auto-fill search path and its
 * unfiltered fallback can both be exercised in mock mode.
 */
const getEligiblePhotos = mockMethod(
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
            return items;
        }
        // EXACT tag match, matching the live endpoint. get_photos_private
        // answers "staircase" with 23 photos but "stair" and "stairs" with
        // none — it is a tag lookup, not a text search, which is the whole
        // reason tagResolver exists.
        return items.filter((item) => item.labels.some((label) => label.toLowerCase() === search));
    },
);

/**
 * Simulate the per-photo record. Mirrors /rest/get_image_data, which is
 * where the REAL popularity signals live: the library endpoint above
 * returns votes=0 and no achievements for every photo on the live API, so
 * auto-fill enriches candidates from here before ranking them.
 */
const getImageData = mockMethod(
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
const submitToChallenge = mockMethod(
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

module.exports = { getEligiblePhotos, getImageData, submitToChallenge };
