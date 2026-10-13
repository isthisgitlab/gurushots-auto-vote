import { useNamedIpcAction } from './useAsyncIpcAction';

const submitPickedIpc = (challengeId: string | number, imageIds: string[]) =>
    window.api.submitPickedPhotos(challengeId, imageIds);

/**
 * Hook for submitting the photos the user picked on a card via IPC.
 * Mirrors useFillChallenge: { submitPicked, loading, error, clearError }.
 */
export const useSubmitPicked = () => useNamedIpcAction('submitPicked', submitPickedIpc);
