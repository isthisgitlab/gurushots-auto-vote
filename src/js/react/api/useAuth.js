import { useState, useCallback } from 'react';
import { useAsyncIpcAction } from './useAsyncIpcAction';

const invokeAuthenticate = (username, password, isMock = false) => window.api.authenticate(username, password, isMock);

/**
 * Hook for authentication via IPC.
 *
 * `authenticate` rides the shared useAsyncIpcAction envelope; the
 * login/logout transitions keep their own error channel (they never
 * toggle `loading`), and the exposed `error` is whichever channel wrote
 * last — matching the original single-error behavior.
 *
 * @returns {{ authenticate: function, login: function, logout: function, loading: boolean, error: string|null, clearError: function }}
 */
export function useAuth() {
    const {
        run,
        loading,
        error: authError,
        clearError: clearAuthError,
    } = useAsyncIpcAction(invokeAuthenticate, {
        failureMessage: 'Authentication failed',
        errorMessage: 'Authentication error',
    });
    const [flowError, setFlowError] = useState(null);

    /**
     * Authenticate user with username/password
     * @param {string} username
     * @param {string} password
     * @param {boolean} isMock - Whether to use mock authentication
     * @returns {Promise<{success: boolean, token?: string, error?: string}>}
     */
    const authenticate = useCallback(
        (username, password, isMock = false) => {
            setFlowError(null);
            return run(username, password, isMock);
        },
        [run],
    );

    /**
     * Signal successful login to main process (transitions to main window)
     */
    const login = useCallback(async () => {
        try {
            await window.api.login();
        } catch (err) {
            clearAuthError();
            setFlowError(err.message || 'Login transition failed');
        }
    }, [clearAuthError]);

    /**
     * Logout the current user
     */
    const logout = useCallback(async () => {
        try {
            await window.api.logout();
        } catch (err) {
            clearAuthError();
            setFlowError(err.message || 'Logout failed');
        }
    }, [clearAuthError]);

    /**
     * Clear any authentication error
     */
    const clearError = useCallback(() => {
        clearAuthError();
        setFlowError(null);
    }, [clearAuthError]);

    return {
        authenticate,
        login,
        logout,
        loading,
        error: authError ?? flowError,
        clearError,
    };
}
