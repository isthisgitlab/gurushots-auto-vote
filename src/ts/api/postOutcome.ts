/**
 * How a POST to the GuruShots API came out, for the callers that must not repeat a request that may have been
 * processed (a spend): the classification of a failed request and the ActionResult a spend answers with.
 */

import { errorMessage } from '../errorMessage';
import { isPlainObject } from '../plainObject';
import type { ActionResult, SuccessResponse } from '../types/gurushots';

/**
 * What a POST came to, for a request whose repeat must not happen unless it is known not to have been processed:
 * the response body, a definite refusal (the server answered a 4xx, "not processed", or the request never left),
 * or unclear (it was sent and no usable answer came — a timeout, a reset, a redirect, a 5xx, a body that is no JSON
 * object).
 */
export type PostOutcome<T> = { kind: 'body'; body: T } | { kind: 'refused' } | { kind: 'unclear' };

// Errors that mean the request never left this machine, so repeating it cannot do anything twice.
const NEVER_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

// What a rejected axios call carries, read from whatever was thrown: a promise can reject with anything (an
// adapter may reject with null, a string or a TypeError), so nothing is assumed about its shape.
type FailureResponse = { status: number | undefined; data: unknown; headers: Record<string, unknown> | undefined };

const responseOf = (caught: unknown): FailureResponse | undefined => {
    if (!isPlainObject(caught) || !isPlainObject(caught.response)) return undefined;
    const { status, data, headers } = caught.response;
    return {
        status: typeof status === 'number' ? status : undefined,
        data,
        headers: isPlainObject(headers) ? headers : undefined,
    };
};

const codeOf = (caught: unknown): string | undefined =>
    isPlainObject(caught) && typeof caught.code === 'string' ? caught.code : undefined;

// An adapter or programmer bug (a TypeError), or a rejection with no error object at all: not a failure of the
// network, so not worth repeating, and no answer to read.
const isNoError = (caught: unknown): boolean => !isPlainObject(caught) || caught instanceof TypeError;

const neverSent = (caught: unknown): boolean => {
    const code = codeOf(caught);
    return code !== undefined && NEVER_SENT_CODES.has(code);
};

/**
 * Whether a failed request is worth retrying. Transient conditions — no response (network drop), a client
 * timeout, a 429, or any 5xx — are retryable; every other 4xx (bad request, invalid token, …) is a definitive
 * answer and is not retried.
 */
const isRetryableError = (caught: unknown): boolean => {
    if (isNoError(caught)) return false;
    const response = responseOf(caught);
    if (!response) return true; // network error / no response
    if (codeOf(caught) === 'ECONNABORTED') return true; // client timeout
    return response.status === 429 || (response.status !== undefined && response.status >= 500);
};

/**
 * Whether a failed request may be sent again without the risk of it being processed twice: a 429 (the server
 * did not process it) or one that never left. Everything else that fails is either a definite refusal or unclear.
 */
const isSafeToRepeat = (caught: unknown): boolean => {
    if (isNoError(caught)) return false;
    const response = responseOf(caught);
    return response ? response.status === 429 : neverSent(caught);
};

/**
 * The verdict on a failed request that is not repeated: refused when the server answered a 4xx ("not processed")
 * or the request never left; unclear otherwise — a timeout, a reset, a 5xx, no error object at all, and a 3xx
 * (the request was sent, and a redirected POST may have been processed before the answer).
 */
const failureVerdict = (caught: unknown): 'refused' | 'unclear' => {
    if (isNoError(caught)) return 'unclear';
    const status = responseOf(caught)?.status;
    if (status !== undefined) return status >= 400 && status < 500 ? 'refused' : 'unclear';
    return neverSent(caught) ? 'refused' : 'unclear';
};

/**
 * Server-requested cooldown in ms, read from a `retry_after` body field or a `Retry-After` header (both
 * expressed in seconds), or null when the server didn't ask for one.
 */
const getRetryAfterMs = (caught: unknown): number | null => {
    const response = responseOf(caught);
    const fromBody = isPlainObject(response?.data) ? response.data.retry_after : undefined;
    if (typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0) {
        return fromBody * 1000;
    }
    const fromHeader = response?.headers?.['retry-after'];
    if (fromHeader != null) {
        const seconds = Number(fromHeader);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    }
    return null;
};

/**
 * What the log line of a failed request says: the response status (or NO_RESPONSE), the message, the response
 * body and whether it was a client timeout.
 */
const describeFailure = (caught: unknown) => {
    const response = responseOf(caught);
    return {
        status: response?.status || 'NO_RESPONSE',
        error: errorMessage(caught),
        responseData: response?.data || null,
        timeout: codeOf(caught) === 'ECONNABORTED',
    };
};

/**
 * The status and Location of a 3xx answer (never the headers object), or null for any other failure.
 */
const redirectOf = (caught: unknown): { status: number; location: unknown } | null => {
    const response = responseOf(caught);
    const status = response?.status;
    if (status === undefined || status < 300 || status >= 400) return null;
    return { status, location: response?.headers?.location ?? response?.headers?.Location };
};

/**
 * A spend's answer as an ActionResult: ok when the body says success, `unclear` when it may have been processed.
 */
const toActionResult = (outcome: PostOutcome<SuccessResponse>): ActionResult => {
    if (outcome.kind === 'body') return { ok: outcome.body.success === true, raw: outcome.body };
    return outcome.kind === 'unclear' ? { ok: false, raw: null, unclear: true } : { ok: false, raw: null };
};

export {
    isRetryableError,
    isSafeToRepeat,
    failureVerdict,
    getRetryAfterMs,
    describeFailure,
    redirectOf,
    toActionResult,
};
