import * as settings from '../../settings';
import { errorResult } from '../errorResult';
import { isIdArg, invalidArgs } from '../isIdArg';
import * as logger from '../../logger';
import * as apiFactory from '../../apiFactory';
import * as auth from '../../services/auth';
import * as votingLogic from '../../services/VotingLogic';
import { recordManualTurboWin } from '../../services/missions';
import { claimTurboRun, releaseTurboRun } from '../../services/turboRunLock';
import { sanitizeForLog, fetchLiveChallenge } from './shared';

import type { IpcReplyFn } from '../registerHandlers';
import type { Challenge, TurboMiniGameResult } from '../../types/gurushots';

/**
 * applyTurbo's `{ ok, raw }` as this module reads it: `raw` is the untrusted
 * upstream body, of which only a redacted summary is ever logged or returned.
 */
type ApplyTurboResult = {
    ok?: boolean;
    raw?: { success?: unknown; error_code?: unknown; message?: unknown } | null;
};

/**
 * Why the manual turbo button may NOT play a challenge the auto-turbo rule
 * declined (null when it may). Bypasses the autoTurbo setting check — the
 * user is explicitly opting in by clicking — but still requires an open
 * challenge and a playable turbo state.
 *
 * @param now - Unix seconds
 */
const turboUnplayableError = (liveChallenge: Challenge, now: number): string | null => {
    const turboState = liveChallenge.member?.turbo?.state;
    const cooldownPassed =
        turboState === 'TIMER' &&
        typeof liveChallenge.member?.turbo?.time_to_open === 'number' &&
        liveChallenge.member.turbo.time_to_open <= now;
    const playable = turboState === 'FREE' || turboState === 'IN_PROGRESS' || cooldownPassed;
    const closeTime = Number(liveChallenge.close_time);
    if (!Number.isFinite(closeTime) || closeTime <= now || !playable) {
        return `Turbo not playable (state=${turboState || 'unknown'})`;
    }
    return null;
};

/**
 * Whitelist the fields returned to the renderer so any future expansion of
 * runTurboMiniGame's internal result shape never accidentally leaks new data
 * over IPC.
 */
const toSafeTurboResult = (result: TurboMiniGameResult | null | undefined) =>
    result
        ? {
              played: result.played,
              correct: result.correct,
              flipped: result.flipped,
              doubleFailed: result.doubleFailed,
              won: result.won,
          }
        : null;

/**
 * Map a mini-game summary to the handler's `{success, error?, result}` reply.
 */
const turboRunResponse = ((result: TurboMiniGameResult | null | undefined) => {
    const safeResult = toSafeTurboResult(result);
    if (result?.played === 0) {
        return { success: false as const, error: 'No battles to play right now', result: safeResult };
    }
    if (!result?.correct) {
        return { success: false as const, error: 'Turbo not earned — try again later', result: safeResult };
    }
    return { success: true as const, result: safeResult };
}) satisfies IpcReplyFn;

/**
 * The live-fetch, playability check and mini-game run, inside the in-flight slot.
 */
const runManualTurbo = (async (challengeId: string | number, safeTitle: string, token: string) => {
    const strategy = apiFactory.getApiStrategy();
    const liveChallenge = await fetchLiveChallenge(strategy, token, challengeId);
    if (!liveChallenge) {
        return { success: false as const, error: 'Challenge no longer active' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (!votingLogic.shouldPlayAutoTurbo(liveChallenge, now)) {
        const unplayable = turboUnplayableError(liveChallenge, now);
        if (unplayable) return { success: false as const, error: unplayable };
    }

    const result: TurboMiniGameResult | null = await strategy.runTurboMiniGame(
        { ...liveChallenge, title: liveChallenge.title || safeTitle },
        token,
    );
    if (result?.won) recordManualTurboWin(token);
    return turboRunResponse(result);
}) satisfies IpcReplyFn;

// Manual run of the Turbo mini-game on a single challenge.
// Independent of autovote — gives the user a way to earn a Turbo on
// demand without enabling continuous voting.
const handlePlayAutoTurbo = (async (event: unknown, challengeId: string | number, challengeTitle: string) => {
    if (!isIdArg(challengeId)) return invalidArgs;
    const safeId = sanitizeForLog(challengeId);
    const safeTitle = sanitizeForLog(challengeTitle) || `challenge ${safeId}`;
    try {
        logger.withCategory('turbo').info(`▶️ Manual auto-turbo run requested for challenge ${safeId}`, null);
        const userSettings = settings.loadSettings();
        if (!userSettings.token) {
            return { success: false as const, error: 'No authentication token found' };
        }

        // Claim the in-flight slot synchronously, before any await, so a
        // second click in the same event-loop tick is rejected. The
        // try/finally that owns the slot wraps the entire critical
        // section including the live-fetch + validation.
        if (!claimTurboRun(challengeId)) {
            return { success: false as const, error: 'A turbo run is already in progress for this challenge' };
        }
        try {
            return await runManualTurbo(challengeId, safeTitle, userSettings.token);
        } finally {
            releaseTurboRun(challengeId, 'manual');
        }
    } catch (error) {
        logger.withCategory('turbo').error('Error running manual auto-turbo:', error);
        return errorResult(error, 'Failed to run turbo mini-game');
    }
}) satisfies IpcReplyFn;

const handleApplyTurboToEntry = (async (event: unknown, challengeId: string | number, imageId: string) => {
    if (!isIdArg(challengeId) || !isIdArg(imageId)) return invalidArgs;
    const safeChallengeId = sanitizeForLog(challengeId);
    const safeImageId = sanitizeForLog(imageId);
    try {
        logger
            .withCategory('turbo')
            .info(`⚡ Apply turbo to entry request: Challenge=${safeChallengeId}, Image=${safeImageId}`, null);
        const guard = auth.requireAuthToken('turbo apply');
        if (!guard.ok) return guard.response;
        const strategy = apiFactory.getApiStrategy();
        const result: ApplyTurboResult | null = await strategy.applyTurbo(challengeId, imageId, guard.token);

        if (result?.ok) {
            logger.withCategory('turbo').success('✅ Turbo applied successfully');
            return { success: true as const, message: 'Turbo applied successfully' };
        }
        // Log only a small redacted summary of the raw response so any
        // session-identifying material the upstream might reflect back
        // is not persisted verbatim. Same sanitiser is applied to the
        // user-facing error string returned to the renderer.
        const safeMessage = sanitizeForLog(result?.raw?.message);
        const safeRaw = result?.raw
            ? { success: result.raw.success, error_code: result.raw.error_code, message: safeMessage }
            : null;
        logger.withCategory('turbo').warning('❌ Failed to apply turbo', safeRaw);
        return { success: false as const, error: safeMessage || 'Failed to apply turbo' };
    } catch (error) {
        logger.withCategory('turbo').error('Error applying turbo to entry:', error);
        return errorResult(error, 'Failed to apply turbo');
    }
}) satisfies IpcReplyFn;

export { handlePlayAutoTurbo, handleApplyTurboToEntry };
