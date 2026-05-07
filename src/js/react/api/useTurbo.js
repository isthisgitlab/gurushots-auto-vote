import { useState, useCallback } from 'react';

/**
 * Hook for applying a won Turbo to a specific entry image via IPC.
 * Mirrors useBoost: { applyTurbo, loading, error, clearError }.
 */
export function useTurbo() {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);

    const applyTurbo = useCallback(async (challengeId, imageId) => {
        setLoading(true);
        setError(null);
        try {
            const result = await window.api.applyTurbo(challengeId, imageId);
            if (!result?.success) {
                setError(result?.error || 'Turbo apply failed');
            }
            return result;
        } catch (err) {
            const message = err.message || 'Turbo apply error';
            setError(message);
            return { success: false, error: message };
        } finally {
            setLoading(false);
        }
    }, []);

    const playAutoTurbo = useCallback(async (challengeId, challengeTitle) => {
        setLoading(true);
        setError(null);
        try {
            const result = await window.api.playAutoTurbo(challengeId, challengeTitle);
            if (!result?.success) {
                setError(result?.error || 'Auto-turbo run failed');
            }
            return result;
        } catch (err) {
            const message = err.message || 'Auto-turbo error';
            setError(message);
            return { success: false, error: message };
        } finally {
            setLoading(false);
        }
    }, []);

    const clearError = useCallback(() => setError(null), []);

    return { applyTurbo, playAutoTurbo, loading, error, clearError };
}
