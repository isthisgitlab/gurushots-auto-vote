import * as settings from '../../settings';
import { errorResult } from '../errorResult';
import { isIdArg } from '../isIdArg';
import * as logger from '../../logger';
import * as apiFactory from '../../apiFactory';
import * as auth from '../../services/auth';
import * as autoFill from '../../services/autoFill';
import { dropContext } from '../../services/libraryCache';
import { fetchUpcoming } from '../../services/discoverChallenges';
import { findActiveChallenge } from '../../services/findActiveChallenge';
import { CHOSEN_PHOTO_ID_RE, MAX_CHOSEN_PHOTOS, MAX_SUGGEST_EXCLUDE } from '../../settings/limits';
import { sanitizeForLog, refuseInvalidArgs, isUsageArg, fetchLiveChallenge } from './shared';
import { mapPhoto } from './library';

import type { IpcReplyFn } from '../registerHandlers';
import type { LibraryUsage } from '../../types/photoPicker';

/**
 * Map a fillChallengeNow result to the handler's reply.
 */
const fillResponse = (result: { success: boolean; submitted: number; skipped: number; error?: string }) => ({
    success: result.success === true,
    submitted: result.submitted,
    skipped: result.skipped,
    error: result.error,
    message: result.success ? `Submitted ${result.submitted} entr${result.submitted === 1 ? 'y' : 'ies'}` : undefined,
});

// Manual fill of empty challenge entries on demand. mode = 'one' fills
// a single slot with the best-ranked eligible photo; mode = 'all' fills
// every empty slot in one batch. Bypasses both the autoSubmit toggle and
// the spacing math — manual click is explicit user intent.
/**
 * @param mode - anything other than `'all'` means `'one'`.
 */
const handleFillChallengeNow = (async (event: unknown, challengeId: string | number, mode: 'one' | 'all') => {
    if (!isIdArg(challengeId)) return refuseInvalidArgs('autoSubmit', 'fill-challenge-now');
    const safeChallengeId = sanitizeForLog(challengeId);
    const safeMode = mode === 'all' ? 'all' : 'one';
    try {
        logger
            .withCategory('autoSubmit')
            .info(`📝 Manual fill request: Challenge=${safeChallengeId}, Mode=${safeMode}`, null);
        const guard = auth.requireAuthToken('manual fill');
        if (!guard.ok) return guard.response;

        const strategy = apiFactory.getApiStrategy();
        const liveChallenge = await fetchLiveChallenge(strategy, guard.token, challengeId);
        if (!liveChallenge) {
            return { success: false as const, error: 'Challenge no longer active' };
        }

        try {
            const result = await autoFill.fillChallengeNow(liveChallenge, guard.token, safeMode, {
                settings,
                logger,
                getEligiblePhotos: strategy.getEligiblePhotos,
                getEligiblePhotosWalk: strategy.getEligiblePhotosWalk,
                getImageData: strategy.getImageData,
                submitToChallenge: strategy.submitToChallenge,
                searchTagAutocomplete: strategy.searchTagAutocomplete,
                getCurrentMemberProfile: strategy.getCurrentMemberProfile,
            });
            return fillResponse(result);
        } finally {
            // Whatever the fill came to, which photos this challenge accepts may have changed.
            dropContext(challengeId);
        }
    } catch (error) {
        logger.withCategory('autoSubmit').error('Error handling fill-challenge-now request:', error);
        return errorResult(error, 'Failed to submit photos');
    }
}) satisfies IpcReplyFn;

/**
 * Whether `imageIds` is a plausible pick: 1..MAX_CHOSEN_PHOTOS distinct ids of the
 * shape a library photo has. Indexed so a sparse array's holes fail the id test
 * (`every` would skip them).
 */
const isPickedIds = (imageIds: unknown): imageIds is string[] => {
    if (!Array.isArray(imageIds) || imageIds.length < 1 || imageIds.length > MAX_CHOSEN_PHOTOS) return false;
    for (let i = 0; i < imageIds.length; i++) {
        const id: unknown = imageIds[i];
        if (typeof id !== 'string' || !CHOSEN_PHOTO_ID_RE.test(id)) return false;
    }
    return new Set(imageIds).size === imageIds.length;
};

