/**
 * Tests for challenges.js
 *
 * Tests the active challenges fetching functionality.
 */

const { getActiveChallenges } = require('../../src/js/api/challenges');

// Mock the api-client module
jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    createCommonHeaders: jest.fn((token) => ({
        'x-token': token || 'mock-token',
        'user-agent': 'GuruShots/1.0 (iPhone; iOS 16.0; en_US)',
        accept: 'application/json',
    })),
}));

// Mock the title-pin module as an identity pass-through so this file keeps
// testing fetch/coalescing behavior in isolation (pin behavior is unit-tested
// in tests/services/challengeTitlePin.test.js). Wiring is still asserted:
// success responses must reach the pin hook, failed fetches must not.
jest.mock('../../src/js/services/challengeTitlePin', () => ({
    pinChallengeTitles: jest.fn((challenges) => challenges),
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
    const { makePostRequest, createCommonHeaders } = require('../../src/js/api/api-client');
    const { pinChallengeTitles } = require('../../src/js/services/challengeTitlePin');
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
                                exposure: { exposure_factor: 75 },
                            },
                            boost: { state: 'AVAILABLE' },
                        },
                    },
                    {
                        id: '67890',
                        title: 'Test Challenge 2',
                        url: 'challenge-2-url',
                        member: {
                            ranking: {
                                exposure: { exposure_factor: 100 },
                            },
                            boost: { state: 'USED' },
                        },
                    },
                ],
            };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await getActiveChallenges(mockToken);

            expect(createCommonHeaders).toHaveBeenCalledWith(mockToken);
            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/get_my_active_challenges',
                expect.objectContaining({
                    'x-token': mockToken,
                    'user-agent': expect.stringContaining('GuruShots'),
                    accept: 'application/json',
                }),
            );

            expect(result).toEqual(mockResponse);
            // Positive wiring: the fetched list must pass through the pin hook
            // (the identity mock would hide a dropped or mis-arged call).
            expect(pinChallengeTitles).toHaveBeenCalledWith(mockResponse.challenges);
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
            const mockResponse = { challenges: [] };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            await getActiveChallenges(shortToken);

            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockDebugFn).toHaveBeenCalledWith('Requesting active challenges from API', {
                hasToken: true,
                tokenPrefix: 'short...',
            });
        });

        test('should handle missing token', async () => {
            const mockResponse = { challenges: [] };

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

            expect(result).toEqual({ challenges: [] });
            // The logger module handles the error message, not console.error
        });

        test('should log response structure details', async () => {
            const mockResponse = {
                challenges: [
                    { id: '1', title: 'Challenge 1' },
                    { id: '2', title: 'Challenge 2' },
                ],
                other_field: 'test',
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
                other_field: 'test',
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

            expect(result).toEqual({ challenges: [] });
            // The logger module handles the error message, not console.error
        });

        test('failed fetch never reaches the title-pin hook', async () => {
            makePostRequest.mockResolvedValueOnce(null);

            const result = await getActiveChallenges(mockToken);

            expect(result).toEqual({ challenges: [] });
            // The early return on a failed request must keep the pin/prune
            // logic from ever seeing the synthetic empty payload.
            expect(pinChallengeTitles).not.toHaveBeenCalled();
        });

        test('should handle falsy response object', async () => {
            // Test with false (which is falsy but not null/undefined)
            makePostRequest.mockResolvedValueOnce(false);

            const result = await getActiveChallenges(mockToken);

            expect(result).toEqual({ challenges: [] });
            expect(logger.withCategory).toHaveBeenCalledWith('api');
            expect(logger.__mockEndOperationFn).toHaveBeenCalledWith(expect.any(String), null, 'API request failed');
        });

        test('coalesces concurrent calls for the same token into a single request', async () => {
            let resolveRequest;
            makePostRequest.mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveRequest = resolve;
                }),
            );

            // Two callers fire while the request is still in flight (the
            // post-cycle UI refresh + the scheduler's window re-check).
            const first = getActiveChallenges(mockToken);
            const second = getActiveChallenges(mockToken);

            expect(first).toBe(second); // same in-flight promise shared

            resolveRequest({ challenges: [{ id: '1' }] });
            const [r1, r2] = await Promise.all([first, second]);

            expect(makePostRequest).toHaveBeenCalledTimes(1);
            expect(r1).toEqual({ challenges: [{ id: '1' }] });
            expect(r2).toBe(r1);
        });

        test('does not coalesce sequential calls (no stale caching)', async () => {
            makePostRequest
                .mockResolvedValueOnce({ challenges: [] })
                .mockResolvedValueOnce({ challenges: [{ id: '2' }] });

            await getActiveChallenges(mockToken);
            const second = await getActiveChallenges(mockToken);

            expect(makePostRequest).toHaveBeenCalledTimes(2);
            expect(second).toEqual({ challenges: [{ id: '2' }] });
        });

        test('should truncate long tokens in logs', async () => {
            const longToken = 'very-long-token-that-should-be-truncated-for-security';
            const mockResponse = { challenges: [] };

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
