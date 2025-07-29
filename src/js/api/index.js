/**
 * GuruShots Auto Voter - API Module Index
 *
 * This file provides a unified interface for all API operations
 * using the new factory pattern with strategies.
 */

const {getMiddleware} = require('../apiFactory');

// Get the middleware instance
const middleware = getMiddleware();

// Export the middleware directly
module.exports = {
    // Main functions
    fetchChallengesAndVote: middleware.apiStrategy.fetchChallengesAndVote.bind(middleware.apiStrategy),
    login: middleware.cliLogin.bind(middleware),

    // All middleware interface
    cliLogin: middleware.cliLogin.bind(middleware),
    cliVote: middleware.cliVote.bind(middleware),
    guiLogin: middleware.guiLogin.bind(middleware),
    guiVote: middleware.guiVote.bind(middleware),
    isAuthenticated: middleware.isAuthenticated.bind(middleware),
    logout: middleware.logout.bind(middleware),
    authenticate: middleware.apiStrategy.authenticate.bind(middleware.apiStrategy),
    getActiveChallenges: middleware.getActiveChallenges.bind(middleware),
    getVoteImages: middleware.getVoteImages.bind(middleware),
    submitVotes: middleware.submitVotes.bind(middleware),
    applyBoost: middleware.applyBoost.bind(middleware),
    applyBoostToEntry: middleware.applyBoostToEntry.bind(middleware),
}; 