/**
 * GuruShots Auto Voter - Mock Authentication Data
 *
 * Mock responses for authentication operations
 */

/**
 * Mock successful login response
 */
const mockLoginSuccess = {
    token: 'mock_prod_token_1234567890abcdef',
    user: {
        id: 12345,
        email: 'test@example.com',
        username: 'testuser',
        display_name: 'Test User',
        avatar: 'https://example.com/avatar.jpg',
        level: 5,
        points: 1250,
    },
    settings: {
        notifications: true,
        email_notifications: false,
        language: 'en',
    },
};

/**
 * Mock failed login response
 */
const mockLoginFailure = {
    error: 'Invalid credentials',
    code: 'AUTH_FAILED',
    message: 'Email or password is incorrect',
};

/**
 * Mock token validation response
 */
const mockTokenValid = {
    valid: true,
    user: {
        id: 12345,
        email: 'test@example.com',
        username: 'testuser',
        display_name: 'Test User',
    },
};

/**
 * Mock token invalid response
 */
const mockTokenInvalid = {
    valid: false,
    error: 'Token expired or invalid',
    code: 'TOKEN_INVALID',
};

module.exports = {
    mockLoginSuccess,
    mockLoginFailure,
    mockTokenValid,
    mockTokenInvalid,
}; 