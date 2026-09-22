import { useAsyncIpcAction } from './useAsyncIpcAction';

/**
 * Hook for boost operations via IPC.
 * Returns { applyBoost, loading, error, clearError }.
 */
export function useBoost() {
    // The apply-boost-to-entry handler takes (challengeId, imageId) only.
    const action = useAsyncIpcAction((challengeId, imageId) => window.api.applyBoost(challengeId, imageId), {
        failureMessage: 'Boost failed',
        errorMessage: 'Boost error',
    });

    return {
        applyBoost: action.run,
        loading: action.loading,
        error: action.error,
        clearError: action.clearError,
    };
}
