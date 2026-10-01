/**
 * Mock counterpart to api/voting.ts: session-stable vote images and a vote
 * submit that records the pre-vote exposure in metadata like the real one.
 */

import * as voting from '../voting';
import * as settings from '../../settings';
import * as logger from '../../logger';
import { simulateApiResponse, simulateApiError, mockMethod } from '../simulate';
import { getSessionCache } from '../sessionCache';
import * as metadata from '../../metadata';

import type { Challenge } from '../../types/gurushots';
import type * as votingModule from '../../api/voting';
import { errorMessage } from '../../errorMessage';

/**
 * Simulate getting vote images. The generated set carries only the
 * challenge's id, title and url, so it is typed as the generator's output
 * rather than the real VoteImagesResponse.
 */
const getVoteImages: (
    challenge: Challenge,
    token: string,
) => Promise<ReturnType<typeof voting.generateMockVoteImages> | null> = mockMethod(
    {
        name: 'getVoteImages',
        tokenArg: 1,
        debug: (challenge, token) => {
            logger.withCategory('challenges').debug(`Challenge: ${challenge.title}`, null);
            logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
        },
        // Real getVoteImages resolves null on failure
        onNoToken: () => null,
    },
    async (challenge) => {
        const sessionMockCache = getSessionCache();
        // Every mock challenge carries a url.
        const challengeUrl = challenge.url as string;
        const cacheKey = `${challengeUrl}-${challenge.id}`;

        // Use cached vote images for session stability
        if (!sessionMockCache.voteImages.has(cacheKey)) {
            const voteImages = voting.generateMockVoteImages(challengeUrl, challenge);
            sessionMockCache.voteImages.set(cacheKey, voteImages);
            logger
                .withCategory('voting')
                .debug(
                    `Generated session-stable vote images for ${challenge.title}: ${voteImages.images.length}`,
                    null,
                );
        } else {
            logger.withCategory('voting').debug(`Using cached vote images for ${challenge.title}`, null);
        }

        // Present: stored above when it was missing.
        const cachedVoteImages = sessionMockCache.voteImages.get(cacheKey) as ReturnType<
            typeof voting.generateMockVoteImages
        >;
        logger.withCategory('voting').debug(`Returning mock vote images: ${cachedVoteImages.images.length}`, null);
        return simulateApiResponse(cachedVoteImages, 1200);
    },
);

/**
 * Simulate submitting votes
 */
const submitVotes: typeof votingModule.submitVotes = mockMethod(
    {
        name: 'submitVotes',
        tokenArg: 1,
        debug: (voteImages, token, exposureThreshold = settings.SETTINGS_SCHEMA.exposure.default) => {
            logger
                .withCategory('voting')
                .debug(`Vote images count: ${voteImages.images ? voteImages.images.length : 0}`, null);
            logger.withCategory('api').debug(`Token provided: ${!!token}`, null);
            logger.withCategory('voting').debug(`Exposure threshold: ${exposureThreshold}`, null);
        },
        // Real submitVotes bare-returns (resolves undefined) on failure
        onNoToken: () => undefined,
    },
    async (voteImages) => {
        if (voteImages.images && voteImages.images.length > 0) {
            logger.withCategory('voting').info('Submitting mock votes successfully', null);

            // Update metadata after successful mock vote submission
            try {
                if (voteImages.challenge && voteImages.challenge.id) {
                    // Use the ORIGINAL exposure factor from before voting (the "from what" value)
                    const originalExposure = voteImages.voting?.exposure?.exposure_factor || 50;

                    logger
                        .withCategory('voting')
                        .debug(
                            `About to update mock metadata for challenge ${voteImages.challenge.id}, original exposure: ${Math.round(originalExposure)}%`,
                            null,
                        );
                    const success = metadata.updateChallengeVoteMetadata(
                        voteImages.challenge.id.toString(),
                        Math.round(originalExposure),
                    );
                    if (success) {
                        logger
                            .withCategory('voting')
                            .debug(
                                `Successfully updated mock metadata for challenge ${voteImages.challenge.id}: original exposure ${Math.round(originalExposure)}%`,
                                null,
                            );
                        logger
                            .withCategory('voting')
                            .success(
                                `Mock metadata updated for challenge ${voteImages.challenge.id}: original exposure ${Math.round(originalExposure)}%`,
                                null,
                                null,
                            );
                    } else {
                        logger
                            .withCategory('voting')
                            .debug(`Failed to update mock metadata for challenge ${voteImages.challenge.id}`, null);
                        logger
                            .withCategory('voting')
                            .warning(`Failed to update mock metadata for challenge ${voteImages.challenge.id}`, null);
                    }
                }
            } catch (error) {
                logger
                    .withCategory('voting')
                    .debug(
                        `Error updating mock metadata for challenge ${voteImages.challenge.id}: ${errorMessage(error)}`,
                        null,
                    );
                logger.withCategory('voting').error(`Error updating mock metadata: ${errorMessage(error)}`, null);
            }

            return simulateApiResponse(voting.mockVoteSubmissionSuccess, 2000);
        } else {
            logger.withCategory('voting').error('No vote images, returning error', null);
            return simulateApiError(voting.mockVoteSubmissionFailure, 1000);
        }
    },
);

export { getVoteImages, submitVotes };
