/**
 * GuruShots Auto Voter - Library Walk
 *
 * The paginated read of the account's eligible-photo library behind
 * getEligiblePhotos's `paginate: true` and getEligiblePhotosWalk: one page
 * fetch, its option normalization, and the budgeted, capped walk over the
 * pages. Split out of submissions.ts, whose other endpoints import it from
 * here; the walk's types and page cap re-export through submissions.ts, the
 * import path every existing caller and test already uses.
 */

import * as logger from '../logger';
import { oneLine } from '../format/logSafe';
import { LIBRARY_ORDERS } from '../librarySort';
import { makePostRequest } from './api-client';
import { ENDPOINTS, createWebHeaders } from './constants';

import type { LibraryOrder } from '../librarySort';
import type { LibraryPhoto, PhotosPrivateResponse } from '../types/gurushots';
import { errorMessage } from '../errorMessage';

// Upper bound on pages fetched by one `paginate: true` call. At the default
// limit of 100 this is 1000 photos. A challenge requiring newly uploaded
// photos may have no eligible image in the first 1000 sorted by votes.
// Hitting the cap is logged, never silent: truncating the candidate list
// without saying so would misreport "considered the whole library".
// A walk given a `skip` (the library listing, which leaves won photos out) may
// read up to twice as many pages, within the same wall-clock budget below.
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
 * The `order=`/`sort=` pair for one page request, from a caller's library
 * order. Absent keeps the app's own votes desc; `'default'` sends no sort at
 * all; a named order maps through LIBRARY_ORDERS to fixed literals, so nothing
 * outside that list reaches the endpoint (unknown values silently fall back to
 * date desc there).
 *
 * @param order - the caller's order, 'default' for the API's own, or absent for votes desc
 */
const orderParams = (order: LibraryOrder | 'default' | undefined): string[] => {
    if (order === 'default') return [];
    const picked = order ? LIBRARY_ORDERS[order] : LIBRARY_ORDERS.votes;
    return [`order=${picked.order}`, `sort=${picked.sort}`];
};

/**
 * Fetch ONE page of the eligible-photo library.
 *
 * @param opts
 *   usage: the library view the server filters `permission.allowed` for —
 *   'submit' (adding a new entry) or 'swap' (replacing an entry); the caller
 *   always normalizes it to one of the two.
 *   order: the whole-library server sort (see librarySort.ts); absent sends
 *   votes desc, 'default' sends nothing.
 * @returns the page's items, or null when the
 *   response was missing/malformed (the caller decides whether that ends a
 *   paginated run or is simply an empty result).
 */
const fetchPhotoPage = async (
    challengeId: string | number,
    token: string,
    {
        limit,
        start,
        search,
        usage,
        order,
    }: { limit: number; start: number; search?: string; usage: string; order?: LibraryOrder | 'default' },
): Promise<LibraryPhoto[] | null> => {
    const headers = createWebHeaders(token);
    // The vote-ordered path sorts by the server's real count even though items
    // report `votes: 0` (see getImageData). The default path omits the sort.
    const params = [
        `c_id=${encodeURIComponent(String(challengeId))}`,
        `limit=${encodeURIComponent(String(limit))}`,
        `start=${encodeURIComponent(String(start))}`,
        `usage=${encodeURIComponent(String(usage))}`,
    ];
    params.splice(2, 0, ...orderParams(order));
    if (typeof search === 'string' && search.trim() !== '') {
        params.push(`search=${encodeURIComponent(search.trim())}`);
    }
    const response = await makePostRequest<PhotosPrivateResponse>(ENDPOINTS.photosPrivate, headers, params.join('&'));
    if (!response || !Array.isArray(response.items)) {
        return null;
    }
    return response.items;
};

type LibraryOptions = {
    limit?: number;
    start?: number;
    search?: string;
    paginate?: boolean;
    logLabel?: string;
    usage?: string;
    budgetMs?: number;
    /** The whole-library server sort: 'default' sends none; absent sends votes desc (see librarySort.ts). */
    order?: LibraryOrder | 'default';
    /**
     * Out-parameter: `firstPageFailed` is set when the first page could not be read (a failed request or an
     * unreadable payload), which the empty list returned for it cannot tell from a library with nothing in it.
     */
    readState?: { firstPageFailed: boolean };
    /**
     * A walk only (getEligiblePhotosWalk): photos this answers true for are left out of `items` and do not count
     * toward the walk's cap or a `maxKept` batch (their ids are reported as `skipped`, up to 2 * MAX_LIBRARY_PAGES *
     * limit of them). Without `maxKept` the walk then ends at MAX_LIBRARY_PAGES * limit kept photos, or at twice
     * MAX_LIBRARY_PAGES pages, whichever comes first, besides the budget.
     */
    skip?: (photo: LibraryPhoto) => boolean;
    /**
     * A walk only (getEligiblePhotosWalk): stop once this many photos were counted — checked after each page, so the
     * page that reaches it is kept whole — wherever `skip` left the counted photos, and report the stop as a routine
     * batch end (`truncated: true`, no warning). `nextStart` says where a continuation walk reads from.
     */
    maxKept?: number;
    /**
     * A walk only (getEligiblePhotosWalk): which kept photos a `maxKept` batch counts (default: every kept photo).
     * Counted or not, a kept photo stays in `items`; photos a `skip` leaves out never reach it.
     */
    counts?: (photo: LibraryPhoto) => boolean;
};

