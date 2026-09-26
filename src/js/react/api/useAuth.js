import { useState, useCallback } from 'react';
import { useAsyncIpcAction } from './useAsyncIpcAction';

/**
 * What `authenticate` resolves: the handler's result, or the envelope's
 * `{ success: false, error }` when the call threw.
 *
 * @typedef {{ success: true, token: string } | { success: false, error: string }} AuthenticateResult
 */

// Always called with all three args by `authenticate` below, which owns the default.
/**
 * @param {string} username
 * @param {string} password
 * @param {boolean} isMock
 */
const invokeAuthenticate = (username, password, isMock) => window.api.authenticate(username, password, isMock);

/**
 * Hook for authentication via IPC.
 *
 * `authenticate` rides the shared useAsyncIpcAction envelope; the
 * login/logout transitions keep their own error channel (they never
 * toggle `loading`), and the exposed `error` is whichever channel wrote
 * last — matching the original single-error behavior.
 *
 * @returns {{
 *   authenticate: (username: string, password: string, isMock?: boolean) => Promise<AuthenticateResult>,
 *   login: () => Promise<void>,
 *   logout: () => Promise<void>,
 *   loading: boolean,
 *   error: string|null,
 *   clearError: () => void,
 * }}
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
    const [flowError, setFlowError] = useState(/** @type {string | null} */ (null));

    const authenticate = useCallback(
        /**
         * Authenticate user with username/password
         * @param {string} username
         * @param {string} password
         * @param {boolean} [isMock] - Whether to use mock authentication
         * @returns {Promise<AuthenticateResult>}
         */
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
            setFlowError(
                /** @type {{ message?: string } | null | undefined} */ (err)?.message || 'Login transition failed',
            );
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
            setFlowError(/** @type {{ message?: string } | null | undefined} */ (err)?.message || 'Logout failed');
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
