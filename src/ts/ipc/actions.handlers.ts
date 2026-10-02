/**
 * IPC handlers for direct user-triggered actions: authenticate,
 * play-auto-turbo, apply-turbo-to-entry, apply-boost-to-entry, and
 * get-active-challenges.
 *
 * The turbo and boost flows are kept structurally separate (different
 * sanitisation, different result shapes, different log categories) —
 * only their token-presence guard is shared via services/auth.ts.
 */

import { registerHandlers } from './registerHandlers';
import {
    handleGetAutoClaimStatus,
    handleGetActiveChallenges,
    handleAuthenticate,
    handleGetBankroll,
    handleGetAutoJoinActive,
    handleGetMemberChallenges,
    handleJoinChallenge,
} from './actions/account';
import { handlePlayAutoTurbo, handleApplyTurboToEntry } from './actions/turbo';
import { handleFillChallengeNow, handleApplyBoostToEntry } from './actions/entries';

import type { IpcMain } from 'electron';
import type { IpcHandlerMap } from './registerHandlers';

const buildHandlers = () =>
    ({
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
    }) satisfies IpcHandlerMap;

const register = (ipcMain: IpcMain) => {
    registerHandlers(ipcMain, buildHandlers());
};

export { register, buildHandlers };
