/**
 * GuruShots Auto Voter - Mock session cache
 *
 * Session-stable mock data, so the generated challenges and per-challenge
 * vote images are not regenerated within the same app run. The single owner
 * of that state: endpoints read it through getSessionCache() on every call,
 * so a clearSessionCache() is seen by all of them.
 */

const createSessionCache = () => ({
    challenges: null,
    voteImages: new Map(), // challengeUrl -> voteImages
});

let sessionMockCache = createSessionCache();

const getSessionCache = () => sessionMockCache;

// Function to clear session cache (for testing)
const clearSessionCache = () => {
    sessionMockCache = createSessionCache();
};

module.exports = { getSessionCache, clearSessionCache };
