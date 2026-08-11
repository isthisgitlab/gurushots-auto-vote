/**
 * GuruShots Auto Voter - Submissions Module
 *
 * Web-API endpoints captured from gurushots.com browser session for the
 * auto-fill feature: list eligible photos and submit photos to a challenge.
 * Uses the same WEB header profile as the turbo flow (x-env: WEB,
 * x-api-version: 13).
 */

const logger = require('../logger');
const { oneLine } = require('../format/logSafe');
const { makePostRequest } = require('./api-client');
const { ENDPOINTS, createWebHeaders, makeRequireValue } = require('./constants');

const requireValue = makeRequireValue('submissions');

// Upper bound on pages fetched by one `paginate: true` call. At the default
// limit of 100 this is 1000 photos — far above any realistic eligible set.
// Hitting the cap is logged, never silent: truncating the candidate list
// without saying so would misreport "considered the whole library".
const MAX_LIBRARY_PAGES = 10;

// Wall-clock ceiling on one paginated walk. A page count alone does NOT bound
// the walk usefully: pages are fetched sequentially and each one is a normal
// makePostRequest carrying the apiTimeout (30s by default) plus up to
// apiMaxRetries exponential-backoff retries, so ten unlucky pages could run
// for minutes. This same fetch is shared with emergency fill, whose entire
// default trigger window is 300s — a walk that outlives the window would
// defeat the feature it is trying to feed. When the budget runs out the walk
// stops and returns what it has: fewer candidates is always better than
// missing the deadline, and the shortfall is logged.
const PAGINATE_BUDGET_MS = 20_000;

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
 *   `limit`, and stops at the first short page, at MAX_LIBRARY_PAGES, at the
 *   PAGINATE_BUDGET_MS wall-clock budget, or at the first failed/malformed
 *   page. It NEVER throws mid-walk: a transient failure on page 7 returns
 *   pages 1-6 rather than sinking a fill that used to succeed on a single
 *   request. Every early stop logs a warning.
 *
 *   budgetMs: override the wall-clock budget for this walk. Callers running
 *   against a deadline should pass something smaller.
 * @returns {Promise<Array<object>>} list of photo items, or empty array on failure
 */
const getEligiblePhotos = async (challengeId, token, options = {}) => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    // A non-positive limit would break both the offset advance (start never
    // moves) and the short-page test (`0 < 0` is false), turning the walk into
    // MAX_LIBRARY_PAGES redundant requests for the same offset.
    const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 100;
    const start = Number.isFinite(options.start) && options.start >= 0 ? options.start : 0;
    const search = options.search;

    if (options.paginate !== true) {
        return (await fetchPhotoPage(challengeId, token, { limit, start, search })) || [];
    }

    const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : PAGINATE_BUDGET_MS;
    const startedAt = Date.now();
    // Dedupe across pages: offset pagination over a live, date-ordered list can
    // repeat a row when the underlying set shifts between requests.
    const byId = new Map();
    const warn = (message) => logger.withCategory('api').warning(`autoFill: ${message}`, null);
    let page = 0;
    let stoppedEarly = false;
    for (; page < MAX_LIBRARY_PAGES; page++) {
        if (page > 0 && Date.now() - startedAt >= budgetMs) {
            warn(
                `reading your photo library took longer than ${Math.round(budgetMs / 1000)}s, so it stopped after ${page} page(s) with ${byId.size} photo(s); older photos were not considered this time`,
            );
            stoppedEarly = true;
            break;
        }
        let items;
        try {
            items = await fetchPhotoPage(challengeId, token, { limit, start: start + page * limit, search });
        } catch (error) {
            warn(
                `reading page ${page + 1} of your photo library failed (${oneLine(error?.message || error)}); continuing with the ${byId.size} photo(s) already read`,
            );
            stoppedEarly = true;
            break;
        }
        if (items === null) {
            // Malformed/missing payload. Page 1 means "no photos" (the
            // long-standing empty-array contract); a later page means a partial
            // walk the caller should know about.
            if (page > 0) {
                warn(
                    `page ${page + 1} of your photo library came back empty or unreadable; continuing with the ${byId.size} photo(s) already read`,
                );
                stoppedEarly = true;
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

    if (!stoppedEarly && page === MAX_LIBRARY_PAGES) {
        warn(
            `stopped reading your photo library at the ${MAX_LIBRARY_PAGES}-page limit with ${byId.size} photo(s); older photos were not considered`,
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
    PAGINATE_BUDGET_MS,
};
