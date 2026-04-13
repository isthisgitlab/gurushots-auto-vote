import { createContext, useContext, useReducer, useCallback, useEffect } from 'react';

// Update states
export const UPDATE_STATES = {
    IDLE: 'idle',
    AVAILABLE: 'available',
    DOWNLOADING: 'downloading',
    READY: 'ready',
    ERROR: 'error',
};

// Action types
const ACTIONS = {
    SET_AVAILABLE: 'SET_AVAILABLE',
    SET_DOWNLOADING: 'SET_DOWNLOADING',
    UPDATE_PROGRESS: 'UPDATE_PROGRESS',
    SET_READY: 'SET_READY',
    SET_ERROR: 'SET_ERROR',
    RESET: 'RESET',
    HIDE_DIALOG: 'HIDE_DIALOG',
};

// Initial state
const initialState = {
    state: UPDATE_STATES.IDLE,
    updateInfo: null,
    progress: null,
    error: null,
    dialogVisible: false,
};

// Reducer
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
    case ACTIONS.RESET:
        return initialState;
    case ACTIONS.HIDE_DIALOG:
        return {
            ...state,
            dialogVisible: false,
        };
    default:
        return state;
    }
}

const UpdateContext = createContext(null);

/**
 * Provider for update dialog state
 */
export function UpdateProvider({ children }) {
    const [state, dispatch] = useReducer(updateReducer, initialState);

    // Setup IPC event listeners
    useEffect(() => {
        const unsubscribeAvailable = window.api.onUpdateAvailable((updateInfo) => {
            dispatch({ type: ACTIONS.SET_AVAILABLE, payload: updateInfo });
        });

        const unsubscribeProgress = window.api.onDownloadProgress((progress) => {
            dispatch({ type: ACTIONS.UPDATE_PROGRESS, payload: progress });
        });

        const unsubscribeDownloaded = window.api.onUpdateDownloaded(() => {
            dispatch({ type: ACTIONS.SET_READY });
        });

        const unsubscribeError = window.api.onUpdateError((error) => {
            dispatch({
                type: ACTIONS.SET_ERROR,
                payload: {
                    message: error.message || 'Download failed',
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
            const canAutoUpdateResult = await window.api.canAutoUpdate();

            if (!canAutoUpdateResult.canAutoUpdate) {
                // Fall back to browser download
                const urlResult = await window.api.getReleasesUrl();
                await window.api.openExternalUrl(urlResult.url);
                dispatch({ type: ACTIONS.HIDE_DIALOG });
                return;
            }

            dispatch({ type: ACTIONS.SET_DOWNLOADING });
            const result = await window.api.downloadUpdate();

            if (!result.success) {
                dispatch({
                    type: ACTIONS.SET_ERROR,
                    payload: { message: result.error, canFallbackToBrowser: true },
                });
            }
        } catch (err) {
            dispatch({
                type: ACTIONS.SET_ERROR,
                payload: { message: err.message || 'Download failed', canFallbackToBrowser: true },
            });
        }
    }, []);

    /**
     * Install update (restart app)
     */
    const installUpdate = useCallback(async () => {
        try {
            await window.api.installUpdate();
        } catch (err) {
            dispatch({
                type: ACTIONS.SET_ERROR,
                payload: { message: err.message || 'Installation failed', canFallbackToBrowser: false },
            });
        }
    }, []);

    /**
     * Skip this version
     */
    const skipVersion = useCallback(async () => {
        try {
            await window.api.skipUpdateVersion();
            dispatch({ type: ACTIONS.HIDE_DIALOG });
        } catch (err) {
            await window.api.logError(`Error skipping update version: ${err.message || err}`);
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
            const urlResult = await window.api.getReleasesUrl();
            await window.api.openExternalUrl(urlResult.url);
            dispatch({ type: ACTIONS.HIDE_DIALOG });
        } catch (err) {
            await window.api.logError(`Error opening download URL: ${err.message || err}`);
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

    return (
        <UpdateContext.Provider value={value}>
            {children}
        </UpdateContext.Provider>
    );
}

/**
 * Hook to access update state and actions
 */
export function useUpdate() {
    const context = useContext(UpdateContext);
    if (!context) {
        throw new Error('useUpdate must be used within an UpdateProvider');
    }
    return context;
}
