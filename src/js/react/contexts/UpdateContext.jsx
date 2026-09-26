// @ts-check
import { createContext, useContext, useReducer, useCallback, useEffect } from 'react';
import * as ipc from '../api/ipc';

/** @import { ComponentChildren } from 'preact' */
/** @import { FormattedUpdateInfo } from '../../services/AutoUpdater' */

// Update states
export const UPDATE_STATES = /** @type {const} */ ({
    IDLE: 'idle',
    AVAILABLE: 'available',
    DOWNLOADING: 'downloading',
    READY: 'ready',
    ERROR: 'error',
});

// Action types
const ACTIONS = /** @type {const} */ ({
    SET_AVAILABLE: 'SET_AVAILABLE',
    SET_DOWNLOADING: 'SET_DOWNLOADING',
    UPDATE_PROGRESS: 'UPDATE_PROGRESS',
    SET_READY: 'SET_READY',
    SET_ERROR: 'SET_ERROR',
    HIDE_DIALOG: 'HIDE_DIALOG',
});

/** @typedef {{ percent: number, transferred: number, total: number, bytesPerSecond: number }} DownloadProgress */
/** @typedef {{ message: string, canFallbackToBrowser: boolean }} UpdateError */

/**
 * @typedef {object} UpdateStateFields
 * @property {FormattedUpdateInfo | null} updateInfo
 * @property {DownloadProgress | null} progress
 * @property {boolean} dialogVisible
 */

/**
 * The update state; the `error` state always carries its error.
 *
 * @typedef {UpdateStateFields & (
 *   | { state: Exclude<(typeof UPDATE_STATES)[keyof typeof UPDATE_STATES], typeof UPDATE_STATES.ERROR>, error: UpdateError | null }
 *   | { state: typeof UPDATE_STATES.ERROR, error: UpdateError }
 * )} UpdateState
 */

/**
 * @typedef {{ type: typeof ACTIONS.SET_AVAILABLE, payload: FormattedUpdateInfo }
 *   | { type: typeof ACTIONS.SET_DOWNLOADING }
 *   | { type: typeof ACTIONS.UPDATE_PROGRESS, payload: DownloadProgress }
 *   | { type: typeof ACTIONS.SET_READY }
 *   | { type: typeof ACTIONS.SET_ERROR, payload: UpdateError }
 *   | { type: typeof ACTIONS.HIDE_DIALOG }} UpdateAction
 */

/**
 * What useUpdate returns: the update state plus its actions.
 *
 * @typedef {UpdateState & {
 *   startDownload: () => Promise<void>,
 *   installUpdate: () => Promise<void>,
 *   skipVersion: () => Promise<void>,
 *   hideDialog: () => void,
 *   openBrowserDownload: () => Promise<void>,
 * }} UpdateContextValue
 */

// Initial state
/** @type {UpdateState} */
const initialState = {
    state: UPDATE_STATES.IDLE,
    updateInfo: null,
    progress: null,
    error: null,
    dialogVisible: false,
};

// Reducer
/**
 * @param {UpdateState} state
 * @param {UpdateAction} action
 * @returns {UpdateState}
 */
function updateReducer(state, action) {
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

const UpdateContext = createContext(/** @type {UpdateContextValue | null} */ (null));

/**
 * Provider for update dialog state
 *
 * @param {{ children?: ComponentChildren }} props
 */
export function UpdateProvider({ children }) {
    const [state, dispatch] = useReducer(updateReducer, initialState);

    // Setup IPC event listeners
    useEffect(() => {
        const unsubscribeAvailable = ipc.onUpdateAvailable((/** @type {FormattedUpdateInfo} */ updateInfo) => {
            dispatch({ type: ACTIONS.SET_AVAILABLE, payload: updateInfo });
        });

        const unsubscribeProgress = ipc.onDownloadProgress((/** @type {DownloadProgress} */ progress) => {
            dispatch({ type: ACTIONS.UPDATE_PROGRESS, payload: progress });
        });

        const unsubscribeDownloaded = ipc.onUpdateDownloaded(() => {
            dispatch({ type: ACTIONS.SET_READY });
        });

        const unsubscribeError = ipc.onUpdateError(
            (/** @type {{ message?: string, canFallbackToBrowser?: boolean }} */ error) => {
                dispatch({
                    type: ACTIONS.SET_ERROR,
                    payload: {
                        message: error?.message || 'Download failed',
                        canFallbackToBrowser: error.canFallbackToBrowser !== false,
                    },
                });
            },
        );

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
                    message: /** @type {Error | null | undefined} */ (err)?.message || 'Download failed',
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
                    message: /** @type {Error | null | undefined} */ (err)?.message || 'Installation failed',
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
                `Error skipping update version: ${/** @type {Error | null | undefined} */ (err)?.message || err}`,
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
                `Error opening download URL: ${/** @type {Error | null | undefined} */ (err)?.message || err}`,
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
 *
 * @returns {UpdateContextValue}
 */
export function useUpdate() {
    const context = useContext(UpdateContext);
    if (!context) {
        throw new Error('useUpdate must be used within an UpdateProvider');
    }
    return context;
}
