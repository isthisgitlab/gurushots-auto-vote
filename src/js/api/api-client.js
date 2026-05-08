/**
 * GuruShots Auto Voter - Core API Client
 *
 * This module provides the core HTTP client functionality and common headers
 * for all API interactions with GuruShots.
 */

const axios = require('axios');
const logger = require('../logger');
const { generateRandomHeaders } = require('./randomizer');
const settings = require('../settings');
const runtime = require('../runtime');

// Common content type for form submissions
const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded; charset=utf-8';

// Capacitor adapter: routes axios requests through CapacitorHttp's native
// OkHttp client (Android) so we can set headers that browser fetch can't
// (host, user-agent, etc. — the iOS-spoof in randomizer.js depends on it).
// Lazy-loaded so Electron / CLI builds never resolve @capacitor/core.
let capacitorAdapter = null;
const getCapacitorHttpAdapter = () => {
    if (capacitorAdapter) return capacitorAdapter;
    const { CapacitorHttp } = require('@capacitor/core');
    capacitorAdapter = async (config) => {
        const response = await CapacitorHttp.request({
            method: (config.method || 'get').toUpperCase(),
            url: config.url,
            headers: config.headers,
            data: config.data,
            connectTimeout: config.timeout,
            readTimeout: config.timeout,
        });
        return {
            data: response.data,
            status: response.status,
            statusText: '',
            headers: response.headers || {},
            config,
        };
    };
    return capacitorAdapter;
};

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

    // Log the request with enhanced context
    logger.withCategory('api').apiRequest('POST', url);

    try {
        const requestConfig = {
            method: 'post',
            url,
            headers,
            data,
            timeout: settings.getSetting('apiTimeout') * 1000, // Convert seconds to milliseconds
        };
        if (runtime.isCapacitor()) {
            requestConfig.adapter = getCapacitorHttpAdapter();
        }
        const response = await axios(requestConfig);

        const duration = Date.now() - startTime;

        // Log successful response with full data
        logger.withCategory('api').api('API Response', {
            method: 'POST',
            url: url,
            status: response.status,
            duration: duration,
            responseData: response.data,
        });

        return response.data;
    } catch (error) {
        const duration = Date.now() - startTime;
        const status = error.response?.status || 'NO_RESPONSE';

        // Log failed response with full error details
        logger.withCategory('api').api('API Error Response', {
            method: 'POST',
            url: url,
            status: status,
            duration: duration,
            error: error.message,
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
