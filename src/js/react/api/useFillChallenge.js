import { useAsyncIpcAction } from './useAsyncIpcAction';

/**
 * Hook for the manual auto-fill action via IPC.
 * Mirrors useTurbo: { fillNow, loading, error, clearError }.
 */
export function useFillChallenge() {
    const action = useAsyncIpcAction((challengeId, mode) => window.api.fillChallengeNow(challengeId, mode), {
        failureMessage: 'Fill failed',
        errorMessage: 'Fill error',
    });

    return {
        fillNow: action.run,
        loading: action.loading,
        error: action.error,
        clearError: action.clearError,
    };
}
