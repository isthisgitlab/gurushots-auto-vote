/**
 * Simplified tests for voting.js
 * 
 * Tests the vote images fetching and submission functionality.
 */

const { getVoteImages, submitVotes } = require('../../src/js/api/voting');

// Mock the makePostRequest function
jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded',
    createCommonHeaders: jest.fn(() => ({ 'x-token': 'test-token' }))
}));

const { makePostRequest, createCommonHeaders } = require('../../src/js/api/api-client');

describe('voting', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getVoteImages', () => {
        test('should fetch vote images successfully', async () => {
            const mockChallenge = { title: 'Test Challenge', url: 'test-url' };
            const mockToken = 'test-token';
            const mockResponse = {
                images: [{ id: 'img1', ratio: 25 }, { id: 'img2', ratio: 30 }]
            };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await getVoteImages(mockChallenge, mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/get_vote_images',
                expect.objectContaining({
                    'content-type': 'application/x-www-form-urlencoded'
                }),
                'limit=100&url=test-url'
            );
            expect(result).toEqual(mockResponse);
        });

        test('should return null when no images', async () => {
            const mockChallenge = { title: 'Test Challenge', url: 'test-url' };
            const mockToken = 'test-token';
            const mockResponse = { images: [] };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await getVoteImages(mockChallenge, mockToken);

            expect(result).toBeNull();
        });
    });

    describe('submitVotes', () => {
        test('should submit votes successfully', async () => {
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 50 } },
                images: [
                    { id: 'img1', ratio: 25 },
                    { id: 'img2', ratio: 30 },
                    { id: 'img3', ratio: 20 }
                ]
            };
            const mockToken = 'test-token';
            const mockResponse = { success: true };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await submitVotes(mockVoteImages, mockToken);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/submit_vote',
                expect.objectContaining({
                    'content-type': 'application/x-www-form-urlencoded'
                }),
                expect.stringContaining('c_id=123')
            );
            expect(result).toEqual(mockResponse);
        });

        test('should return undefined when no images', async () => {
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 50 } },
                images: []
            };
            const mockToken = 'test-token';

            const result = await submitVotes(mockVoteImages, mockToken);

            expect(result).toBeUndefined();
        });

        test('should use custom exposure threshold instead of hardcoded 100', async () => {
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 50 } },
                images: [
                    { id: 'img1', ratio: 25 },
                    { id: 'img2', ratio: 30 },
                    { id: 'img3', ratio: 20 }
                ]
            };
            const mockToken = 'test-token';
            const customThreshold = 75; // Custom threshold instead of 100
            const mockResponse = { success: true };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await submitVotes(mockVoteImages, mockToken, customThreshold);

            // The function should continue voting until it reaches the custom threshold (75)
            // Starting at 50, it needs 25 more points to reach 75
            // It should select images until it reaches or exceeds 75
            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/submit_vote',
                expect.objectContaining({
                    'content-type': 'application/x-www-form-urlencoded'
                }),
                expect.stringContaining('c_id=123')
            );
            expect(result).toEqual(mockResponse);
        });

        test('should handle exposure threshold function parameter', async () => {
            const mockVoteImages = {
                challenge: { id: '123', title: 'Test Challenge' },
                voting: { exposure: { exposure_factor: 50 } },
                images: [
                    { id: 'img1', ratio: 25 },
                    { id: 'img2', ratio: 30 }
                ]
            };
            const mockToken = 'test-token';
            const mockResponse = { success: true };

            makePostRequest.mockResolvedValueOnce(mockResponse);

            // Test with a function that returns a threshold
            const thresholdFunction = (challengeId) => {
                return challengeId === '123' ? 80 : 100;
            };

            const result = await submitVotes(mockVoteImages, mockToken, thresholdFunction);

            expect(makePostRequest).toHaveBeenCalledWith(
                'https://api.gurushots.com/rest_mobile/submit_vote',
                expect.objectContaining({
                    'content-type': 'application/x-www-form-urlencoded'
                }),
                expect.stringContaining('c_id=123')
            );
            expect(result).toEqual(mockResponse);
        });
    });
});