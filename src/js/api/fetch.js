/**
 * GuruShots Auto Voter - API Interaction Module
 * 
 * This module handles all interactions with the GuruShots API, including:
 * - Authentication and login
 * - Fetching active challenges
 * - Getting images to vote on
 * - Submitting votes
 * - Applying boosts to photos
 * 
 * The module uses axios for HTTP requests and requires a valid authentication token
 * stored in the .env file to function properly.
 */

const path = require('path');
require('dotenv').config({path: path.resolve(__dirname, '../.env')});

const axios = require('axios');
const prompt = require('prompt-sync')();
const { generateRandomHeaders } = require('./randomizer');

// Common content type for form submissions
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';

/**
 * Makes a POST request to the GuruShots API
 * 
 * @param {string} url - The API endpoint URL
 * @param {object} headers - Request headers including authentication token
 * @param {string} data - URL-encoded form data (default: empty string)
 * @returns {object|null} - Response data or null if request failed
 * @throws {Error} - If TOKEN environment variable is not set
 */
const makePostRequest = async (url, headers, data = '') => {
    // Verify that authentication token exists
    if (!process.env.TOKEN || process.env.TOKEN === '') {
        console.error('TOKEN must be set');
        process.exit(1);
    }

    try {
        const response = await axios({
            method: 'post', 
            url, 
            headers, 
            data, 
            timeout: 3000, // 3 second timeout to prevent hanging
        });
        return response.data;
    } catch (error) {
        console.error(`Error during POST request to ${url}:`, error.message || error);
        return null; // Return null instead of throwing to prevent crashing
    }
};

/**
 * Common headers for all API requests to GuruShots
 * 
 * These headers mimic an iOS device to ensure compatibility with the API.
 * Headers are randomized to make the app look more natural when used by multiple people.
 * The x-token header is populated from the TOKEN environment variable
 * which is obtained during the login process.
 */
const getCommonHeaders = () => {
    return generateRandomHeaders(process.env.TOKEN);
};

/**
 * Fetches all active challenges for the authenticated user
 * 
 * @returns {object} Response containing array of active challenges
 *                   or empty challenges array if request fails
 */
const getActiveChallenges = async () => {
    console.log('Getting active challenges');
    const headers = getCommonHeaders();
    const response = await makePostRequest('https://api.gurushots.com/rest_mobile/get_my_active_challenges', headers);
    
    // Handle failed requests gracefully
    if (!response) {
        console.error('Failed to fetch active challenges.');
        return {challenges: []}; // Return empty challenges to avoid crashing
    }
    return response;
};

/**
 * Fetches images available for voting in a specific challenge
 * 
 * @param {object} challenge - Challenge object containing title and URL
 * @returns {object|null} - Response containing images to vote on, or null if request failed
 */
