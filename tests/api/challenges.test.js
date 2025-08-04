/**
 * Tests for challenges.js
 *
 * Tests the active challenges fetching functionality.
 */

const {getActiveChallenges} = require('../../src/js/api/challenges');

// Mock the api-client module
jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    createCommonHeaders: jest.fn((token) => ({
        'x-token': token || 'mock-token',
        'user-agent': 'GuruShots/1.0 (iPhone; iOS 16.0; en_US)',
        'accept': 'application/json',
    }))
}));

// Mock the logger module
jest.mock('../../src/js/logger', () => {
    const mockDebugFn = jest.fn();
    const mockEndOperationFn = jest.fn();
    
    return {
        debug: jest.fn(),
        error: jest.fn(),
        startOperation: jest.fn(),
        endOperation: jest.fn(),
        withCategory: jest.fn(() => ({
            info: jest.fn(),
            error: jest.fn(),
            debug: mockDebugFn,
            success: jest.fn(),
            warning: jest.fn(),
            api: jest.fn(),
            apiRequest: jest.fn(),
            startOperation: jest.fn(),
            endOperation: mockEndOperationFn,
            progress: jest.fn(),
        })),
        // Export the mock functions for testing
        __mockDebugFn: mockDebugFn,
        __mockEndOperationFn: mockEndOperationFn,
    };
});

describe('challenges', () => {
    const mockToken = 'test-token-123';
    const {makePostRequest, createCommonHeaders} = require('../../src/js/api/api-client');
    const logger = require('../../src/js/logger');

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getActiveChallenges', () => {
        test('should fetch active challenges successfully', async () => {
            const mockResponse = {
                challenges: [
                    {
                        id: '12345',
                        title: 'Test Challenge 1',
                        url: 'challenge-1-url',
                        member: {
                            ranking: {
                                exposure: {exposure_factor: 75}
                            },
                            boost: {state: 'AVAILABLE'}
                        }
                    },
                    {
                        id: '67890',
                        title: 'Test Challenge 2',
                        url: 'challenge-2-url',
                        member: {
                            ranking: {
                                exposure: {exposure_factor: 100}
                            },
                            boost: {state: 'USED'}
                        }
                    }
                ]
            };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await getActiveChallenges(mockToken);

            expect(createCommonHeaders).toHaveBeenCalledWith(mockToken);
            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/get_my_active_challenges',
                expect.objectContaining({
                    'x-token': mockToken,
                    'user-agent': expect.stringContaining('GuruShots'),
                    'accept': 'application/json',
                })
            );

            expect(result).toEqual(mockResponse);
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Requesting active challenges from API', {
                hasToken: true,
                tokenPrefix: 'test-token...',
            });
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Active challenges response received', {
                challengeCount: 2,
                hasValidStructure: true,
                responseKeys: ['challenges'],
            });
        });

        test('should handle short token with truncation format', async () => {
            const shortToken = 'short';
            const mockResponse = {challenges: []};

            makePostRequest.mockResolvedValueOnce(mockResponse);

            await getActiveChallenges(shortToken);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Requesting active challenges from API', {
                hasToken: true,
                tokenPrefix: 'short...',
            });
        });

        test('should handle missing token', async () => {
            const mockResponse = {challenges: []};

            makePostRequest.mockResolvedValueOnce(mockResponse);

            await getActiveChallenges();

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Requesting active challenges from API', {
                hasToken: false,
                tokenPrefix: 'none',
            });
            expect(createCommonHeaders).toHaveBeenCalledWith(undefined);
        });

        test('should return empty challenges array when request fails', async () => {
            makePostRequest.mockResolvedValueOnce(null);

            const result = await getActiveChallenges(mockToken);

            expect(result).toEqual({challenges: []});
            // The logger module handles the error message, not console.error
        });

        test('should log response structure details', async () => {
            const mockResponse = {
                challenges: [
                    {id: '1', title: 'Challenge 1'},
                    {id: '2', title: 'Challenge 2'}
                ],
                other_field: 'test'
            };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            await getActiveChallenges(mockToken);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Active challenges response received', {
                challengeCount: 2,
                hasValidStructure: true,
                responseKeys: ['challenges', 'other_field'],
            });
        });

        test('should handle response without challenges array', async () => {
            const mockResponse = {
                other_field: 'test'
            };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            await getActiveChallenges(mockToken);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Active challenges response received', {
                challengeCount: 0,
                hasValidStructure: false,
                responseKeys: ['other_field'],
            });
        });

        test('should handle null response gracefully', async () => {
            makePostRequest.mockResolvedValueOnce(null);

            const result = await getActiveChallenges(mockToken);

            expect(result).toEqual({challenges: []});
            // The logger module handles the error message, not console.error
        });

        test('should handle falsy response object', async () => {
            // Test with false (which is falsy but not null/undefined)
            makePostRequest.mockResolvedValueOnce(false);

            const result = await getActiveChallenges(mockToken);

            expect(result).toEqual({challenges: []});
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockEndOperationFn).toHaveBeenCalledWith(expect.any(String), null, 'API request failed');
        });

        test('should truncate long tokens in logs', async () => {
            const longToken = 'very-long-token-that-should-be-truncated-for-security';
            const mockResponse = {challenges: []};

            makePostRequest.mockResolvedValueOnce(mockResponse);

            await getActiveChallenges(longToken);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Requesting active challenges from API', {
                hasToken: true,
                tokenPrefix: 'very-long-...',
            });
        });
    });
});