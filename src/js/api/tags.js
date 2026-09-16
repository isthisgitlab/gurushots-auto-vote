/**
 * GuruShots Auto Voter - Tag vocabulary lookups
 *
 * Two small reads that exist for one reason: auto-fill's server-side photo
 * search needs a tag the member's library ACTUALLY uses, and a challenge title
 * is usually not one.
 *
 * THE TWO ENDPOINTS MATCH DIFFERENTLY, which is the whole point:
 *
 *   get_photos_private?search=  matches a tag EXACTLY.
 *       "staircase" -> 23 photos | "stair" -> 0 | "stairs" -> 0
 *   search_autocomplete         matches a SUBSTRING of a tag.
 *       "stair" -> ["staircase"] | "case" -> ["staircase"] | "stairs" -> []
 *
 * So a "Stairs" challenge searched the exact tag "stair", got nothing, and fell
 * through to an unfiltered library walk that ranked by popularity — which is
 * how a yoga photo ended up submitted to a stairs challenge. Running the term
 * through autocomplete first turns it into "staircase", which the photo search
 * can actually use. Note "stairs" itself returns nothing: autocomplete is a
 * substring match and no tag CONTAINS "stairs", which is why the resolver backs
 * the term off a character at a time (see services/tagResolver.js).
 *
 * member_id is required and is a member identity, NOT a display name. Both the
 * account's user_name and its opaque id hash work; an email address does not
 * ("Couldn't find username: <email>"). That distinction matters because the app
 * logs in with an email, so the login field is not a usable source — use
 * getCurrentMemberProfile, which resolves identity from the token alone.
 *
 * Both functions follow this codebase's transport contract: everything goes
 * through makePostRequest, which returns the body or null and NEVER throws, so
 * both return null on any failure and callers branch on null.
 */

const { makePostRequest } = require('./api-client');
const { ENDPOINTS, createWebHeaders, makeRequireValue } = require('./constants');

const requireValue = makeRequireValue('tags');

/**
 * Resolve the signed-in member's own profile from the session token.
 *
 * Exists so tag lookups never have to guess an identity: the response's
 * `profile.id` (and `profile.user_name`) are both accepted by
 * searchTagAutocomplete, while the email the user typed at login is not.
 *
 * @param {string} token - session token
 * @returns {Promise<{id: string, userName: string}|null>} identity, or null
 *   when the call failed or the payload lacked an id.
 */
const getCurrentMemberProfile = async (token) => {
    requireValue(token, 'token');
    const response = await makePostRequest(ENDPOINTS.currentMemberProfile, createWebHeaders(token), '');
    const profile = response && response.profile;
    if (!profile || typeof profile !== 'object') return null;
    const id = profile.id;
    if (typeof id !== 'string' || id === '') return null;
    return { id, userName: typeof profile.user_name === 'string' ? profile.user_name : '' };
};

// The endpoint returns nothing at all below three characters ("st" -> []), so
// a shorter probe is a guaranteed wasted round-trip. The resolver's backoff
// stops here for the same reason.
const MIN_AUTOCOMPLETE_CHARS = 3;

/**
 * Tags in the member's own library whose text CONTAINS `term`.
 *
 * @param {string} token - session token
 * @param {string} term - partial tag text; under MIN_AUTOCOMPLETE_CHARS the
 *   server always answers empty, so we skip the request and return [].
 * @param {string} memberId - the member's id or user_name (NOT an email)
 * @returns {Promise<Array<string>>} matching tags, or [] on any failure —
 *   this is an optional enhancement to a fill and must never break one.
 */
const searchTagAutocomplete = async (token, term, memberId) => {
    requireValue(token, 'token');
    const text = typeof term === 'string' ? term.trim() : '';
    if (text.length < MIN_AUTOCOMPLETE_CHARS) return [];
    if (typeof memberId !== 'string' || memberId === '') return [];

    const data = `search=${encodeURIComponent(text)}&member_id=${encodeURIComponent(memberId)}`;
    const response = await makePostRequest(ENDPOINTS.searchAutocomplete, createWebHeaders(token), data);
    if (!response || !Array.isArray(response.items)) return [];
    // The payload is untrusted: keep only non-empty strings and normalise, so a
    // malformed entry can never reach the photo-search query string.
    return response.items
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim().toLowerCase())
        .filter((item) => item !== '');
};

module.exports = {
    getCurrentMemberProfile,
    searchTagAutocomplete,
    MIN_AUTOCOMPLETE_CHARS,
};
