/**
 * GuruShots Auto Voter - Authentication Module
 *
 * This module handles user authentication with the GuruShots API.
 * It's designed to work with both CLI and GUI interfaces.
 */

const { makePostRequest, createCommonHeaders, FORM_CONTENT_TYPE } = require('./api-client');
const { ENDPOINTS } = require('./constants');
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
 * @returns {Promise<object|null>} - Response data containing token or null if login failed
 */
const authenticate = async (email, password) => {
    logger.withCategory('authentication').info('Starting authentication...', null);

    const data = `login=${encodeURIComponent(email)}&password=${password}`;
    const headers = {
        ...createCommonHeaders(undefined),
        'content-type': FORM_CONTENT_TYPE,
        'content-length': data.length.toString(),
        'x-token': undefined,
    };

    // Routed through makePostRequest so the CapacitorHttp adapter applies on
    // Android — the iOS-spoof headers in randomizer.js (host, user-agent) are
    // forbidden in browser fetch and only survive via native OkHttp.
    const responseData = await makePostRequest(ENDPOINTS.signup, headers, data);

    if (responseData) {
        logger.withCategory('authentication').success('Authentication successful', null, null);
    } else {
        logger.withCategory('authentication').error('Authentication failed', null);
    }
    return responseData;
};

module.exports = {
    authenticate,
};
