/**
 * GuruShots Auto Voter - Submissions Module
 *
 * Web-API endpoints captured from gurushots.com browser session for the
 * auto-fill feature: list eligible photos and submit photos to a challenge.
 * Uses the same WEB header profile as the turbo flow (x-env: WEB,
 * x-api-version: 13).
 */

import { makePostRequest } from './api-client';
import { ENDPOINTS, createWebHeaders, makeRequireValue } from './constants';
import {
    fetchPhotoPage,
    markFirstPageFailed,
    normalizeLibraryOptions,
    walkLibrary,
    MAX_LIBRARY_PAGES,
} from './libraryWalk';

import type { ActionResult, ImageDataResponse, ImageRecord, LibraryPhoto, SuccessResponse } from '../types/gurushots';
import type { LibraryOptions, LibraryWalk } from './libraryWalk';

const requireValue = makeRequireValue('submissions');

/**
 * Fetches the user's photo library filtered to photos eligible for
 * submission to a given challenge. The server applies the eligibility
 * filter via permission.allowed on each item; we still defensively
 * filter again client-side in the picker.
 *
 * @param options
 *   usage: 'submit' (default) or 'swap' — forwarded to every page request.
 *   logLabel: prefix for the paginated-walk warnings (default 'autoSubmit'); the
 *   join flow passes 'join' so its messages aren't attributed to auto-fill.
 *   search: optional free-text term; when a non-empty string, the server
 *   filters the library against its own tag index (mirrors the web UI's
 *   `search=hat`) so auto-fill can prefer on-theme photos.
 *   order: 'default' omits the vote sort so the API's default order can reveal
 *   eligible new photos that are beyond the vote-sorted page cap. A named
 *   order ('votes' | 'newest' | 'oldest', librarySort.ts) sorts the whole
 *   walk on the server — continuations carry it. Absent still sends votes
 *   desc, so callers that name no order read exactly as before.
 *
 *   paginate: opt IN to walking the whole library instead of returning the
 *   first page. WITHOUT this flag the call returns exactly one page — the
 *   contract every non-paginating caller and test relies on. It is an explicit
 *   flag rather than being inferred from `start` being absent, because
 *   "start at offset 50 AND keep paging" is a legitimate future request that
 *   presence-based detection would silently downgrade to a single page.
 *
 *   With paginate:true the walk begins at `start` (default 0), advances by
 *   `limit`, and stops at the first short page, at MAX_LIBRARY_PAGES, at the
 *   PAGINATE_BUDGET_MS wall-clock budget, or at the first failed/malformed
 *   page. It NEVER throws mid-walk: a transient failure on page 7 returns
 *   pages 1-6 rather than sinking the whole fill over one bad page. Every
 *   early stop logs a warning.
 *
 *   budgetMs: override the wall-clock budget for this walk. Callers running
 *   against a deadline should pass something smaller.
 * @returns list of photo items, or empty array on failure (`readState.firstPageFailed` tells the two apart)
 */
const getEligiblePhotos = async (
    challengeId: string | number,
    token: string,
    options: Omit<LibraryOptions, 'skip'> = {},
): Promise<LibraryPhoto[]> => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');

    if (options.paginate !== true) {
        const { limit, start, search, usage, order } = normalizeLibraryOptions(options);
        const items = await fetchPhotoPage(challengeId, token, { limit, start, search, usage, order });
        if (items === null) markFirstPageFailed(options.readState, 0);
        return items ?? [];
    }
    return (await walkLibrary(challengeId, token, options)).items;
};

/**
 * The paginated library walk (same options and stop conditions as
 * getEligiblePhotos with paginate:true; `paginate` itself is implied), plus
 * whether it was cut short. The chosen-photos lookup needs that bit: a photo
 * absent from a truncated walk was simply not reached, so it may only be
 * recorded as "not found" after a complete walk.
 */
const getEligiblePhotosWalk = async (
    challengeId: string | number,
    token: string,
    options: Omit<LibraryOptions, 'paginate'> = {},
): Promise<LibraryWalk> => {
    requireValue(challengeId, 'challengeId');
    requireValue(token, 'token');
    return walkLibrary(challengeId, token, options);
};

/**
 * Fetches the full per-photo record, including the popularity signals the
 * library endpoint does not carry.
 *
 * WHY THIS EXISTS: get_photos_private returns `votes: 0` for every library
 * photo and no `achievements` field at all, so the auto-fill picker's
 * popularity tiers were flat zero on real data and ranking collapsed to
 * views/upload-date (see the header of services/photoPicker/tiers.ts). This
 * endpoint returns the real `votes`, `views` and `achievements`, and is what
 * services/photoStats.ts uses to enrich candidates before ranking.
 *
 * @returns the photo record, or null when the request
 *   failed or the payload was unsuccessful/malformed
 */
const getImageData = async (imageId: string | number, token: string): Promise<ImageRecord | null> => {
    requireValue(imageId, 'imageId');
    requireValue(token, 'token');
    const headers = createWebHeaders(token);
    const data = `id=${encodeURIComponent(String(imageId))}`;
    const response = await makePostRequest<ImageDataResponse>(ENDPOINTS.imageData, headers, data);
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
 * @param imageIds - non-empty list of photo ids
 */
const submitToChallenge = async (
    challengeId: string | number,
    imageIds: Array<string>,
    token: string,
): Promise<ActionResult> => {
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
    const response = await makePostRequest<SuccessResponse>(ENDPOINTS.submitToChallenge, headers, data);
    if (!response) {
        return { ok: false, raw: null };
    }
    return {
        ok: response.success === true,
        raw: response,
    };
};

export { getEligiblePhotos, getEligiblePhotosWalk, getImageData, submitToChallenge, MAX_LIBRARY_PAGES };
