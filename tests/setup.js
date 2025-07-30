/**
 * Jest Setup File
 *
 * This file contains global setup configuration for Jest tests.
 * It mocks external dependencies and sets up common test utilities.
 */

// Mock axios for all tests to prevent real HTTP calls
jest.mock('axios');

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

// Global test timeout
jest.setTimeout(10000);

// Suppress console logs during tests unless explicitly testing them
beforeEach(() => {
    jest.clearAllMocks();
});