/**
 * Why a library walk stopped. `end` = a short page said the library ran out;
 * every other value is an early stop (`truncated` is exactly "stop !== 'end'").
 * Optional on the type: `truncated` is the contract every caller reads; `stop`
 * is the extra detail walkLibrary always reports and only the walk memo needs.
 */
type LibraryWalkStop = 'end' | 'page-cap' | 'budget' | 'failed' | 'batch';

/**
 * A walk's photos, and whether it stopped before the library was exhausted. `skipped` (only when the walk was given a
 * `skip`) are the ids of the photos it left out. `nextStart` is `start + (pages fully read) * limit` at every exit:
 * the offset a continuation walk reads from, so a batch can resume where this one stopped and a page cut short by a
 * failure or the budget is re-read rather than skipped.
 */
type LibraryWalk = {
    items: LibraryPhoto[];
    truncated: boolean;
    nextStart: number;
    stop?: LibraryWalkStop;
    skipped?: string[];
};

/**
 * The request shape every library read shares, normalized from caller options.
 */
const normalizeLibraryOptions = (options: LibraryOptions) => ({
    // A non-positive limit would break both the offset advance (start never
    // moves) and the short-page test (`0 < 0` is false), turning the walk into
    // MAX_LIBRARY_PAGES redundant requests for the same offset.
    // (The typeof tests only narrow for the checker: Number.isFinite is already
    // false for a non-number.)
    limit:
        typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 100,
    start:
        typeof options.start === 'number' && Number.isFinite(options.start) && options.start >= 0 ? options.start : 0,
    search: options.search,
    usage: options.usage === 'swap' ? 'swap' : 'submit',
    order: options.order,
});

/** Notes in a caller's readState that the first page (page index 0) of a read failed. */
const markFirstPageFailed = (readState: LibraryOptions['readState'], page: number): void => {
    if (page === 0 && readState) readState.firstPageFailed = true;
};

/**
 * The paginated library walk (see getEligiblePhotos for its stop conditions).
 * Given a `skip`, the cap is on the photos kept rather than the pages read: the walk ends once at least
 * MAX_LIBRARY_PAGES * limit photos are kept (checked after each page, so the page that crosses it is kept whole), or at
 * twice MAX_LIBRARY_PAGES pages. Rows the server repeats are kept once, so a walk can need more than MAX_LIBRARY_PAGES
 * pages to see that many distinct photos, but never reads past its page ceiling.
 * Given a `maxKept`, the walk instead ends once that many photos were counted (a `counts` predicate picks which kept
 * photos count, all of them by default), wherever `skip` left them and independent of it; `maxPages` and the budget
 * are unchanged. A batch end is routine and logs no warning — unlike every other early stop.
 * `truncated` is true whenever it stopped for any reason other than reaching a
 * short page: the budget, a failed or unreadable page (the first included), the
 * page cap, or a `maxKept` batch end. A caller that wants to conclude "this
 * photo is not in the library" may only do so from a walk that was not
 * truncated. `stop` names which of those happened ('end' | 'page-cap' |
 * 'budget' | 'failed' | 'batch'; a kept-photo cap reached through `skip` reads
 * as 'batch'). Every exit reports `nextStart`, the offset a continuation walk
 * reads from.
 */