const getVoteImages = async (challenge) => {
    console.log(`Fetching vote images for challenge: ${challenge.title}`);
    
    // Request up to 100 images for voting
    const data = `limit=100&url=${challenge.url}`;
    const headers = {
        ...getCommonHeaders(), 
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
 * @returns {object|undefined} - API response or undefined if submission failed
 */
const submitVotes = async (voteImages) => {
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
        ...getCommonHeaders(), 
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

/**
 * Applies a boost to a photo in a challenge
 * 
 * Boosts increase the visibility of your photo in a challenge.
 * This function finds the first non-turboed photo entry and applies a boost to it.
 * 
 * @param {object} challenge - Challenge object containing id and member data
 * @returns {object|null} - API response or null if boost failed
 */
const applyBoost = async (challenge) => {
    const {id, member} = challenge;

    /**
     * Helper function to find the first non-turboed photo entry
     * 
     * @param {Array} entries - Array of photo entries in the challenge
     * @returns {string|null} - ID of the first non-turboed entry or null if none found
     */
    const getFirstNonTurboKey = (entries) => {
        for (let i = 0; i < entries.length; i++) {
            if (!entries[i].turbo) {
                return entries[i].id;
            }
        }
        return null;
    };

    // Find a photo to boost
    const boostImageId = getFirstNonTurboKey(member.ranking.entries);
    if (!boostImageId) {
        console.error('No non-turboed entries found for boosting.');
        return null;
    }

    // Prepare request data
    const data = `c_id=${id}&image_id=${boostImageId}`;
    const headers = {
        ...getCommonHeaders(),
        'content-type': FORM_CONTENT_TYPE,
    };

    // Send boost request to API
    const response = await makePostRequest('https://api.gurushots.com/rest_mobile/boost_photo', headers, data);
    if (!response) {
        console.error(`Failed to apply boost for challenge ID: ${id}`);
        return;
    }

    console.log(`Boost applied successfully to image ID: ${boostImageId}`);
    return response;
};

/**
 * Applies a boost to a specific photo entry in a challenge
 * 
 * @param {number} challengeId - Challenge ID
 * @param {string} imageId - Image ID to boost
 * @returns {object|null} - API response or null if boost failed
 */
const applyBoostToEntry = async (challengeId, imageId) => {
    // Prepare request data
    const data = `c_id=${challengeId}&image_id=${imageId}`;
    const headers = {
        ...getCommonHeaders(),
        'content-type': FORM_CONTENT_TYPE,
    };

    // Send boost request to API
    const response = await makePostRequest('https://api.gurushots.com/rest_mobile/boost_photo', headers, data);
    if (!response) {
        console.error(`Failed to apply boost for challenge ID: ${challengeId}, image ID: ${imageId}`);
        return null;
    }

    console.log(`Boost applied successfully to image ID: ${imageId} in challenge ${challengeId}`);
    return response;
};

/**
 * Helper functions for managing delays between operations
 */

/**
 * Creates a promise that resolves after the specified time
 * 
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise} - Promise that resolves after the specified time
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Generates a random delay between min and max milliseconds
 * 
 * Used to add variability to request timing to appear more human-like
 * 
 * @param {number} min - Minimum delay in milliseconds
 * @param {number} max - Maximum delay in milliseconds
 * @returns {number} - Random delay value
 */
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

/**
 * Main function that fetches active challenges and processes them
 * 
 * This function:
 * 1. Gets all active challenges for the user
 * 2. For each challenge:
 *    - Applies boosts if available and close to deadline
 *    - Votes on images if exposure factor is less than 100
 * 
 * @returns {void}
 */
const fetchChallengesAndVote = async () => {
    // Get all active challenges
    const {challenges} = await getActiveChallenges();
    // Current timestamp in seconds (Unix epoch time)
    const now = Math.floor(Date.now() / 1000);

    // Process each challenge
    for (const challenge of challenges) {
        // Check if boost is available for this challenge
        const {boost} = challenge.member;
        if (boost.state === 'AVAILABLE' && boost.timeout) {
            console.log(`Boost available for challenge: ${challenge.title}`);

            // Apply boost if deadline is within 1 hour
            const oneHourInSeconds = 60 * 60; // 1 hour in seconds
            const timeUntilDeadline = boost.timeout - now;

            if (timeUntilDeadline <= oneHourInSeconds && timeUntilDeadline > 0) {
                console.log(`Boost deadline is within 1 hour (${Math.floor(timeUntilDeadline / 60)} minutes). Executing boost.`);
                try {
                    await applyBoost(challenge);
                } catch (error) {
                    console.error('Error during boost process:', error.message || error);
                }
            }
        }

        // Vote on challenge if exposure factor is less than 100 and challenge has started
        if (challenge.member.ranking.exposure.exposure_factor < 100 && challenge.start_time < now) {
            try {
                // Get images to vote on
                const voteImages = await getVoteImages(challenge);
                if (voteImages) {
                    // Submit votes
                    await submitVotes(voteImages);
                    // Add random delay between challenges to mimic human behavior
                    await sleep(getRandomDelay(2000, 5000));
                }
            } catch (error) {
                console.error(`Error voting on challenge: ${challenge.title}. Skipping to next challenge.`);
                console.error(error.message || error);
            }
        }
    }

    // Format completion time using Latvian locale (24-hour format)
    const completionTime = new Date().toLocaleTimeString('lv-LV');
    console.log(`Voting process completed for all challenges at ${completionTime}`);
};

/**
 * Authenticates with GuruShots and obtains an authentication token
 * 
 * This function:
 * 1. Prompts the user for email and password
 * 2. Sends authentication request to GuruShots API
 * 3. Saves the obtained token to the .env file for future use
 * 
 * @returns {object|null} - Response data containing token or null if login failed
 */
const login = async () => {
    console.log('start login');

    // Prompt user for credentials
    var email = prompt('Please enter your email: ');
    var password = prompt('Please enter your password: ');

    // Prepare login data
    const data = `login=${encodeURIComponent(email)}&password=${password}`;

    // Create loading animation for better user experience
    var loading = (function () {
        var h = ['|', '/', '-', '\\']; // Animation characters
        var i = 0;

        return setInterval(() => {
            i = (i > 3) ? 0 : i;
            console.clear();
            console.log(`Logging in ${h[i]}`);
            i++;
        }, 300);
    })();

    // Prepare request configuration
    const config = {
        method: 'post',
        url: 'https://api.gurushots.com/rest_mobile/signup', // API endpoint for login
        headers: {
            ...getCommonHeaders(),
            'content-type': FORM_CONTENT_TYPE,
            'content-length': data.length.toString(),
            'x-token': undefined, // Remove token for login request
        },
        data: data,
        timeout: 5000, // 5 second timeout
    };

    try {
        // Send login request
        const response = await axios(config);
        clearInterval(loading); // Stop loading animation
        console.log('login successful');

        // Process successful login
        if (response.data && response.data.token) {
            console.log('Token obtained successfully');
            process.env.TOKEN = response.data.token;

            // Save token to .env file for persistence
            const fs = require('fs');
            const envPath = path.resolve(__dirname, '../.env');
            let envContent = '';

            try {
                // Read existing .env file if it exists
                if (fs.existsSync(envPath)) {
                    envContent = fs.readFileSync(envPath, 'utf8');

                    // Replace TOKEN line if it exists
                    if (envContent.includes('TOKEN=')) {
                        envContent = envContent.replace(/TOKEN=.*(\r?\n|$)/g, `TOKEN=${response.data.token}$1`);
                    } else {
                        // Add TOKEN line if it doesn't exist
                        envContent += `\nTOKEN=${response.data.token}`;
                    }
                } else {
                    // Create new .env file with TOKEN
                    envContent = `TOKEN=${response.data.token}\n`;
                }

                // Write to .env file
                fs.writeFileSync(envPath, envContent);
                console.log('Token saved to .env file');
            } catch (err) {
                console.error('Error saving token to .env file:', err.message);
            }
        }

        return response.data;
    } catch (error) {
        clearInterval(loading); // Stop loading animation
        console.error('login error');
        console.error(error.message || error);
        return null;
    }
};

// Export the main function for cron
module.exports = {
    fetchChallengesAndVote,
    login,
    applyBoostToEntry,
};
