/**
 * GuruShots Auto Voter - Mock layer facade
 *
 * Facade over the mock layer: the mock API client (mock/apiClient.js)
 * apiFactory selects in mock mode, and the session-cache reset.
 */

import { clearSessionCache } from './sessionCache';
import { mockApiClient } from './apiClient';

export {
    // Mock API client
    mockApiClient,

    // Session cache control
    clearSessionCache,
};
