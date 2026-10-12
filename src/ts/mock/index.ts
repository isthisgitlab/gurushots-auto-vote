/**
 * GuruShots Auto Voter - Mock layer facade
 *
 * Facade over the mock layer: the mock API client (mock/apiClient.ts)
 * apiFactory selects in mock mode, and the session-cache reset.
 */

import { clearSessionCache } from './sessionCache';
import { mockApiClient } from './apiClient';
import { mockMetadata } from './metadata';

export {
    // Mock API client
    mockApiClient,

    // Vote metadata kept in memory, never in metadata.json
    mockMetadata,

    // Session cache control
    clearSessionCache,
};