const walkLibrary = async (
    challengeId: string | number,
    token: string,
    options: LibraryOptions,
): Promise<LibraryWalk> => {
    const { limit, start, search, usage, order } = normalizeLibraryOptions(options);
    const budgetMs =
        typeof options.budgetMs === 'number' && Number.isFinite(options.budgetMs) && options.budgetMs > 0
            ? options.budgetMs
            : PAGINATE_BUDGET_MS;
    const startedAt = Date.now();
    // Dedupe across pages: offset pagination over a live, vote-ordered list can
    // repeat a row when the underlying order shifts between requests. The same
    // shift can also skip one (a photo gaining votes mid-walk moves up into a
    // page already read); the walk takes seconds, so that is accepted.
    const byId: Map<string, LibraryPhoto> = new Map();
    // Prefix the library-walk warnings with the calling flow (auto-fill vs join)
    // so a "10-page limit" message from a join isn't mislabeled as auto-fill.
    const logLabel =
        typeof options.logLabel === 'string' && options.logLabel.trim() ? options.logLabel.trim() : 'autoSubmit';
    const warn = (message: string) => logger.withCategory('api').warning(`${logLabel}: ${message}`, null);
    // With a `skip`, the photos left out do not use up the cap, so the walk may need more pages to keep as many.
    const { skip, counts, maxKept } = options;
    const maxPages = skip ? 2 * MAX_LIBRARY_PAGES : MAX_LIBRARY_PAGES;
    const keepCap = MAX_LIBRARY_PAGES * limit;
    // A bound on what a skipping walk records, however many photos the library holds.
    const skippedCap = 2 * MAX_LIBRARY_PAGES * limit;
    const skipped = new Set<string>();
    // Photos a `maxKept` batch counts: kept (deduped, so a repeated row never counts twice) and passing `counts`.
    let counted = 0;
    // `start + (pages fully read) * limit`, so a continuation resumes here and a page cut short by a failure or the
    // budget is re-read rather than skipped.
    let nextStart = start;
    const result = (truncated: boolean, stop: LibraryWalkStop): LibraryWalk => ({
        items: Array.from(byId.values()),
        truncated,
        nextStart,
        stop,
        ...(skip ? { skipped: Array.from(skipped) } : {}),
    });
    let page = 0;
    // Why the walk stopped early, when it did; null until a budget or failed-page break sets it.
    let stoppedAs: 'budget' | 'failed' | null = null;
    for (; page < maxPages; page++) {
        if (page > 0 && Date.now() - startedAt >= budgetMs) {
            warn(
                `reading your photo library took longer than ${Math.round(budgetMs / 1000)}s, so it stopped after ${page} page(s) with ${byId.size} photo(s); less-voted photos were not considered this time`,
            );
            stoppedAs = 'budget';
            break;
        }
        let items;
        try {
            items = await fetchPhotoPage(challengeId, token, {
                limit,
                start: start + page * limit,
                search,
                usage,
                order,
            });
        } catch (error) {
            markFirstPageFailed(options.readState, page);
            warn(
                `reading page ${page + 1} of your photo library failed (${oneLine(errorMessage(error) || error)}); continuing with the ${byId.size} photo(s) already read`,
            );
            stoppedAs = 'failed';
            break;
        }
        if (items === null) {
            // Malformed/missing payload. Page 1 means "no photos" (the
            // long-standing empty-array contract); a later page means a partial
            // walk the caller should know about.
            markFirstPageFailed(options.readState, page);
            if (page > 0) {
                warn(
                    `page ${page + 1} of your photo library came back empty or unreadable; continuing with the ${byId.size} photo(s) already read`,
                );
            }
            stoppedAs = 'failed';
            break;
        }
        for (const item of items) {
            if (!item || item.id === undefined || item.id === null) continue;
            if (skip?.(item)) {
                if (!byId.has(item.id) && skipped.size < skippedCap) skipped.add(String(item.id));
            } else if (!byId.has(item.id)) {
                byId.set(item.id, item);
                skipped.delete(String(item.id));
                if (counts?.(item) ?? true) counted++;
            }
        }
        nextStart = start + (page + 1) * limit;
        if (items.length < limit) {
            // Short page — the library is exhausted.
            return result(false, 'end');
        }
        if (maxKept !== undefined && counted >= maxKept) {
            // A batch end is routine, not an early stop worth a warning about.
            return result(true, 'batch');
        }
        if (skip && byId.size >= keepCap) {
            warn(`stopped reading your photo library at ${byId.size} photo(s); less-voted photos were not considered`);
            return result(true, 'batch');
        }
    }

    if (stoppedAs === null) {
        warn(
            `stopped reading your photo library at the ${maxPages}-page limit with ${byId.size} photo(s); less-voted photos were not considered`,
        );
        return result(true, 'page-cap');
    }
    return result(true, stoppedAs);
};

export { fetchPhotoPage, normalizeLibraryOptions, markFirstPageFailed, walkLibrary, MAX_LIBRARY_PAGES };
export type { LibraryOptions, LibraryWalk };