/** Whether `ids` is a plausible exclude list: at most MAX_SUGGEST_EXCLUDE ids of the shape a library photo has (may be empty). */
const isExcludeIds = (ids: unknown): ids is string[] => {
    if (!Array.isArray(ids) || ids.length > MAX_SUGGEST_EXCLUDE) return false;
    for (let i = 0; i < ids.length; i++) {
        const id: unknown = ids[i];
        if (typeof id !== 'string' || !CHOSEN_PHOTO_ID_RE.test(id)) return false;
    }
    return true;
};

// Challenges with a picked-photos submit running, by id: a second submit for one of them is turned away
// instead of racing the first (the live re-read cannot see a submit that has not landed yet).
const submitsInFlight = new Set<string>();

// Manual submit of exactly the photos the user picked on the challenge card. Unlike
// fill-challenge-now nothing is ranked or filtered: the ids go to the challenge as
// given, after a check that they still fit the open slots.
const handleSubmitPickedPhotos = (async (event: unknown, challengeId: string | number, imageIds: string[]) => {
    if (!isIdArg(challengeId) || !isPickedIds(imageIds)) return refuseInvalidArgs('autoSubmit', 'submit-picked-photos');
    const inFlightKey = String(challengeId);
    const safeChallengeId = sanitizeForLog(challengeId);
    if (submitsInFlight.has(inFlightKey)) {
        logger
            .withCategory('autoSubmit')
            .info(`📝 Manual pick request refused: a submit for Challenge=${safeChallengeId} is already running`, null);
        return { success: false as const, error: 'submit-busy' };
    }
    submitsInFlight.add(inFlightKey);
    try {
        logger
            .withCategory('autoSubmit')
            .info(`📝 Manual pick request: Challenge=${safeChallengeId}, Photos=${imageIds.length}`, null);
        const guard = auth.requireAuthToken('manual pick');
        if (!guard.ok) return guard.response;

        const strategy = apiFactory.getApiStrategy();
        const liveChallenge = await fetchLiveChallenge(strategy, guard.token, challengeId);
        if (!liveChallenge) {
            return { success: false as const, error: 'Challenge no longer active' };
        }

        try {
            return await autoFill.submitPickedPhotos(liveChallenge, guard.token, imageIds, {
                logger,
                submitToChallenge: strategy.submitToChallenge,
            });
        } finally {
            // Whatever the submit came to (even an unclear answer), which photos this challenge accepts may have changed.
            dropContext(challengeId);
        }
    } catch (error) {
        logger.withCategory('autoSubmit').error('Error handling submit-picked-photos request:', error);
        return errorResult(error, 'Failed to submit photos');
    } finally {
        submitsInFlight.delete(inFlightKey);
    }
}) satisfies IpcReplyFn;

// A photo-suggestions ranking is running (one per process: the CLI, the web shell and every window share it).
let suggestRunning = false;

/**
 * The top photos the scheduled auto-fill's rules favour for a challenge, best first, submitting nothing (the
 * Pick… "Auto" button and `list-photos --suggest`). It is a ranking under those rules, not a replay of the
 * next fill. One ranking at a time answers `suggest-busy` to the rest.
 *
 * @param usage - what the eligibility is read for: `'submit'` (the default) is entering the challenge, `'swap'`
 *   is replacing an entry's photo (the swap picker's Auto).
 * @param exclude - ids an earlier answer named: the ranking runs on the rest, so a second press pages on to the
 *   next-best. When nothing is left to rank the answer is `no-more-suggestions`.
 *
 * Failures are `{ success: false, error: <fixed code> }` and never carry raw text.
 */
