// @ts-check
/**
 * Mock counterpart to api/login.js: accepts any non-empty credentials.
 */

import * as auth from '../auth';
import * as logger from '../../logger';
import { simulateApiResponse, simulateApiError } from '../simulate';

/**
 * Simulate authentication
 *
 * @type {typeof import('../../api/login').authenticate}
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

export { authenticate };
