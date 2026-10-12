/**
 * GuruShots Auto Voter - Core API Client
 *
 * This module provides the core HTTP client functionality and common headers
 * for all API interactions with GuruShots.
 */

import axios from 'axios';
import * as logger from '../logger';
import { generateRandomHeaders } from './randomizer';
import { sleep } from '../timing';
import * as settings from '../settings';
import * as runtime from '../runtime';
import { ENDPOINTS, FORM_CONTENT_TYPE } from './constants';
import { isPlainObject } from '../plainObject';

import type { AxiosAdapter, AxiosRequestConfig, AxiosResponse } from 'axios';
import {
    describeFailure,
    failureVerdict,
    getRetryAfterMs,
    isRetryableError,
    isSafeToRepeat,
    redirectOf,
} from './postOutcome';
import type { PostOutcome } from './postOutcome';

/**
 * Request headers as the api/ modules build them. A value may be undefined
 * (login sends no token); axios drops it.
 */
type RequestHeaders = Record<string, string | undefined>;

/**
 * The native bridge globals of the Android headless-service WebView.
 */
interface HeadlessHttpGlobals {
    __gsResolveHeadlessHttp?: (id: number, resultJson: string) => void;
    AndroidHeadlessHttp: {
        request: (id: number, method: string, url: string, headersJson: string, body: string) => void;
    };
}

// A custom axios adapter must enforce validateStatus itself — axios does not
// post-process an adapter's resolved value — so non-2xx responses must reject
// with the response attached. That's what lets makePostRequest's retry/backoff
// classify 429/5xx as retryable and surface other 4xx (e.g. invalid token) as
// terminal, instead of handing an error body back to callers as a "success".
// Shared by both the Capacitor and headless adapters below.
const finalizeAdapterResponse = (response: AxiosResponse): AxiosResponse => {
    if (response.status >= 200 && response.status < 300) return response;
    const err = new Error(`Request failed with status code ${response.status}`) as Error & { response?: AxiosResponse };
    err.response = response;
    throw err;
};

