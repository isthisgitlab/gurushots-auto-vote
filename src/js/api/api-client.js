/**
 * GuruShots Auto Voter - Core API Client
 *
 * This module provides the core HTTP client functionality and common headers
 * for all API interactions with GuruShots.
 */

const axios = require('axios');
const logger = require('../logger');
const { generateRandomHeaders } = require('./randomizer');
const { sleep } = require('./utils');
const settings = require('../settings');
const runtime = require('../runtime');
const { FORM_CONTENT_TYPE } = require('./constants');

// A custom axios adapter must enforce validateStatus itself — axios does not
// post-process an adapter's resolved value — so non-2xx responses must reject
// with the response attached. That's what lets makePostRequest's retry/backoff
// classify 429/5xx as retryable and surface other 4xx (e.g. invalid token) as
// terminal, instead of handing an error body back to callers as a "success".
// Shared by both the Capacitor and headless adapters below.
const finalizeAdapterResponse = (response) => {
    if (response.status >= 200 && response.status < 300) return response;
    const err = new Error(`Request failed with status code ${response.status}`);
    err.response = response;
    throw err;
};

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
        // Throwing here surfaces as a rejection from this async adapter, so a
        // 429/5xx on the foreground path now reaches the retry layer instead
        // of being mistaken for a successful response.
        return finalizeAdapterResponse({
            data: response.data,
            status: response.status,
            statusText: '',
            headers: response.headers || {},
            config,
        });
    };
    return capacitorAdapter;
};

// Headless background-service adapter: routes axios through a native
// @JavascriptInterface (AndroidHeadlessHttp) backed by OkHttp, since the
// bare service WebView has no Capacitor runtime / CapacitorHttp.
//
// Asynchronous by design: a synchronous bridge would block the WebView's
// JS thread for the whole network round-trip. Instead `request` returns
// immediately, native runs OkHttp off-thread, and posts the result back
// by calling globalThis.__gsResolveHeadlessHttp(id, resultJson) — where
// resultJson is a JSON string { status, body, headers }.
let headlessReqSeq = 0;
const headlessPending = new Map();
const ensureHeadlessResolver = () => {
    if (globalThis.__gsResolveHeadlessHttp) return;
    globalThis.__gsResolveHeadlessHttp = (id, resultJson) => {
        const cb = headlessPending.get(id);
        if (cb) {
            headlessPending.delete(id);
            cb(resultJson);
        }
    };
};

let headlessAdapter = null;
const getHeadlessHttpAdapter = () => {
    if (headlessAdapter) return headlessAdapter;
    ensureHeadlessResolver();
    headlessAdapter = (config) =>
        new Promise((resolve, reject) => {
            const id = ++headlessReqSeq;
            headlessPending.set(id, (resultJson) => {
                try {
                    const parsed = JSON.parse(resultJson);
                    // A transport/network failure on the native side — reject so
                    // the retry layer treats it as a (retryable) no-response error.
                    if (parsed.error) {
                        reject(new Error(parsed.error));
                        return;
                    }
                    // The API returns JSON; parse the body so callers get an
                    // object, matching CapacitorHttp/axios. Leave non-JSON as-is.
                    let data = parsed.body;
                    try {
                        data = JSON.parse(parsed.body);
                    } catch {
                        /* non-JSON body — return the raw string */
                    }
                    const response = {
                        data,
                        status: parsed.status,
                        statusText: '',
                        headers: parsed.headers || {},
                        config,
                    };
                    // finalizeAdapterResponse throws on non-2xx (with the
                    // response attached) — that throw is caught by the
                    // surrounding catch below and rejected, so the retry/backoff
                    // layer classifies it; otherwise we resolve the 2xx response.
                    const finalized = finalizeAdapterResponse(response);
                    resolve(finalized);
                } catch (err) {
                    reject(err);
                }
            });
            const body = typeof config.data === 'string' ? config.data : config.data ? JSON.stringify(config.data) : '';
            globalThis.AndroidHeadlessHttp.request(
                id,
                (config.method || 'get').toUpperCase(),
                config.url,
                JSON.stringify(config.headers || {}),
                body,
            );
        });
    return headlessAdapter;
};

// Upper bound on how long a single request will block while retrying.
// A server-sent cooldown longer than this (e.g. a multi-minute 429
// Retry-After) is left for the scheduler's next cycle rather than
// stalling the current one.
const MAX_RETRY_DELAY_MS = 30_000;

// Smallest delay we'll wait before a retry, even if the server asks for
// less (or 0) — guards against a misbehaving server spinning the loop.
const MIN_RETRY_DELAY_MS = 100;

// Coerce a user/CLI-supplied setting to a non-negative integer, falling
// back to the default for missing / negative / non-numeric values. The
// retry knobs aren't in the schema, so this is the only guard against a
// bad `set-setting apiMaxRetries -1` turning the loop into a no-op (or a
// NaN bound that never terminates).
const coerceNonNegInt = (value, fallback) => {
    if (value == null) return fallback; // undefined/null → default, not Number(null)===0
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

/**
 * Whether a failed request is worth retrying. Transient conditions —
 * no response (network drop), a client timeout, a 429, or any 5xx —
 * are retryable; every other 4xx (bad request, invalid token, …) is
 * a definitive answer and is not retried.
 */
const isRetryableError = (error) => {
    // A TypeError (or similar) means an adapter/programmer bug, not a
    // transient network failure — retrying it just wastes the backoff.
    if (error instanceof TypeError) return false;
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
 * @returns {Promise<object|null>} - Response data or null if request failed
 */
const makePostRequest = async (url, headers, data = '') => {
    const maxRetries = coerceNonNegInt(settings.getSetting('apiMaxRetries'), 3);
    const baseDelayMs = coerceNonNegInt(settings.getSetting('apiRetryBaseDelayMs'), 1000);

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
            if (runtime.isHeadlessService()) {
                requestConfig.adapter = getHeadlessHttpAdapter();
            } else if (runtime.isCapacitor()) {
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
                delayMs = Math.max(cooldownMs, MIN_RETRY_DELAY_MS);
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