const handleSuggestPhotos = (async (
    event: unknown,
    challengeId: string | number,
    usage?: LibraryUsage,
    exclude?: string[],
) => {
    if (
        !isIdArg(challengeId) ||
        (usage !== undefined && !isUsageArg(usage)) ||
        (exclude !== undefined && !isExcludeIds(exclude))
    ) {
        return refuseInvalidArgs('autoSubmit', 'suggest-photos');
    }
    const log = logger.withCategory('autoSubmit');
    if (suggestRunning) {
        log.info('📝 Photo suggestions refused: a ranking is already running', null);
        return { success: false as const, error: 'suggest-busy' as const };
    }
    suggestRunning = true;
    try {
        log.info(
            `📝 Photo suggestions request: Challenge=${sanitizeForLog(challengeId)}, Excluded=${exclude?.length ?? 0}`,
            null,
        );
        const guard = auth.requireAuthToken('photo suggestions');
        if (!guard.ok) return guard.response;

        const strategy = apiFactory.getApiStrategy();
        // A Discover row's challenge is un-joined; it resolves from the open/upcoming lists and still ranks —
        // the same library read the join flow makes. A failed list read is indistinguishable from a miss and
        // answers challenge-ended (pre-existing conflation, kept).
        let fromDiscover = false;
        let challenge = await fetchLiveChallenge(strategy, guard.token, challengeId);
        if (!challenge) {
            const open = await strategy.getMemberChallenges(guard.token, 'open');
            challenge = findActiveChallenge(open, challengeId);
            if (!challenge) {
                challenge = findActiveChallenge(
                    await fetchUpcoming(guard.token, strategy.getMemberChallenges),
                    challengeId,
                );
            }
            fromDiscover = challenge !== null;
        }
        if (!challenge) return { success: false as const, error: 'challenge-ended' as const };

        const result = await autoFill.suggestFillPhotos(
            challenge,
            guard.token,
            {
                settings,
                logger,
                getEligiblePhotos: strategy.getEligiblePhotos,
                getEligiblePhotosWalk: strategy.getEligiblePhotosWalk,
                getImageData: strategy.getImageData,
                searchTagAutocomplete: strategy.searchTagAutocomplete,
                getCurrentMemberProfile: strategy.getCurrentMemberProfile,
            },
            undefined,
            { usage, exclude: new Set(exclude), ignoreOnly: fromDiscover },
        );
        if (result.status === 'fetch-error') return { success: false as const, error: 'fetch-failed' as const };
        if (result.status !== 'suggested') return { success: false as const, error: result.status };
        // An id that is not a safe token could never be stored in a list, so it is not offered.
        const photos = result.photos.filter((photo) => CHOSEN_PHOTO_ID_RE.test(String(photo.id))).map(mapPhoto);
        if (photos.length === 0) {
            const error = exclude?.length ? ('no-more-suggestions' as const) : ('no-eligible' as const);
            return { success: false as const, error };
        }
        const memberId = await autoFill.resolveMemberId(
            guard.token,
            strategy.getCurrentMemberProfile,
            logger,
            'suggest',
        );
        return { success: true as const, memberId, photos, statsLimited: result.statsLimited };
    } catch (error) {
        // The reply is a fixed code: what went wrong goes to the log only.
        log.error('Error handling suggest-photos request:', error);
        return { success: false as const, error: 'suggest-failed' as const };
    } finally {
        suggestRunning = false;
    }
}) satisfies IpcReplyFn;

const logBoostRequest = (message: string) => logger.withCategory(logger.CATEGORIES.VOTING).info(message, null);

const handleApplyBoostToEntry = (async (event: unknown, challengeId: string | number, imageId: string) => {
    if (!isIdArg(challengeId) || !isIdArg(imageId)) return refuseInvalidArgs('voting', 'apply-boost-to-entry');
    // Sanitize before logging (matches the sibling turbo/fill handlers) —
    // these args can be arbitrary user input via the CLI `boost --image=`.
    const safeChallengeId = sanitizeForLog(challengeId);
    const safeImageId = sanitizeForLog(imageId);
    try {
        logBoostRequest(`🚀 Apply boost to entry request: Challenge=${safeChallengeId}, Image=${safeImageId}`);

        const guard = auth.requireAuthToken('boost');
        if (!guard.ok) return guard.response;

        const strategy = apiFactory.getApiStrategy();

        logBoostRequest(`🚀 Applying boost to entry: Challenge=${safeChallengeId}, Image=${safeImageId}`);
        const result = await strategy.applyBoostToEntry(challengeId, imageId, guard.token);

        if (result) {
            logger.withCategory('voting').success('✅ Boost applied successfully');
            return { success: true as const, message: 'Boost applied successfully' };
        }
        logger.withCategory('voting').warning('❌ Failed to apply boost', null);
        return { success: false as const, error: 'Failed to apply boost' };
    } catch (error) {
        logger.withCategory('voting').error('Error applying boost to entry:', error);
        return errorResult(error, 'Failed to apply boost');
    }
}) satisfies IpcReplyFn;

export { handleFillChallengeNow, handleSubmitPickedPhotos, handleSuggestPhotos, handleApplyBoostToEntry };
