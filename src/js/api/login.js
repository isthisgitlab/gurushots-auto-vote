/**
 * GuruShots Auto Voter - Authentication Module
 * 
 * This module handles user authentication with the GuruShots API.
 * It's designed to work with both CLI and GUI interfaces.
 */

const axios = require('axios');
const { createCommonHeaders, FORM_CONTENT_TYPE } = require('./api-client');

/**
 * Authenticates with GuruShots and obtains an authentication token
 * 
 * This function:
 * 1. Takes email and password as parameters
 * 2. Sends authentication request to GuruShots API
 * 3. Returns the response data containing token
 * 
 * @param {string} email - User's email address
 * @param {string} password - User's password
 * @returns {object|null} - Response data containing token or null if login failed
 */
const authenticate = async (email, password) => {
    console.log('Starting authentication...');

    // Prepare login data
    const data = `login=${encodeURIComponent(email)}&password=${password}`;

    // Prepare request configuration
    const config = {
        method: 'post',
        url: 'https://api.gurushots.com/rest_mobile/signup', // API endpoint for login
        headers: {
            ...createCommonHeaders(undefined), // No token for login request
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
        console.log('Authentication successful');

        return response.data;
    } catch (error) {
        console.error('Authentication error:', error.message || error);
        return null;
    }
};

module.exports = {
    authenticate,
}; 