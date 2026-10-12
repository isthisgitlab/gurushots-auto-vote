/**
 * How a POST to the GuruShots API came out, for the callers that must not repeat a request that may have been
 * processed (a spend): the classification of a failed request and the ActionResult a spend answers with.
 */

import type { ActionResult, SuccessResponse } from '../types/gurushots';

/**
 * What a failed axios call rejects with, as far as the retry layer reads it.
 */
export interface RequestFailure {
    message?: string;
    code?: string;
    response?: { status?: number; data?: { retry_after?: unknown }; headers?: Record<string, unknown> };
}

/**
 * What a POST came to, for a request whose repeat must not happen unless it is known not to have been processed:
 * the response body, a definite refusal (the server said it did not process it, or the request never left), or
 * unclear (it was sent and no usable answer came — a timeout, a reset, a 5xx, a body that is no JSON object).
 */
export type PostOutcome<T> = { kind: 'body'; body: T } | { kind: 'refused' } | { kind: 'unclear' };

// Errors that mean the request never left this machine, so repeating it cannot do anything twice.
const NEVER_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/**
 * Whether a failed request may be sent again without the risk of it being processed twice: a 429 (the server
 * did not process it) or one that never left. Everything else that fails is either a definite refusal or unclear.
 */
const isSafeToRepeat = (error: RequestFailure | null | undefined): boolean => {
    if (error == null || error instanceof TypeError) return false;
    if (error.response) return error.response.status === 429;
    return error.code !== undefined && NEVER_SENT_CODES.has(error.code);
};

/**
 * The verdict on a failed request that is not repeated: refused when the server answered "not processed" (3xx, 4xx)
 * or the request never left, unclear otherwise (a timeout, a reset, a 5xx, no error object at all).
 */
const failureVerdict = (error: RequestFailure | null | undefined): 'refused' | 'unclear' => {
    if (error == null || error instanceof TypeError) return 'unclear';
    const status = error.response?.status;
    if (typeof status === 'number') return status >= 300 && status < 500 ? 'refused' : 'unclear';
    return error.code !== undefined && NEVER_SENT_CODES.has(error.code) ? 'refused' : 'unclear';
};

/**
 * A spend's answer as an ActionResult: ok when the body says success, `unclear` when it may have been processed.
 */
const toActionResult = (outcome: PostOutcome<SuccessResponse>): ActionResult => {
    if (outcome.kind === 'body') return { ok: outcome.body.success === true, raw: outcome.body };
    return outcome.kind === 'unclear' ? { ok: false, raw: null, unclear: true } : { ok: false, raw: null };
};

export { isSafeToRepeat, failureVerdict, toActionResult };
