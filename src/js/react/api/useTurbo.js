import { useCallback } from 'react';
import { useAsyncIpcAction } from './useAsyncIpcAction';

/**
 * Hook for applying a won Turbo to a specific entry image via IPC.
 * Mirrors useBoost: { applyTurbo, loading, error, clearError }.
 */
export function useTurbo() {
    const apply = useAsyncIpcAction(
        (challengeId, imageId) => window.api.applyTurbo(challengeId, imageId),
        { failureMessage: 'Turbo apply failed', errorMessage: 'Turbo apply error' },
    );
    const auto = useAsyncIpcAction(
        (challengeId, challengeTitle) => window.api.playAutoTurbo(challengeId, challengeTitle),
        { failureMessage: 'Auto-turbo run failed', errorMessage: 'Auto-turbo error' },
    );

    const clearError = useCallback(() => {
        apply.clearError();
        auto.clearError();
    }, [apply, auto]);

    return {
        applyTurbo: apply.run,
        playAutoTurbo: auto.run,
        loading: apply.loading || auto.loading,
        // Surface whichever side most recently produced an error.
        error: apply.error ?? auto.error,
        clearError,
    };
}
