import { useState, useCallback } from 'react';

/**
 * Hook for boost operations via IPC
 * @returns {{ applyBoost: function, loading: boolean, error: string|null }}
 */
export function useBoost() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    /**
     * Apply boost to a challenge entry
     */
    const applyBoost = useCallback(async (challengeId, imageId, boostType = 'boost') => {
        setLoading(true);
        setError(null);

        try {
            const result = await window.api.applyBoost(challengeId, imageId, boostType);

            if (!result?.success) {
                setError(result?.error || 'Boost failed');
            }

            return result;
        } catch (err) {
            const message = err.message || 'Boost error';
            setError(message);
            return { success: false, error: message };
        } finally {
            setLoading(false);
        }
    }, []);

    /**
     * Clear error
     */
    const clearError = useCallback(() => {
        setError(null);
    }, []);

    return {
        applyBoost,
        loading,
        error,
        clearError,
    };
}
