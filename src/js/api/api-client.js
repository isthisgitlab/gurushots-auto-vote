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
    const startTime = Date.now();
    const endpoint = url.split('/').pop() || 'unknown';
    
    // Log the request with enhanced context
    logger.apiRequest('POST', url);
    
    try {
        const response = await axios({
            method: 'post',
            url,
            headers,
            data,
            timeout: settings.getSetting('apiTimeout') * 1000, // Convert seconds to milliseconds
        });

        const duration = Date.now() - startTime;
        
        // Log successful response with timing
        logger.apiResponse('POST', url, response.status, duration);
        
        // Log detailed response data only in debug mode
        if (logger.isDevMode()) {
            logger.api('API Response Details', {
                endpoint,
                status: response.status,
                responseSize: JSON.stringify(response.data).length,
                headers: response.headers,
                duration: `${duration}ms`,
            });
        }

        return response.data;
    } catch (error) {
        const duration = Date.now() - startTime;
        const status = error.response?.status || 'NO_RESPONSE';
        
        // Log failed response with timing
        logger.apiResponse('POST', url, status, duration);
        
        // Log detailed error information
        logger.error('API Request Failed', {
            endpoint,
            url,
            method: 'POST',
            duration: `${duration}ms`,
            error: error.message,
            status: error.response?.status || 'NO_RESPONSE',
            responseData: error.response?.data || null,
            timeout: error.code === 'ECONNABORTED',
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