/**
 * Jest Setup File
 *
 * This file contains global setup configuration for Jest tests.
 * It mocks external dependencies and sets up common test utilities.
 */

// Mock axios for all tests to prevent real HTTP calls
jest.mock('axios', () => jest.fn());

// Mock fs operations if needed
jest.mock('fs', () => ({
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    writeFileSync: jest.fn(),
    appendFileSync: jest.fn(),
    readdirSync: jest.fn(),
    mkdirSync: jest.fn(),
}));

// Mock path operations
jest.mock('path', () => ({
    join: jest.fn((...args) => args.join('/')),
    dirname: jest.fn(),
    resolve: jest.fn(),
}));

// Mock logger to prevent fs/path dependency issues in tests
jest.mock('../src/js/logger.js', () => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    api: jest.fn(),
    startOperation: jest.fn(),
    endOperation: jest.fn(),
    apiRequest: jest.fn(),
    apiResponse: jest.fn(),
    progress: jest.fn(),
    cliInfo: jest.fn(),
    cliError: jest.fn(),
    cliSuccess: jest.fn(),
    cliDebug: jest.fn(),
    cliWarning: jest.fn(),
    isDevMode: jest.fn(() => false),
    CATEGORIES: {
        SETTINGS: 'settings',
        AUTHENTICATION: 'authentication',
        VOTING: 'voting',
        CHALLENGES: 'challenges',
        API: 'api',
        UI: 'ui',
        TRANSLATION: 'translation',
        MIDDLEWARE: 'middleware',
        UPDATE: 'update',
    },
    withCategory: jest.fn(() => ({
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        api: jest.fn(),
        apiRequest: jest.fn(),
        startOperation: jest.fn(),
        endOperation: jest.fn(),
        progress: jest.fn(),
    })),
}));


// Global test timeout
jest.setTimeout(10000);

// Suppress console logs during tests unless explicitly testing them
beforeEach(() => {
    jest.clearAllMocks();
});