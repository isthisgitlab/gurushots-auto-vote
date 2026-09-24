/**
 * Real-strategy active-challenge read: the api/challenges fetch plus
 * first-seen title pinning, with concurrent calls coalesced per token.
 */

const { fetchActiveChallenges } = require('../../api/challenges');
const { pinChallengeTitles } = require('../../services/challengeTitlePin');

/**
 * One fetch, then pin first-seen titles onto a successful response. A failed
 * fetch (flagged `fetchFailed`) must never reach the pin/prune logic — a
 * network blip would wipe pins. The server mutates `title` while an event
 * (turbo) is active; pinning keeps display and title-rule matching stable
 * (see services/challengeTitlePin).
 *
 * @param {string} token
 * @returns {Promise<object>}
 */
const fetchAndPin = async (token) => {
    const response = await fetchActiveChallenges(token);
    if (!response.fetchFailed && Array.isArray(response.challenges)) {
        pinChallengeTitles(response.challenges);
    }
    return response;
};

// In-flight request coalescing. Independent consumers can want the current
// active-challenge list at the same instant — e.g. a UI challenges refresh
// racing an in-progress voting cycle. We share the in-flight promise per token
// and clear it as soon as the request settles, so only genuinely *concurrent*
// calls are merged (and pinned once); a later (sequential) call still hits the
// network for fresh data. No resolved-result caching, so this never serves
// stale challenge state.
const inFlightByToken = new Map();

/**
 * Fetches all active challenges for the authenticated user, coalescing
 * concurrent calls for the same token into one request.
 *
 * @param {string} token - Authentication token
 * @returns {Promise<object>} Response containing array of active challenges
 *                   or empty challenges array if request fails
 */
const getActiveChallenges = (token) => {
    const key = token || '';
    const existing = inFlightByToken.get(key);
    if (existing) {
        return existing;
    }

    const request = fetchAndPin(token).finally(() => {
        inFlightByToken.delete(key);
    });
    inFlightByToken.set(key, request);
    return request;
};

module.exports = { getActiveChallenges };
