import { useAsyncIpcAction } from './useAsyncIpcAction';
import { useTranslation } from '@/contexts/TranslationContext';

/**
 * Hook for the manual auto-fill action via IPC.
 * Mirrors useTurbo: { fillNow, loading, error, clearError }.
 */
export function useFillChallenge() {
    const { t } = useTranslation();
    const action = useAsyncIpcAction(
        async (challengeId, mode) => {
            const result = await window.api.fillChallengeNow(challengeId, mode);
            return result?.errorCode === 'no-visual-match' ? { ...result, error: t('app.visualNoMatch') } : result;
        },
        {
            failureMessage: 'Fill failed',
            errorMessage: 'Fill error',
        },
    );

    return {
        fillNow: action.run,
        loading: action.loading,
        error: action.error,
        clearError: action.clearError,
    };
}
