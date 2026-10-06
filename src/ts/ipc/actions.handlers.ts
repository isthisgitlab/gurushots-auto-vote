/**
 * IPC handlers for direct user-triggered actions and account reads, one module
 * per area under ./actions: authenticate, get-active-challenges,
 * get-auto-claim-status, get-bankroll, get-auto-join-active,
 * get-member-challenges and join-challenge (account.ts); play-auto-turbo and
 * apply-turbo-to-entry (turbo.ts); fill-challenge-now and
 * apply-boost-to-entry (entries.ts); get-library-photos (library.ts).
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
    handleGetOpenChosenAnnotations,
    handleConfirmAccount,
    handleJoinChallenge,
} from './actions/account';
import { handlePlayAutoTurbo, handleApplyTurboToEntry } from './actions/turbo';
import { handleFillChallengeNow, handleApplyBoostToEntry } from './actions/entries';
import { handleGetLibraryPhotos } from './actions/library';

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
        'get-open-chosen-annotations': handleGetOpenChosenAnnotations,
        'confirm-account': handleConfirmAccount,
        'join-challenge': handleJoinChallenge,
        'get-library-photos': handleGetLibraryPhotos,
    }) satisfies IpcHandlerMap;

const register = (ipcMain: IpcMain) => {
    registerHandlers(ipcMain, buildHandlers());
};

export { register, buildHandlers };
