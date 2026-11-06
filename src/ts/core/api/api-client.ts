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
import { platform } from '../platform/port';
import { ENDPOINTS, FORM_CONTENT_TYPE } from './constants';
import { isPlainObject } from '../plainObject';

import type { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
    describeFailure,
    failureVerdict,
    getRetryAfterMs,
    isRetryableError,
    isSafeToRepeat,
    redirectOf,
    responseDataOf,
} from './postOutcome';
import type { PostOutcome } from './postOutcome';

/**
 * Request headers as the api/ modules build them. A value may be undefined
 * (login sends no token); axios drops it.
 */
type RequestHeaders = Record<string, string | undefined>;

// A custom axios adapter must enforce validateStatus itself — axios does not
// post-process an adapter's resolved value — so non-2xx responses must reject
// with the response attached. That's what lets makePostRequest's retry/backoff
// classify 429/5xx as retryable and surface other 4xx (e.g. invalid token) as
// terminal, instead of handing an error body back to callers as a "success".
// The platform adapters (platforms/webview/http.ts, platforms/headless/http.ts)
// end in it; the axios default adapter needs no help.
const finalizeAdapterResponse = (response: AxiosResponse): AxiosResponse => {
    if (response.status >= 200 && response.status < 300) return response;
    const err = new Error(`Request failed with status code ${response.status}`) as Error & { response?: AxiosResponse };
    err.response = response;
    throw err;
};

// Endpoints whose response bodies carry account data (the login token and the member profile), other
// members' rosters (the team reads), or other members' profile data (the web active-challenge read
// — which also carries guru/cover-photo owner names — and get_member_challenges, the un-joined
// listing): the api log records the status and timing of these calls, never the body. Their callers
// log only counts and flags.
const BODY_UNLOGGED_URLS = new Set<string>([
    ENDPOINTS.signup,
    ENDPOINTS.currentMemberProfile,
    ENDPOINTS.getTeams,
    ENDPOINTS.getMatch,
    ENDPOINTS.webActiveChallenges,
    ENDPOINTS.getMemberChallenges,
    ENDPOINTS.startTurboSession,
]);

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
    const adapter = platform().http.adapter;
    if (adapter !== null) requestConfig.adapter = adapter;
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
 * How a failed attempt goes on: the wait before the next one, or null when the call ends here (not worth repeating,
 * out of attempts, or a cooldown longer than the in-call cap).
 */
const nextAttemptDelayMs = (
    caught: unknown,
    repeatable: boolean,
    attempt: number,
    maxRetries: number,
    baseDelayMs: number,
): number | null => {
    const mayRepeat = repeatable ? isRetryableError(caught) : isSafeToRepeat(caught);
    return mayRepeat && attempt < maxRetries ? retryDelayMs(caught, attempt, baseDelayMs) : null;
};

/**
 * The debug log's record of a failed attempt: what happens next, and the response body whole, for every endpoint
 * ('API Error Response' keeps only a few fields of it).
 */
const debugFailure = (
    url: string,
    failure: Omit<ReturnType<typeof describeFailure>, 'responseData'>,
    caught: unknown,
    decision: string,
    delayMs: number | null,
): void =>
    logger.writeDebug('api-error', `POST ${url} failed (${failure.status})`, {
        url,
        status: failure.status,
        error: failure.error,
        decision,
        delayMs: delayMs === null ? null : Math.round(delayMs),
        responseData: responseDataOf(caught),
    });

const terminalPostOutcome = <T extends object>(
    url: string,
    caught: unknown,
    retainRefusedResponse: boolean,
): PostOutcome<T> => {
    if (failureVerdict(caught) !== 'refused') return { kind: 'unclear' };
    if (!retainRefusedResponse) return { kind: 'refused' };
    const response = responseObject<T>(url, responseDataOf(caught));
    return response ? { kind: 'refused', response } : { kind: 'refused' };
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
    retainRefusedResponse = false,
): Promise<PostOutcome<T>> => {
    const maxRetries = settings.getSetting('apiMaxRetries');
    const baseDelayMs = settings.getSetting('apiRetryBaseDelayMs');

    for (let attempt = 0; ; attempt++) {
        const startTime = Date.now();

        // Log the request with enhanced context
        logger.withCategory('api').apiRequest('POST', url);
        // The debug log keeps the request whole: every header (the token included) and the body.
        logger.writeDebug('api-out', `POST ${url}`, { url, headers, body: data });

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

            // The body of any other endpoint is already in the debug log, in the 'API Response' record above.
            logger.writeDebug('api-in', `POST ${url} → ${response.status} (${duration}ms)`, {
                url,
                status: response.status,
                headers: response.headers,
                durationMs: duration,
                ...(BODY_UNLOGGED_URLS.has(url) ? { responseData: response.data as unknown } : {}),
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

            const delayMs = nextAttemptDelayMs(caught, repeatable, attempt, maxRetries, baseDelayMs);
            if (delayMs === null) {
                const outcome = terminalPostOutcome<T>(url, caught, retainRefusedResponse);
                debugFailure(url, failure, caught, outcome.kind, null);
                return outcome;
            }
            debugFailure(url, failure, caught, 'retry', delayMs);

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
const postOnce = <T extends object>(
    url: string,
    headers: RequestHeaders,
    data: string = '',
    retainRefusedResponse = false,
): Promise<PostOutcome<T>> => sendPost<T>(url, headers, data, false, retainRefusedResponse);

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

export { makePostRequest, postOnce, createCommonHeaders, FORM_CONTENT_TYPE, finalizeAdapterResponse };
