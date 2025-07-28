/**
 * GuruShots Auto Voter - API Factory
 * 
 * This module provides a factory pattern to switch between real and mock APIs
 * based on the application settings. It allows the CLI to use either real
 * API calls or mock data for testing and development.
 */

const settings = require('./settings');

// Import real API modules
const realApi = require('./api');

// Import mock API modules
const mockApi = require('./mock');
const mockMiddleware = require('./mock/mock-middleware');

/**
 * Get the appropriate API based on environment
 * 
 * @returns {object} - API object with real or mock functions
 */
const getApi = () => {
    // Force fresh settings load to avoid cache issues
    const userSettings = settings.loadSettings();
    
    console.log('=== API Factory Debug ===');
    console.log('User settings:', JSON.stringify(userSettings, null, 2));
    console.log('Mock setting:', userSettings.mock);
    console.log('Token exists:', !!userSettings.token);
    console.log('Token length:', userSettings.token ? userSettings.token.length : 0);
    console.log('Full token:', userSettings.token || 'NO TOKEN');
    
    // Check if mock mode is enabled based on user settings
    if (userSettings.mock) {
        console.log('✅ Using MOCK API for development/testing');
        return {
            fetchChallengesAndVote: mockApi.mockApiClient.fetchChallengesAndVote,
            authenticate: mockApi.mockApiClient.authenticate,
            getActiveChallenges: mockApi.mockApiClient.getActiveChallenges,
            getVoteImages: mockApi.mockApiClient.getVoteImages,
            submitVotes: mockApi.mockApiClient.submitVotes,
            applyBoost: mockApi.mockApiClient.applyBoost,
            applyBoostToEntry: mockApi.mockApiClient.applyBoostToEntry,
        };
    } else {
        console.log('🌐 Using REAL API for production');
        return {
            fetchChallengesAndVote: realApi.fetchChallengesAndVote,
            authenticate: realApi.authenticate,
            // For real API, we use the middleware functions
            getActiveChallenges: realApi.getActiveChallenges,
            getVoteImages: realApi.getVoteImages,
            submitVotes: realApi.submitVotes,
            applyBoost: realApi.applyBoost,
            applyBoostToEntry: realApi.applyBoostToEntry,
        };
    }
};

/**
 * Get the appropriate middleware based on environment
 * 
 * @returns {object} - Middleware object with real or mock functions
 */
const getMiddleware = () => {
    const userSettings = settings.loadSettings();
    
    // Check if mock mode is enabled based on user settings
    if (userSettings.mock) {
        console.log('Using MOCK middleware for development/testing');
        return {
            cliLogin: mockMiddleware.mockCliLogin,
            cliVote: mockMiddleware.mockCliVote,
            guiLogin: mockMiddleware.mockGuiLogin,
            guiVote: mockMiddleware.mockGuiVote,
            isAuthenticated: mockMiddleware.mockIsAuthenticated,
            logout: mockMiddleware.mockLogout,
        };
    } else {
        console.log('Using REAL middleware for production');
        return {
            cliLogin: realApi.cliLogin,
            cliVote: realApi.cliVote,
            guiLogin: realApi.guiLogin,
            guiVote: realApi.guiVote,
            isAuthenticated: realApi.isAuthenticated,
            logout: realApi.logout,
        };
    }
};

// Function to force refresh API (useful when settings change)
const refreshApi = () => {
    console.log('🔄 Forcing API refresh due to settings change');
    // The getApi function already loads fresh settings, so no cache needed
};

// Export the factory functions
module.exports = {
    getApi,
    getMiddleware,
    refreshApi,
    
    // Convenience exports for direct access
    get fetchChallengesAndVote() {
        return getApi().fetchChallengesAndVote;
    },
    
    get authenticate() {
        return getApi().authenticate;
    },
    
    get cliLogin() {
        return getMiddleware().cliLogin;
    },
    
    get cliVote() {
        return getMiddleware().cliVote;
    },
    
    get guiLogin() {
        return getMiddleware().guiLogin;
    },
    
    get guiVote() {
        return getMiddleware().guiVote;
    },
    
    get isAuthenticated() {
        return getMiddleware().isAuthenticated;
    },
    
    get logout() {
        return getMiddleware().logout;
    },
}; 