// Capacitor adapter: routes axios requests through CapacitorHttp's native
// OkHttp client (Android) so we can set headers that browser fetch can't
// (host, user-agent, etc. — the iOS-spoof in randomizer.ts depends on it).
// Lazy-loaded so Electron / CLI builds never resolve @capacitor/core.
let capacitorAdapter: AxiosAdapter | null = null;
const getCapacitorHttpAdapter = (): AxiosAdapter => {
    if (capacitorAdapter) return capacitorAdapter;
    const { CapacitorHttp } = require('@capacitor/core') as typeof import('@capacitor/core');
    capacitorAdapter = async (config) => {
        const response = await CapacitorHttp.request({
            method: (config.method || 'get').toUpperCase(),
            url: config.url as string,
            headers: config.headers,
            data: config.data as unknown,
            connectTimeout: config.timeout,
            readTimeout: config.timeout,
            disableRedirects: true,
        });
        // Throwing here surfaces as a rejection from this async adapter, so a
        // 429/5xx on the foreground path reaches the retry layer instead
        // of being mistaken for a successful response.
        return finalizeAdapterResponse({
            data: response.data as unknown,
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
const headlessPending: Map<number, (resultJson: string) => void> = new Map();
const headlessGlobals = globalThis as typeof globalThis & HeadlessHttpGlobals;
const ensureHeadlessResolver = () => {
    if (headlessGlobals.__gsResolveHeadlessHttp) return;
    headlessGlobals.__gsResolveHeadlessHttp = (id, resultJson) => {
        const cb = headlessPending.get(id);
        if (cb) {
            headlessPending.delete(id);
            cb(resultJson);
        }
    };
};

type HeadlessResult = { error?: string; status: number; body: string; headers: Record<string, string> };

/**
 * The native bridge's result JSON as a HeadlessResult. It is parsed as `unknown` and checked: a result with no
 * numeric status (and no `error`), or a body that is not a string, is rejected as malformed.
 */
const parseHeadlessResult = (resultJson: string): HeadlessResult => {
    const parsed: unknown = JSON.parse(resultJson);
    if (!isPlainObject(parsed)) throw new Error('Malformed native HTTP result');
    if (parsed.error) {
        if (typeof parsed.error !== 'string') throw new Error('Malformed native HTTP result');
        return { error: parsed.error, status: 0, body: '', headers: {} };
    }
    if (typeof parsed.status !== 'number' || !Number.isFinite(parsed.status) || typeof parsed.body !== 'string') {
        throw new Error('Malformed native HTTP result');
    }
    const headers: Record<string, string> = {};
    if (isPlainObject(parsed.headers)) {
        for (const [name, value] of Object.entries(parsed.headers)) {
            if (typeof value === 'string') headers[name] = value;
        }
    }
    return { status: parsed.status, body: parsed.body, headers };
};

let headlessAdapter: AxiosAdapter | null = null;
const getHeadlessHttpAdapter = (): AxiosAdapter => {
    if (headlessAdapter) return headlessAdapter;
    ensureHeadlessResolver();
    headlessAdapter = (config) =>
        new Promise((resolve, reject) => {
            const id = ++headlessReqSeq;
            headlessPending.set(id, (resultJson) => {
                try {
                    // The AndroidHeadlessHttp result contract (see the adapter note above).
                    const parsed = parseHeadlessResult(resultJson);
                    // A transport/network failure on the native side — reject so
                    // the retry layer treats it as a (retryable) no-response error.
                    if (parsed.error) {
                        reject(new Error(parsed.error));
                        return;
                    }
                    // The API returns JSON; parse the body so callers get an
                    // object, matching CapacitorHttp/axios. Leave non-JSON as-is.
                    let data: unknown = parsed.body;
                    try {
                        data = JSON.parse(parsed.body);
                    } catch {
                        /* non-JSON body — return the raw string */
                    }
                    const response = {
                        data,
                        status: parsed.status,
                        statusText: '',
                        headers: parsed.headers,
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
            headlessGlobals.AndroidHeadlessHttp.request(
                id,
                (config.method || 'get').toUpperCase(),
                config.url as string,
                JSON.stringify(config.headers || {}),
                body,
            );
        });
    return headlessAdapter;
};

// Endpoints whose response bodies carry account data (the login token and the member profile): the api log
// records the status and timing of these calls, never the body.
const BODY_UNLOGGED_URLS = new Set<string>([ENDPOINTS.signup, ENDPOINTS.currentMemberProfile]);

// Upper bound on how long a single request will block while retrying.
// A server-sent cooldown longer than this (e.g. a multi-minute 429
// Retry-After) is left for the scheduler's next cycle rather than
// stalling the current one.
const MAX_RETRY_DELAY_MS = 30_000;

// Smallest delay we'll wait before a retry, even if the server asks for
// less (or 0) — guards against a misbehaving server spinning the loop.
const MIN_RETRY_DELAY_MS = 100;

/**
 * The one place a 2xx body becomes a response type. Anything that is not a
 * JSON object (an HTML error page, a bare string, an array) is no GuruShots
 * response and reads as a failed request. The fields stay unverified on
 * purpose: T declares them optional and each endpoint wrapper guards its
 * reads, so upstream drift in one field degrades that read instead of
 * rejecting the whole response.
 */
const responseObject = <T extends object>(url: string, body: unknown): T | null => {
    if (isPlainObject(body)) return body as T;
    logger.withCategory('api').warning('API response body is not a JSON object', {
        url,
        type: Array.isArray(body) ? 'array' : typeof body,
    });
    return null;
};

/**
 * The axios request of one POST attempt, on the adapter of the platform it runs on.
 */
const postConfig = (url: string, headers: RequestHeaders, data: string): AxiosRequestConfig => {
    const requestConfig: AxiosRequestConfig = {
        method: 'post',
        url,
        headers,
        data,
        timeout: settings.getSetting('apiTimeout') * 1000, // Convert seconds to milliseconds
        // The API never redirects; following one would replay the x-token header at the target.
        maxRedirects: 0,
    };
    if (runtime.isHeadlessService()) {
        requestConfig.adapter = getHeadlessHttpAdapter();
    } else if (runtime.isCapacitor()) {
        requestConfig.adapter = getCapacitorHttpAdapter();
    }
    return requestConfig;
};

/**
 * How long to wait before the next attempt: an explicit server cooldown when present, else exponential
 * backoff with jitter. Null when the cooldown is longer than the in-call cap, which defers the request to the
 * next scheduled cycle.
 */
const retryDelayMs = (caught: unknown, attempt: number, baseDelayMs: number): number | null => {
    const cooldownMs = getRetryAfterMs(caught);
    if (cooldownMs == null) {
        return Math.min(baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs, MAX_RETRY_DELAY_MS);
    }
    return cooldownMs > MAX_RETRY_DELAY_MS ? null : Math.max(cooldownMs, MIN_RETRY_DELAY_MS);
};

/**
 * The retry loop behind both POST entry points.
 *
 * @param repeatable - true: transient failures (network drop, timeout, 429, 5xx) are retried with exponential
 *   backoff + jitter up to `apiMaxRetries` times. false: only a 429 and a request that never left are retried;
 *   any other failure ends the call, as refused or unclear.
 */
const sendPost = async <T extends object>(
    url: string,
    headers: RequestHeaders,
    data: string,
    repeatable: boolean,
): Promise<PostOutcome<T>> => {
    const maxRetries = settings.getSetting('apiMaxRetries');
    const baseDelayMs = settings.getSetting('apiRetryBaseDelayMs');

    for (let attempt = 0; ; attempt++) {
        const startTime = Date.now();

        // Log the request with enhanced context
        logger.withCategory('api').apiRequest('POST', url);

        try {
            const response = await axios(postConfig(url, headers, data));

            const duration = Date.now() - startTime;

            // Log successful response with full data (but for the account endpoints)
            logger.withCategory('api').api('API Response', {
                method: 'POST',
                url: url,
                status: response.status,
                duration: duration,
                ...(BODY_UNLOGGED_URLS.has(url) ? {} : { responseData: response.data as unknown }),
            });

            const body = responseObject<T>(url, response.data);
            return body ? { kind: 'body', body } : { kind: 'unclear' };
        } catch (caught) {
            const { responseData, ...failure } = describeFailure(caught);

            // Log failed response with full error details (but for the account endpoints)
            logger.withCategory('api').api('API Error Response', {
                method: 'POST',
                url: url,
                ...failure,
                ...(BODY_UNLOGGED_URLS.has(url) ? {} : { responseData }),
                duration: Date.now() - startTime,
            });

            const redirect = redirectOf(caught);
            if (redirect) {
                logger.withCategory('api').warning('API request answered with a redirect, not followed', {
                    url,
                    ...redirect,
                });
            }

            const mayRepeat = repeatable ? isRetryableError(caught) : isSafeToRepeat(caught);
            if (!mayRepeat || attempt >= maxRetries) {
                return { kind: failureVerdict(caught) }; // An outcome instead of a throw, to prevent crashing
            }

            const delayMs = retryDelayMs(caught, attempt, baseDelayMs);
            if (delayMs === null) return { kind: failureVerdict(caught) };

            logger.withCategory('api').warning('Retrying API request after transient failure', {
                url,
                status: failure.status,
                attempt: attempt + 1,
                maxRetries,
                delayMs: Math.round(delayMs),
            });

            await sleep(delayMs);
        }
    }
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
 * @param url - The API endpoint URL
 * @param headers - Request headers including authentication token
 * @param data - URL-encoded form data (default: empty string)
 * @returns The response body as `T` (the shape the endpoint wrapper reads, all
 *   fields optional), or null if the request failed or the body was not a JSON
 *   object. Only the object check is enforced: the wrapper guards every read.
 */
const makePostRequest = async <T extends object>(
    url: string,
    headers: RequestHeaders,
    data: string = '',
): Promise<T | null> => {
    const outcome = await sendPost<T>(url, headers, data, true);
    return outcome.kind === 'body' ? outcome.body : null;
};

/**
 * Makes a POST request that spends something and is not known to be idempotent: a retry after a timeout could
 * spend twice. A 429 (honouring its Retry-After, as makePostRequest does) and a request that never left
 * (ECONNREFUSED, ENOTFOUND, EAI_AGAIN) are retried; any other failure is one attempt and says which kind it was.
 *
 * @returns `body` with the response; `refused` when the server did not process it (3xx, 4xx, a 429 that ran out of
 *   retries, a request that never left); `unclear` when it was sent and no usable answer came (a timeout, a reset,
 *   a 5xx, a 2xx whose body is not a JSON object), so it may or may not have been processed.
 */
const postOnce = <T extends object>(url: string, headers: RequestHeaders, data: string = ''): Promise<PostOutcome<T>> =>
    sendPost<T>(url, headers, data, false);

/**
 * Creates common headers for all API requests to GuruShots
 *
 * These headers mimic an iOS device to ensure compatibility with the API.
 * The x-token header is populated from the provided token parameter.
 *
 * @param token - Authentication token (undefined for login)
 * @returns Headers object for API requests
 */
const createCommonHeaders = (token: string | undefined): RequestHeaders => {
    return generateRandomHeaders(token);
};

export { makePostRequest, postOnce, createCommonHeaders, FORM_CONTENT_TYPE };
