/**
 * Tests for mock/index.js
 *
 * Tests the mock data system and API client simulation.
 */

const mockIndex = require('../../src/js/mock/index');

// Mock the individual mock modules
jest.mock('../../src/js/mock/auth', () => ({
    mockLoginSuccess: {token: 'mock-auth-token', success: true},
    mockLoginFailure: {error: 'Invalid credentials', success: false}
}));

jest.mock('../../src/js/mock/challenges', () => ({
    mockActiveChallenges: {challenges: [{id: '1', title: 'Test Challenge'}]},
    generateMockChallenges: jest.fn(() => ({challenges: [{id: '2', title: 'Generated Challenge'}]}))
}));

jest.mock('../../src/js/mock/voting', () => ({
    mockVoteImagesByChallenge: {
        'challenge-1': {images: [{id: 'img1', ratio: 25}]}
    },
    mockEmptyVoteImages: {images: []},
    mockVoteSubmissionSuccess: {success: true, votes: 5},
    mockVoteSubmissionFailure: {error: 'Vote submission failed'},
    generateMockVoteImages: jest.fn((url, challenge) => ({images: [{id: 'generated-img', ratio: 30}]}))
}));

jest.mock('../../src/js/mock/boost', () => ({
    mockBoostSuccess: {success: true, boost_applied: true},
    mockBoostFailure: {error: 'Boost failed'},
    mockBoostAlreadyUsed: {error: 'Boost already used'}
}));

jest.mock('../../src/js/mock/errors', () => ({
    mockAuthErrors: {
        invalidToken: {error: 'Invalid token', code: 401}
    }
}));

// Mock console methods
jest.spyOn(console, 'log').mockImplementation();
jest.spyOn(console, 'warn').mockImplementation();

// Mock logger
jest.mock('../../src/js/logger', () => ({
    debug: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    error: jest.fn(),
    api: jest.fn(),
}));

