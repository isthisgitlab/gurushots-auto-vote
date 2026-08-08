/**
 * GuruShots Auto Voter - Mock Error Data
 *
 * Mock error responses used by the mock API client's auth guards.
 */

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

module.exports = {
    mockAuthErrors,
};
