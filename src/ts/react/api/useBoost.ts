import { useNamedIpcAction } from './useAsyncIpcAction';

// The apply-boost-to-entry handler takes (challengeId, imageId) only.
const applyBoostIpc = (challengeId: string | number, imageId: string) => window.api.applyBoost(challengeId, imageId);
const LABELS = { failureMessage: 'Boost failed', errorMessage: 'Boost error' };

/**
 * Hook for boost operations via IPC.
 * Returns { applyBoost, loading, error, clearError }.
 */
export const useBoost = () => useNamedIpcAction('applyBoost', applyBoostIpc, LABELS);
