/**
 * Tests for MockApiStrategy.js
 *
 * Tests the mock API strategy implementation.
 */

const MockApiStrategy = require('../../src/js/strategies/MockApiStrategy');
const {mockApiClient} = require('../../src/js/mock');
const settings = require('../../src/js/settings');

// Mock the mock api-client
jest.mock('../../src/js/mock', () => ({
    mockApiClient: {
        authenticate: jest.fn(),
        getActiveChallenges: jest.fn(),
        getVoteImages: jest.fn(),
        submitVotes: jest.fn(),
        applyBoost: jest.fn(),
        applyBoostToEntry: jest.fn(),
        fetchChallengesAndVote: jest.fn(),
    }
}));

// Mock logger
jest.mock('../../src/js/logger', () => ({
    info: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    debug: jest.fn(),
}));

describe('MockApiStrategy', () => {
    let mockApiStrategy;
    const {mockApiClient} = require('../../src/js/mock');
    const mockLogger = require('../../src/js/logger');

    beforeEach(() => {
        mockApiStrategy = new MockApiStrategy();
        jest.clearAllMocks();
    });

    describe('constructor', () => {
        test('should create instance correctly', () => {
            expect(mockApiStrategy).toBeInstanceOf(MockApiStrategy);
        });
    });

    describe('getStrategyType', () => {
        test('should return correct strategy type', () => {
            const result = mockApiStrategy.getStrategyType();
            expect(result).toBe('MockAPI');
        });
    });

    describe('authenticate', () => {
        test('should call mock authenticate with correct parameters', async () => {
            const mockEmail = 'test@example.com';
            const mockPassword = 'password123';
            const mockResponse = {token: 'mock-token', success: true};

            mockApiClient.authenticate.mockResolvedValueOnce(mockResponse);

            const result = await mockApiStrategy.authenticate(mockEmail, mockPassword);

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock authentication');
            expect(mockApiClient.authenticate).toHaveBeenCalledWith(mockEmail, mockPassword);
            expect(result).toEqual(mockResponse);
        });

        test('should handle authentication errors', async () => {
            const mockError = new Error('Authentication failed');
            mockApiClient.authenticate.mockRejectedValueOnce(mockError);

            await expect(mockApiStrategy.authenticate('test@example.com', 'wrongpassword'))
                .rejects.toThrow('Authentication failed');

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock authentication');
            expect(mockApiClient.authenticate).toHaveBeenCalledWith('test@example.com', 'wrongpassword');
        });
    });

    describe('getActiveChallenges', () => {
        test('should call mock getActiveChallenges with correct parameters', async () => {
            const mockToken = 'test-token-123';
            const mockResponse = {
                challenges: [
                    {id: '1', title: 'Challenge 1'},
                    {id: '2', title: 'Challenge 2'}
                ]
            };

            mockApiClient.getActiveChallenges.mockResolvedValueOnce(mockResponse);

            const result = await mockApiStrategy.getActiveChallenges(mockToken);

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock getActiveChallenges');
            expect(mockApiClient.getActiveChallenges).toHaveBeenCalledWith(mockToken);
            expect(result).toEqual(mockResponse);
        });

        test('should handle getActiveChallenges errors', async () => {
            const mockError = new Error('Failed to get challenges');
            mockApiClient.getActiveChallenges.mockRejectedValueOnce(mockError);

            await expect(mockApiStrategy.getActiveChallenges('invalid-token'))
                .rejects.toThrow('Failed to get challenges');

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock getActiveChallenges');
            expect(mockApiClient.getActiveChallenges).toHaveBeenCalledWith('invalid-token');
        });
    });

    describe('getVoteImages', () => {
        test('should call mock getVoteImages with correct parameters', async () => {
            const mockChallenge = {id: '123', title: 'Test Challenge', url: 'challenge-url'};
            const mockToken = 'test-token-123';
            const mockResponse = {
                images: [
                    {id: 'img1', ratio: 10},
                    {id: 'img2', ratio: 15}
                ]
            };

            mockApiClient.getVoteImages.mockResolvedValueOnce(mockResponse);

            const result = await mockApiStrategy.getVoteImages(mockChallenge, mockToken);

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock getVoteImages');
            expect(mockApiClient.getVoteImages).toHaveBeenCalledWith(mockChallenge, mockToken);
            expect(result).toEqual(mockResponse);
        });

        test('should handle getVoteImages errors', async () => {
            const mockError = new Error('Failed to get vote images');
            mockApiClient.getVoteImages.mockRejectedValueOnce(mockError);

            const mockChallenge = {id: '123', title: 'Test Challenge'};

            await expect(mockApiStrategy.getVoteImages(mockChallenge, 'invalid-token'))
                .rejects.toThrow('Failed to get vote images');

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock getVoteImages');
            expect(mockApiClient.getVoteImages).toHaveBeenCalledWith(mockChallenge, 'invalid-token');
        });
    });

    describe('submitVotes', () => {
        test('should call mock submitVotes with correct parameters', async () => {
            const mockVoteImages = {
                challenge: {id: '123', title: 'Test Challenge'},
                images: [{id: 'img1', ratio: 25}]
            };
            const mockToken = 'test-token-123';
            const mockResponse = {success: true};

            mockApiClient.submitVotes.mockResolvedValueOnce(mockResponse);

            const result = await mockApiStrategy.submitVotes(mockVoteImages, mockToken);

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock submitVotes');
            expect(mockApiClient.submitVotes).toHaveBeenCalledWith(mockVoteImages, mockToken, settings.SETTINGS_SCHEMA.exposure.default);
            expect(result).toEqual(mockResponse);
        });

        test('should handle submitVotes errors', async () => {
            const mockVoteImages = {images: []};
            const mockError = new Error('Failed to submit votes');

            mockApiClient.submitVotes.mockRejectedValueOnce(mockError);

            await expect(mockApiStrategy.submitVotes(mockVoteImages, 'invalid-token'))
                .rejects.toThrow('Failed to submit votes');

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock submitVotes');
            expect(mockApiClient.submitVotes).toHaveBeenCalledWith(mockVoteImages, 'invalid-token', settings.SETTINGS_SCHEMA.exposure.default);
        });
    });

    describe('applyBoost', () => {
        test('should call mock applyBoost with correct parameters', async () => {
            const mockChallenge = {
                id: '123',
                title: 'Test Challenge',
                member: {boost: {state: 'AVAILABLE'}}
            };
            const mockToken = 'test-token-123';
            const mockResponse = {success: true, boost_applied: true};

            mockApiClient.applyBoost.mockResolvedValueOnce(mockResponse);

            const result = await mockApiStrategy.applyBoost(mockChallenge, mockToken);

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock applyBoost');
            expect(mockApiClient.applyBoost).toHaveBeenCalledWith(mockChallenge, mockToken);
            expect(result).toEqual(mockResponse);
        });

        test('should handle applyBoost errors', async () => {
            const mockError = new Error('Failed to apply boost');
            mockApiClient.applyBoost.mockRejectedValueOnce(mockError);

            const mockChallenge = {id: '123', title: 'Test Challenge'};

            await expect(mockApiStrategy.applyBoost(mockChallenge, 'invalid-token'))
                .rejects.toThrow('Failed to apply boost');

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock applyBoost');
            expect(mockApiClient.applyBoost).toHaveBeenCalledWith(mockChallenge, 'invalid-token');
        });
    });

    describe('applyBoostToEntry', () => {
        test('should call mock applyBoostToEntry with correct parameters', async () => {
            const mockChallengeId = '123';
            const mockImageId = 'img456';
            const mockToken = 'test-token-123';
            const mockResponse = {success: true, boost_applied: true};

            mockApiClient.applyBoostToEntry.mockResolvedValueOnce(mockResponse);

            const result = await mockApiStrategy.applyBoostToEntry(mockChallengeId, mockImageId, mockToken);

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock applyBoostToEntry');
            expect(mockApiClient.applyBoostToEntry).toHaveBeenCalledWith(mockChallengeId, mockImageId, mockToken);
            expect(result).toEqual(mockResponse);
        });

        test('should handle applyBoostToEntry errors', async () => {
            const mockError = new Error('Failed to apply boost to entry');
            mockApiClient.applyBoostToEntry.mockRejectedValueOnce(mockError);

            await expect(mockApiStrategy.applyBoostToEntry('123', 'img456', 'invalid-token'))
                .rejects.toThrow('Failed to apply boost to entry');

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock applyBoostToEntry');
            expect(mockApiClient.applyBoostToEntry).toHaveBeenCalledWith('123', 'img456', 'invalid-token');
        });
    });

    describe('fetchChallengesAndVote', () => {
        test('should call mock fetchChallengesAndVote with correct parameters', async () => {
            const mockToken = 'test-token-123';
            const mockResponse = {success: true, message: 'Voting completed'};

            mockApiClient.fetchChallengesAndVote.mockResolvedValueOnce(mockResponse);

            const result = await mockApiStrategy.fetchChallengesAndVote(mockToken);

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock fetchChallengesAndVote');
            expect(mockApiClient.fetchChallengesAndVote).toHaveBeenCalledWith(mockToken, settings.SETTINGS_SCHEMA.exposure.default);
            expect(result).toEqual(mockResponse);
        });

        test('should handle fetchChallengesAndVote errors', async () => {
            const mockError = new Error('Failed to fetch challenges and vote');

            mockApiClient.fetchChallengesAndVote.mockRejectedValueOnce(mockError);

            await expect(mockApiStrategy.fetchChallengesAndVote('invalid-token'))
                .rejects.toThrow('Failed to fetch challenges and vote');

            expect(mockLogger.debug).toHaveBeenCalledWith('🔧 Using mock fetchChallengesAndVote');
            expect(mockApiClient.fetchChallengesAndVote).toHaveBeenCalledWith('invalid-token', settings.SETTINGS_SCHEMA.exposure.default);
        });
    });
});