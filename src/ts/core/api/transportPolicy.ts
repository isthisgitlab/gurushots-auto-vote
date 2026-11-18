/**
 * What one logical request runs under, as typed data: the timeout of an attempt, how many times the request is repeated, and
 * the base of the backoff between the repeats. api-client.ts captures one at the entry of each request; the read-only
 * evidence reads of a scenario's facts and of an owner's publication are handed the saved one explicitly.
 *
 * A module of its own so that the services that hand the saved policy to their reads (the scenario evidence loader) do not
 * import the API factory, whose load order depends on the mock client that the same services are part of.
 */

import * as settings from '../settings';

/**
 * Captured once, before the first attempt: a publication or a saved edit that lands while the request is under way changes
 * none of it, and the next request captures afresh.
 */
type TransportPolicy = Readonly<{ timeoutSec: number; maxRetries: number; retryBaseDelayMs: number }>;

/**
 * The policy from the SAVED settings, validated as they were loaded. This is the declared bootstrap context of the
 * read-only evidence requests: they must be able to read what a policy is worked out from, so they cannot wait for it. It is
 * passed to a request explicitly, never picked after another policy failed.
 */
const baselineTransportPolicy = (): TransportPolicy =>
    Object.freeze({
        timeoutSec: settings.getSetting('apiTimeout'),
        maxRetries: settings.getSetting('apiMaxRetries'),
        retryBaseDelayMs: settings.getSetting('apiRetryBaseDelayMs'),
    });

export { baselineTransportPolicy };
export type { TransportPolicy };
