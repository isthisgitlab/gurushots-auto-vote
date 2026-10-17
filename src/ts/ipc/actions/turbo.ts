import * as settings from '../../settings';
import { errorResult } from '../errorResult';
import { isIdArg } from '../isIdArg';
import * as logger from '../../logger';
import * as apiFactory from '../../apiFactory';
import * as auth from '../../services/auth';
import * as votingLogic from '../../services/VotingLogic';
import { recordManualTurboWin } from '../../services/missions';
import { isKnownTurboMode } from '../../voting/turboMode';
import { claimTurboRun, releaseTurboRun } from '../../services/turboRunLock';
import { sanitizeForLog, refuseInvalidArgs, fetchLiveChallenge } from './shared';

import type { IpcReplyFn } from '../registerHandlers';
import type { Challenge, SnapStopReason, TurboGameResult } from '../../types/gurushots';

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
    if (!isKnownTurboMode(liveChallenge.member?.turbo)) {
        return 'Turbo mode unknown; try again later';
    }
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
 * What a Snap game that did not win tells the user, by why it stopped. Fixed text: nothing the game or the server
 * said travels over IPC.
 */
const SNAP_STOP_ERRORS: Record<SnapStopReason, string> = {
    completed: 'Snap was interrupted; try again later',
    'no-model': 'Snap needs the vision model, which this build does not include',
    withdrawn: 'Snap is no longer offered for this challenge',
    unavailable: 'Snap is no longer offered for this challenge',
    'unparsed-caption': 'Snap question could not be answered',
    'judge-failed': 'Snap question could not be answered',
    'request-failed': 'Snap was interrupted; try again later',
    'vote-unclear': 'Snap was interrupted; try again later',
    cancelled: 'Snap was interrupted; try again later',
};

/**
 * Whitelist the fields returned to the renderer so any future expansion of
 * runTurboGame's internal result shape never accidentally leaks new data
 * over IPC.
 */
const toSafeTurboResult = (result: TurboGameResult | null | undefined) => {
    if (!result) return null;
    if (result.kind === 'snap') {
        return {
            kind: result.kind,
            answered: result.answered,
            total: result.total,
            meanAgreement: result.meanAgreement,
            won: result.won,
            stopReason: result.stopReason,
        };
    }
    return {
        kind: result.kind,
        played: result.played,
        correct: result.correct,
        flipped: result.flipped,
        doubleFailed: result.doubleFailed,
        won: result.won,
    };
};

/**
 * Map a turbo game's summary to the handler's `{success, error?, result}` reply.
 */
const turboRunResponse = ((result: TurboGameResult | null | undefined) => {
    const safeResult = toSafeTurboResult(result);
    if (result?.kind === 'snap') {
        return result.won
            ? { success: true as const, result: safeResult }
            : { success: false as const, error: SNAP_STOP_ERRORS[result.stopReason], result: safeResult };
    }
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

    const result: TurboGameResult | null = await strategy.runTurboGame(
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
    if (!isIdArg(challengeId)) return refuseInvalidArgs('turbo', 'play-auto-turbo');
    const safeId = sanitizeForLog(challengeId);
    const safeTitle = sanitizeForLog(challengeTitle) || `challenge ${safeId}`;
    try {
        logger.withCategory('turbo').info(`▶️ Manual auto-turbo run requested for challenge ${safeId}`, null);
        const userSettings = settings.loadSettings();
        if (!userSettings.auth.token) {
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
            return await runManualTurbo(challengeId, safeTitle, userSettings.auth.token);
        } finally {
            releaseTurboRun(challengeId, 'manual');
        }
    } catch (error) {
        logger.withCategory('turbo').error('Error running manual auto-turbo:', error);
        return errorResult(error, 'Failed to run turbo mini-game');
    }
}) satisfies IpcReplyFn;

const handleApplyTurboToEntry = (async (event: unknown, challengeId: string | number, imageId: string) => {
    if (!isIdArg(challengeId) || !isIdArg(imageId)) return refuseInvalidArgs('turbo', 'apply-turbo-to-entry');
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
