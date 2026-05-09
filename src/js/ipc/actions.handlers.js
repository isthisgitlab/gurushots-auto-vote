/**
 * IPC handlers for direct user-triggered actions: authenticate,
 * play-auto-turbo, apply-turbo-to-entry, apply-boost-to-entry, and
 * get-active-challenges.
 *
 * The turbo and boost flows are kept structurally separate (different
 * sanitisation, different result shapes, different log categories) —
 * only their token-presence guard is shared via services/auth.js.
 */

const settings = require('../settings');
const logger = require('../logger');
const apiFactory = require('../apiFactory');
const auth = require('../services/auth');
const votingLogic = require('../services/VotingLogic');
const autoFill = require('../services/autoFill');
const { runTurboMiniGame } = require('../api/main');

// In-process guard that prevents two simultaneous mini-game runs on
// the same challenge — defends against double-click and against an
// autovote cycle racing with a manual click.
const turboMiniGameInFlight = new Set();

const sanitizeForLog = (value) =>
    String(value ?? '')
        .replace(/[\r\n\t]/g, ' ')
        .slice(0, 200);

const buildHandlers = () => ({
    'get-active-challenges': async (event, token) => {
        try {
            logger.withCategory('api').debug('=== IPC get-active-challenges ===', null);
            logger.withCategory('api').debug(`Token received: ${!!token}`, null);
            const strategy = apiFactory.getApiStrategy();
            return await strategy.getActiveChallenges(token);
        } catch (error) {
            logger.withCategory('api').error('Error handling get-active-challenges request:', error);
            throw error;
        }
    },

    authenticate: async (event, username, password, isMock) => {
        logger
            .withCategory('general')
            .info(
                `🔐 Authentication request received - Mock: ${isMock}, Username: ${username}`,
                null,
                logger.CATEGORIES.AUTHENTICATION,
            );
        try {
            if (isMock) {
                const { mockLoginSuccess, mockLoginFailure } = require('../mock/auth');

                // Simulate network delay for realistic behavior
                await new Promise((resolve) => setTimeout(resolve, 500));

                const isValidCredential = true;

                if (isValidCredential) {
                    const result = {
                        success: true,
                        token: mockLoginSuccess.token,
                        message: 'Mock login successful',
                        user: {
                            id: mockLoginSuccess.user.id,
                            email: username,
                            username: mockLoginSuccess.user.username,
                            display_name: mockLoginSuccess.user.display_name,
                        },
                    };
                    logger.withCategory('authentication').info('🔐 Mock authentication successful:', result);
                    return result;
                }
                const result = {
                    success: false,
                    message: mockLoginFailure.message || 'Invalid mock credentials',
                };
                logger.withCategory('authentication').info('🔐 Mock authentication failed:', result);
                return result;
            }

            // Real authentication
            const { authenticate: realAuthenticate } = require('../api/login');
            const response = await realAuthenticate(username, password);

            if (!response) {
                return { success: false, message: 'Authentication failed - no response from server' };
            }

            logger.withCategory('authentication').info('🔐 Real authentication response:', response);

            // GuruShots may return different success indicators across
            // versions; accept any of token / success===true / status==='success'.
            if (response && (response.token || response.success === true || response.status === 'success')) {
                const token = response.token || response.access_token || response.auth_token;
                if (token) {
                    const result = {
                        success: true,
                        token,
                        message: 'Production login successful',
                        user: {
                            id: response.member_id || response.user_id || response.id,
                            email: username,
                            username: response.user_name || response.username || response.name,
                            display_name:
                                response.user_name || response.username || response.name || response.display_name,
                        },
                    };
                    logger.withCategory('authentication').info('🔐 Real authentication successful:', result);
                    return result;
                }
            }

            const result = {
                success: false,
                message: response.error || response.message || 'Authentication failed - invalid response from server',
            };
            logger.withCategory('authentication').info('🔐 Real authentication failed:', result);
            return result;
        } catch (error) {
            logger.withCategory('authentication').error('Error handling authenticate request:', error);
            return { success: false, message: error.message || 'Authentication failed due to network error' };
        }
    },

    // Manual run of the Turbo mini-game on a single challenge.
    // Independent of autovote — gives the user a way to earn a Turbo on
    // demand without enabling continuous voting.
    'play-auto-turbo': async (event, challengeId, challengeTitle) => {
        const safeId = sanitizeForLog(challengeId);
        const safeTitle = sanitizeForLog(challengeTitle) || `challenge ${safeId}`;
        try {
            logger.withCategory('turbo').info(`▶️ Manual auto-turbo run requested for challenge ${safeId}`, null);
            const userSettings = settings.loadSettings();
            if (!userSettings.token) {
                return { success: false, error: 'No authentication token found' };
            }

            // Claim the in-flight slot synchronously, before any await, so a
            // second click in the same event-loop tick is rejected. The
            // try/finally that owns the slot wraps the entire critical
            // section including the live-fetch + validation.
            if (turboMiniGameInFlight.has(safeId)) {
                return { success: false, error: 'A turbo run is already in progress for this challenge' };
            }
            turboMiniGameInFlight.add(safeId);
            try {
                const strategy = apiFactory.getApiStrategy();
                const challengesResponse = await strategy.getActiveChallenges(userSettings.token);
                const liveChallenge = challengesResponse?.challenges?.find((c) => String(c.id) === String(challengeId));
                if (!liveChallenge) {
                    return { success: false, error: 'Challenge no longer active' };
                }
                const now = Math.floor(Date.now() / 1000);
                if (!votingLogic.shouldPlayAutoTurbo(liveChallenge, now)) {
                    // Bypass the autoTurbo setting check for the manual
                    // button — the user is explicitly opting in by clicking.
                    const turboState = liveChallenge.member?.turbo?.state;
                    const cooldownPassed =
                        turboState === 'TIMER' &&
                        typeof liveChallenge.member?.turbo?.time_to_open === 'number' &&
                        liveChallenge.member.turbo.time_to_open <= now;
                    const playable = turboState === 'FREE' || turboState === 'IN_PROGRESS' || cooldownPassed;
                    const closeTime = Number(liveChallenge.close_time);
                    if (!Number.isFinite(closeTime) || closeTime <= now || !playable) {
                        return { success: false, error: `Turbo not playable (state=${turboState || 'unknown'})` };
                    }
                }

                const result = await runTurboMiniGame(
                    { id: liveChallenge.id, title: liveChallenge.title || safeTitle },
                    userSettings.token,
                );
                // Whitelist the fields returned to the renderer so any
                // future expansion of runTurboMiniGame's internal result
                // shape never accidentally leaks new data over IPC.
                const safeResult = result
                    ? {
                          played: result.played,
                          correct: result.correct,
                          flipped: result.flipped,
                          doubleFailed: result.doubleFailed,
                          won: result.won,
                      }
                    : null;
                if (result?.played === 0) {
                    return { success: false, error: 'No battles to play right now', result: safeResult };
                }
                if (!result?.correct) {
                    return { success: false, error: 'Turbo not earned — try again later', result: safeResult };
                }
                return { success: true, result: safeResult };
            } finally {
                turboMiniGameInFlight.delete(safeId);
            }
        } catch (error) {
            logger.withCategory('turbo').error('Error running manual auto-turbo:', error);
            return { success: false, error: error.message || 'Failed to run turbo mini-game' };
        }
    },

    'apply-turbo-to-entry': async (event, challengeId, imageId) => {
        const safeChallengeId = sanitizeForLog(challengeId);
        const safeImageId = sanitizeForLog(imageId);
        try {
            logger
                .withCategory('turbo')
                .info(`⚡ Apply turbo to entry request: Challenge=${safeChallengeId}, Image=${safeImageId}`, null);
            const guard = auth.requireAuthToken('turbo apply');
            if (!guard.ok) return guard.response;
            const strategy = apiFactory.getApiStrategy();
            const result = await strategy.applyTurbo(challengeId, imageId, guard.token);

            if (result?.ok) {
                logger.withCategory('turbo').success('✅ Turbo applied successfully');
                return { success: true, message: 'Turbo applied successfully' };
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
            return { success: false, error: safeMessage || 'Failed to apply turbo' };
        } catch (error) {
            logger.withCategory('turbo').error('Error applying turbo to entry:', error);
            return { success: false, error: error.message || 'Failed to apply turbo' };
        }
    },

    // Manual fill of empty challenge entries on demand. mode = 'one' fills
    // a single slot with the best-ranked eligible photo; mode = 'all' fills
    // every empty slot in one batch. Bypasses both the autoFill toggle and
    // the spacing math — manual click is explicit user intent.
    'fill-challenge-now': async (event, challengeId, mode) => {
        const safeChallengeId = sanitizeForLog(challengeId);
        const safeMode = mode === 'all' ? 'all' : 'one';
        try {
            logger
                .withCategory('autoFill')
                .info(`📝 Manual fill request: Challenge=${safeChallengeId}, Mode=${safeMode}`, null);
            const guard = auth.requireAuthToken('manual fill');
            if (!guard.ok) return guard.response;

            const strategy = apiFactory.getApiStrategy();
            const challengesResponse = await strategy.getActiveChallenges(guard.token);
            const liveChallenge = challengesResponse?.challenges?.find((c) => String(c.id) === String(challengeId));
            if (!liveChallenge) {
                return { success: false, error: 'Challenge no longer active' };
            }

            const result = await autoFill.fillChallengeNow(liveChallenge, guard.token, safeMode, {
                logger,
                getEligiblePhotos: strategy.getEligiblePhotos,
                submitToChallenge: strategy.submitToChallenge,
            });

            return {
                success: result.success === true,
                submitted: result.submitted,
                skipped: result.skipped,
                error: result.error,
                message: result.success
                    ? `Submitted ${result.submitted} entr${result.submitted === 1 ? 'y' : 'ies'}`
                    : undefined,
            };
        } catch (error) {
            logger.withCategory('autoFill').error('Error handling fill-challenge-now request:', error);
            return { success: false, error: error.message || 'Failed to fill challenge' };
        }
    },

    'apply-boost-to-entry': async (event, challengeId, imageId) => {
        try {
            logger
                .withCategory('general')
                .info(
                    `🚀 Apply boost to entry request: Challenge=${challengeId}, Image=${imageId}`,
                    null,
                    logger.CATEGORIES.VOTING,
                );

            const guard = auth.requireAuthToken('boost');
            if (!guard.ok) return guard.response;

            const strategy = apiFactory.getApiStrategy();

            logger
                .withCategory('general')
                .info(
                    `🚀 Applying boost to entry: Challenge=${challengeId}, Image=${imageId}`,
                    null,
                    logger.CATEGORIES.VOTING,
                );
            const result = await strategy.applyBoostToEntry(challengeId, imageId, guard.token);

            if (result) {
                logger.withCategory('voting').success('✅ Boost applied successfully');
                return { success: true, message: 'Boost applied successfully' };
            }
            logger.withCategory('voting').warning('❌ Failed to apply boost', null);
            return { success: false, error: 'Failed to apply boost' };
        } catch (error) {
            logger.withCategory('voting').error('Error applying boost to entry:', error);
            return { success: false, error: error.message || 'Failed to apply boost' };
        }
    },
});

const register = (ipcMain) => {
    const handlers = buildHandlers();
    for (const [channel, impl] of Object.entries(handlers)) {
        ipcMain.handle(channel, impl);
    }
};

module.exports = { register, buildHandlers };
