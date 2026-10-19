import { useNamedIpcAction } from './useAsyncIpcAction';

const fillNowIpc = (challengeId: string | number, mode: 'one' | 'all') =>
    window.api.fillChallengeNow(challengeId, mode);

/**
 * Hook for the manual photo-submit action via IPC.
 * Mirrors useTurbo: { fillNow, loading, error, clearError }.
 */
export const useFillChallenge = () => useNamedIpcAction('fillNow', fillNowIpc);
