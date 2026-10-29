/**
 * GuruShots Auto Voter - Mock layer facade
 *
 * Facade over the mock layer: the mock API client (mock/apiClient.ts)
 * apiFactory selects in mock mode, and the session-cache reset.
 */

import { clearSessionCache } from './sessionCache';
import { mockApiClient } from './apiClient';
import { mockEntryAgeLedger } from './strategy';

export {
    // Mock API client
    mockApiClient,

    // The mock surface's in-memory entry-age ledger (apiFactory.getEntryAgeLedger)
    mockEntryAgeLedger,

    // Session cache control
    clearSessionCache,
};
