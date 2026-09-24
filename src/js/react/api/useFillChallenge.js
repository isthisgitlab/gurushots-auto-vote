import { useAsyncIpcAction } from './useAsyncIpcAction';

/**
 * Hook for the manual photo-submit action via IPC.
 * Mirrors useTurbo: { fillNow, loading, error, clearError }.
 */
export function useFillChallenge() {
    const action = useAsyncIpcAction((challengeId, mode) => window.api.fillChallengeNow(challengeId, mode), {
        failureMessage: 'Photo submit failed',
        errorMessage: 'Photo submit error',
    });

    return {
        fillNow: action.run,
        loading: action.loading,
        error: action.error,
        clearError: action.clearError,
    };
}
