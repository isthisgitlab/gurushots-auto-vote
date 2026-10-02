import * as settings from '../../settings';
import { errorResult } from '../errorResult';
import { isIdArg, invalidArgs } from '../isIdArg';
import * as logger from '../../logger';
import * as apiFactory from '../../apiFactory';
import * as auth from '../../services/auth';
import { isAutoJoinActive } from '../../services/joinChallenges';
import { getAutoClaimStatus } from '../../services/autoClaim';
import { rememberChallenges } from '../../windows/quitGuard';
import { sanitizeForLog } from './shared';

import type { IpcReplyFn } from '../registerHandlers';
import type { joinChallengeSingle } from '../../services/joinChallenges';
import type { ActiveChallengesResponse, Bankroll, Challenge } from '../../types/gurushots';

const handleGetAutoClaimStatus = (async () => {
    try {
        return { success: true as const, ...getAutoClaimStatus() };
    } catch (error) {
        logger.withCategory('claim').error('Error reading auto-claim status:', error);
        return errorResult(error, 'Could not read auto-claim status');
    }
}) satisfies IpcReplyFn;

const handleGetActiveChallenges = (async (event: unknown, token: string): Promise<ActiveChallengesResponse> => {
    try {
        logger.withCategory('api').debug('=== IPC get-active-challenges ===', null);
        logger.withCategory('api').debug(`Token received: ${!!token}`, null);
        const strategy = apiFactory.getApiStrategy();
        const result: ActiveChallengesResponse = await strategy.getActiveChallenges(token);
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
}) satisfies IpcReplyFn;

const handleAuthenticate = (async (event: unknown, username: string, password: string, isMock: boolean) => {
    logger
        .withCategory(logger.CATEGORIES.AUTHENTICATION)
        .info(`🔐 Authentication request received - Mock: ${isMock}, Username: ${username}`, null);
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
            return { success: true as const, token };
        }
        logger.withCategory('authentication').info('🔐 Authentication failed', { error });
        return { success: false as const, error };
    } catch (error) {
        logger.withCategory('authentication').error('Error handling authenticate request:', error);
        return errorResult(error, 'Authentication failed due to network error');
    }
}) satisfies IpcReplyFn;

// Account currency balances (keys/swaps/fills/coins). success:false means
// the balance could not be read — the renderer/CLI must NOT render 0 in that
// case (0 would wrongly imply an empty balance).
const handleGetBankroll = (async () => {
    try {
        const guard = auth.requireAuthToken('bankroll');
        if (!guard.ok) return guard.response;
        const strategy = apiFactory.getApiStrategy();
        const bankroll: Bankroll | null = await strategy.getBankroll(guard.token);
        if (!bankroll) {
            return { success: false as const, error: 'Could not read your balance right now' };
        }
        // Whitelist the four known currencies — never forward a raw payload.
        return {
            success: true as const,
            keys: bankroll.keys,
            swaps: bankroll.swaps,
            fills: bankroll.fills,
            coins: bankroll.coins,
        };
    } catch (error) {
        logger.withCategory('api').error('Error handling get-bankroll request:', error);
        return errorResult(error, 'Failed to read bankroll');
    }
}) satisfies IpcReplyFn;

// Whether auto-join is armed (master on OR a title profile enables it) —
// drives the header "auto-join" indicator. Settings-only, no auth needed.
const handleGetAutoJoinActive = (async () => {
    try {
        return { success: true as const, active: isAutoJoinActive() === true };
    } catch (error) {
        logger.withCategory('join').error('Error handling get-auto-join-active request:', error);
        return { success: false as const, active: false };
    }
}) satisfies IpcReplyFn;

// List un-joined ("open") challenges for the Discover view / CLI.
/**
 * @param filter - Server-side filter; defaults to 'open'.
 */
const handleGetMemberChallenges = (async (event?: unknown, filter?: string) => {
    try {
        const guard = auth.requireAuthToken('member challenges');
        if (!guard.ok) return guard.response;
        const strategy = apiFactory.getApiStrategy();
        const items: Challenge[] | null = await strategy.getMemberChallenges(
            guard.token,
            filter === undefined ? 'open' : filter,
        );
        return { success: true as const, items: Array.isArray(items) ? items : [] };
    } catch (error) {
        logger.withCategory('api').error('Error handling get-member-challenges request:', error);
        return { ...errorResult(error, 'Failed to list challenges'), items: [] };
    }
}) satisfies IpcReplyFn;

// Manual single join. Paid joins require spendCoins:true — otherwise the
// service returns status 'needs-confirm' and nothing is charged. The
// service re-fetches the live candidate and holds a shared in-flight lock,
// so this handler stays thin.
/**
 * @param spendCoins - Only `true` authorizes a paid join.
 */
const handleJoinChallenge = (async (event: unknown, challengeId: string | number, spendCoins?: boolean) => {
    if (!isIdArg(challengeId)) return invalidArgs;
    const safeId = sanitizeForLog(challengeId);
    try {
        logger
            .withCategory('join')
            .info(`▶️ Join request: Challenge=${safeId}, spendCoins=${spendCoins === true}`, null);
        const guard = auth.requireAuthToken('join');
        if (!guard.ok) return guard.response;
        const strategy = apiFactory.getApiStrategy();
        const outcome: Awaited<ReturnType<typeof joinChallengeSingle>> | null = await strategy.joinChallenge(
            challengeId,
            spendCoins === true,
            guard.token,
        );
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
}) satisfies IpcReplyFn;

export {
    handleGetAutoClaimStatus,
    handleGetActiveChallenges,
    handleAuthenticate,
    handleGetBankroll,
    handleGetAutoJoinActive,
    handleGetMemberChallenges,
    handleJoinChallenge,
};
