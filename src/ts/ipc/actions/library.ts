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
import { MAX_TAG_LENGTH } from '../../settings/limits';
import { errorResult } from '../errorResult';
import { isIdArg } from '../isIdArg';
import { refuseInvalidArgs } from './shared';

import type { IpcReplyFn } from '../registerHandlers';
import type { LibraryPhoto } from '../../types/gurushots';

// Shortest gap between the end of one walk and the start of the next. The chooser
// runs a search on every submit; this stops a held Enter key (or a script) from
// queueing one walk of up to ten page requests after another.
const MIN_WALK_INTERVAL_MS = 1500;

// Per-photo caps on what is forwarded: a labels list and a server message are
// untrusted text bound for the renderer and the CLI.
const MAX_LABELS_PER_PHOTO = 32;
const MAX_LABEL_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 200;

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

/** The fields of one library photo the renderer and CLI are given — nothing else is forwarded. */
const mapPhoto = (photo: LibraryPhoto) => ({
    id: String(photo.id),
    labels: (Array.isArray(photo.labels) ? photo.labels : [])
        .filter((label): label is string => typeof label === 'string')
        .slice(0, MAX_LABELS_PER_PHOTO)
        .map((label) => label.slice(0, MAX_LABEL_LENGTH)),
    allowed: photo.permission?.allowed === true,
    message:
        typeof photo.permission?.message === 'string' ? photo.permission.message.slice(0, MAX_MESSAGE_LENGTH) : null,
    uploadDate: typeof photo.upload_date === 'number' && Number.isFinite(photo.upload_date) ? photo.upload_date : null,
});

/**
 * The challenge id the library is read through when the caller named none: any
 * active challenge, else one from the last open list. Null when there is neither.
 */
const borrowChallengeId = async (strategy: apiFactory.ApiStrategy, token: string): Promise<string | number | null> => {
    const active = await strategy.getActiveChallenges(token);
    const borrowed = active?.challenges?.find((challenge) => isIdArg(challenge?.id));
    if (borrowed) return borrowed.id;
    const open = settings.getOpenChallengeIds();
    return open && open.size > 0 ? ([...open][0] as string) : null;
};

/**
 * @param challengeId - read the library as seen by this challenge (its photos'
 *   `allowed` flags are then meaningful); omitted for the plain library
 * @param search - a tag to narrow the listing to, as the server matches it
 */
const handleGetLibraryPhotos = (async (event: unknown, challengeId?: string | number | null, search?: unknown) => {
    const hasChallenge = challengeId !== undefined && challengeId !== null;
    const hasSearch = search !== undefined && search !== null;
    if ((hasChallenge && !isIdArg(challengeId)) || (hasSearch && typeof search !== 'string')) {
        return refuseInvalidArgs('autoFill', 'get-library-photos');
    }
    const term = hasSearch ? cleanSearch(search as string) : undefined;
    try {
        const guard = auth.requireAuthToken('library photos');
        if (!guard.ok) return guard.response;
        const { token } = guard;
        const strategy = apiFactory.getApiStrategy();

        const contextId = hasChallenge ? challengeId : await borrowChallengeId(strategy, token);
        if (contextId === null) {
            // Nothing to read the library through: no active challenge and no open one seen yet.
            return { success: false as const, error: 'no-challenge-context' as const };
        }
        const outcome = await throttled(async () => {
            const walk = await strategy.getEligiblePhotosWalk(contextId, token, { search: term, logLabel: 'library' });
            const memberId = await resolveMemberId(token, strategy.getCurrentMemberProfile, logger, 'library');
            return { walk, memberId };
        });
        if (outcome === SUPERSEDED) return { success: false as const, error: 'superseded' as const };
        return {
            success: true as const,
            photos: outcome.walk.items.map(mapPhoto),
            memberId: outcome.memberId,
            truncated: outcome.walk.truncated,
            allowedKnown: hasChallenge,
        };
    } catch (error) {
        logger.withCategory('autoFill').error('Error handling get-library-photos request:', error);
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

export { handleGetLibraryPhotos, __resetLibraryThrottle, MIN_WALK_INTERVAL_MS };
