/**
 * Tests for apiFactory.js
 *
 * Tests the API factory pattern for switching between real and mock APIs.
 */

const {getApiStrategy, getMiddleware, refreshApi} = require('../src/js/apiFactory');

// Mock the settings module
jest.mock('../src/js/settings', () => ({
    loadSettings: jest.fn(),
}));

// Mock the middleware
jest.mock('../src/js/services/BaseMiddleware', () => {
    return jest.fn().mockImplementation((strategy) => ({
        strategy,
        mockMiddlewareInstance: true,
    }));
});

// Mock the strategies
jest.mock('../src/js/strategies/RealApiStrategy', () => {
    return jest.fn().mockImplementation(() => ({
        getStrategyType: () => 'RealAPI',
        mockRealStrategy: true,
    }));
});

jest.mock('../src/js/strategies/MockApiStrategy', () => {
    return jest.fn().mockImplementation(() => ({
        getStrategyType: () => 'MockAPI',
        mockMockStrategy: true,
    }));
});

// Mock console methods
jest.spyOn(console, 'log').mockImplementation();

describe('apiFactory', () => {
    const settings = require('../src/js/settings');
    const BaseMiddleware = require('../src/js/services/BaseMiddleware');
    const RealApiStrategy = require('../src/js/strategies/RealApiStrategy');
    const MockApiStrategy = require('../src/js/strategies/MockApiStrategy');

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset internal state
        refreshApi();
    });

    describe('getApiStrategy', () => {
        test('should return MockApiStrategy when mock is true', () => {
            settings.loadSettings.mockReturnValueOnce({
                mock: true,
                token: 'test-token-123'
            });

            const strategy = getApiStrategy();

            expect(settings.loadSettings).toHaveBeenCalled();
            expect(MockApiStrategy).toHaveBeenCalled();
            expect(strategy.mockMockStrategy).toBe(true);
            expect(console.log).toHaveBeenCalledWith('✅ Using MOCK API strategy for development/testing');
        });

        test('should return RealApiStrategy when mock is false', () => {
            settings.loadSettings.mockReturnValueOnce({
                mock: false,
                token: 'test-token-123'
            });

            const strategy = getApiStrategy();

            expect(settings.loadSettings).toHaveBeenCalled();
            expect(RealApiStrategy).toHaveBeenCalled();
            expect(strategy.mockRealStrategy).toBe(true);
            expect(console.log).toHaveBeenCalledWith('🌐 Using REAL API strategy for production');
        });

        test('should log debug information', () => {
            const mockSettings = {
                mock: true,
                token: 'test-token-123'
            };
            settings.loadSettings.mockReturnValueOnce(mockSettings);

            getApiStrategy();

            expect(console.log).toHaveBeenCalledWith('=== API Factory Debug ===');
            expect(console.log).toHaveBeenCalledWith('Mock setting:', true);
            expect(console.log).toHaveBeenCalledWith('Token exists:', true);
        });

        test('should handle missing token', () => {
            const mockSettings = {
                mock: false,
                token: null
            };
            settings.loadSettings.mockReturnValueOnce(mockSettings);

            getApiStrategy();

            expect(console.log).toHaveBeenCalledWith('Token exists:', false);
        });

        test('should handle undefined token', () => {
            const mockSettings = {
                mock: false
            };
            settings.loadSettings.mockReturnValueOnce(mockSettings);

            getApiStrategy();

            expect(console.log).toHaveBeenCalledWith('Token exists:', false);
        });

        test('should cache strategy when settings do not change', () => {
            const mockSettings = {
                mock: true,
                token: 'test-token-123'
            };
            settings.loadSettings.mockReturnValue(mockSettings);

            const strategy1 = getApiStrategy();
            const strategy2 = getApiStrategy();

            expect(strategy1).toBe(strategy2);
            expect(MockApiStrategy).toHaveBeenCalledTimes(1);
            expect(settings.loadSettings).toHaveBeenCalledTimes(2); // Force fresh load each time
        });

        test('should recreate strategy when mock setting changes', () => {
            // First call with mock: true
            settings.loadSettings.mockReturnValueOnce({
                mock: true,
                token: 'test-token-123'
            });

            const strategy1 = getApiStrategy();
            expect(strategy1.mockMockStrategy).toBe(true);

            // Second call with mock: false
            settings.loadSettings.mockReturnValueOnce({
                mock: false,
                token: 'test-token-123'
            });

            const strategy2 = getApiStrategy();
            expect(strategy2.mockRealStrategy).toBe(true);

            expect(MockApiStrategy).toHaveBeenCalledTimes(1);
            expect(RealApiStrategy).toHaveBeenCalledTimes(1);
        });

        test('should recreate strategy when no previous strategy exists', () => {
            settings.loadSettings.mockReturnValueOnce({
                mock: true,
                token: 'test-token-123'
            });

            const strategy = getApiStrategy();

            expect(MockApiStrategy).toHaveBeenCalledTimes(1);
            expect(strategy.mockMockStrategy).toBe(true);
        });
    });

    describe('getMiddleware', () => {
        test('should create middleware with MockApiStrategy', () => {
            settings.loadSettings.mockReturnValueOnce({
                mock: true,
                token: 'test-token-123'
            });

            const middleware = getMiddleware();

            expect(BaseMiddleware).toHaveBeenCalledWith(expect.objectContaining({
                mockMockStrategy: true
            }));
            expect(middleware.mockMiddlewareInstance).toBe(true);
            expect(console.log).toHaveBeenCalledWith('Creating middleware with MockAPI strategy');
        });

        test('should create middleware with RealApiStrategy', () => {
            settings.loadSettings.mockReturnValueOnce({
                mock: false,
                token: 'test-token-123'
            });

            const middleware = getMiddleware();

            expect(BaseMiddleware).toHaveBeenCalledWith(expect.objectContaining({
                mockRealStrategy: true
            }));
            expect(middleware.mockMiddlewareInstance).toBe(true);
            expect(console.log).toHaveBeenCalledWith('Creating middleware with RealAPI strategy');
        });

        test('should cache middleware instance', () => {
            settings.loadSettings.mockReturnValue({
                mock: true,
                token: 'test-token-123'
            });

            const middleware1 = getMiddleware();
            const middleware2 = getMiddleware();

            expect(middleware1).toBe(middleware2);
            expect(BaseMiddleware).toHaveBeenCalledTimes(1);
        });

        test('should recreate middleware when strategy changes', () => {
            // First call with mock: true
            settings.loadSettings.mockReturnValueOnce({
                mock: true,
                token: 'test-token-123'
            });

            const middleware1 = getMiddleware();

            // Second call with mock: false (force new strategy)
            refreshApi(); // Clear cache
            settings.loadSettings.mockReturnValueOnce({
                mock: false,
                token: 'test-token-123'
            });

            const middleware2 = getMiddleware();

            expect(middleware1).not.toBe(middleware2);
            expect(BaseMiddleware).toHaveBeenCalledTimes(2);
        });
    });

    describe('refreshApi', () => {
        test('should clear cached strategy and middleware', () => {
            // Set up initial state
            settings.loadSettings.mockReturnValue({
                mock: true,
                token: 'test-token-123'
            });

            const strategy1 = getApiStrategy();
            const middleware1 = getMiddleware();

            // Call refreshApi
            refreshApi();

            // Get new instances
            const strategy2 = getApiStrategy();
            const middleware2 = getMiddleware();

            expect(strategy1).not.toBe(strategy2);
            expect(middleware1).not.toBe(middleware2);
            expect(MockApiStrategy).toHaveBeenCalledTimes(2);
            expect(BaseMiddleware).toHaveBeenCalledTimes(2);
        });

        test('should log refresh message', () => {
            refreshApi();

            expect(console.log).toHaveBeenCalledWith('🔄 Forcing API refresh due to settings change');
        });

        test('should reset internal cache flags', () => {
            // Set up initial state with mock: true
            settings.loadSettings.mockReturnValueOnce({
                mock: true,
                token: 'test-token-123'
            });

            getApiStrategy();

            // Refresh and change to mock: false
            refreshApi();
            settings.loadSettings.mockReturnValueOnce({
                mock: false,
                token: 'test-token-123'
            });

            const strategy = getApiStrategy();

            expect(strategy.mockRealStrategy).toBe(true);
            expect(RealApiStrategy).toHaveBeenCalledTimes(1);
        });
    });

    describe('integration scenarios', () => {
        test('should handle complete workflow with setting changes', () => {
            // Start with mock API
            settings.loadSettings.mockReturnValueOnce({
                mock: true,
                token: 'test-token-123'
            });

            const mockStrategy = getApiStrategy();
            const mockMiddleware = getMiddleware();

            expect(mockStrategy.mockMockStrategy).toBe(true);
            expect(mockMiddleware.strategy.mockMockStrategy).toBe(true);

            // Switch to real API
            refreshApi();
            settings.loadSettings.mockReturnValueOnce({
                mock: false,
                token: 'test-token-123'
            });

            const realStrategy = getApiStrategy();
            const realMiddleware = getMiddleware();

            expect(realStrategy.mockRealStrategy).toBe(true);
            expect(realMiddleware.strategy).toBeDefined();

            // Verify they're different instances
            expect(mockStrategy).not.toBe(realStrategy);
            expect(mockMiddleware).not.toBe(realMiddleware);
        });

        test('should handle empty settings object', () => {
            settings.loadSettings.mockReturnValueOnce({});

            const strategy = getApiStrategy();

            expect(strategy.mockRealStrategy).toBe(true);
            expect(console.log).toHaveBeenCalledWith('Mock setting:', undefined);
            expect(console.log).toHaveBeenCalledWith('🌐 Using REAL API strategy for production');
        });
    });
});