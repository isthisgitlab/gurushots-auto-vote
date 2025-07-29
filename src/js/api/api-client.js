/**
 * GuruShots Auto Voter - Core API Client
 *
 * This module provides the core HTTP client functionality and common headers
 * for all API interactions with GuruShots.
 */

const axios = require('axios');
const logger = require('../logger');
const {generateRandomHeaders} = require('./randomizer');
const settings = require('../settings');

// Common content type for form submissions
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';

/**
 * Makes a POST request to the GuruShots API
 *
 * @param {string} url - The API endpoint URL
 * @param {object} headers - Request headers including authentication token
 * @param {string} data - URL-encoded form data (default: empty string)
 * @returns {object|null} - Response data or null if request failed
 */
const makePostRequest = async (url, headers, data = '') => {
    logger.api('🌐 === API REQUEST ===', {url, headers, data});

    try {
        const response = await axios({
            method: 'post',
            url,
            headers,
            data,
            timeout: settings.getSetting('apiTimeout') * 1000 // Convert seconds to milliseconds
        });

        logger.api('✅ === API RESPONSE ===', {
            status: response.status,
            headers: response.headers,
            data: response.data,
        });

        return response.data;
    } catch (error) {
        logger.error('❌ === API ERROR ===', {
            url,
            error: error.message,
            response: error.response ? {
                status: error.response.status,
                data: error.response.data,
                headers: error.response.headers,
            } : 'No response',
        });
        return null; // Return null instead of throwing to prevent crashing
    }
};

/**
 * Creates common headers for all API requests to GuruShots
 *
 * These headers mimic an iOS device to ensure compatibility with the API.
 * The x-token header is populated from the provided token parameter.
 *
 * @param {string} token - Authentication token
 * @returns {object} - Headers object for API requests
 */
const createCommonHeaders = (token) => {
    return generateRandomHeaders(token);
};

module.exports = {
    makePostRequest,
    createCommonHeaders,
    FORM_CONTENT_TYPE,
}; 