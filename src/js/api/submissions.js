/**
 * GuruShots Auto Voter - Submissions Module
 *
 * Web-API endpoints captured from gurushots.com browser session for the
 * auto-fill feature: list eligible photos and submit photos to a challenge.
 * Uses the same WEB header profile as the turbo flow (x-env: WEB,
 * x-api-version: 13).
 */

const logger = require('../logger');
const { makePostRequest } = require('./api-client');
const { ENDPOINTS, createWebHeaders, makeRequireValue } = require('./constants');

const requireValue = makeRequireValue('submissions');

// Upper bound on pages fetched by one `paginate: true` call. At the default
// limit of 100 this is 1000 photos — far above any realistic eligible set,
// while keeping worst-case sequential latency well inside the emergency-fill
// window (each page is a normal makePostRequest under the apiTimeout setting).
// Hitting the cap is logged, never silent: truncating the candidate list
// without saying so would misreport "considered the whole library".
const MAX_LIBRARY_PAGES = 10;

/**
 * Fetch ONE page of the eligible-photo library.
 *
 * @param {string|number} challengeId
 * @param {string} token
 * @param {{limit: number, start: number, search?: string}} opts
 * @returns {Promise<Array<object>|null>} the page's items, or null when the
 *   response was missing/malformed (the caller decides whether that ends a
 *   paginated run or is simply an empty result).
 */
const fetchPhotoPage = async (challengeId, token, { limit, start, search }) => {
    const headers = createWebHeaders(token);
    const params = [
        `c_id=${encodeURIComponent(String(challengeId))}`,
        `limit=${encodeURIComponent(String(limit))}`,
        'order=date',
        'sort=desc',
        `start=${encodeURIComponent(String(start))}`,
        'usage=submit',
    ];
    if (typeof search === 'string' && search.trim() !== '') {
        params.push(`search=${encodeURIComponent(search.trim())}`);
    }
    const response = await makePostRequest(ENDPOINTS.photosPrivate, headers, params.join('&'));
    if (!response || !Array.isArray(response.items)) {
        return null;
    }
    return response.items;
};

/**
 * Fetches the user's photo library filtered to photos eligible for
 * submission to a given challenge. The server applies the eligibility
 * filter via permission.allowed on each item; we still defensively
 * filter again client-side in the picker.
 *
 * @param {string|number} challengeId
 * @param {string} token
 * @param {{limit?: number, start?: number, search?: string, paginate?: boolean}} [options]
 *   search: optional free-text term; when a non-empty string, the server
 *   filters the library against its own tag index (mirrors the web UI's
 *   `search=hat`) so auto-fill can prefer on-theme photos.
 *
 *   paginate: opt IN to walking the whole library instead of returning the
 *   first page. WITHOUT this flag the call returns exactly one page — the
 *   long-standing behavior every caller and test relies on. It is a explicit
 *   flag rather than being inferred from `start` being absent, because
 *   "start at offset 50 AND keep paging" is a legitimate future request that
 *   presence-based detection would silently downgrade to a single page.
 *
 *   With paginate:true the walk begins at `start` (default 0), advances by
 *   `limit`, and stops at the first short page, at MAX_LIBRARY_PAGES, or at
 *   the first failed/malformed page. It NEVER throws mid-walk: a transient
 *   failure on page 7 returns pages 1-6 rather than sinking a fill that used
 *   to succeed on a single request. Both early-stop paths log a warning.
 * @returns {Promise<Array<object>>} list of photo items, or empty array on failure
 */
