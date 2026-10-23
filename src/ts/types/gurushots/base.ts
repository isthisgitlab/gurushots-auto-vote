/**
 * The shared primitives of the GuruShots API payload shapes: the time unit
 * every timestamp uses and the two write-result envelopes.
 */

/** Unix time in seconds, as the API sends it. */
export type UnixSeconds = number;

/**
 * A write endpoint's body; the code only checks `success`. This and the action
 * payloads below (src/ts/api/*, mirrored by src/ts/mock/*) leave a field
 * optional where a refusal or failure body omits it.
 */
export interface SuccessResponse {
    success?: boolean;
}

/**
 * `{ ok, raw }` from a spend / submit / apply call; `raw` is null when the request failed. `unclear` is set by a
 * spend that goes out once: the request was sent and no usable answer came, so it may have been processed.
 * A refusal (`raw` null, not unclear) was not.
 */
export interface ActionResult {
    ok: boolean;
    raw: SuccessResponse | null;
    unclear?: boolean;
}
