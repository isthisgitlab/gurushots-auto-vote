/**
 * GuruShots Auto Voter - Core API Client
 * 
 * This module provides the core HTTP client functionality and common headers
 * for all API interactions with GuruShots.
 */

const axios = require('axios');
const logger = require('../logger');

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
    logger.api('🌐 === API REQUEST ===', { url, headers, data });
    
    try {
        const response = await axios({
            method: 'post', 
            url, 
            headers, 
            data, 
            timeout: 30000, // 30 second timeout for real API
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
const createCommonHeaders = (token) => ({
    'host': 'api.gurushots.com',
    'accept': '*/*',
    'x-device': 'iPhone',                // Identifies as an iPhone device
    'x-requested-with': 'XMLHttpRequest',
    'x-model': 'iPhone X',               // Specific iPhone model
    'accept-language': 'fr-SE;q=1.0, en-SE;q=0.9, sv-SE;q=0.8, es-SE;q=0.7',
    'x-api-version': '20',               // API version required by GuruShots
    'x-env': 'IOS',                      // Environment identifier
    'user-agent': 'GuruShotsIOS/2.41.3 (com.gurushots.app; build:507; iOS 16.7.11) Alamofire/5.10.2',
    'x-app-version': '2.41.3',           // App version to match
    'connection': 'keep-alive',
    'x-brand': 'Apple',
    'x-token': token,                    // Authentication token
});

module.exports = {
    makePostRequest,
    createCommonHeaders,
    FORM_CONTENT_TYPE,
}; 