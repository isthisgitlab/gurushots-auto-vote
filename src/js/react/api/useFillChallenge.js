import { useNamedIpcAction } from './useAsyncIpcAction';

const fillNowIpc = (challengeId, mode) => window.api.fillChallengeNow(challengeId, mode);
const LABELS = { failureMessage: 'Photo submit failed', errorMessage: 'Photo submit error' };

/**
 * Hook for the manual photo-submit action via IPC.
 * Mirrors useTurbo: { fillNow, loading, error, clearError }.
 */
export const useFillChallenge = () => useNamedIpcAction('fillNow', fillNowIpc, LABELS);
