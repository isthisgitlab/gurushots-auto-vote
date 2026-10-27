/**
 * IPC handlers for direct user-triggered actions and account reads, one module
 * per area under ./actions: authenticate, get-active-challenges,
 * get-auto-claim-status, get-bankroll, get-auto-join-active,
 * get-member-challenges and join-challenge (account.ts); play-auto-turbo and
 * apply-turbo-to-entry (turbo.ts); fill-challenge-now, submit-picked-photos,
 * suggest-photos and apply-boost-to-entry (entries.ts); get-library-photos
 * and search-photo-tags (library.ts); get-photo-stats (photoStats.ts).
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
    handleJoinChallenge,
    handleForgetUnconfirmedPayment,
} from './actions/account';
import { handlePlayAutoTurbo, handleApplyTurboToEntry } from './actions/turbo';
import {
    handleFillChallengeNow,
    handleSubmitPickedPhotos,
    handleSuggestPhotos,
    handleApplyBoostToEntry,
} from './actions/entries';
import { handleGetLibraryPhotos, handleSearchPhotoTags } from './actions/library';
import { handleGetPhotoStats } from './actions/photoStats';

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
        'submit-picked-photos': handleSubmitPickedPhotos,
        'suggest-photos': handleSuggestPhotos,
        'apply-boost-to-entry': handleApplyBoostToEntry,
        'get-bankroll': handleGetBankroll,
        'get-auto-join-active': handleGetAutoJoinActive,
        'get-member-challenges': handleGetMemberChallenges,
        'get-open-chosen-annotations': handleGetOpenChosenAnnotations,
        'join-challenge': handleJoinChallenge,
        'forget-unconfirmed-payment': handleForgetUnconfirmedPayment,
        'get-library-photos': handleGetLibraryPhotos,
        'search-photo-tags': handleSearchPhotoTags,
        'get-photo-stats': handleGetPhotoStats,
    }) satisfies IpcHandlerMap;

const register = (ipcMain: IpcMain) => {
    registerHandlers(ipcMain, buildHandlers());
};

export { register, buildHandlers };
