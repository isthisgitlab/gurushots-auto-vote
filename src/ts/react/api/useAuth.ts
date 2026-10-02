import { useState, useCallback } from 'react';
import { useAsyncIpcAction } from './useAsyncIpcAction';
import { errorMessage } from '../../errorMessage';

/**
 * What `authenticate` resolves: the handler's result, or the envelope's
 * `{ success: false, error }` when the call threw.
 */
export type AuthenticateResult = { success: true; token: string } | { success: false; error: string };

// Always called with all three args by `authenticate` below, which owns the default.
const invokeAuthenticate = (username: string, password: string, isMock: boolean) =>
    window.api.authenticate(username, password, isMock);

/**
 * Hook for authentication via IPC.
 *
 * `authenticate` rides the shared useAsyncIpcAction envelope; the
 * login/logout transitions keep their own error channel (they never
 * toggle `loading`), and the exposed `error` is whichever channel wrote
 * last — matching the original single-error behavior.
 */
export function useAuth(): {
    authenticate: (username: string, password: string, isMock?: boolean) => Promise<AuthenticateResult>;
    login: () => Promise<void>;
    logout: () => Promise<void>;
    loading: boolean;
    error: string | null;
    clearError: () => void;
} {
    const {
        run,
        loading,
        error: authError,
        clearError: clearAuthError,
    } = useAsyncIpcAction(invokeAuthenticate, {
        failureMessage: 'Authentication failed',
        errorMessage: 'Authentication error',
    });
    const [flowError, setFlowError] = useState<string | null>(null);

    const authenticate = useCallback(
        /**
         * Authenticate user with username/password
         * @param isMock - Whether to use mock authentication
         */
        (username: string, password: string, isMock: boolean = false): Promise<AuthenticateResult> => {
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
            setFlowError(errorMessage(err) || 'Login transition failed');
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
            setFlowError(errorMessage(err) || 'Logout failed');
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