describe('mock/index', () => {
    const auth = require('../../src/js/mock/auth');
    const challenges = require('../../src/js/mock/challenges');
    const voting = require('../../src/js/mock/voting');
    const boost = require('../../src/js/mock/boost');
    const errors = require('../../src/js/mock/errors');
    const logger = require('../../src/js/logger');

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset cancellation flag
        mockIndex.setCancellationFlag(false);
    });

    describe('module exports', () => {
        test('should export individual mock modules', () => {
            expect(mockIndex.auth).toBe(auth);
            expect(mockIndex.challenges).toBe(challenges);
            expect(mockIndex.voting).toBe(voting);
            expect(mockIndex.boost).toBe(boost);
            expect(mockIndex.errors).toBe(errors);
        });

        test('should export mockData object with all modules', () => {
            expect(mockIndex.mockData).toEqual({
                auth,
                challenges,
                voting,
                boost,
                errors
            });
        });

        test('should export utility functions', () => {
            expect(typeof mockIndex.getMockData).toBe('function');
            expect(typeof mockIndex.simulateApiResponse).toBe('function');
            expect(typeof mockIndex.simulateApiError).toBe('function');
            expect(typeof mockIndex.mockApiClient).toBe('object');
            expect(typeof mockIndex.setCancellationFlag).toBe('function');
        });
    });

    describe('getMockData', () => {
        test('should return correct mock data by type', () => {
            const authData = mockIndex.getMockData('auth');
            const challengesData = mockIndex.getMockData('challenges');

            expect(authData).toBe(auth);
            expect(challengesData).toBe(challenges);
        });

        test('should return specific scenario data', () => {
            auth.specificScenario = {test: 'data'};

            const scenarioData = mockIndex.getMockData('auth', 'specificScenario');

            expect(scenarioData).toEqual({test: 'data'});
        });

        test('should throw error for unknown type', () => {
            expect(() => mockIndex.getMockData('unknown')).toThrow('Unknown mock data type: unknown');
        });

        test('should throw error for unknown scenario', () => {
            expect(() => mockIndex.getMockData('auth', 'unknownScenario'))
                .toThrow('Unknown scenario "unknownScenario" for type "auth"');
        });
    });

    describe('simulateApiResponse', () => {
        test('should resolve with data after delay', async () => {
            const testData = {test: 'response'};
            const startTime = Date.now();

            const result = await mockIndex.simulateApiResponse(testData, 100);

            const endTime = Date.now();
            expect(result).toEqual(testData);
            expect(endTime - startTime).toBeGreaterThanOrEqual(90); // Allow 10ms tolerance for CI timing precision
        });

        test('should use default delay of 1000ms', async () => {
            const testData = {test: 'response'};
            const startTime = Date.now();

            const result = await mockIndex.simulateApiResponse(testData);

            const endTime = Date.now();
            expect(result).toEqual(testData);
            expect(endTime - startTime).toBeGreaterThanOrEqual(990); // Allow 10ms tolerance for CI timing precision
        });
    });

    describe('simulateApiError', () => {
        test('should reject with error after delay', async () => {
            const testError = new Error('Test error');
            const startTime = Date.now();

            await expect(mockIndex.simulateApiError(testError, 100)).rejects.toThrow('Test error');

            const endTime = Date.now();
            expect(endTime - startTime).toBeGreaterThanOrEqual(90); // Allow 10ms tolerance for CI timing precision
        });

        test('should use default delay of 500ms', async () => {
            const testError = new Error('Test error');
            const startTime = Date.now();

            await expect(mockIndex.simulateApiError(testError)).rejects.toThrow('Test error');

            const endTime = Date.now();
            expect(endTime - startTime).toBeGreaterThanOrEqual(490); // Allow 10ms tolerance for CI timing precision
        });
    });

    describe('setCancellationFlag', () => {
        test('should set cancellation flag', () => {
            mockIndex.setCancellationFlag(true);

            expect(() => mockIndex.setCancellationFlag(true)).not.toThrow();
            expect(() => mockIndex.setCancellationFlag(false)).not.toThrow();
        });
    });

    describe('mockApiClient', () => {
        describe('authenticate', () => {
            test('should return success for valid credentials', async () => {
                const result = await mockIndex.mockApiClient.authenticate('test@example.com', 'password');

                expect(result).toEqual(auth.mockLoginSuccess);
                expect(logger.debug).toHaveBeenCalledWith('Mock authentication with: test@example.com, password: [hidden]');
                expect(logger.success).toHaveBeenCalledWith('Mock authentication successful');
            });

            test('should return failure for empty email', async () => {
                await expect(mockIndex.mockApiClient.authenticate('', 'password'))
                    .rejects.toEqual(auth.mockLoginFailure);

                expect(logger.error).toHaveBeenCalledWith('Mock authentication failed - empty credentials');
            });

            test('should return failure for empty password', async () => {
                await expect(mockIndex.mockApiClient.authenticate('test@example.com', ''))
                    .rejects.toEqual(auth.mockLoginFailure);

                expect(logger.error).toHaveBeenCalledWith('Mock authentication failed - empty credentials');
            });

            test('should handle whitespace-only credentials', async () => {
                await expect(mockIndex.mockApiClient.authenticate('   ', '   '))
                    .rejects.toEqual(auth.mockLoginFailure);

                expect(logger.error).toHaveBeenCalledWith('Mock authentication failed - empty credentials');
            });

            test('should log password as hidden when provided', async () => {
                await mockIndex.mockApiClient.authenticate('test@example.com', 'mypassword');

                expect(logger.debug).toHaveBeenCalledWith('Mock authentication with: test@example.com, password: [hidden]');
            });

            test('should log no password when not provided', async () => {
                await expect(mockIndex.mockApiClient.authenticate('test@example.com', null))
                    .rejects.toEqual(auth.mockLoginFailure);

                expect(logger.debug).toHaveBeenCalledWith('Mock authentication with: test@example.com, password: no password');
            });
        });

        describe('getActiveChallenges', () => {
            test('should return challenges for any token', async () => {
                const result = await mockIndex.mockApiClient.getActiveChallenges('any-token');


                expect(result).toEqual({challenges: [{id: '2', title: 'Generated Challenge'}]});
                expect(logger.api).toHaveBeenCalledWith('Mock getActiveChallenges');
            });

            test('should generate fresh challenges if generator exists', async () => {
                // Clear the session cache to ensure the generator is called
                mockIndex.clearSessionCache();
                
                challenges.generateMockChallenges.mockReturnValueOnce({
                    challenges: [{
                        id: 'fresh',
                        title: 'Fresh Challenge'
                    }]
                });

                const result = await mockIndex.mockApiClient.getActiveChallenges('test-token');

                expect(challenges.generateMockChallenges).toHaveBeenCalled();
                expect(result).toEqual({challenges: [{id: 'fresh', title: 'Fresh Challenge'}]});
            });

            test('should return error for missing token', async () => {
                await expect(mockIndex.mockApiClient.getActiveChallenges(null))
                    .rejects.toEqual(errors.mockAuthErrors.invalidToken);

                expect(logger.error).toHaveBeenCalledWith('No token provided, returning error');
            });

            test('should log token information', async () => {
                await mockIndex.mockApiClient.getActiveChallenges('test-token-123');

                expect(logger.debug).toHaveBeenCalledWith('Token provided: true');
                expect(logger.debug).toHaveBeenCalledWith('Token starts with mock_: false');
            });
        });

        describe('getVoteImages', () => {
            test('should return vote images for challenge', async () => {
                const challenge = {title: 'Test Challenge', url: 'challenge-1'};

                const result = await mockIndex.mockApiClient.getVoteImages(challenge, 'test-token');


                expect(result).toEqual({images: [{id: 'generated-img', ratio: 30}]});
                expect(logger.api).toHaveBeenCalledWith('Mock getVoteImages');
                expect(logger.debug).toHaveBeenCalledWith('Challenge: Test Challenge');
            });

            test('should generate fresh vote images if generator exists', async () => {
                const challenge = {title: 'Test Challenge', url: 'test-url'};
                voting.generateMockVoteImages.mockReturnValueOnce({images: [{id: 'fresh-img', ratio: 20}]});

                const result = await mockIndex.mockApiClient.getVoteImages(challenge, 'test-token');

                expect(voting.generateMockVoteImages).toHaveBeenCalledWith('test-url', challenge);
                expect(result).toEqual({images: [{id: 'fresh-img', ratio: 20}]});
            });

            test('should return empty images for unknown challenge', async () => {
                const challenge = {title: 'Unknown Challenge', url: 'unknown-url'};

                // Mock generateMockVoteImages to return empty for this test
                voting.generateMockVoteImages.mockReturnValueOnce(voting.mockEmptyVoteImages);

                const result = await mockIndex.mockApiClient.getVoteImages(challenge, 'test-token');

                expect(result).toEqual(voting.mockEmptyVoteImages);
            });

            test('should return error for missing token', async () => {
                const challenge = {title: 'Test Challenge', url: 'challenge-1'};

                await expect(mockIndex.mockApiClient.getVoteImages(challenge, null))
                    .rejects.toEqual(errors.mockAuthErrors.invalidToken);
            });
        });

        describe('submitVotes', () => {
            test('should submit votes successfully', async () => {
                const voteImages = {images: [{id: 'img1', ratio: 25}]};

                const result = await mockIndex.mockApiClient.submitVotes(voteImages, 'test-token');

                expect(result).toEqual(voting.mockVoteSubmissionSuccess);
                expect(logger.api).toHaveBeenCalledWith('Mock submitVotes');
                // Note: 'Submitting mock votes successfully' was removed from the mock implementation
            });

            test('should return error for empty images', async () => {
                const voteImages = {images: []};

                await expect(mockIndex.mockApiClient.submitVotes(voteImages, 'test-token'))
                    .rejects.toEqual(voting.mockVoteSubmissionFailure);

                // Note: This error message was changed to use logger.error
            });

            test('should return error for missing token', async () => {
                const voteImages = {images: [{id: 'img1', ratio: 25}]};

                await expect(mockIndex.mockApiClient.submitVotes(voteImages, null))
                    .rejects.toEqual(errors.mockAuthErrors.invalidToken);
            });
        });

        describe('applyBoost', () => {
            test('should apply boost successfully when available', async () => {
                const challenge = {
                    title: 'Test Challenge',
                    member: {boost: {state: 'AVAILABLE'}}
                };

                const result = await mockIndex.mockApiClient.applyBoost(challenge, 'test-token');

                expect(result).toEqual(boost.mockBoostSuccess);
                expect(logger.api).toHaveBeenCalledWith('Mock applyBoost');
                // Note: 'Applying boost successfully' message was not migrated to logger
            });

            test('should return error when boost already used', async () => {
                const challenge = {
                    title: 'Test Challenge',
                    member: {boost: {state: 'USED'}}
                };

                await expect(mockIndex.mockApiClient.applyBoost(challenge, 'test-token'))
                    .rejects.toEqual(boost.mockBoostAlreadyUsed);

                // Note: 'Boost already used' message was not migrated to logger
            });

            test('should return error when boost not available', async () => {
                const challenge = {
                    title: 'Test Challenge',
                    member: {boost: {state: 'NOT_AVAILABLE'}}
                };

                await expect(mockIndex.mockApiClient.applyBoost(challenge, 'test-token'))
                    .rejects.toEqual(boost.mockBoostFailure);

                // Note: 'Boost not available' message was not migrated to logger
            });
        });

        describe('applyBoostToEntry', () => {
            test('should apply boost to entry successfully', async () => {
                const result = await mockIndex.mockApiClient.applyBoostToEntry('123', 'img456', 'test-token');

                expect(result).toEqual(boost.mockBoostSuccess);
                // Note: This was changed to logger.api('Mock applyBoostToEntry')
                // Note: This message was not migrated to logger in the implementation
            });

            test('should return error for missing token', async () => {
                await expect(mockIndex.mockApiClient.applyBoostToEntry('123', 'img456', null))
                    .rejects.toEqual(errors.mockAuthErrors.invalidToken);
            });
        });

        describe('fetchChallengesAndVote', () => {
            test('should complete voting process successfully', async () => {
                // Mock challenges with proper structure for the voting process
                challenges.mockActiveChallenges = {
                    challenges: [
                        {
                            id: '1',
                            title: 'Test Challenge',
                            url: 'test-url',
                            member: {
                                boost: {state: 'AVAILABLE'},
                                ranking: {
                                    exposure: {exposure_factor: 50}
                                }
                            }
                        }
                    ]
                };

                const result = await mockIndex.mockApiClient.fetchChallengesAndVote('test-token');

                expect(result).toEqual({success: true, message: 'Mock voting process completed'});
                expect(logger.info).toHaveBeenCalledWith('Mock Voting Process Started');
                expect(logger.info).toHaveBeenCalledWith('Mock Voting Process Completed');
            });

            test('should handle cancellation during voting process', async () => {
                mockIndex.setCancellationFlag(true);

                const result = await mockIndex.mockApiClient.fetchChallengesAndVote('test-token');

                expect(result).toEqual({success: false, message: 'Mock voting cancelled by user'});
                // Note: Cancellation messages were not migrated to logger
            });

            test('should return error for missing token', async () => {
                await expect(mockIndex.mockApiClient.fetchChallengesAndVote(null))
                    .rejects.toEqual(errors.mockAuthErrors.invalidToken);
            });
        });
    });
});