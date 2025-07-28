/**
 * GuruShots Auto Voter - Mock Boost Data
 * 
 * Mock responses for boost operations
 */

/**
 * Mock boost application success response
 */
const mockBoostSuccess = {
    success: true,
    message: 'Boost applied successfully',
    challenge_id: 1001,
    image_id: 'entry_001',
    boost_type: 'standard',
    duration: 3600, // 1 hour in seconds
    applied_at: Math.floor(Date.now() / 1000),
    expires_at: Math.floor(Date.now() / 1000) + 3600,
};

/**
 * Mock boost application failure response
 */
const mockBoostFailure = {
    success: false,
    error: 'No boost available',
    code: 'BOOST_UNAVAILABLE',
    message: 'You have no boosts available for this challenge',
};

/**
 * Mock boost already used response
 */
const mockBoostAlreadyUsed = {
    success: false,
    error: 'Boost already used',
    code: 'BOOST_USED',
    message: 'You have already used your boost for this challenge',
};

/**
 * Mock boost timeout response
 */
const mockBoostTimeout = {
    success: false,
    error: 'Boost timeout expired',
    code: 'BOOST_TIMEOUT',
    message: 'The boost timeout has expired for this challenge',
};

/**
 * Mock boost data for different challenge states
 */
const mockBoostData = {
    // Challenge with available boost
    available: {
        state: 'AVAILABLE',
        timeout: Math.floor(Date.now() / 1000) + 3600, // Available for 1 hour
        type: 'standard',
        duration: 3600,
    },
    
    // Challenge with used boost
    used: {
        state: 'USED',
        timeout: 0,
        type: 'standard',
        duration: 3600,
        applied_at: Math.floor(Date.now() / 1000) - 1800, // Applied 30 minutes ago
    },
    
    // Challenge with unavailable boost
    unavailable: {
        state: 'UNAVAILABLE',
        timeout: 0,
        type: null,
        duration: 0,
    },
    
    // Challenge with boost about to expire
    expiring: {
        state: 'AVAILABLE',
        timeout: Math.floor(Date.now() / 1000) + 300, // Available for 5 minutes
        type: 'standard',
        duration: 3600,
    },
};

/**
 * Mock boost history
 */
const mockBoostHistory = [
    {
        challenge_id: 1001,
        challenge_title: 'Street Photography',
        image_id: 'entry_001',
        applied_at: Math.floor(Date.now() / 1000) - 86400, // 1 day ago
        duration: 3600,
        boost_type: 'standard',
        result: 'success',
    },
    {
        challenge_id: 999,
        challenge_title: 'Previous Challenge',
        image_id: 'entry_999',
        applied_at: Math.floor(Date.now() / 1000) - 172800, // 2 days ago
        duration: 3600,
        boost_type: 'standard',
        result: 'success',
    },
];

module.exports = {
    mockBoostSuccess,
    mockBoostFailure,
    mockBoostAlreadyUsed,
    mockBoostTimeout,
    mockBoostData,
    mockBoostHistory,
}; 