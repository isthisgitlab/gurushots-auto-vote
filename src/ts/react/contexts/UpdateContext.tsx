import { createContext, useContext, useReducer, useCallback, useLayoutEffect } from 'react';
import * as ipc from '../api/ipc';

import type { ComponentChildren } from 'preact';
import type { Dispatch } from 'react';
import type { UpdateSummary } from '../../services/AutoUpdater';
import { errorMessage } from '../../errorMessage';

// Update states
export const UPDATE_STATES = {
    IDLE: 'idle',
    AVAILABLE: 'available',
    DOWNLOADING: 'downloading',
    READY: 'ready',
    ERROR: 'error',
} as const;

// Action types
const ACTIONS = {
    SET_AVAILABLE: 'SET_AVAILABLE',
    SET_DOWNLOADING: 'SET_DOWNLOADING',
    UPDATE_PROGRESS: 'UPDATE_PROGRESS',
    SET_READY: 'SET_READY',
    SET_ERROR: 'SET_ERROR',
    HIDE_DIALOG: 'HIDE_DIALOG',
} as const;

export type DownloadProgress = { percent: number; transferred: number; total: number; bytesPerSecond: number };
/**
 * Which step failed, for the dialog's translated message: `update` (reaching the
 * update server or downloading) offers the browser download, `install` does not, and
 * `unverified` (the Android updater refused the download because it could not be checked
 * against the release; the release page is already open) does not either, nor does `page-opened`
 * (the Android install failed for another reason and the release page is already open).
 */
type UpdateError = { kind: 'update' | 'install' | 'unverified' | 'page-opened' };

// The codes the Android updater rejects a download with when it cannot vouch for it.
const UNVERIFIED_DOWNLOAD_CODES: ReadonlySet<string> = new Set([
    'host',
    'content-type',
    'size',
    'digest',
    'digest-missing',
]);

// The code the Android updater answers with when its install failed and it opened the release page instead.
const RELEASE_PAGE_OPENED_CODE = 'release-page-opened';

interface UpdateStateFields {
    updateInfo: UpdateSummary | null;
    progress: DownloadProgress | null;
    dialogVisible: boolean;
}

/**
 * The update state; the `error` state always carries its error.
 */
type UpdateState = UpdateStateFields &
    (
        | {
              state: Exclude<(typeof UPDATE_STATES)[keyof typeof UPDATE_STATES], typeof UPDATE_STATES.ERROR>;
              error: UpdateError | null;
          }
        | { state: typeof UPDATE_STATES.ERROR; error: UpdateError }
    );

type UpdateAction =
    | { type: typeof ACTIONS.SET_AVAILABLE; payload: UpdateSummary }
    | { type: typeof ACTIONS.SET_DOWNLOADING }
    | { type: typeof ACTIONS.UPDATE_PROGRESS; payload: DownloadProgress }
    | { type: typeof ACTIONS.SET_READY }
    | { type: typeof ACTIONS.SET_ERROR; payload: UpdateError }
    | { type: typeof ACTIONS.HIDE_DIALOG };

/**
 * What useUpdate returns: the update state plus its actions.
 */
export type UpdateContextValue = UpdateState & {
    startDownload: () => Promise<void>;
    installUpdate: () => Promise<void>;
    skipVersion: () => Promise<void>;
    hideDialog: () => void;
    openBrowserDownload: () => Promise<void>;
};

// Initial state
const initialState: UpdateState = {
    state: UPDATE_STATES.IDLE,
    updateInfo: null,
    progress: null,
    error: null,
    dialogVisible: false,
};

