import { useAsyncIpcAction } from './useAsyncIpcAction';

/**
 * Hook for boost operations via IPC.
 * Returns { applyBoost, loading, error, clearError }.
 */
export function useBoost() {
    const action = useAsyncIpcAction(
        (challengeId, imageId, boostType = 'boost') => window.api.applyBoost(challengeId, imageId, boostType),
        { failureMessage: 'Boost failed', errorMessage: 'Boost error' },
    );

    return {
        applyBoost: action.run,
        loading: action.loading,
        error: action.error,
        clearError: action.clearError,
    };
}
