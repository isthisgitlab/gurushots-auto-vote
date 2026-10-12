/**
 * Vote metadata for mock mode, in memory: the real metadata.json is shared and un-namespaced, and mock challenge ids
 * never match real ones, so a mock vote written there would stay in the user's file with nothing to prune it.
 */

import type { ChallengeMetadataEntry } from '../types/stores';

const createMemoryMetadata = () => {
    const entries = new Map<string, ChallengeMetadataEntry>();
    return {
        /** Records the exposure a challenge had when it was voted on, as the real updateChallengeVoteMetadata does. */
        updateChallengeVoteMetadata: (challengeId: string | number, exposure: number): void => {
            entries.set(String(challengeId), { lastVoteTime: new Date().toISOString(), exposureBump: exposure });
        },
        /** One challenge's entry, or null when it has not been voted on. */
        getChallengeMetadata: (challengeId: string | number): ChallengeMetadataEntry | null =>
            entries.get(String(challengeId)) ?? null,
    };
};

const mockMetadata = createMemoryMetadata();

export { createMemoryMetadata, mockMetadata };
