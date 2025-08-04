/**
 * GuruShots Auto Voter - Authentication Module
 *
 * This module handles user authentication with the GuruShots API.
 * It's designed to work with both CLI and GUI interfaces.
 */

const axios = require('axios');
const {createCommonHeaders, FORM_CONTENT_TYPE} = require('./api-client');
const logger = require('../logger');

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
    logger.withCategory('authentication').info('Starting authentication...', null);
    const startTime = Date.now();

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
            'x-token': undefined,
        },
        data: data,
        timeout: 5000, // 5 second timeout
    };

    try {
        // Log the request
        logger.withCategory('api').apiRequest('POST', config.url);
        
        // Send login request
        const response = await axios(config);
        
        // Log successful response with full data
        logger.withCategory('api').api('API Response', {
            method: 'POST',
            url: config.url,
            status: response.status,
            duration: Date.now() - startTime,
            responseData: response.data,
        });
        logger.withCategory('authentication').success('Authentication successful', null, null);

        return response.data;
    } catch (error) {
        // Log failed response with error details
        const status = error.response?.status || 'NO_RESPONSE';
        logger.withCategory('api').api('API Error Response', {
            method: 'POST',
            url: config.url,
            status: status,
            duration: Date.now() - startTime,
            error: error.message,
            responseData: error.response?.data || null,
        });
        logger.withCategory('authentication').error('Authentication error:', error.message || error);
        return null;
    }
};

module.exports = {
    authenticate,
}; 