/**
 * GuruShots Auto Voter - API Factory
 *
 * This module provides a factory pattern to switch between real and mock APIs
 * based on the application settings. It uses the strategy pattern to eliminate
 * code duplication and provide a clean interface.
 */

const settings = require('./settings');
const BaseMiddleware = require('./services/BaseMiddleware');
const RealApiStrategy = require('./strategies/RealApiStrategy');
const MockApiStrategy = require('./strategies/MockApiStrategy');
const logger = require('./logger');

// Cache for strategy instances to avoid recreating them
let currentStrategy = null;
let currentMiddleware = null;
let lastMockSetting = null;

/**
 * Get the appropriate API strategy based on environment
 *
 * @returns {ApiStrategy} - API strategy instance (real or mock)
 */
const getApiStrategy = () => {

    const userSettings = settings.loadSettings();

    // Check if we need to recreate the strategy due to setting change
    if (lastMockSetting !== userSettings.mock || !currentStrategy) {
        logger.debug('=== API Factory Debug ===');
        logger.debug('Mock setting:', userSettings.mock);
        logger.debug('Token exists:', !!userSettings.token);

        // Create the appropriate strategy
        if (userSettings.mock) {
            logger.info('✅ Using MOCK API strategy for development/testing');
            currentStrategy = new MockApiStrategy();
        } else {
            logger.info('🌐 Using REAL API strategy for production');
            currentStrategy = new RealApiStrategy();
        }

        // Update cache
        lastMockSetting = userSettings.mock;
        currentMiddleware = null; // Reset middleware cache
    }

    return currentStrategy;
};

/**
 * Get the middleware instance with the appropriate strategy
 *
 * @returns {BaseMiddleware} - Middleware instance with strategy
 */
const getMiddleware = () => {
    // Get or create the current strategy
    const strategy = getApiStrategy();

    // Create middleware if not cached or strategy changed
    if (!currentMiddleware) {
        logger.debug(`Creating middleware with ${strategy.getStrategyType()} strategy`);
        currentMiddleware = new BaseMiddleware(strategy);
    }

    return currentMiddleware;
};

// Function to force refresh API (useful when settings change)
const refreshApi = () => {
    logger.info('🔄 Forcing API refresh due to settings change');
    currentStrategy = null;
    currentMiddleware = null;
    lastMockSetting = null;
};

// Export the factory functions
module.exports = {
    getApiStrategy,
    getMiddleware,
    refreshApi,
}; 