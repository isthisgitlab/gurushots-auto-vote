/**
 * GuruShots Auto Voter - Mock Data Index
 *
 * Facade over the mock layer: the fixture modules, the latency helpers, the
 * mock API client (mock/apiClient.js) apiFactory selects in mock mode, and
 * the session-cache reset.
 */

import * as auth from './auth';
import * as challenges from './challenges';
import * as voting from './voting';
import * as boost from './boost';
import * as errors from './errors';
import { simulateApiResponse, simulateApiError } from './simulate';
import { clearSessionCache } from './sessionCache';
import { mockApiClient } from './apiClient';

/**
 * Complete mock data object
 */
const mockData = {
    auth,
    challenges,
    voting,
    boost,
    errors,
};

/**
 * Helper function to get mock data by type and scenario
 *
 * @param {string} type - The type of mock data (auth, challenges, voting, boost, errors)
 * @param {string|null} [scenario] - The specific scenario (optional)
 * @returns {unknown} - The requested mock data
 */
const getMockData = (type, scenario = null) => {
    // Looked up by caller-supplied name, so read through a string-keyed view.
    const byType = /** @type {Record<string, Record<string, unknown>>} */ (mockData);
    if (!byType[type]) {
        throw new Error(`Unknown mock data type: ${type}`);
    }

    if (scenario) {
        if (!byType[type][scenario]) {
            throw new Error(`Unknown scenario "${scenario}" for type "${type}"`);
        }
        return byType[type][scenario];
    }

    return byType[type];
};

export {
    // Individual mock data modules
    auth,
    challenges,
    voting,
    boost,
    errors,

    // Complete mock data object
    mockData,

    // Helper functions
    getMockData,
    simulateApiResponse,
    simulateApiError,

    // Mock API client
    mockApiClient,

    // Session cache control
    clearSessionCache,
};
