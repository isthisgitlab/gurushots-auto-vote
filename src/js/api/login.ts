/**
 * GuruShots Auto Voter - Authentication Module
 *
 * This module handles user authentication with the GuruShots API.
 * It's designed to work with both CLI and GUI interfaces.
 */

import { makePostRequest, createCommonHeaders, FORM_CONTENT_TYPE } from './api-client';
import { ENDPOINTS } from './constants';
import * as logger from '../logger';

import type { LoginResponse } from '../types/gurushots';

/**
 * Authenticates with GuruShots and obtains an authentication token
 *
 * This function:
 * 1. Takes email and password as parameters
 * 2. Sends authentication request to GuruShots API
 * 3. Returns the response data containing token
 *
 * @param email - User's email address
 * @param password - User's password
 * @returns Response data containing token or null if login failed
 */
const authenticate = async (email: string, password: string): Promise<LoginResponse | null> => {
    logger.withCategory('authentication').info('Starting authentication...', null);

    // URLSearchParams encodes BOTH fields RFC-compliantly — a password
    // containing & = % + would otherwise be truncated or corrupted
    // server-side. No manual content-length: axios computes the byte
    // length itself (a UTF-16 .length count under-reports multibyte).
    const data = new URLSearchParams({ login: email, password }).toString();
    const headers = {
        ...createCommonHeaders(undefined),
        'content-type': FORM_CONTENT_TYPE,
        'x-token': undefined,
    };

    // Routed through makePostRequest so the CapacitorHttp adapter applies on
    // Android — the iOS-spoof headers in randomizer.ts (host, user-agent) are
    // forbidden in browser fetch and only survive via native OkHttp.
    const responseData = (await makePostRequest(ENDPOINTS.signup, headers, data)) as LoginResponse | null;

    if (responseData) {
        logger.withCategory('authentication').success('Authentication successful', null, null);
    } else {
        logger.withCategory('authentication').error('Authentication failed', null);
    }
    return responseData;
};

export { authenticate };
