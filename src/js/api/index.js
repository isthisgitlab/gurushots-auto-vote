/**
 * GuruShots Auto Voter - API Module Index
 * 
 * This file provides a unified interface for all API operations,
 * maintaining backward compatibility with the original fetch.js structure.
 */

// Export middleware functions for CLI and GUI usage
const middleware = require('./middleware');

// Export the main functions for backward compatibility
module.exports = {
    // Backward compatibility exports
    fetchChallengesAndVote: middleware.fetchChallengesAndVote,
    login: middleware.cliLogin,
    
    // New middleware interface
    ...middleware,
}; 