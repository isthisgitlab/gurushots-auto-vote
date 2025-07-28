/**
 * Simplified tests for voting.js
 * 
 * Tests the vote images fetching and submission functionality.
 */

const { getVoteImages, submitVotes } = require('../../src/js/api/voting');

// Mock the api-client module
jest.mock('../../src/js/api/api-client', () => ({
  makePostRequest: jest.fn(),
  createCommonHeaders: jest.fn((token) => ({
    'x-token': token || 'mock-token',
    'user-agent': 'GuruShots/1.0 (iPhone; iOS 16.0; en_US)',
    'accept': 'application/json',
  })),
  FORM_CONTENT_TYPE: 'application/x-www-form-urlencoded; charset=utf-8'
}));

// Mock console methods
jest.spyOn(console, 'log').mockImplementation();
jest.spyOn(console, 'warn').mockImplementation();
jest.spyOn(console, 'error').mockImplementation();

describe('voting', () => {
  const mockToken = 'test-token-123';
  const { makePostRequest, createCommonHeaders } = require('../../src/js/api/api-client');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getVoteImages', () => {
    const mockChallenge = {
      id: '12345',
      title: 'Test Challenge',
      url: 'challenge-test-url'
    };

    test('should fetch vote images successfully', async () => {
      const mockResponse = {
        images: [
          { id: 'img1', ratio: 10 },
          { id: 'img2', ratio: 15 }
        ]
      };

      makePostRequest.mockResolvedValueOnce(mockResponse);

      const result = await getVoteImages(mockChallenge, mockToken);

      expect(result).toEqual(mockResponse);
      expect(makePostRequest).toHaveBeenCalledWith(
        'https://api.gurushots.com/rest_mobile/get_vote_images',
        expect.objectContaining({
          'x-token': mockToken,
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
        }),
        'limit=100&url=challenge-test-url'
      );
    });

    test('should return null when no images', async () => {
      const mockResponse = { images: [] };
      makePostRequest.mockResolvedValueOnce(mockResponse);

      const result = await getVoteImages(mockChallenge, mockToken);

      expect(result).toBeNull();
    });
  });

  describe('submitVotes', () => {
    test('should submit votes successfully', async () => {
      const mockVoteImages = {
        challenge: { id: '12345', title: 'Test Challenge' },
        voting: { exposure: { exposure_factor: 90 } },
        images: [{ id: 'img1', ratio: 15 }]
      };

      const mockResponse = { success: true };
      makePostRequest.mockResolvedValueOnce(mockResponse);

      // Mock Math.random for predictable result
      jest.spyOn(Math, 'random').mockReturnValue(0);

      const result = await submitVotes(mockVoteImages, mockToken);

      expect(result).toEqual(mockResponse);
      
      Math.random.mockRestore();
    });

    test('should return undefined when no images', async () => {
      const mockVoteImages = {
        challenge: { id: '12345', title: 'Test Challenge' },
        voting: { exposure: { exposure_factor: 50 } },
        images: []
      };

      const result = await submitVotes(mockVoteImages, mockToken);

      expect(result).toBeUndefined();
      expect(makePostRequest).not.toHaveBeenCalled();
    });
  });
});