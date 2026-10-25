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

export { mockBoostSuccess };
