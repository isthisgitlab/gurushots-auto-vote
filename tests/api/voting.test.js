/**
 * Simplified tests for voting.js
 *
 * Tests the vote images fetching and submission functionality.
 */

const {getVoteImages, submitVotes} = require('../../src/js/api/voting');

// Mock the makePostRequest function
jest.mock('../../src/js/api/api-client', () => ({
    makePostRequest: jest.fn(),
    FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded',
    createCommonHeaders: jest.fn(() => ({'x-token': 'test-token'}))
}));

// Mock the logger module
jest.mock('../../src/js/logger', () => ({
    info: jest.fn(),
    warning: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    startOperation: jest.fn(() => 'mock-operation-id'),
    endOperation: jest.fn(),
}));

// Mock the metadata module
jest.mock('../../src/js/metadata', () => ({
    updateChallengeVoteMetadata: jest.fn(() => true),
}));

const {makePostRequest, createCommonHeaders} = require('../../src/js/api/api-client');
const logger = require('../../src/js/logger');
const { updateChallengeVoteMetadata } = require('../../src/js/metadata');

describe('voting', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('getVoteImages', () => {
        test('should fetch vote images successfully', async () => {
            const mockChallenge = {title: 'Test Challenge', url: 'test-url'};
            const mockToken = 'test-token';
            const mockResponse = {
                images: [{id: 'img1', ratio: 25}, {id: 'img2', ratio: 30}]
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
            const mockChallenge = {title: 'Test Challenge', url: 'test-url'};
            const mockToken = 'test-token';
            const mockResponse = {images: []};

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await getVoteImages(mockChallenge, mockToken);

            expect(result).toBeNull();
        });
    });

    describe('submitVotes', () => {
        test('should submit votes successfully', async () => {
            const mockVoteImages = {
                challenge: {id: '123', title: 'Test Challenge'},
                voting: {exposure: {exposure_factor: 50}},
                images: [
                    {id: 'img1', ratio: 25},
                    {id: 'img2', ratio: 30},
                    {id: 'img3', ratio: 20}
                ]
            };
            const mockToken = 'test-token';
            const mockResponse = {success: true};

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
                challenge: {id: '123', title: 'Test Challenge'},
                voting: {exposure: {exposure_factor: 50}},
                images: []
            };
            const mockToken = 'test-token';

            const result = await submitVotes(mockVoteImages, mockToken);

            expect(result).toBeUndefined();
        });

        test('should use custom exposure threshold instead of hardcoded 100', async () => {
            const mockVoteImages = {
                challenge: {id: '123', title: 'Test Challenge'},
                voting: {exposure: {exposure_factor: 50}},
                images: [
                    {id: 'img1', ratio: 25},
                    {id: 'img2', ratio: 30},
                    {id: 'img3', ratio: 20}
                ]
            };
            const mockToken = 'test-token';
            const customThreshold = 75; // Custom threshold instead of 100
            const mockResponse = {success: true};

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
                challenge: {id: '123', title: 'Test Challenge'},
                voting: {exposure: {exposure_factor: 50}},
                images: [
                    {id: 'img1', ratio: 25},
                    {id: 'img2', ratio: 30}
                ]
            };
            const mockToken = 'test-token';
            const mockResponse = {success: true};

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

        test('should handle insufficient images for target exposure', async () => {
            const mockVoteImages = {
                challenge: {id: '123', title: 'Test Challenge'},
                voting: {exposure: {exposure_factor: 50}},
                images: [
                    {id: 'img1', ratio: 10} // Only one small image available
                ]
            };
            const mockToken = 'test-token';
            const mockResponse = {success: true};
            const targetThreshold = 100; // High threshold that can't be reached

            makePostRequest.mockResolvedValueOnce(mockResponse);

            const result = await submitVotes(mockVoteImages, mockToken, targetThreshold);

            // Should log warning about insufficient images
            expect(logger.warning).toHaveBeenCalledWith(
                expect.stringContaining('Insufficient images to reach 100% exposure for Test Challenge (only 1 images available)')
            );
            expect(result).toEqual(mockResponse);
        });

        test('should handle vote submission failure', async () => {
            const mockVoteImages = {
                challenge: {id: '123', title: 'Test Challenge'},
                voting: {exposure: {exposure_factor: 50}},
                images: [
                    {id: 'img1', ratio: 25}
                ]
            };
            const mockToken = 'test-token';

            makePostRequest.mockResolvedValueOnce(null); // Simulate failure

            const result = await submitVotes(mockVoteImages, mockToken);

            expect(logger.endOperation).toHaveBeenCalledWith(expect.any(String), null, 'Vote submission failed');
            expect(result).toBeUndefined();
        });

        test('should handle metadata update failure', async () => {
            const mockVoteImages = {
                challenge: {id: '123', title: 'Test Challenge'},
                voting: {exposure: {exposure_factor: 50}},
                images: [
                    {id: 'img1', ratio: 25}
                ]
            };
            const mockToken = 'test-token';
            const mockResponse = {success: true};

            makePostRequest.mockResolvedValueOnce(mockResponse);
            updateChallengeVoteMetadata.mockReturnValueOnce(false); // Simulate metadata update failure

            const result = await submitVotes(mockVoteImages, mockToken);

            expect(logger.debug).toHaveBeenCalledWith('🔧 DEBUG: Failed to update metadata for challenge 123');
            expect(logger.warning).toHaveBeenCalledWith('Failed to update metadata for challenge 123');
            expect(result).toEqual(mockResponse);
        });

        test('should handle metadata update error exception', async () => {
            const mockVoteImages = {
                challenge: {id: '123', title: 'Test Challenge'},
                voting: {exposure: {exposure_factor: 50}},
                images: [
                    {id: 'img1', ratio: 25}
                ]
            };
            const mockToken = 'test-token';
            const mockResponse = {success: true};
            const mockError = new Error('Metadata update error');

            makePostRequest.mockResolvedValueOnce(mockResponse);
            updateChallengeVoteMetadata.mockImplementationOnce(() => {
                throw mockError;
            });

            const result = await submitVotes(mockVoteImages, mockToken);

            expect(logger.debug).toHaveBeenCalledWith('🔧 DEBUG: Error updating metadata for challenge 123:', mockError);
            expect(logger.warning).toHaveBeenCalledWith('Error updating metadata for challenge 123:', mockError);
            expect(result).toEqual(mockResponse);
        });
    });
});