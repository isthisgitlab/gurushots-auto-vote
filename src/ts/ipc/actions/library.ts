/**
 * IPC handler behind the Chosen Photos chooser and the CLI `list-photos`: a
 * read-only listing of the signed-in member's photo library.
 *
 * The listing is the server's own eligible-photo walk (get_photos_private),
 * which is paginated and slow, so reads are throttled to one walk at a time per
 * process. get_photos_private requires a challenge id: with one, each photo's
 * `allowed` flag says whether it can enter THAT challenge; without one the
 * handler borrows any active (else open) challenge just to read the library,
 * and says so with `allowedKnown: false` because the flags then describe a
 * different challenge.
 */

import * as settings from '../../settings';
import * as logger from '../../logger';
import * as apiFactory from '../../apiFactory';
import * as auth from '../../services/auth';
import { resolveMemberId } from '../../services/autoFill';
import {
    CHOSEN_PHOTO_ID_RE,
    LIBRARY_BATCH_PHOTOS,
    MAX_LIBRARY_KEEP_PHOTOS,
    MAX_TAG_LENGTH,
    MAX_WON_IDS,
} from '../../settings/limits';
import { htmlToText } from '../../format/htmlToText';
import { asPreview } from '../../libraryPreview';
import { accountGeneration } from '../../services/accountScope';
import { dropEpoch, readFresh, readLatest, writeListing } from '../../services/libraryCache';
import { errorResult } from '../errorResult';
import { isIdArg } from '../isIdArg';
import { isUsageArg, refuseInvalidArgs } from './shared';

import type { IpcReplyFn } from '../registerHandlers';
import type { LibraryPhoto } from '../../types/gurushots';
import type { LibraryUsage } from '../../types/photoPicker';

// Shortest gap between the end of one walk and the start of the next. The chooser
// runs a search on every submit; this stops a held Enter key (or a script) from
// queueing one walk of up to twenty page requests (ten, doubled when photos are left out) after another.
const MIN_WALK_INTERVAL_MS = 1500;

// Per-photo caps on what is forwarded: a labels list and a server message are
// untrusted text bound for the renderer and the CLI.
const MAX_LABELS_PER_PHOTO = 32;
const MAX_LABEL_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 200;
// How much of the raw HTML message is converted: markup makes the raw text longer than what it shows.
const MAX_RAW_MESSAGE_LENGTH = 4 * MAX_MESSAGE_LENGTH;

/** What a throttled request resolves to when a newer request took its place in the queue. */
const SUPERSEDED = Symbol('superseded');

// `run` settles the caller's promise itself and never rejects.
type Pending = { run: () => Promise<void>; drop: () => void };

// One walk in flight in this process, at most one waiting behind it.
let pending: Pending | null = null;
let running = false;
let lastEndedAt = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const pump = (): void => {
    if (running || !pending || timer !== undefined) return;
    const delay = lastEndedAt + MIN_WALK_INTERVAL_MS - Date.now();
    if (delay > 0) {
        timer = setTimeout(() => {
            timer = undefined;
            pump();
        }, delay);
        return;
    }
    const next = pending;
    pending = null;
    running = true;
    void next.run().finally(() => {
        running = false;
        lastEndedAt = Date.now();
        pump();
    });
};

/**
 * Run `job` as the only walk in flight: it starts at once when none is running
 * and the minimum gap has passed, otherwise it waits — and a request that
 * arrives while another is already waiting replaces it (the older caller gets
 * SUPERSEDED), because only the newest search is still wanted.
 */
const throttled = <T>(job: () => Promise<T>): Promise<T | typeof SUPERSEDED> =>
    new Promise((resolve, reject) => {
        pending?.drop();
        pending = {
            run: () => job().then(resolve, reject),
            drop: () => resolve(SUPERSEDED),
        };
        pump();
    });

/**
 * The search term as sent to the server: control characters stripped, trimmed,
 * capped at one tag's length. Undefined when nothing is left.
 */
const cleanSearch = (search: string): string | undefined =>
    search
        .replace(/\p{Cc}/gu, '')
        .trim()
        .slice(0, MAX_TAG_LENGTH) || undefined;

/** The server's HTML reason as text, converted from no more than MAX_RAW_MESSAGE_LENGTH of it. */
const messageText = (html: string): string => htmlToText(html.slice(0, MAX_RAW_MESSAGE_LENGTH));

