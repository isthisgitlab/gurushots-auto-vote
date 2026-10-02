import * as settings from '../../settings';
import { errorResult } from '../errorResult';
import { isIdArg, invalidArgs } from '../isIdArg';
import * as logger from '../../logger';
import * as apiFactory from '../../apiFactory';
import * as auth from '../../services/auth';
import * as autoFill from '../../services/autoFill';
import { sanitizeForLog, fetchLiveChallenge } from './shared';

import type { IpcReplyFn } from '../registerHandlers';

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
// every empty slot in one batch. Bypasses both the autoFill toggle and
// the spacing math — manual click is explicit user intent.
/**
 * @param mode - anything other than `'all'` means `'one'`.
 */
const handleFillChallengeNow = (async (event: unknown, challengeId: string | number, mode: 'one' | 'all') => {
    if (!isIdArg(challengeId)) return invalidArgs;
    const safeChallengeId = sanitizeForLog(challengeId);
    const safeMode = mode === 'all' ? 'all' : 'one';
    try {
        logger
            .withCategory('autoFill')
            .info(`📝 Manual fill request: Challenge=${safeChallengeId}, Mode=${safeMode}`, null);
        const guard = auth.requireAuthToken('manual fill');
        if (!guard.ok) return guard.response;

        const strategy = apiFactory.getApiStrategy();
        const liveChallenge = await fetchLiveChallenge(strategy, guard.token, challengeId);
        if (!liveChallenge) {
            return { success: false as const, error: 'Challenge no longer active' };
        }

        const result = await autoFill.fillChallengeNow(liveChallenge, guard.token, safeMode, {
            settings,
            logger,
            getEligiblePhotos: strategy.getEligiblePhotos,
            getImageData: strategy.getImageData,
            submitToChallenge: strategy.submitToChallenge,
            searchTagAutocomplete: strategy.searchTagAutocomplete,
            getCurrentMemberProfile: strategy.getCurrentMemberProfile,
        });
        return fillResponse(result);
    } catch (error) {
        logger.withCategory('autoFill').error('Error handling fill-challenge-now request:', error);
        return errorResult(error, 'Failed to submit photos');
    }
}) satisfies IpcReplyFn;

const logBoostRequest = (message: string) => logger.withCategory(logger.CATEGORIES.VOTING).info(message, null);

const handleApplyBoostToEntry = (async (event: unknown, challengeId: string | number, imageId: string) => {
    if (!isIdArg(challengeId) || !isIdArg(imageId)) return invalidArgs;
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

export { handleFillChallengeNow, handleApplyBoostToEntry };
