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
const { FORM_CONTENT_TYPE } = require('./constants');

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

// Upper bound on how long a single request will block while retrying.
// A server-sent cooldown longer than this (e.g. a multi-minute 429
// Retry-After) is left for the scheduler's next cycle rather than
// stalling the current one.
const MAX_RETRY_DELAY_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether a failed request is worth retrying. Transient conditions —
 * no response (network drop), a client timeout, a 429, or any 5xx —
 * are retryable; every other 4xx (bad request, invalid token, …) is
 * a definitive answer and is not retried.
 */
const isRetryableError = (error) => {
    if (!error.response) return true; // network error / no response
    if (error.code === 'ECONNABORTED') return true; // client timeout
    const status = error.response.status;
    return status === 429 || (typeof status === 'number' && status >= 500);
};

/**
 * Server-requested cooldown in ms, read from a `retry_after` body field
 * or a `Retry-After` header (both expressed in seconds), or null when
 * the server didn't ask for one.
 */
const getRetryAfterMs = (error) => {
    const fromBody = error.response?.data?.retry_after;
    if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) {
        return fromBody * 1000;
    }
    const fromHeader = error.response?.headers?.['retry-after'];
    if (fromHeader != null) {
        const seconds = Number(fromHeader);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    }
    return null;
};

/**
 * Makes a POST request to the GuruShots API
 *
 * Transient failures (network drop, timeout, 429, 5xx) are retried with
 * exponential backoff + jitter up to `apiMaxRetries` times so an
 * unattended voting cycle survives a momentary blip. The contract is
 * unchanged: the resolved response body on success, `null` on ultimate
 * failure — callers continue to branch on `null`.
 *
 * @param {string} url - The API endpoint URL
 * @param {object} headers - Request headers including authentication token
 * @param {string} data - URL-encoded form data (default: empty string)
 * @returns {object|null} - Response data or null if request failed
 */
const makePostRequest = async (url, headers, data = '') => {
    const maxRetries = settings.getSetting('apiMaxRetries') ?? 3;
    const baseDelayMs = settings.getSetting('apiRetryBaseDelayMs') ?? 1000;

    for (let attempt = 0; ; attempt++) {
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

            if (!isRetryableError(error) || attempt >= maxRetries) {
                return null; // Return null instead of throwing to prevent crashing
            }

            // Honor an explicit server cooldown when present, else use
            // exponential backoff with jitter. A cooldown longer than the
            // in-call cap is deferred to the next scheduled cycle.
            const cooldownMs = getRetryAfterMs(error);
            let delayMs;
            if (cooldownMs != null) {
                if (cooldownMs > MAX_RETRY_DELAY_MS) return null;
                delayMs = cooldownMs;
            } else {
                delayMs = Math.min(baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs, MAX_RETRY_DELAY_MS);
            }

            logger.withCategory('api').warning('Retrying API request after transient failure', {
                url,
                status,
                attempt: attempt + 1,
                maxRetries,
                delayMs: Math.round(delayMs),
            });

            await sleep(delayMs);
        }
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
