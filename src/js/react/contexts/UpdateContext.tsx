import { createContext, useContext, useReducer, useCallback, useEffect } from 'react';
import * as ipc from '../api/ipc';

import type { ComponentChildren } from 'preact';
import type { FormattedUpdateInfo } from '../../services/AutoUpdater';

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
type UpdateError = { message: string; canFallbackToBrowser: boolean };

interface UpdateStateFields {
    updateInfo: FormattedUpdateInfo | null;
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
    | { type: typeof ACTIONS.SET_AVAILABLE; payload: FormattedUpdateInfo }
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
            return {
                ...state,
                state: UPDATE_STATES.READY,
            };
        case ACTIONS.SET_ERROR:
            return {
                ...state,
                state: UPDATE_STATES.ERROR,
                error: action.payload,
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
 * Provider for update dialog state
 */
export function UpdateProvider({ children }: { children?: ComponentChildren }) {
    const [state, dispatch] = useReducer(updateReducer, initialState);

    // Setup IPC event listeners
    useEffect(() => {
        const unsubscribeAvailable = ipc.onUpdateAvailable((updateInfo: FormattedUpdateInfo) => {
            dispatch({ type: ACTIONS.SET_AVAILABLE, payload: updateInfo });
        });

        const unsubscribeProgress = ipc.onDownloadProgress((progress: DownloadProgress) => {
            dispatch({ type: ACTIONS.UPDATE_PROGRESS, payload: progress });
        });

        const unsubscribeDownloaded = ipc.onUpdateDownloaded(() => {
            dispatch({ type: ACTIONS.SET_READY });
        });

        const unsubscribeError = ipc.onUpdateError((error: { message?: string; canFallbackToBrowser?: boolean }) => {
            dispatch({
                type: ACTIONS.SET_ERROR,
                payload: {
                    message: error?.message || 'Download failed',
                    canFallbackToBrowser: error.canFallbackToBrowser !== false,
                },
            });
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

            if (!result.success) {
                dispatch({
                    type: ACTIONS.SET_ERROR,
                    payload: { message: result.error, canFallbackToBrowser: true },
                });
            }
        } catch (err) {
            dispatch({
                type: ACTIONS.SET_ERROR,
                payload: {
                    message: (err as Error | null | undefined)?.message || 'Download failed',
                    canFallbackToBrowser: true,
                },
            });
        }
    }, []);

    /**
     * Install update (restart app)
     */
    const installUpdate = useCallback(async () => {
        try {
            await ipc.installUpdate();
        } catch (err) {
            dispatch({
                type: ACTIONS.SET_ERROR,
                payload: {
                    message: (err as Error | null | undefined)?.message || 'Installation failed',
                    canFallbackToBrowser: false,
                },
            });
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
            await ipc.logRendererError(
                `Error skipping update version: ${(err as Error | null | undefined)?.message || err}`,
            );
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
            await ipc.logRendererError(
                `Error opening download URL: ${(err as Error | null | undefined)?.message || err}`,
            );
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