/** The fields of one library photo the renderer and CLI are given — nothing else is forwarded. */
const mapPhoto = (photo: LibraryPhoto) => ({
    id: String(photo.id),
    labels: (Array.isArray(photo.labels) ? photo.labels : [])
        .filter((label): label is string => typeof label === 'string')
        .slice(0, MAX_LABELS_PER_PHOTO)
        .map((label) => label.slice(0, MAX_LABEL_LENGTH)),
    allowed: photo.permission?.allowed === true,
    // The server words the reason as HTML; it goes on as text.
    message:
        typeof photo.permission?.message === 'string'
            ? messageText(photo.permission.message).slice(0, MAX_MESSAGE_LENGTH)
            : null,
    uploadDate: typeof photo.upload_date === 'number' && Number.isFinite(photo.upload_date) ? photo.upload_date : null,
});

/**
 * Whether the server says the photo has won a challenge: such a photo can never be entered again, so the listing
 * leaves it out. The message is the only signal (the API has no field for it); if the server rewords it, a won photo
 * shows as blocked again, as any other.
 */
const hasWonChallenge = (photo: LibraryPhoto): boolean =>
    photo.permission?.allowed === false &&
    typeof photo.permission.message === 'string' &&
    /has won a challenge/i.test(messageText(photo.permission.message));

/**
 * The challenge id the library is read through when the caller named none: any
 * active challenge, else one from the last open list. Null when there is neither.
 */
const borrowChallengeId = async (strategy: apiFactory.ApiStrategy, token: string): Promise<string | number | null> => {
    const active = await strategy.getActiveChallenges(token);
    const borrowed = active?.challenges?.find((challenge) => isIdArg(challenge?.id));
    if (borrowed) return borrowed.id;
    const [firstOpen] = settings.getOpenChallengeIds() ?? [];
    return firstOpen ?? null;
};

/**
 * The cached answer to a no-search `'cached'` request: the challenge's own listing for the usage while it is
 * fresh, else the newest one read for any challenge or usage as a preview (its marks withheld). Null when
 * nothing is cached.
 */
const answerFromCache = (token: string, contextId: string | number | null, usage: LibraryUsage) => {
    const fresh = readFresh(token, contextId, usage);
    if (fresh) return { success: true as const, ...fresh, preview: false };
    const latest = readLatest(token);
    return latest ? { success: true as const, ...asPreview(latest), preview: true } : null;
};

/**
 * @param challengeId - read the library as seen by this challenge (its photos'
 *   `allowed` flags are then meaningful); omitted for the plain library
 * @param search - a tag to narrow the listing to, as the server matches it
 * @param mode - `'cached'` answers the no-search listing from memory when it can: a listing read for this
 *   challenge in the last LIBRARY_FRESH_MS as it is, else the newest listing read for any challenge as a
 *   preview (`preview: true`, no marks), and walks only when nothing is cached. `'fresh'` (the default)
 *   always walks, and a no-search walk is kept for the next `'cached'` request.
 * @param usage - what the `allowed` flags are read for, as the server filters them per usage: `'submit'` (the
 *   default) is entering the challenge, `'swap'` is replacing an entry's photo. Listings are cached per usage.
 * @param start - read one batch from this offset into the library instead of walking it all; 0 reads from the top.
 *   A batch from 0 (or an omitted start) is kept for the next `'cached'` request like a full walk, whatever its
 *   batch size (a wider re-read replaces the older entry); a continuation (`start > 0`) never is, and `'cached'`
 *   refuses one.
 * @param keep - how many photos a `start` batch counts before it stops (default 100); given only with `start`.
 */
