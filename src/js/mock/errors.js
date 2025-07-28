/**
 * GuruShots Auto Voter - Mock Error Data
 * 
 * Mock error responses for various API scenarios
 */

/**
 * Network error response
 */
const mockNetworkError = {
    error: 'Network Error',
    code: 'NETWORK_ERROR',
    message: 'Unable to connect to GuruShots servers',
    details: 'Please check your internet connection and try again',
};

/**
 * Authentication error responses
 */
const mockAuthErrors = {
    invalidToken: {
        error: 'Invalid Token',
        code: 'AUTH_INVALID_TOKEN',
        message: 'The provided authentication token is invalid or expired',
        details: 'Please login again to obtain a new token',
    },
    
    expiredToken: {
        error: 'Token Expired',
        code: 'AUTH_TOKEN_EXPIRED',
        message: 'Your authentication token has expired',
        details: 'Please login again to continue',
    },
    
    missingToken: {
        error: 'Missing Token',
        code: 'AUTH_MISSING_TOKEN',
        message: 'No authentication token provided',
        details: 'Please login to obtain an authentication token',
    },
    
    invalidCredentials: {
        error: 'Invalid Credentials',
        code: 'AUTH_INVALID_CREDENTIALS',
        message: 'Email or password is incorrect',
        details: 'Please check your credentials and try again',
    },
};

/**
 * Rate limiting error responses
 */
const mockRateLimitErrors = {
    tooManyRequests: {
        error: 'Too Many Requests',
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'You have exceeded the rate limit for API requests',
        details: 'Please wait before making additional requests',
        retry_after: 60, // seconds
    },
    
    votingRateLimit: {
        error: 'Voting Rate Limit',
        code: 'VOTING_RATE_LIMIT',
        message: 'You are voting too quickly',
        details: 'Please slow down your voting pace',
        retry_after: 30, // seconds
    },
};

/**
 * Challenge-specific error responses
 */
const mockChallengeErrors = {
    challengeNotFound: {
        error: 'Challenge Not Found',
        code: 'CHALLENGE_NOT_FOUND',
        message: 'The specified challenge does not exist',
        details: 'The challenge may have been removed or the URL is incorrect',
    },
    
    challengeNotActive: {
        error: 'Challenge Not Active',
        code: 'CHALLENGE_NOT_ACTIVE',
        message: 'This challenge is not currently active',
        details: 'The challenge may not have started yet or has already ended',
    },
    
    challengeEnded: {
        error: 'Challenge Ended',
        code: 'CHALLENGE_ENDED',
        message: 'This challenge has already ended',
        details: 'Voting is no longer possible for this challenge',
    },
    
    noVoteImages: {
        error: 'No Vote Images',
        code: 'NO_VOTE_IMAGES',
        message: 'No images available for voting in this challenge',
        details: 'All images may have been voted on or the challenge is empty',
    },
};

/**
 * Voting-specific error responses
 */
const mockVotingErrors = {
    alreadyVoted: {
        error: 'Already Voted',
        code: 'ALREADY_VOTED',
        message: 'You have already voted on these images',
        details: 'Each image can only be voted on once per session',
    },
    
    invalidImageIds: {
        error: 'Invalid Image IDs',
        code: 'INVALID_IMAGE_IDS',
        message: 'One or more image IDs are invalid',
        details: 'The images may have been removed or are not available for voting',
    },
    
    exposureFactorComplete: {
        error: 'Exposure Factor Complete',
        code: 'EXPOSURE_FACTOR_COMPLETE',
        message: 'Your exposure factor is already at maximum',
        details: 'You have already reached 100% exposure for this challenge',
    },
};

/**
 * Boost-specific error responses
 */
const mockBoostErrors = {
    noBoostAvailable: {
        error: 'No Boost Available',
        code: 'NO_BOOST_AVAILABLE',
        message: 'No boost is available for this challenge',
        details: 'You may have already used your boost or it is not available yet',
    },
    
    boostTimeoutExpired: {
        error: 'Boost Timeout Expired',
        code: 'BOOST_TIMEOUT_EXPIRED',
        message: 'The boost timeout has expired',
        details: 'The boost must be used within the specified time limit',
    },
    
    noNonTurboedEntries: {
        error: 'No Non-Turboed Entries',
        code: 'NO_NON_TURBOED_ENTRIES',
        message: 'No non-turboed entries found for boosting',
        details: 'All your entries in this challenge are already turboed',
    },
};

/**
 * Server error responses
 */
const mockServerErrors = {
    internalServerError: {
        error: 'Internal Server Error',
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An internal server error occurred',
        details: 'Please try again later or contact support if the problem persists',
    },
    
    serviceUnavailable: {
        error: 'Service Unavailable',
        code: 'SERVICE_UNAVAILABLE',
        message: 'The service is temporarily unavailable',
        details: 'Please try again later',
        retry_after: 300, // 5 minutes
    },
    
    maintenanceMode: {
        error: 'Maintenance Mode',
        code: 'MAINTENANCE_MODE',
        message: 'The service is currently under maintenance',
        details: 'Please check back later',
        estimated_duration: 3600, // 1 hour
    },
};

/**
 * Generic error response generator
 */
const createMockError = (type, code, message, details = null) => ({
    error: type,
    code: code,
    message: message,
    details: details,
    timestamp: Math.floor(Date.now() / 1000),
});

module.exports = {
    mockNetworkError,
    mockAuthErrors,
    mockRateLimitErrors,
    mockChallengeErrors,
    mockVotingErrors,
    mockBoostErrors,
    mockServerErrors,
    createMockError,
}; 