/**
 * GuruShots Auto Voter - Voting Module
 *
 * This module handles fetching images for voting and submitting votes
 * to the GuruShots API.
 */

const {makePostRequest, createCommonHeaders, FORM_CONTENT_TYPE} = require('./api-client');
const logger = require('../logger');
const { updateChallengeVoteMetadata } = require('../metadata');

/**
 * Fetches images available for voting in a specific challenge
 *
 * @param {object} challenge - Challenge object containing title and URL
 * @param {string} token - Authentication token
 * @returns {object|null} - Response containing images to vote on, or null if request failed
 */
const getVoteImages = async (challenge, token) => {
    const operationId = `get-vote-images-${challenge.id}`;
    logger.withCategory('api').startOperation(operationId, `Fetching vote images for challenge ${challenge.title}`);

    // Request up to 100 images for voting
    const data = `limit=100&url=${challenge.url}`;
    const headers = {
        ...createCommonHeaders(token),
        'content-type': FORM_CONTENT_TYPE,
    };

    const response = await makePostRequest('https://api.gurushots.com/rest_mobile/get_vote_images', headers, data);

    // Validate response contains images
    if (!response || !response.images || response.images.length === 0) {
        logger.withCategory('api').endOperation(operationId, null, 'No images available for voting');
        return null;
    }

    logger.withCategory('api').endOperation(operationId, `Retrieved ${response.images.length} images for voting`);
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
 * @returns {object|undefined} - API response or undefined if submission failed
 */
const submitVotes = async (voteImages, token, targetExposure = 100) => {
    const {challenge, voting, images} = voteImages;
    const operationId = `submit-votes-${challenge.id}`;
    
    // Validate we have images to vote on
    if (!images || images.length === 0) {
        logger.withCategory('voting').warning(`No images to vote on for challenge: ${challenge.title}`, null);
        return;
    }
    
    logger.withCategory('voting').startOperation(operationId, `Submitting votes for challenge ${challenge.title} (target: ${targetExposure}%)`);

    // Prepare data for vote submission
    let votedImages = '';
    // Track all images viewed during this session
    const viewedImages = images.map(img => `&viewed_image_ids[]=${encodeURIComponent(img.id)}`).join('');
    // Get current exposure factor from the challenge data
    let {exposure_factor} = voting.exposure;
    const originalExposureFactor = exposure_factor; // Store original exposure level for metadata

    // Track unique images to avoid voting for the same image twice
    const uniqueImageIds = new Set();

    // Continue voting until exposure factor reaches target exposure
    while (exposure_factor < targetExposure) {
        // Select a random image from the available images
        const randomImage = images[Math.floor(Math.random() * images.length)];
        if (uniqueImageIds.has(randomImage.id)) continue;

        // Add image to voted list and update exposure factor
        uniqueImageIds.add(randomImage.id);
        votedImages += `&image_ids[]=${encodeURIComponent(randomImage.id)}`;
        exposure_factor += randomImage.ratio;

        // Break if we've used all available images but still haven't reached target exposure
        if (uniqueImageIds.size === images.length) {
            logger.withCategory('voting').warning(`Insufficient images to reach ${targetExposure}% exposure for ${challenge.title} (only ${uniqueImageIds.size} images available)`, null);
            break;
        }
    }

    // Prepare final request data
    const data = `c_id=${challenge.id}${votedImages}&layout=scroll${viewedImages}`;
    const headers = {
        ...createCommonHeaders(token),
        'content-type': FORM_CONTENT_TYPE,
    };

    // Submit votes to API
    const response = await makePostRequest('https://api.gurushots.com/rest_mobile/submit_vote', headers, data);
    if (!response) {
        logger.withCategory('voting').endOperation(operationId, null, 'Vote submission failed');
        return;
    }

    // Update metadata after successful vote submission
    try {
        logger.withCategory('voting').debug(`🔧 DEBUG: About to update metadata for challenge ${challenge.id}, original exposure: ${Math.round(originalExposureFactor)}%`, null);
        const success = updateChallengeVoteMetadata(challenge.id, Math.round(originalExposureFactor));
        if (success) {
            logger.withCategory('voting').debug(`🔧 DEBUG: Successfully updated metadata for challenge ${challenge.id}: original exposure ${Math.round(originalExposureFactor)}%`, null);
            logger.withCategory('voting').info(`Updated metadata for challenge ${challenge.id}: original exposure ${Math.round(originalExposureFactor)}%`, null);
        } else {
            logger.withCategory('voting').debug(`🔧 DEBUG: Failed to update metadata for challenge ${challenge.id}`, null);
            logger.withCategory('voting').warning(`Failed to update metadata for challenge ${challenge.id}`, null);
        }
    } catch (error) {
        logger.withCategory('voting').debug(`🔧 DEBUG: Error updating metadata for challenge ${challenge.id}:`, error);
        logger.withCategory('voting').warning(`Error updating metadata for challenge ${challenge.id}:`, error);
    }

    logger.withCategory('voting').endOperation(operationId, `Votes submitted successfully (${uniqueImageIds.size} images, ~${exposure_factor.toFixed(1)}% exposure)`);
    return response;
};

module.exports = {
    getVoteImages,
    submitVotes,
}; 