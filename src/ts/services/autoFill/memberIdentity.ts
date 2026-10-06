/**
 * Auto-fill — the member id tag resolution needs, memoised per session token.
 * This module owns the identity cache; __resetMemberIdCache clears it.
 */

import type { FillLogger, RankDeps } from '../../types/autoFill';
import { errorMessage } from '../../errorMessage';

/**
 * A memoised lookup: the shared promise, and when a null answer expires (null =
 * never, for a resolved id or a lookup still in flight).
 */
type MemberIdCacheEntry = {
    promise: Promise<string | null>;
    expiresAt: number | null;
    /** The id once the lookup resolved to one (what peekMemberId reads without waiting). */
    id: string | null;
};

// Member identity for tag resolution, memoised per token.
//
// get_current_member_profile is a token-only read whose answer cannot change
// within a run, while a fill pass touches every active challenge — so without
// this the identity lookup would repeat on each one. Keyed by token so a
// re-login naturally misses; bounded because an unbounded map keyed by a
// credential is a leak waiting to happen, and one entry is the realistic case.
const memberIdCache: Map<string, MemberIdCacheEntry> = new Map();
const MAX_MEMBER_ID_CACHE = 4;

// How long a FAILED identity lookup stays cached before it is retried.
//
// A successful id cannot change under a given token, so it is cached for the
// process lifetime. A null is different: the common cause is a transient
// network blip, not "this account cannot do it", and caching that permanently
// would let one flaky request silently disable tag resolution for the whole
// session — reverting to the off-theme fills this feature exists to stop, with
// nothing in the UI to explain it. Expiring the negative keeps the retry cheap
// (one call a minute at worst) without hammering a genuinely broken endpoint.
const NEGATIVE_IDENTITY_TTL_MS = 60_000;

/**
 * The member id tag resolution needs, or null when it cannot be determined.
 *
 * Resolved from the session token rather than the login field on purpose: the
 * app authenticates with an email, and search_autocomplete rejects an email
 * ("Couldn't find username"). The profile's own id is what it accepts.
 */
const resolveMemberId = async (
    token: string,
    getCurrentMemberProfile: NonNullable<RankDeps['getCurrentMemberProfile']>,
    logger?: FillLogger | null,
    logLabel?: string,
): Promise<string | null> => {
    const cached = memberIdCache.get(token);
    // A resolved id never expires; a cached null does (see NEGATIVE_IDENTITY_TTL_MS).
    if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) return cached.promise;

    // Cache the PROMISE, not the value, so two fills racing on the same token
    // share one request instead of both missing an empty cache and issuing it.
    // A voting pass is sequential, but manual "Fill Now" is not.
    const promise = (async () => {
        try {
            const profile = await getCurrentMemberProfile(token);
            if (profile && typeof profile.id === 'string' && profile.id !== '') return profile.id;
            return null;
        } catch (error) {
            // Never fails a fill — but say so at debug level, or the eventual
            // "why did tag resolution stop firing?" has no thread to pull.
            if (logger) {
                logger
                    .withCategory(logLabel || 'autoFill')
                    .debug(`${logLabel || 'autoFill'}: identity lookup failed: ${errorMessage(error) || error}`, null);
            }
            return null;
        }
    })();

    if (memberIdCache.size >= MAX_MEMBER_ID_CACHE) memberIdCache.clear();
    const entry: MemberIdCacheEntry = { promise, expiresAt: null, id: null };
    memberIdCache.set(token, entry);
    // Fire-and-forget by design: the caller awaits `promise` itself, this only
    // stamps the expiry afterwards. `void` because the inner function catches
    // everything and resolves to null, so there is no rejection to handle.
    void promise.then((id) => {
        entry.id = id;
        if (id === null) entry.expiresAt = Date.now() + NEGATIVE_IDENTITY_TTL_MS;
    });
    return promise;
};

/**
 * The member id for this token if an earlier lookup already resolved it, else
 * null — never starts a lookup. For synchronous callers (the settings IPC
 * stamping which account saved a list) that must not wait on the network.
 */
const peekMemberId = (token: string): string | null => memberIdCache.get(token)?.id ?? null;

/**
 * Evict a cached FAILED lookup for this token, so the next `resolveMemberId` asks again at once
 * instead of waiting out NEGATIVE_IDENTITY_TTL_MS. For a user's explicit retry only. A resolved id
 * stays (it cannot change under a token), and so does a lookup still in flight (callers share it).
 */
const forgetFailedMemberId = (token: string): void => {
    const entry = memberIdCache.get(token);
    if (entry && entry.id === null && entry.expiresAt !== null) memberIdCache.delete(token);
};

// Test-only: drop the memoised identity between cases.
const __resetMemberIdCache = () => memberIdCache.clear();

export { resolveMemberId, peekMemberId, forgetFailedMemberId, __resetMemberIdCache };