// Reducer
function updateReducer(state: UpdateState, action: UpdateAction): UpdateState {
    switch (action.type) {
        case ACTIONS.SET_AVAILABLE:
            return {
                ...state,
                state: UPDATE_STATES.AVAILABLE,
                updateInfo: action.payload,
                dialogVisible: true,
                error: null,
            };
        case ACTIONS.SET_DOWNLOADING:
            return {
                ...state,
                state: UPDATE_STATES.DOWNLOADING,
                progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
            };
        case ACTIONS.UPDATE_PROGRESS:
            return {
                ...state,
                progress: action.payload,
            };
        case ACTIONS.SET_READY:
            // Hiding the dialog mid-download leaves "Restart now" nowhere else: a finished download brings it back.
            return {
                ...state,
                state: UPDATE_STATES.READY,
                dialogVisible: true,
            };
        case ACTIONS.SET_ERROR:
            return {
                ...state,
                state: UPDATE_STATES.ERROR,
                error: action.payload,
                // Only a download the user hid comes back to say it failed. A check that fails in the background
                // (any state, READY included) must not pop a modal up; an install failure arrives from READY with
                // the dialog already open.
                dialogVisible: state.state === UPDATE_STATES.DOWNLOADING ? true : state.dialogVisible,
            };
        case ACTIONS.HIDE_DIALOG:
            return {
                ...state,
                dialogVisible: false,
            };
        // Every dispatch below uses an ACTIONS key; there is no unknown type
        // to fall through to.
    }
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

/**
 * Put the dialog into its error state. The user reads a translated message for
 * the failed step; the technical reason goes to the log.
 */
const failWith = (dispatch: Dispatch<UpdateAction>, kind: 'update' | 'install', reason: unknown, code?: unknown) => {
    const unverified = kind === 'update' && typeof code === 'string' && UNVERIFIED_DOWNLOAD_CODES.has(code);
    const pageOpened = kind === 'update' && code === RELEASE_PAGE_OPENED_CODE;
    const step = kind === 'install' ? 'Update install' : 'Update';
    void ipc.logRendererError(
        `${step} failed: ${errorMessage(reason) || reason}${unverified || pageOpened ? ` (${code})` : ''}`,
    );
    const failedKind = (() => {
        if (unverified) return 'unverified';
        return pageOpened ? 'page-opened' : kind;
    })();
    dispatch({ type: ACTIONS.SET_ERROR, payload: { kind: failedKind } });
};

/**
 * Provider for update dialog state
 */
export function UpdateProvider({ children }: { children?: ComponentChildren }) {
    const [state, dispatch] = useReducer(updateReducer, initialState);

    // Setup IPC event listeners
    useLayoutEffect(() => {
        const unsubscribeAvailable = ipc.onUpdateAvailable((updateInfo: UpdateSummary) => {
            dispatch({ type: ACTIONS.SET_AVAILABLE, payload: updateInfo });
        });

        const unsubscribeProgress = ipc.onDownloadProgress((progress: DownloadProgress) => {
            dispatch({ type: ACTIONS.UPDATE_PROGRESS, payload: progress });
        });

        const unsubscribeDownloaded = ipc.onUpdateDownloaded(() => {
            dispatch({ type: ACTIONS.SET_READY });
        });

        const unsubscribeError = ipc.onUpdateError((error: { message?: string; code?: string }) => {
            failWith(dispatch, 'update', error?.message, error?.code);
        });

        return () => {
            // Cleanup listeners if cleanup functions are provided
            if (typeof unsubscribeAvailable === 'function') unsubscribeAvailable();
            if (typeof unsubscribeProgress === 'function') unsubscribeProgress();
            if (typeof unsubscribeDownloaded === 'function') unsubscribeDownloaded();
            if (typeof unsubscribeError === 'function') unsubscribeError();
        };
    }, []);

    /**
     * Start download
     */
    const startDownload = useCallback(async () => {
        try {
            const canAutoUpdateResult = await ipc.canAutoUpdate();

            if (!canAutoUpdateResult.canAutoUpdate) {
                // Fall back to browser download
                const urlResult = await ipc.getReleasesUrl();
                await ipc.openExternalUrl(urlResult.url);
                dispatch({ type: ACTIONS.HIDE_DIALOG });
                return;
            }

            dispatch({ type: ACTIONS.SET_DOWNLOADING });
            const result = await ipc.downloadUpdate();

            // The Android updater's refusal answers with its code beside the error.
            if (!result.success) failWith(dispatch, 'update', result.error, result.code);
        } catch (err) {
            failWith(dispatch, 'update', err);
        }
    }, []);

    /**
     * Install update (restart app)
     */
    const installUpdate = useCallback(async () => {
        try {
            const result = await ipc.installUpdate();
            if (!result.success) failWith(dispatch, 'install', result.error);
        } catch (err) {
            failWith(dispatch, 'install', err);
        }
    }, []);

    /**
     * Skip this version
     */
    const skipVersion = useCallback(async () => {
        try {
            await ipc.skipUpdateVersion();
            dispatch({ type: ACTIONS.HIDE_DIALOG });
        } catch (err) {
            await ipc.logRendererError(`Error skipping update version: ${errorMessage(err) || err}`);
        }
    }, []);

    /**
     * Hide dialog (remind later or cancel)
     */
    const hideDialog = useCallback(() => {
        dispatch({ type: ACTIONS.HIDE_DIALOG });
    }, []);

    /**
     * Open browser download
     */
    const openBrowserDownload = useCallback(async () => {
        try {
            const urlResult = await ipc.getReleasesUrl();
            await ipc.openExternalUrl(urlResult.url);
            dispatch({ type: ACTIONS.HIDE_DIALOG });
        } catch (err) {
            await ipc.logRendererError(`Error opening download URL: ${errorMessage(err) || err}`);
        }
    }, []);

    const value = {
        ...state,
        startDownload,
        installUpdate,
        skipVersion,
        hideDialog,
        openBrowserDownload,
    };

    return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

/**
 * Hook to access update state and actions
 */
export function useUpdate(): UpdateContextValue {
    const context = useContext(UpdateContext);
    if (!context) {
        throw new Error('useUpdate must be used within an UpdateProvider');
    }
    return context;
}
