import { useNamedIpcAction } from './useAsyncIpcAction';

import type { LibraryUsage } from '../../types/photoPicker';

const suggestIpc = (challengeId: string | number, usage: LibraryUsage) => window.api.suggestPhotos(challengeId, usage);

/**
 * Hook for ranking the library under the auto-submit rules via IPC; nothing is submitted.
 * Mirrors useFillChallenge: { suggest, loading, error, clearError }.
 */
export const useSuggestPhotos = () => useNamedIpcAction('suggest', suggestIpc);
