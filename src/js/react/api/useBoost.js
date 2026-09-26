// @ts-check
import { useNamedIpcAction } from './useAsyncIpcAction';

// The apply-boost-to-entry handler takes (challengeId, imageId) only.
/**
 * @param {string | number} challengeId
 * @param {string} imageId
 */
const applyBoostIpc = (challengeId, imageId) => window.api.applyBoost(challengeId, imageId);
const LABELS = { failureMessage: 'Boost failed', errorMessage: 'Boost error' };

/**
 * Hook for boost operations via IPC.
 * Returns { applyBoost, loading, error, clearError }.
 */
export const useBoost = () => useNamedIpcAction('applyBoost', applyBoostIpc, LABELS);
