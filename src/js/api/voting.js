/**
 * GuruShots Auto Voter - Voting Module
 *
 * This module handles fetching images for voting and submitting votes
 * to the GuruShots API.
 */

const { makePostRequest, createCommonHeaders, FORM_CONTENT_TYPE } = require('./api-client');
const { ENDPOINTS } = require('./constants');
const logger = require('../logger');
const { updateChallengeVoteMetadata } = require('../metadata');

/**
 * Fetches images available for voting in a specific challenge
 *
 * @param {object} challenge - Challenge object containing title and URL
 * @param {string} token - Authentication token
 * @returns {Promise<object|null>} - Response containing images to vote on, or null if request failed
 */
const getVoteImages = async (challenge, token) => {
    const operationId = `get-vote-images-${challenge.id}`;
    logger
        .withCategory('api')
        .startOperation(operationId, `Fetching vote images for ${logger.challengeTag(challenge)}`, 'DEBUG');

    // Request up to 100 images for voting
    const data = `limit=100&url=${challenge.url}`;
    const headers = {
        ...createCommonHeaders(token),
        'content-type': FORM_CONTENT_TYPE,
    };

    const response = await makePostRequest(ENDPOINTS.voteImages, headers, data);

    // No-images is an expected branch (mock-mode, or pool emptied between cycles).
    // The outer voting op reports the user-visible line; we close at DEBUG.
    if (!response || !response.images || response.images.length === 0) {
        logger.withCategory('api').endOperation(operationId, 'no images available, returning null');
        return null;
    }

    logger.withCategory('api').endOperation(operationId, `retrieved ${response.images.length} images`);
    return response;
};

/**
 * Submits votes for images in a challenge
 *
 * This function:
 * 1. Randomly selects images to vote on
 * 2. Continues voting until the exposure factor reaches the target exposure or all images are used
 * 3. Submits the votes to the GuruShots API
 *
 * @param {object} voteImages - Object containing challenge, voting, and images data
 * @param {string} token - Authentication token
 * @param {number} targetExposure - Target exposure percentage (default: 100)
 * @returns {Promise<object|undefined>} - API response or undefined if submission failed
 */
