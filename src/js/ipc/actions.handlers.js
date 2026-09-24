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
const { registerHandlers } = require('./registerHandlers');
const logger = require('../logger');
const apiFactory = require('../apiFactory');
const auth = require('../services/auth');
const votingLogic = require('../services/VotingLogic');
const autoFill = require('../services/autoFill');
const { isAutoJoinActive } = require('../services/joinChallenges');
const { getAutoClaimStatus } = require('../services/autoClaim');
const { findActiveChallenge } = require('../services/findActiveChallenge');
const { rememberChallenges } = require('../windows/quitGuard');

// In-process guard that prevents two simultaneous mini-game runs on
// the same challenge — defends against double-click and against an
// autovote cycle racing with a manual click.
const turboMiniGameInFlight = new Set();

const sanitizeForLog = logger.sanitizeLogString;

/** Shared catch-path result: `{ success: false, error }` with a fallback message. */
const errorResult = (error, fallback) => ({ success: false, error: error?.message || fallback });

/** Re-fetch the active list and resolve one challenge from it (null when it is gone). */
const fetchLiveChallenge = async (strategy, token, challengeId) => {
    const challengesResponse = await strategy.getActiveChallenges(token);
    return findActiveChallenge(challengesResponse?.challenges, challengeId);
};

const handleGetAutoClaimStatus = async () => {
    try {
        return { success: true, ...getAutoClaimStatus() };
    } catch (error) {
        logger.withCategory('claim').error('Error reading auto-claim status:', error);
        return { success: false, error: error?.message || 'Could not read auto-claim status' };
    }
};

const handleGetActiveChallenges = async (event, token) => {
    try {
        logger.withCategory('api').debug('=== IPC get-active-challenges ===', null);
        logger.withCategory('api').debug(`Token received: ${!!token}`, null);
        const strategy = apiFactory.getApiStrategy();
        const result = await strategy.getActiveChallenges(token);
        // Feeds the quit confirmation. A failed fetch keeps the previous
        // list — an empty one would wave through a quit mid-boost-window.
        if (!result?.fetchFailed) rememberChallenges(result?.challenges);
        return result;
    } catch (error) {
        // Never throw to the renderer (architecture invariant). Return the
        // same `{ challenges, fetchFailed }` shape the happy path uses so
        // useActiveChallenges' "always resolves a list shape" assumption
        // holds — a corrupted settings.json during getApiStrategy() must
        // surface as a failed fetch, not a raw stack in the error UI.
        logger.withCategory('api').error('Error handling get-active-challenges request:', error);
        return { challenges: [], fetchFailed: true };
    }
};

const handleAuthenticate = async (event, username, password, isMock) => {
    logger
        .withCategory('general')
        .info(
            `🔐 Authentication request received - Mock: ${isMock}, Username: ${username}`,
            null,
            logger.CATEGORIES.AUTHENTICATION,
        );
    try {
        // Route through the factory (no direct api/mock imports) and the
        // shared token normalizer. The explicit isMock arg from the login
        // screen still selects the surface — login happens before the mock
        // setting is necessarily committed, so we pass the caller's choice
        // as an explicit override rather than re-reading settings.mock here.
        const strategy = apiFactory.getApiStrategy({ mock: !!isMock });
        const response = await strategy.authenticate(username, password);
        const { ok, token, error } = auth.extractAuthResult(response);

        if (ok) {
            settings.setSetting('token', token);
            logger.withCategory('authentication').info('🔐 Authentication successful', { success: true });
            return { success: true, token };
        }
        logger.withCategory('authentication').info('🔐 Authentication failed', { error });
        return { success: false, error };
    } catch (error) {
        logger.withCategory('authentication').error('Error handling authenticate request:', error);
        return errorResult(error, 'Authentication failed due to network error');
    }
};

/**
 * Why the manual turbo button may NOT play a challenge the auto-turbo rule
 * declined (null when it may). Bypasses the autoTurbo setting check — the
 * user is explicitly opting in by clicking — but still requires an open
 * challenge and a playable turbo state.
 */
const turboUnplayableError = (liveChallenge, now) => {
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
const toSafeTurboResult = (result) =>
    result
        ? {
              played: result.played,
              correct: result.correct,
              flipped: result.flipped,
              doubleFailed: result.doubleFailed,
              won: result.won,
          }
        : null;

/** Map a mini-game summary to the handler's `{success, error?, result}` reply. */
const turboRunResponse = (result) => {
    const safeResult = toSafeTurboResult(result);
    if (result?.played === 0) {
        return { success: false, error: 'No battles to play right now', result: safeResult };
    }
    if (!result?.correct) {
        return { success: false, error: 'Turbo not earned — try again later', result: safeResult };
    }
    return { success: true, result: safeResult };
};

/** The live-fetch, playability check and mini-game run, inside the in-flight slot. */
const runManualTurbo = async (challengeId, safeTitle, token) => {
    const strategy = apiFactory.getApiStrategy();
    const liveChallenge = await fetchLiveChallenge(strategy, token, challengeId);
    if (!liveChallenge) {
        return { success: false, error: 'Challenge no longer active' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (!votingLogic.shouldPlayAutoTurbo(liveChallenge, now)) {
        const unplayable = turboUnplayableError(liveChallenge, now);
        if (unplayable) return { success: false, error: unplayable };
    }

    const result = await strategy.runTurboMiniGame(
        { id: liveChallenge.id, title: liveChallenge.title || safeTitle },
        token,
    );
    return turboRunResponse(result);
};

// Manual run of the Turbo mini-game on a single challenge.
// Independent of autovote — gives the user a way to earn a Turbo on
// demand without enabling continuous voting.
const handlePlayAutoTurbo = async (event, challengeId, challengeTitle) => {
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
            return await runManualTurbo(challengeId, safeTitle, userSettings.token);
        } finally {
            turboMiniGameInFlight.delete(safeId);
        }
    } catch (error) {
        logger.withCategory('turbo').error('Error running manual auto-turbo:', error);
        return errorResult(error, 'Failed to run turbo mini-game');
    }
};

const handleApplyTurboToEntry = async (event, challengeId, imageId) => {
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
        return errorResult(error, 'Failed to apply turbo');
    }
};

