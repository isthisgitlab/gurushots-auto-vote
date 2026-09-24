/**
 * Mock counterpart to api/login.js: accepts any non-empty credentials.
 */

const auth = require('../auth');
const logger = require('../../logger');
const { simulateApiResponse, simulateApiError } = require('../simulate');

/**
 * Simulate authentication
 */
const authenticate = async (email, password) => {
    logger
        .withCategory('authentication')
        .debug(`Mock authentication with: ${email}, password: ${password ? '[hidden]' : 'no password'}`, null);

    // Accept any non-empty email and password for mock mode
    if (email && email.trim() !== '' && password && password.trim() !== '') {
        logger.withCategory('authentication').success('Mock authentication successful', null, null);
        return simulateApiResponse(auth.mockLoginSuccess, 1500);
    } else {
        logger.withCategory('authentication').error('Mock authentication failed - empty credentials', null);
        return simulateApiError(auth.mockLoginFailure, 1000);
    }
};

module.exports = { authenticate };