const submitVotes = async (voteImages, token, targetExposure = 100) => {
    const { challenge, voting, images } = voteImages;
    const startTime = Date.now();

    // Validate we have images to vote on
    if (!images || images.length === 0) {
        logger.withCategory('voting').warning(`${logger.challengeTag(challenge)} No images to vote on`, null);
        return;
    }

    logger
        .withCategory('voting')
        .debug(`${logger.challengeTag(challenge)} Submitting votes (target: ${targetExposure}%)`, null);

    // Prepare data for vote submission
    let votedImages = '';
    // Track all images viewed during this session
    const viewedImages = images.map((img) => `&viewed_image_ids[]=${encodeURIComponent(img.id)}`).join('');
    // Get current exposure factor from the challenge data
    let { exposure_factor } = voting.exposure;
    const originalExposureFactor = exposure_factor; // Store original exposure level for metadata

    // Vote over a shuffled, de-duplicated copy of the pool.
    //
    // This used to sample `images` at random and terminate on
    // `uniqueImageIds.size === images.length`. That guard is unreachable whenever the
    // endpoint returns one image id twice — the Set can never grow to the array's length —
    // so once every distinct id had been consumed the loop spun forever on `continue`,
    // synchronously, with no cancellation check. Iterating a shuffled deduped list makes
    // termination structural: each iteration consumes exactly one candidate. Shuffling first
    // preserves the same distribution over selection order the rejection sampling had.
    const uniqueImages = [];
    const seenImageIds = new Set();
    for (const image of images) {
        if (!image || seenImageIds.has(image.id)) continue;
        seenImageIds.add(image.id);
        uniqueImages.push(image);
    }

    // Fisher-Yates, so the pick order stays unbiased.
    for (let i = uniqueImages.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [uniqueImages[i], uniqueImages[j]] = [uniqueImages[j], uniqueImages[i]];
    }

    const votedImageIds = [];
    let unusableRatios = 0;

    for (const image of uniqueImages) {
        // Keep the original comparison verbatim rather than negating it. A legacy caller can
        // still pass a function as the target, and `number < function` is false — but so is
        // `number >= function`, so an inverted test would vote the whole pool instead of
        // standing down. See the thresholdFunction case in tests/api/voting.test.js.
        if (!(exposure_factor < targetExposure)) break;

        votedImageIds.push(image.id);
        votedImages += `&image_ids[]=${encodeURIComponent(image.id)}`;

        // A missing or non-numeric ratio must not poison the accumulator: `NaN < target` is
        // false, so a single malformed entry used to end the loop after one vote and submit
        // a near-empty ballot without warning. Count it instead and keep going.
        const ratio = Number(image.ratio);
        if (Number.isFinite(ratio)) {
            exposure_factor += ratio;
        } else {
            unusableRatios++;
        }
    }

    if (unusableRatios > 0) {
        logger
            .withCategory('voting')
            .warning(
                `${logger.challengeTag(challenge)} ${unusableRatios} of ${uniqueImages.length} images had no usable exposure ratio — exposure estimate may be low`,
                null,
            );
    }

    // Only a genuine shortfall is worth warning about. The old code warned whenever the pool
    // was exhausted, including when the final image carried us past the target.
    if (votedImageIds.length > 0 && exposure_factor < targetExposure) {
        logger
            .withCategory('voting')
            .warning(
                `${logger.challengeTag(challenge)} Insufficient images to reach ${targetExposure}% exposure (only ${uniqueImages.length} available)`,
                null,
            );
    }

    // The loop above never ran, so there is nothing to submit. This happens when
    // the exposure the vote-images endpoint reports is ALREADY at/above the target
    // — most easily reached via voteOnNewEntry, which deliberately votes when the
    // challenge-list exposure sits at/above the trigger, but any caller can hit it
    // when the two endpoints disagree. Posting an image_ids-less vote request
    // achieves nothing, and letting it through would log a clean "voted" cycle for
    // zero actual votes.
    if (votedImageIds.length === 0) {
        logger
            .withCategory('voting')
            .warning(
                `${logger.challengeTag(challenge)} No vote submitted: exposure already ${exposure_factor}% (target ${targetExposure}%)`,
                null,
            );
        return;
    }

    // Prepare final request data
    const data = `c_id=${challenge.id}${votedImages}&layout=scroll${viewedImages}`;
    const headers = {
        ...createCommonHeaders(token),
        'content-type': FORM_CONTENT_TYPE,
    };

    // Submit votes to API
    const response = await makePostRequest(ENDPOINTS.submitVote, headers, data);
    if (!response) {
        logger.withCategory('voting').error(`${logger.challengeTag(challenge)} Vote submission failed`, null);
        return;
    }

    // Update metadata after successful vote submission
    try {
        const success = updateChallengeVoteMetadata(challenge.id, Math.round(originalExposureFactor));
        if (success) {
            logger
                .withCategory('voting')
                .debug(
                    `Updated metadata for ${logger.challengeTag(challenge)}: original exposure ${Math.round(originalExposureFactor)}%`,
                    null,
                );
        } else {
            logger
                .withCategory('voting')
                .warning(`Failed to update metadata for ${logger.challengeTag(challenge)}`, null);
        }
    } catch (error) {
        logger.withCategory('voting').warning(`Error updating metadata for ${logger.challengeTag(challenge)}:`, error);
    }

    const duration = Date.now() - startTime;
    logger
        .withCategory('voting')
        .success(
            `${logger.challengeTag(challenge)} Votes submitted (${votedImageIds.length} images, ~${exposure_factor.toFixed(1)}% exposure)`,
            null,
            duration,
        );

    return response;
};

module.exports = {
    getVoteImages,
    submitVotes,
};
