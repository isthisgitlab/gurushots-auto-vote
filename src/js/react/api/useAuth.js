import { useState, useCallback } from 'react';

/**
 * Hook for authentication via IPC
 * @returns {{ authenticate: function, login: function, logout: function, loading: boolean, error: string|null }}
 */
export function useAuth() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    /**
     * Authenticate user with username/password
     * @param {string} username
     * @param {string} password
     * @param {boolean} isMock - Whether to use mock authentication
     * @returns {Promise<{success: boolean, token?: string, message?: string, user?: object}>}
     */
    const authenticate = useCallback(async (username, password, isMock = false) => {
        setLoading(true);
        setError(null);

        try {
            const result = await window.api.authenticate(username, password, isMock);

            if (!result.success) {
                setError(result.message || 'Authentication failed');
            }

            return result;
        } catch (err) {
            const message = err.message || 'Authentication error';
            setError(message);
            return { success: false, message };
        } finally {
            setLoading(false);
        }
    }, []);

    /**
     * Signal successful login to main process (transitions to main window)
     */
    const login = useCallback(async () => {
        try {
            await window.api.login();
        } catch (err) {
            setError(err.message || 'Login transition failed');
        }
    }, []);

    /**
     * Logout the current user
     */
    const logout = useCallback(async () => {
        try {
            await window.api.logout();
        } catch (err) {
            setError(err.message || 'Logout failed');
        }
    }, []);

    /**
     * Clear any authentication error
     */
    const clearError = useCallback(() => {
        setError(null);
    }, []);

    return {
        authenticate,
        login,
        logout,
        loading,
        error,
        clearError,
    };
}
