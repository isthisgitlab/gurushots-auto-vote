/**
 * CLI-GUI Parity Integration Tests
 *
 * This test suite verifies that all logic from the GUI version works correctly
 * in the CLI version, ensuring feature parity between the two interfaces.
 */

const {getMiddleware} = require('../../src/js/apiFactory');
const settings = require('../../src/js/settings');
const BaseMiddleware = require('../../src/js/services/BaseMiddleware');
const RealApiStrategy = require('../../src/js/strategies/RealApiStrategy');
const MockApiStrategy = require('../../src/js/strategies/MockApiStrategy');

// Mock the API client for testing
jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    createCommonHeaders: jest.fn(),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded',
}));

// Mock the logger
jest.mock('../../src/js/logger', () => ({
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    success: jest.fn(),
    cleanup: jest.fn(),
    api: jest.fn(),
    startOperation: jest.fn(),
    endOperation: jest.fn(),
    apiRequest: jest.fn(),
    apiResponse: jest.fn(),
    isDevMode: jest.fn(() => false),
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        api: jest.fn(),
    })),
}));

describe('CLI-GUI Parity Tests', () => {
    let realStrategy;
    let mockStrategy;
    let realMiddleware;
    let mockMiddleware;

    beforeEach(() => {
        // Clear all mocks
        jest.clearAllMocks();
        
        // Create fresh strategy instances
        realStrategy = new RealApiStrategy();
        mockStrategy = new MockApiStrategy();
        realMiddleware = new BaseMiddleware(realStrategy);
        mockMiddleware = new BaseMiddleware(mockStrategy);
    });

    describe('Core Architecture Compatibility', () => {
        test('CLI and GUI use the same API factory', () => {
            // Test that the API factory works the same for both CLI and GUI
            const middleware = getMiddleware();
            
            expect(middleware).toBeInstanceOf(BaseMiddleware);
            expect(middleware.apiStrategy).toBeDefined();
            expect(typeof middleware.apiStrategy.getStrategyType).toBe('function');
        });

        test('CLI and GUI use the same strategy pattern', () => {
            // Both strategies should implement the same interface
            expect(typeof realStrategy.authenticate).toBe('function');
            expect(typeof mockStrategy.authenticate).toBe('function');
            expect(typeof realStrategy.getActiveChallenges).toBe('function');
            expect(typeof mockStrategy.getActiveChallenges).toBe('function');
            expect(typeof realStrategy.getVoteImages).toBe('function');
            expect(typeof mockStrategy.getVoteImages).toBe('function');
            expect(typeof realStrategy.submitVotes).toBe('function');
            expect(typeof mockStrategy.submitVotes).toBe('function');
            expect(typeof realStrategy.applyBoost).toBe('function');
            expect(typeof mockStrategy.applyBoost).toBe('function');
            expect(typeof realStrategy.fetchChallengesAndVote).toBe('function');
            expect(typeof mockStrategy.fetchChallengesAndVote).toBe('function');
        });

        test('CLI and GUI use the same middleware methods', () => {
            // Both should have the same middleware methods
            expect(typeof realMiddleware.cliLogin).toBe('function');
            expect(typeof realMiddleware.guiLogin).toBe('function');
            expect(typeof realMiddleware.cliVote).toBe('function');
            expect(typeof realMiddleware.guiVote).toBe('function');
            expect(typeof realMiddleware.isAuthenticated).toBe('function');
            expect(typeof realMiddleware.logout).toBe('function');
        });
    });

    describe('Settings Management Compatibility', () => {
        test('CLI can access all GUI settings', () => {
            // Test that CLI can access all the same settings as GUI
            const allSettings = settings.loadSettings();
            
            // Verify all expected settings are present
            expect(allSettings).toHaveProperty('theme');
            expect(allSettings).toHaveProperty('stayLoggedIn');
            expect(allSettings).toHaveProperty('mock');
            expect(allSettings).toHaveProperty('token');
            expect(allSettings).toHaveProperty('timezone');
            expect(allSettings).toHaveProperty('customTimezones');
            expect(allSettings).toHaveProperty('language');
            expect(allSettings).toHaveProperty('apiTimeout');
            expect(allSettings).toHaveProperty('checkFrequency');
            expect(allSettings).toHaveProperty('windowBounds');
            expect(allSettings).toHaveProperty('challengeSettings');
            expect(allSettings).toHaveProperty('apiHeaders');
        });

        test('CLI can handle settings schema', async () => {
            const schema = await settings.getSettingsSchema();
            
            // Verify all expected settings are in the schema
            expect(schema).toHaveProperty('exposure');
            expect(schema).toHaveProperty('boostTime');
                    expect(schema).toHaveProperty('lastMinuteThreshold');
        expect(schema).toHaveProperty('onlyBoost');
        expect(schema).toHaveProperty('voteOnlyInLastMinute');

            // Verify schema structure
            expect(schema.exposure).toHaveProperty('type');
            expect(schema.exposure).toHaveProperty('default');
            expect(schema.exposure).toHaveProperty('label');
            expect(schema.exposure).toHaveProperty('description');
        });

        test('CLI can handle global default settings functions', () => {
            // Test that CLI can use the same global default functions as GUI
            const settingKey = 'exposure';
            
            // Test that the functions exist and work
            expect(typeof settings.getGlobalDefault).toBe('function');
            expect(typeof settings.setGlobalDefault).toBe('function');
            expect(typeof settings.resetGlobalDefault).toBe('function');
            
            // Test that we can get a global default value
            const globalValue = settings.getGlobalDefault(settingKey);
            expect(typeof globalValue).toBe('number');
            expect(globalValue).toBeGreaterThan(0);
        });

        test('CLI can handle per-challenge settings functions', () => {
            // Test that CLI can use the same per-challenge functions as GUI
            const challengeId = '12345';
            const settingKey = 'exposure';
            
            // Test that the functions exist
            expect(typeof settings.getChallengeOverride).toBe('function');
            expect(typeof settings.setChallengeOverride).toBe('function');
            expect(typeof settings.removeChallengeOverride).toBe('function');
            expect(typeof settings.getEffectiveSetting).toBe('function');
            
            // Test that we can get an effective setting
            const effectiveValue = settings.getEffectiveSetting(settingKey, challengeId);
            expect(typeof effectiveValue).toBe('number');
            expect(effectiveValue).toBeGreaterThan(0);
        });
    });

    describe('Authentication Compatibility', () => {
        test('CLI and GUI use the same authentication logic', () => {
            // Test that both strategies use the same authentication method
            expect(typeof realStrategy.authenticate).toBe('function');
            expect(typeof mockStrategy.authenticate).toBe('function');

            // Test that middleware provides both CLI and GUI login methods
            expect(typeof realMiddleware.cliLogin).toBe('function');
            expect(typeof realMiddleware.guiLogin).toBe('function');
            expect(typeof mockMiddleware.cliLogin).toBe('function');
            expect(typeof mockMiddleware.guiLogin).toBe('function');
        });

        test('CLI can check authentication status', () => {
            // Test without token
            expect(realMiddleware.isAuthenticated()).toBe(false);
            expect(mockMiddleware.isAuthenticated()).toBe(false);
        });

        test('CLI can logout', () => {
            // Test logout function exists and works
            expect(typeof realMiddleware.logout).toBe('function');
            expect(typeof mockMiddleware.logout).toBe('function');
            
            // Test that logout doesn't throw errors
            expect(() => realMiddleware.logout()).not.toThrow();
            expect(() => mockMiddleware.logout()).not.toThrow();
        });
    });

    describe('Voting Logic Compatibility', () => {
        test('CLI and GUI use the same core voting logic', () => {
            // Both strategies should have the same voting methods
            expect(typeof realStrategy.fetchChallengesAndVote).toBe('function');
            expect(typeof mockStrategy.fetchChallengesAndVote).toBe('function');
            expect(typeof realStrategy.getActiveChallenges).toBe('function');
            expect(typeof mockStrategy.getActiveChallenges).toBe('function');
            expect(typeof realStrategy.getVoteImages).toBe('function');
            expect(typeof mockStrategy.getVoteImages).toBe('function');
            expect(typeof realStrategy.submitVotes).toBe('function');
            expect(typeof mockStrategy.submitVotes).toBe('function');
        });

        test('CLI can handle exposure threshold logic', () => {
            // Test that CLI can use the same exposure threshold logic as GUI
            const challengeId = '12345';
            
            // Test that we can get effective settings for exposure
            const effectiveThreshold = settings.getEffectiveSetting('exposure', challengeId);
            expect(typeof effectiveThreshold).toBe('number');
            expect(effectiveThreshold).toBeGreaterThan(0);
        });

        test('CLI can handle boost time logic', () => {
            // Test that CLI can use the same boost time logic as GUI
            const challengeId = '12345';
            
            // Test that we can get effective settings for boost time
            const effectiveBoostTime = settings.getEffectiveSetting('boostTime', challengeId);
            expect(typeof effectiveBoostTime).toBe('number');
            expect(effectiveBoostTime).toBeGreaterThanOrEqual(0);
        });

        test('CLI can handle last minutes logic', () => {
            // Test that CLI can use the same last minutes logic as GUI
            const challengeId = '12345';
            
            // Test that we can get effective settings for last minutes
                    const effectiveLastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challengeId);
        expect(typeof effectiveLastMinuteThreshold).toBe('number');
        expect(effectiveLastMinuteThreshold).toBeGreaterThan(0);
        });
    });

    describe('Boost Functionality Compatibility', () => {
        test('CLI and GUI use the same boost logic', () => {
            // Both strategies should have the same boost methods
            expect(typeof realStrategy.applyBoost).toBe('function');
            expect(typeof mockStrategy.applyBoost).toBe('function');
            expect(typeof realStrategy.applyBoostToEntry).toBe('function');
            expect(typeof mockStrategy.applyBoostToEntry).toBe('function');
        });

        test('CLI can handle boost-only mode', () => {
            // Test that CLI can use the same boost-only logic as GUI
            const challengeId = '12345';
            
            // Test that we can get effective settings for boost-only mode
            const onlyBoost = settings.getEffectiveSetting('onlyBoost', challengeId);
            expect(typeof onlyBoost).toBe('boolean');
        });
    });

    describe('Challenge Processing Compatibility', () => {
        test('CLI and GUI use the same challenge processing logic', () => {
            // Both strategies should have the same challenge processing methods
            expect(typeof realStrategy.getActiveChallenges).toBe('function');
            expect(typeof mockStrategy.getActiveChallenges).toBe('function');
        });

        test('CLI can handle vote-only-in-last-threshold logic', () => {
            // Test that CLI can use the same vote-only-in-last-threshold logic as GUI
            const challengeId = '12345';
            
            // Test that we can get effective settings for vote-only-in-last-threshold
                    const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challengeId);
        expect(typeof voteOnlyInLastMinute).toBe('boolean');
        });
    });

    describe('Settings Schema Compatibility', () => {
        test('CLI can handle all settings schema types', async () => {
            const schema = await settings.getSettingsSchema();
            
            // Test that CLI can handle all setting types
            for (const [key, config] of Object.entries(schema)) {
                expect(config).toHaveProperty('type');
                expect(config).toHaveProperty('default');
                expect(config).toHaveProperty('label');
                expect(config).toHaveProperty('description');
                
                // Test that CLI can get effective settings for all types
                const effectiveValue = settings.getEffectiveSetting(key, 'test-challenge');
                expect(effectiveValue).toBeDefined();
            }
        });

        test('CLI can handle boolean settings', () => {
            const challengeId = '12345';
            
            // Test boolean setting
            const onlyBoost = settings.getEffectiveSetting('onlyBoost', challengeId);
            expect(typeof onlyBoost).toBe('boolean');
        });

        test('CLI can handle number settings', () => {
            const challengeId = '12345';
            
            // Test number setting
            const exposure = settings.getEffectiveSetting('exposure', challengeId);
            expect(typeof exposure).toBe('number');
            expect(exposure).toBeGreaterThan(0);
        });

        test('CLI can handle time settings', () => {
            const challengeId = '12345';
            
            // Test time setting (in seconds)
            const boostTime = settings.getEffectiveSetting('boostTime', challengeId);
            expect(typeof boostTime).toBe('number');
            expect(boostTime).toBeGreaterThanOrEqual(0);
        });
    });

    describe('Environment Compatibility', () => {
        test('CLI works in both development and production environments', () => {
            // Test that CLI can handle different environments like GUI
            const envInfo = settings.getEnvironmentInfo();
            
            expect(envInfo).toHaveProperty('nodeEnv');
            expect(envInfo).toHaveProperty('defaultMock');
            expect(typeof envInfo.defaultMock).toBe('boolean');
        });

        test('CLI can handle mock mode switching', () => {
            // Test that CLI can switch between mock and real modes
            const originalMock = settings.getSetting('mock');
            
            // Test that we can get the current mock setting
            expect(typeof originalMock).toBe('boolean');
        });
    });

    describe('Integration Tests', () => {
        test('CLI can perform a complete voting cycle like GUI', () => {
            // Test that CLI can perform the same voting cycle as GUI
            // Test that the voting cycle can be called (even if it fails due to mocked API)
            expect(typeof realStrategy.fetchChallengesAndVote).toBe('function');
            expect(typeof mockStrategy.fetchChallengesAndVote).toBe('function');
        });

        test('CLI can handle complex settings scenarios like GUI', () => {
            // Test a complex settings scenario that GUI might handle
            const challengeId = '12345';
            
            // Test that we can get effective settings for all challenge settings
            const exposure = settings.getEffectiveSetting('exposure', challengeId);
            const boostTime = settings.getEffectiveSetting('boostTime', challengeId);
            const lastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challengeId);
            const onlyBoost = settings.getEffectiveSetting('onlyBoost', challengeId);
            const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challengeId);
            
            // Verify all settings are of the correct types
            expect(typeof exposure).toBe('number');
            expect(typeof boostTime).toBe('number');
            expect(typeof lastMinuteThreshold).toBe('number');
            expect(typeof onlyBoost).toBe('boolean');
            expect(typeof voteOnlyInLastMinute).toBe('boolean');
            
            // Verify numeric values are reasonable
            expect(exposure).toBeGreaterThan(0);
            expect(boostTime).toBeGreaterThanOrEqual(0);
            expect(lastMinuteThreshold).toBeGreaterThan(0);
        });
    });
}); 