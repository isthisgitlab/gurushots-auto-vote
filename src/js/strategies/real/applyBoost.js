/**
 * Real-strategy auto-cycle boost: chooses which entry to boost, posts it over
 * the api/boost transport, and marks the entry as boosted on success.
 */

const { boostImage } = require('../../api/boost');
const logger = require('../../logger');
const { pickBoostEntry } = require('../../services/VotingLogic');

/**
 * Applies a boost to a photo in a challenge.
 *
 * Boosts increase the visibility of your photo in a challenge.
 * Picks the entry via `boostImageIndex`, walking backward past any
 * turboed entry until a non-turboed one is found.
 *
 * @param {object} challenge - Challenge object containing id and member data
 * @param {string} token - Authentication token
 * @returns {Promise<object|null>} - API response or null if boost failed
 */
const applyBoost = async (challenge, token) => {
    const { id, member } = challenge;
    const challengeId = id?.toString?.() || '';
    const entries = member?.ranking?.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
        logger.withCategory('voting').error('No entries available for boosting', { challengeId });
        return null;
    }
    const picked = pickBoostEntry(challenge, challengeId);
    if (!picked) {
        logger
            .withCategory('voting')
            .error("Couldn't apply Boost — your only entry already has Turbo (Boost and Turbo can't share an entry)", {
                challengeId,
            });
        return null;
    }
    const boostImageId = picked.id;
    if (!boostImageId) {
        logger.withCategory('voting').error('Selected boost entry has no id', { challengeId });
        return null;
    }

    const response = await boostImage(challengeId, boostImageId, token);
    if (!response) return null;

    // Raise the conflict flag on the local challenge object now that the boost landed.
    // `picked` is a reference into challenge.member.ranking.entries, so a turbo running
    // later in this same pass sees the entry as taken instead of picking it again — boost
    // and turbo may both be spent on a challenge, but never on the same entry. Set here, at
    // the point the apply is known to have succeeded: the response carries no entry id, so
    // a later caller would otherwise have to re-run the pick and hope it resolved the same way.
    picked.boosted = true;
    return response;
};

module.exports = { applyBoost };