/** Map a fillChallengeNow result to the handler's reply. */
const fillResponse = (result) => ({
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
const handleFillChallengeNow = async (event, challengeId, mode) => {
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
            return { success: false, error: 'Challenge no longer active' };
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
};

const logBoostRequest = (message) => logger.withCategory('general').info(message, null, logger.CATEGORIES.VOTING);

const handleApplyBoostToEntry = async (event, challengeId, imageId) => {
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
            return { success: true, message: 'Boost applied successfully' };
        }
        logger.withCategory('voting').warning('❌ Failed to apply boost', null);
        return { success: false, error: 'Failed to apply boost' };
    } catch (error) {
        logger.withCategory('voting').error('Error applying boost to entry:', error);
        return errorResult(error, 'Failed to apply boost');
    }
};

// Account currency balances (keys/swaps/fills/coins). success:false means
// the balance could not be read — the renderer/CLI must NOT render 0 in that
// case (0 would wrongly imply an empty balance).
const handleGetBankroll = async () => {
    try {
        const guard = auth.requireAuthToken('bankroll');
        if (!guard.ok) return guard.response;
        const strategy = apiFactory.getApiStrategy();
        const bankroll = await strategy.getBankroll(guard.token);
        if (!bankroll) {
            return { success: false, error: 'Could not read your balance right now' };
        }
        // Whitelist the four known currencies — never forward a raw payload.
        return {
            success: true,
            keys: bankroll.keys,
            swaps: bankroll.swaps,
            fills: bankroll.fills,
            coins: bankroll.coins,
        };
    } catch (error) {
        logger.withCategory('api').error('Error handling get-bankroll request:', error);
        return errorResult(error, 'Failed to read bankroll');
    }
};

// Whether auto-join is armed (master on OR a title profile enables it) —
// drives the header "auto-join" indicator. Settings-only, no auth needed.
const handleGetAutoJoinActive = async () => {
    try {
        return { success: true, active: isAutoJoinActive() === true };
    } catch (error) {
        logger.withCategory('join').error('Error handling get-auto-join-active request:', error);
        return { success: false, active: false };
    }
};

// List un-joined ("open") challenges for the Discover view / CLI.
const handleGetMemberChallenges = async (event, filter) => {
    try {
        const guard = auth.requireAuthToken('member challenges');
        if (!guard.ok) return guard.response;
        const strategy = apiFactory.getApiStrategy();
        const items = await strategy.getMemberChallenges(guard.token, filter === undefined ? 'open' : filter);
        return { success: true, items: Array.isArray(items) ? items : [] };
    } catch (error) {
        logger.withCategory('api').error('Error handling get-member-challenges request:', error);
        return { success: false, items: [], error: error?.message || 'Failed to list challenges' };
    }
};

// Manual single join. Paid joins require spendCoins:true — otherwise the
// service returns status 'needs-confirm' and nothing is charged. The
// service re-fetches the live candidate and holds a shared in-flight lock,
// so this handler stays thin.
const handleJoinChallenge = async (event, challengeId, spendCoins) => {
    const safeId = sanitizeForLog(challengeId);
    try {
        logger
            .withCategory('join')
            .info(`▶️ Join request: Challenge=${safeId}, spendCoins=${spendCoins === true}`, null);
        const guard = auth.requireAuthToken('join');
        if (!guard.ok) return guard.response;
        const strategy = apiFactory.getApiStrategy();
        const outcome = await strategy.joinChallenge(challengeId, spendCoins === true, guard.token);
        return {
            success: outcome?.status === 'joined',
            status: outcome?.status,
            cost: outcome?.cost,
            coins: outcome?.coins,
            challengeId: outcome?.challengeId,
        };
    } catch (error) {
        logger.withCategory('join').error('Error handling join-challenge request:', error);
        return errorResult(error, 'Failed to join challenge');
    }
};

const buildHandlers = () => ({
    'get-auto-claim-status': handleGetAutoClaimStatus,
    'get-active-challenges': handleGetActiveChallenges,
    authenticate: handleAuthenticate,
    'play-auto-turbo': handlePlayAutoTurbo,
    'apply-turbo-to-entry': handleApplyTurboToEntry,
    'fill-challenge-now': handleFillChallengeNow,
    'apply-boost-to-entry': handleApplyBoostToEntry,
    'get-bankroll': handleGetBankroll,
    'get-auto-join-active': handleGetAutoJoinActive,
    'get-member-challenges': handleGetMemberChallenges,
    'join-challenge': handleJoinChallenge,
});

const register = (ipcMain) => {
    registerHandlers(ipcMain, buildHandlers());
};

module.exports = { register, buildHandlers };