const getEligiblePhotos = async (challengeId, token, options = {}) => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    const limit = Number.isFinite(options.limit) ? options.limit : 100;
    const start = Number.isFinite(options.start) ? options.start : 0;
    const search = options.search;

    if (options.paginate !== true) {
        return (await fetchPhotoPage(challengeId, token, { limit, start, search })) || [];
    }

    // Dedupe across pages: offset pagination over a live, date-ordered list can
    // repeat a row when the underlying set shifts between requests.
    const byId = new Map();
    let page = 0;
    for (; page < MAX_LIBRARY_PAGES; page++) {
        let items;
        try {
            items = await fetchPhotoPage(challengeId, token, { limit, start: start + page * limit, search });
        } catch (error) {
            logger
                .withCategory('api')
                .warning(
                    `get_photos_private: page ${page + 1} failed (${error?.message || error}); using the ${byId.size} photo(s) fetched so far`,
                    null,
                );
            break;
        }
        if (items === null) {
            // Malformed/missing payload. Page 1 means "no photos" (the
            // long-standing empty-array contract); a later page means a partial
            // walk the caller should know about.
            if (page > 0) {
                logger
                    .withCategory('api')
                    .warning(
                        `get_photos_private: page ${page + 1} returned no usable items; using the ${byId.size} photo(s) fetched so far`,
                        null,
                    );
            }
            break;
        }
        for (const item of items) {
            if (item && item.id !== undefined && item.id !== null && !byId.has(item.id)) {
                byId.set(item.id, item);
            }
        }
        if (items.length < limit) {
            // Short page — the library is exhausted.
            return Array.from(byId.values());
        }
    }

    if (page === MAX_LIBRARY_PAGES) {
        logger
            .withCategory('api')
            .warning(
                `get_photos_private: stopped at the ${MAX_LIBRARY_PAGES}-page cap with ${byId.size} photo(s); older photos were not considered`,
                null,
            );
    }
    return Array.from(byId.values());
};

/**
 * Fetches the full per-photo record, including the popularity signals the
 * library endpoint does not carry.
 *
 * WHY THIS EXISTS: get_photos_private returns `votes: 0` for every library
 * photo and no `achievements` field at all, so the auto-fill picker's
 * popularity tiers were flat zero on real data and ranking collapsed to
 * views/upload-date (see the header of services/photoPicker.js). This
 * endpoint returns the real `votes`, `views` and `achievements`, and is what
 * services/photoStats.js uses to enrich candidates before ranking.
 *
 * @param {string|number} imageId
 * @param {string} token
 * @returns {Promise<object|null>} the photo record, or null when the request
 *   failed or the payload was unsuccessful/malformed
 */
const getImageData = async (imageId, token) => {
    requireValue(imageId, 'imageId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `id=${encodeURIComponent(String(imageId))}`;
    const response = await makePostRequest(ENDPOINTS.imageData, headers, data);
    if (!response || response.success !== true) {
        return null;
    }
    const photo = response.data;
    if (!photo || typeof photo !== 'object' || Array.isArray(photo)) {
        return null;
    }
    return photo;
};

/**
 * Submits one or more photos to a challenge.
 *
 * @param {string|number} challengeId
 * @param {Array<string>} imageIds - non-empty list of photo ids
 * @param {string} token
 * @returns {Promise<{ok: boolean, raw: object|null}>}
 */
const submitToChallenge = async (challengeId, imageIds, token) => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    if (!Array.isArray(imageIds) || imageIds.length === 0) {
        throw new Error('submissions: imageIds must be a non-empty array');
    }
    const headers = createWebHeaders(token);
    const params = [`c_id=${encodeURIComponent(String(challengeId))}`, 'el=challenges', 'el_id=true'];
    imageIds.forEach((id, index) => {
        params.push(`image_ids[${index}]=${encodeURIComponent(String(id))}`);
    });
    const data = params.join('&');
    const response = await makePostRequest(ENDPOINTS.submitToChallenge, headers, data);
    if (!response) {
        return { ok: false, raw: null };
    }
    return {
        ok: response.success === true,
        raw: response,
    };
};

module.exports = {
    getEligiblePhotos,
    getImageData,
    submitToChallenge,
    MAX_LIBRARY_PAGES,
};
