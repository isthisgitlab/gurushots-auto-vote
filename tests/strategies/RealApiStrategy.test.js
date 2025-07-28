/**
 * Tests for RealApiStrategy.js
 * 
 * Tests the real API strategy implementation.
 */

const RealApiStrategy = require('../../src/js/strategies/RealApiStrategy');

// Mock all the API modules
jest.mock('../../src/js/api/login', () => ({
  authenticate: jest.fn(),
}));

jest.mock('../../src/js/api/main', () => ({
  fetchChallengesAndVote: jest.fn(),
}));

jest.mock('../../src/js/api/challenges', () => ({
  getActiveChallenges: jest.fn(),
}));

jest.mock('../../src/js/api/voting', () => ({
  getVoteImages: jest.fn(),
  submitVotes: jest.fn(),
}));

jest.mock('../../src/js/api/boost', () => ({
  applyBoost: jest.fn(),
  applyBoostToEntry: jest.fn(),
}));

describe('RealApiStrategy', () => {
  let realApiStrategy;
  
  // Import mocked modules
  const { authenticate } = require('../../src/js/api/login');
  const { fetchChallengesAndVote } = require('../../src/js/api/main');
  const { getActiveChallenges } = require('../../src/js/api/challenges');
  const { getVoteImages, submitVotes } = require('../../src/js/api/voting');
  const { applyBoost, applyBoostToEntry } = require('../../src/js/api/boost');

  beforeEach(() => {
    realApiStrategy = new RealApiStrategy();
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    test('should create instance correctly', () => {
      expect(realApiStrategy).toBeInstanceOf(RealApiStrategy);
    });
  });

  describe('getStrategyType', () => {
    test('should return correct strategy type', () => {
      const result = realApiStrategy.getStrategyType();
      expect(result).toBe('RealAPI');
    });
  });

  describe('authenticate', () => {
    test('should delegate to real authenticate function', async () => {
      const mockEmail = 'test@example.com';
      const mockPassword = 'password123';
      const mockResponse = { token: 'real-token', success: true };

      authenticate.mockResolvedValueOnce(mockResponse);

      const result = await realApiStrategy.authenticate(mockEmail, mockPassword);

      expect(authenticate).toHaveBeenCalledWith(mockEmail, mockPassword);
      expect(result).toEqual(mockResponse);
    });

    test('should handle authentication errors', async () => {
      const mockError = new Error('Authentication failed');
      authenticate.mockRejectedValueOnce(mockError);

      await expect(realApiStrategy.authenticate('test@example.com', 'wrongpassword'))
        .rejects.toThrow('Authentication failed');
      
      expect(authenticate).toHaveBeenCalledWith('test@example.com', 'wrongpassword');
    });

    test('should return null for failed authentication', async () => {
      authenticate.mockResolvedValueOnce(null);

      const result = await realApiStrategy.authenticate('test@example.com', 'wrongpassword');

      expect(result).toBeNull();
      expect(authenticate).toHaveBeenCalledWith('test@example.com', 'wrongpassword');
    });
  });

  describe('getActiveChallenges', () => {
    test('should delegate to real getActiveChallenges function', async () => {
      const mockToken = 'test-token-123';
      const mockResponse = { 
        challenges: [
          { id: '1', title: 'Challenge 1' },
          { id: '2', title: 'Challenge 2' }
        ]
      };

      getActiveChallenges.mockResolvedValueOnce(mockResponse);

      const result = await realApiStrategy.getActiveChallenges(mockToken);

      expect(getActiveChallenges).toHaveBeenCalledWith(mockToken);
      expect(result).toEqual(mockResponse);
    });

    test('should handle getActiveChallenges errors', async () => {
      const mockError = new Error('Failed to get challenges');
      getActiveChallenges.mockRejectedValueOnce(mockError);

      await expect(realApiStrategy.getActiveChallenges('invalid-token'))
        .rejects.toThrow('Failed to get challenges');
      
      expect(getActiveChallenges).toHaveBeenCalledWith('invalid-token');
    });
  });

  describe('getVoteImages', () => {
    test('should delegate to real getVoteImages function', async () => {
      const mockChallenge = { id: '123', title: 'Test Challenge', url: 'challenge-url' };
      const mockToken = 'test-token-123';
      const mockResponse = {
        images: [
          { id: 'img1', ratio: 10 },
          { id: 'img2', ratio: 15 }
        ]
      };

      getVoteImages.mockResolvedValueOnce(mockResponse);

      const result = await realApiStrategy.getVoteImages(mockChallenge, mockToken);

      expect(getVoteImages).toHaveBeenCalledWith(mockChallenge, mockToken);
      expect(result).toEqual(mockResponse);
    });

    test('should handle getVoteImages errors', async () => {
      const mockError = new Error('Failed to get vote images');
      getVoteImages.mockRejectedValueOnce(mockError);

      const mockChallenge = { id: '123', title: 'Test Challenge' };
      
      await expect(realApiStrategy.getVoteImages(mockChallenge, 'invalid-token'))
        .rejects.toThrow('Failed to get vote images');
      
      expect(getVoteImages).toHaveBeenCalledWith(mockChallenge, 'invalid-token');
    });

    test('should return null when no images available', async () => {
      getVoteImages.mockResolvedValueOnce(null);

      const mockChallenge = { id: '123', title: 'Test Challenge' };
      const result = await realApiStrategy.getVoteImages(mockChallenge, 'test-token');

      expect(result).toBeNull();
      expect(getVoteImages).toHaveBeenCalledWith(mockChallenge, 'test-token');
    });
  });

  describe('submitVotes', () => {
    test('should delegate to real submitVotes function', async () => {
      const mockVoteImages = {
        challenge: { id: '123', title: 'Test Challenge' },
        images: [{ id: 'img1', ratio: 25 }]
      };
      const mockToken = 'test-token-123';
      const mockResponse = { success: true, votes_submitted: 5 };

      submitVotes.mockResolvedValueOnce(mockResponse);

      const result = await realApiStrategy.submitVotes(mockVoteImages, mockToken);

      expect(submitVotes).toHaveBeenCalledWith(mockVoteImages, mockToken);
      expect(result).toEqual(mockResponse);
    });

    test('should handle submitVotes errors', async () => {
      const mockError = new Error('Failed to submit votes');
      submitVotes.mockRejectedValueOnce(mockError);

      const mockVoteImages = { images: [] };
      
      await expect(realApiStrategy.submitVotes(mockVoteImages, 'invalid-token'))
        .rejects.toThrow('Failed to submit votes');
      
      expect(submitVotes).toHaveBeenCalledWith(mockVoteImages, 'invalid-token');
    });
  });

  describe('applyBoost', () => {
    test('should delegate to real applyBoost function', async () => {
      const mockChallenge = { 
        id: '123', 
        title: 'Test Challenge',
        member: { boost: { state: 'AVAILABLE' } }
      };
      const mockToken = 'test-token-123';
      const mockResponse = { success: true, boost_applied: true };

      applyBoost.mockResolvedValueOnce(mockResponse);

      const result = await realApiStrategy.applyBoost(mockChallenge, mockToken);

      expect(applyBoost).toHaveBeenCalledWith(mockChallenge, mockToken);
      expect(result).toEqual(mockResponse);
    });

    test('should handle applyBoost errors', async () => {
      const mockError = new Error('Failed to apply boost');
      applyBoost.mockRejectedValueOnce(mockError);

      const mockChallenge = { id: '123', title: 'Test Challenge' };
      
      await expect(realApiStrategy.applyBoost(mockChallenge, 'invalid-token'))
        .rejects.toThrow('Failed to apply boost');
      
      expect(applyBoost).toHaveBeenCalledWith(mockChallenge, 'invalid-token');
    });

    test('should return null when boost cannot be applied', async () => {
      applyBoost.mockResolvedValueOnce(null);

      const mockChallenge = { id: '123', title: 'Test Challenge' };
      const result = await realApiStrategy.applyBoost(mockChallenge, 'test-token');

      expect(result).toBeNull();
      expect(applyBoost).toHaveBeenCalledWith(mockChallenge, 'test-token');
    });
  });

  describe('applyBoostToEntry', () => {
    test('should delegate to real applyBoostToEntry function', async () => {
      const mockChallengeId = '123';
      const mockImageId = 'img456';
      const mockToken = 'test-token-123';
      const mockResponse = { success: true, boost_applied: true };

      applyBoostToEntry.mockResolvedValueOnce(mockResponse);

      const result = await realApiStrategy.applyBoostToEntry(mockChallengeId, mockImageId, mockToken);

      expect(applyBoostToEntry).toHaveBeenCalledWith(mockChallengeId, mockImageId, mockToken);
      expect(result).toEqual(mockResponse);
    });

    test('should handle applyBoostToEntry errors', async () => {
      const mockError = new Error('Failed to apply boost to entry');
      applyBoostToEntry.mockRejectedValueOnce(mockError);
      
      await expect(realApiStrategy.applyBoostToEntry('123', 'img456', 'invalid-token'))
        .rejects.toThrow('Failed to apply boost to entry');
      
      expect(applyBoostToEntry).toHaveBeenCalledWith('123', 'img456', 'invalid-token');
    });

    test('should return null when boost cannot be applied to entry', async () => {
      applyBoostToEntry.mockResolvedValueOnce(null);

      const result = await realApiStrategy.applyBoostToEntry('123', 'img456', 'test-token');

      expect(result).toBeNull();
      expect(applyBoostToEntry).toHaveBeenCalledWith('123', 'img456', 'test-token');
    });
  });

  describe('fetchChallengesAndVote', () => {
    test('should delegate to real fetchChallengesAndVote function', async () => {
      const mockToken = 'test-token-123';
      const mockResponse = { success: true, challenges_processed: 3 };

      fetchChallengesAndVote.mockResolvedValueOnce(mockResponse);

      const result = await realApiStrategy.fetchChallengesAndVote(mockToken);

      expect(fetchChallengesAndVote).toHaveBeenCalledWith(mockToken);
      expect(result).toEqual(mockResponse);
    });

    test('should handle fetchChallengesAndVote errors', async () => {
      const mockError = new Error('Failed to fetch challenges and vote');
      fetchChallengesAndVote.mockRejectedValueOnce(mockError);
      
      await expect(realApiStrategy.fetchChallengesAndVote('invalid-token'))
        .rejects.toThrow('Failed to fetch challenges and vote');
      
      expect(fetchChallengesAndVote).toHaveBeenCalledWith('invalid-token');
    });
  });
});