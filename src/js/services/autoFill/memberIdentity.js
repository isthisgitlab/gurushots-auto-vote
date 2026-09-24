/**
 * Auto-fill — the member id tag resolution needs, memoised per session token.
 * This module owns the identity cache; __resetMemberIdCache clears it.
 */

// Member identity for tag resolution, memoised per token.
//
// get_current_member_profile is a token-only read whose answer cannot change
// within a run, while a fill pass touches every active challenge — so without
// this the identity lookup would repeat on each one. Keyed by token so a
// re-login naturally misses; bounded because an unbounded map keyed by a
// credential is a leak waiting to happen, and one entry is the realistic case.
const memberIdCache = new Map();
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
 *
 * @param {string} token
 * @param {function} getCurrentMemberProfile
 * @returns {Promise<string|null>}
 */
const resolveMemberId = async (token, getCurrentMemberProfile, logger, logLabel) => {
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
                    .debug(
                        `${logLabel || 'autoFill'}: identity lookup failed: ${(error && error.message) || error}`,
                        null,
                    );
            }
            return null;
        }
    })();

    if (memberIdCache.size >= MAX_MEMBER_ID_CACHE) memberIdCache.clear();
    const entry = { promise, expiresAt: null };
    memberIdCache.set(token, entry);
    // Fire-and-forget by design: the caller awaits `promise` itself, this only
    // stamps the expiry afterwards. `void` because the inner function catches
    // everything and resolves to null, so there is no rejection to handle.
    void promise.then((id) => {
        if (id === null) entry.expiresAt = Date.now() + NEGATIVE_IDENTITY_TTL_MS;
    });
    return promise;
};

// Test-only: drop the memoised identity between cases.
const __resetMemberIdCache = () => memberIdCache.clear();

module.exports = {
    resolveMemberId,
    __resetMemberIdCache,
};
