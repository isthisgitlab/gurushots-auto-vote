/**
 * GuruShots Auto Voter - Voting Module
 * 
 * This module handles fetching images for voting and submitting votes
 * to the GuruShots API.
 */

const { makePostRequest, createCommonHeaders, FORM_CONTENT_TYPE } = require('./api-client');

/**
 * Fetches images available for voting in a specific challenge
 * 
 * @param {object} challenge - Challenge object containing title and URL
 * @param {string} token - Authentication token
 * @returns {object|null} - Response containing images to vote on, or null if request failed
 */
const getVoteImages = async (challenge, token) => {
    console.log(`Fetching vote images for challenge: ${challenge.title}`);
    
    // Request up to 100 images for voting
    const data = `limit=100&url=${challenge.url}`;
    const headers = {
        ...createCommonHeaders(token), 
        'content-type': FORM_CONTENT_TYPE,
    };

    const response = await makePostRequest('https://api.gurushots.com/rest_mobile/get_vote_images', headers, data);
    
    // Validate response contains images
    if (!response || !response.images || response.images.length === 0) {
        console.warn(`No images available or invalid response for challenge: ${challenge.title}. Skipping.`);
        return null;
    }

    console.log(`Fetched ${response.images.length} images for challenge: ${challenge.title}`);
    return response;
};

/**
 * Submits votes for images in a challenge
 * 
 * This function:
 * 1. Randomly selects images to vote on
 * 2. Continues voting until the exposure factor reaches 100 or all images are used
 * 3. Submits the votes to the GuruShots API
 * 
 * @param {object} voteImages - Object containing challenge, voting, and images data
 * @param {string} token - Authentication token
 * @returns {object|undefined} - API response or undefined if submission failed
 */
const submitVotes = async (voteImages, token) => {
    const {challenge, voting, images} = voteImages;

    // Validate we have images to vote on
    if (!images || images.length === 0) {
        console.warn(`No images to vote on for challenge: ${challenge.title}`);
        return;
    }

    // Prepare data for vote submission
    let votedImages = '';
    // Track all images viewed during this session
    const viewedImages = images.map(img => `&viewed_image_ids[]=${encodeURIComponent(img.id)}`).join('');
    // Get current exposure factor from the challenge data
    let {exposure_factor} = voting.exposure;

    // Track unique images to avoid voting for the same image twice
    const uniqueImageIds = new Set();

    // Continue voting until exposure factor reaches 100
    while (exposure_factor < 100) {
        // Select a random image from the available images
        const randomImage = images[Math.floor(Math.random() * images.length)];
        if (uniqueImageIds.has(randomImage.id)) continue;

        // Add image to voted list and update exposure factor
        uniqueImageIds.add(randomImage.id);
        votedImages += `&image_ids[]=${encodeURIComponent(randomImage.id)}`;
        exposure_factor += randomImage.ratio;

        // Break if we've used all available images but still haven't reached 100
        if (uniqueImageIds.size === images.length) {
            console.warn(`Not enough images to reach exposure factor 100 for challenge: ${challenge.title}`);
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
        console.error(`Failed to submit votes for challenge: ${challenge.title}`);
        return;
    }

    console.log(`Votes submitted successfully for challenge: ${challenge.title}`);
    return response;
};

module.exports = {
    getVoteImages,
    submitVotes,
}; 