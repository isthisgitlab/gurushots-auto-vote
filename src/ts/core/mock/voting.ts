/**
 * GuruShots Auto Voter - Mock Voting Data
 *
 * Mock responses for voting operations
 */

import type { Challenge } from '../types/gurushots';

const buildVoteImage = (i: number) => {
    const ratio = Math.random() * 3 + 3; // 3-6 ratio

    return {
        id: `vote_img_${String(i + 1).padStart(3, '0')}`,
        ratio: Math.round(ratio * 10) / 10, // Round to 1 decimal
    };
};

const titleFromUrl = (challengeUrl: string) =>
    challengeUrl
        .replace('-2024', '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (l) => l.toUpperCase());

/**
 * Generate dynamic mock vote images for different challenges
 */
const generateMockVoteImages = (challengeUrl: string, originalChallenge: Challenge | null = null) => {
    // Generate 15-25 random images for voting
    const numImages = Math.floor(Math.random() * 11) + 15; // 15-25 images
    const images = Array.from({ length: numImages }, (_, i) => buildVoteImage(i));

    return {
        challenge: {
            id: originalChallenge ? originalChallenge.id : Math.floor(Math.random() * 9000) + 1000,
            title: originalChallenge ? originalChallenge.title : titleFromUrl(challengeUrl),
            url: originalChallenge ? originalChallenge.url : challengeUrl,
        },
        voting: {
            exposure: {
                // Use original challenge's exposure values or random defaults.
                exposure_factor:
                    originalChallenge?.member?.ranking?.exposure?.exposure_factor ||
                    Math.floor(Math.random() * 30) + 20, // random 20-50%
                vote_exposure_factor:
                    originalChallenge?.member?.ranking?.exposure?.vote_exposure_factor ||
                    Math.floor(Math.random() * 30) + 20, // random 20-50%
                vote_ratio:
                    originalChallenge?.member?.ranking?.exposure?.vote_ratio ||
                    Math.round((1 + Math.random() * 2) * 100) / 100, // random 1-3, 2 decimals
            },
        },
        images,
    };
};

/**
 * Mock vote submission success response
 */
const mockVoteSubmissionSuccess = {
    success: true,
    message: 'Votes submitted successfully',
    challenge_id: 1001,
    votes_submitted: 5,
    new_exposure_factor: 100,
    rewards: {
        points_earned: 25,
        experience_gained: 10,
    },
};

/**
 * Mock vote submission failure response
 */
const mockVoteSubmissionFailure = {
    success: false,
    error: 'Invalid challenge or images',
    code: 'VOTE_FAILED',
    message: 'Unable to submit votes for this challenge',
};

export { mockVoteSubmissionSuccess, mockVoteSubmissionFailure, generateMockVoteImages };