const handleGetLibraryPhotos = (async (
    event: unknown,
    challengeId?: string | number | null,
    search?: string | null,
    mode?: 'cached' | 'fresh',
    usage?: LibraryUsage,
    start?: number | null,
    keep?: number | null,
) => {
    const hasChallenge = challengeId !== undefined && challengeId !== null;
    const hasSearch = search !== undefined && search !== null;
    const hasStart = start !== undefined && start !== null;
    const hasKeep = keep !== undefined && keep !== null;
    if (
        (hasChallenge && !isIdArg(challengeId)) ||
        (hasSearch && typeof search !== 'string') ||
        (mode !== undefined && mode !== 'cached' && mode !== 'fresh') ||
        (usage !== undefined && !isUsageArg(usage)) ||
        // A batch read starts at a non-negative offset and keeps at most one full walk's worth of photos.
        (hasStart && !(Number.isSafeInteger(start) && start >= 0)) ||
        (hasKeep && !(Number.isSafeInteger(keep) && keep >= 1 && keep <= MAX_LIBRARY_KEEP_PHOTOS)) ||
        // A batch size without an offset says nothing to read from.
        (hasKeep && !hasStart) ||
        // The cache only holds reads from offset 0, so a cached answer could not say where a continuation begins.
        (mode === 'cached' && typeof start === 'number' && start > 0)
    ) {
        return refuseInvalidArgs('autoSubmit', 'get-library-photos');
    }
    const term = typeof search === 'string' ? cleanSearch(search) : undefined;
    try {
        const guard = auth.requireAuthToken('library photos');
        if (!guard.ok) return guard.response;
        const { token } = guard;
        // The cache keys the challenge asked for: the settings and rules choosers ask for none, whatever one is borrowed.
        const contextId = challengeId ?? null;
        const readUsage = usage ?? 'submit';
        if (mode === 'cached' && term === undefined) {
            const cached = answerFromCache(token, contextId, readUsage);
            if (cached) return cached;
        }
        // Compared after the walk: an account that left, or an entry dropped by an action of this window, meanwhile.
        const generation = accountGeneration();
        const epoch = dropEpoch();
        const strategy = apiFactory.getApiStrategy();

        // The borrowing lookup is a request of its own, so it runs inside the
        // throttled job like the walk it serves.
        const readState = { firstPageFailed: false };
        const outcome = await throttled(async () => {
            const readAtMs = Date.now();
            const readThrough = challengeId ?? (await borrowChallengeId(strategy, token));
            // Nothing to read the library through: no active challenge and no open one seen yet.
            if (readThrough === null) return null;
            const walkOptions = {
                search: term,
                logLabel: 'library',
                usage: readUsage,
                skip: hasWonChallenge,
            };
            const walk = await strategy.getEligiblePhotosWalk(
                readThrough,
                token,
                hasStart
                    ? {
                          ...walkOptions,
                          start,
                          maxKept: keep ?? LIBRARY_BATCH_PHOTOS,
                          // Marks, for the return below, that page 0 of THIS walk failed: a continuation whose
                          // first page comes back empty answers nothing rather than an empty batch.
                          readState,
                          // A named challenge's batch counts only photos it may enter; a borrowed read counts
                          // every kept photo, since no challenge's flags are the point.
                          ...(hasChallenge && {
                              counts: (photo: LibraryPhoto) => photo.permission?.allowed === true,
                          }),
                      }
                    : walkOptions,
            );
            const memberId = await resolveMemberId(token, strategy.getCurrentMemberProfile, logger, 'library');
            return { walk, memberId, readAtMs };
        });
        if (outcome === SUPERSEDED) return { success: false as const, error: 'superseded' as const };
        if (outcome === null) return { success: false as const, error: 'no-challenge-context' as const };
        // The account left while the walk ran: what it read is not the signed-in account's to be shown.
        if (generation !== accountGeneration()) return { success: false as const, error: 'account-changed' as const };
        // A batch whose first page failed has nothing to continue from; a full read keeps today's behavior
        // (the empty listing the walk returned, marked truncated).
        if (hasStart && readState.firstPageFailed)
            return { success: false as const, error: 'library-read-failed' as const };
        const skipped = outcome.walk.skipped ?? [];
        const listing = {
            // An id that is not a safe token could never be stored in a list, so it is not offered.
            photos: outcome.walk.items.filter((photo) => CHOSEN_PHOTO_ID_RE.test(String(photo.id))).map(mapPhoto),
            memberId: outcome.memberId,
            // The photos left out for having won a challenge: how many the walk recorded, and their ids (kept in
            // memory only, capped).
            wonCount: skipped.length,
            wonIds: skipped.filter((id) => CHOSEN_PHOTO_ID_RE.test(id)).slice(0, MAX_WON_IDS),
            truncated: outcome.walk.truncated,
            // Where the read stopped: the offset a continuation read starts from.
            nextStart: outcome.walk.nextStart,
            allowedKnown: hasChallenge,
            readAtMs: outcome.readAtMs,
        };
        // Only the no-search listing is kept, and not a read that kept nothing and was cut short (it may be a
        // failed read), nor one an action of this window outdated while it ran — and never a continuation,
        // which the cache cannot answer for (it only holds reads from offset 0). Every read from offset 0 is
        // kept, whatever its batch size: it is a valid listing from the top with its own nextStart, and it
        // replaces the older entry, so a later `'cached'` answer never shows an older, smaller listing.
        const keepCached =
            term === undefined &&
            (listing.photos.length > 0 || listing.wonCount > 0 || !listing.truncated) &&
            (!hasStart || start === 0);
        if (keepCached && epoch === dropEpoch()) writeListing(token, contextId, listing, readUsage);
        return { success: true as const, ...listing, preview: false };
    } catch (error) {
        logger.withCategory('autoSubmit').error('Error handling get-library-photos request:', error);
        return errorResult(error, 'Failed to read your photo library');
    }
}) satisfies IpcReplyFn;

// Test-only: forget the throttle state between cases.
const __resetLibraryThrottle = (): void => {
    clearTimeout(timer);
    timer = undefined;
    pending = null;
    running = false;
    lastEndedAt = 0;
};

export { handleGetLibraryPhotos, mapPhoto, hasWonChallenge, __resetLibraryThrottle, MIN_WALK_INTERVAL_MS };
