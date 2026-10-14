import { useNamedIpcAction } from './useAsyncIpcAction';

const suggestIpc = (challengeId: string | number) => window.api.suggestPhotos(challengeId);

/**
 * Hook for ranking the library under the auto-submit rules via IPC; nothing is submitted.
 * Mirrors useFillChallenge: { suggest, loading, error, clearError }.
 */
export const useSuggestPhotos = () => useNamedIpcAction('suggest', suggestIpc);
