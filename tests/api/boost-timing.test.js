/**
 * Tests for boost timing settings
 *
 * Tests that the boost timing logic respects user settings instead of hardcoded values.
 */

const fs = require('fs');

// Mock the settings module
const mockSettings = {
    getEffectiveSetting: jest.fn(),
    SETTINGS_SCHEMA: {
        boostTime: {
            default: 3600 // 1 hour default
        },
        exposure: {
            default: 100 // exposure default
        }
    }
};

jest.mock('../../src/js/settings', () => mockSettings);

// Mock the challenges module
const mockChallenges = {
    getActiveChallenges: jest.fn()
};

jest.mock('../../src/js/api/challenges', () => mockChallenges);

// Mock the voting module
const mockVoting = {
    getVoteImages: jest.fn(),
    submitVotes: jest.fn()
};

jest.mock('../../src/js/api/voting', () => mockVoting);

// Mock the boost module
const mockBoost = {
    applyBoost: jest.fn()
};

jest.mock('../../src/js/api/boost', () => mockBoost);

// Mock the utils module
const mockUtils = {
    sleep: jest.fn(),
    getRandomDelay: jest.fn()
};

jest.mock('../../src/js/api/utils', () => mockUtils);

// Mock the voting logic service
const mockVotingLogic = {
    shouldApplyBoost: jest.fn(),
    getEffectiveBoostTime: jest.fn(),
    evaluateVotingDecision: jest.fn()
};

jest.mock('../../src/js/services/VotingLogic', () => mockVotingLogic);

// Mock the metadata module
const mockMetadata = {
    cleanupStaleMetadata: jest.fn()
};

jest.mock('../../src/js/metadata', () => mockMetadata);

// Mock the logger module
jest.mock('../../src/js/logger', () => {
    const mockStartOperationFn = jest.fn();
    const mockEndOperationFn = jest.fn();

    return {
        startOperation: jest.fn(),
        endOperation: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        progress: jest.fn(),
        challengeInfo: jest.fn(),
        challengeSuccess: jest.fn(),
        challengeError: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
        debug: jest.fn(),
        api: jest.fn(),
        withCategory: jest.fn(() => ({
            info: jest.fn(),
            warning: jest.fn(),
            debug: jest.fn(),
            error: jest.fn(),
            api: jest.fn(),
            apiRequest: jest.fn(),
            startOperation: mockStartOperationFn,
            endOperation: mockEndOperationFn,
            progress: jest.fn(),
            success: jest.fn(),
        })),
        // Export the mock functions for testing
        __mockStartOperationFn: mockStartOperationFn,
        __mockEndOperationFn: mockEndOperationFn,
    };
});

// Mock console methods
jest.spyOn(console, 'log').mockImplementation();
jest.spyOn(console, 'error').mockImplementation();

describe('boost timing settings', () => {
    const mockToken = 'test-token-123';

    beforeEach(() => {
        jest.clearAllMocks();

        // Set up default mock responses
        mockChallenges.getActiveChallenges.mockResolvedValue({
            challenges: []
        });

        mockVoting.getVoteImages.mockResolvedValue([]);
        mockVoting.submitVotes.mockResolvedValue();
        mockBoost.applyBoost.mockResolvedValue({success: true});
        mockUtils.sleep.mockResolvedValue();
        mockUtils.getRandomDelay.mockReturnValue(3000);
        mockMetadata.cleanupStaleMetadata.mockReturnValue(true);
        
        // Set up voting logic defaults
        mockVotingLogic.shouldApplyBoost.mockReturnValue(false);
        mockVotingLogic.getEffectiveBoostTime.mockReturnValue(3600); // 1 hour default
        mockVotingLogic.evaluateVotingDecision.mockReturnValue({
            shouldVote: false,
            voteReason: 'No voting needed',
            targetExposure: 100
        });
    });

    describe('fetchChallengesAndVote', () => {
        test('should use custom boost time setting instead of hardcoded 1 hour', async () => {
            jest.resetModules();
            // Create a challenge with boost available
            const now = Math.floor(Date.now() / 1000);
            const challengeWithBoost = {
                id: '12345',
                title: 'Test Challenge',
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    boost: {
                        state: 'AVAILABLE',
                        timeout: now + 1200 // Available for 20 minutes
                    },
                    ranking: {
                        exposure: {
                            exposure_factor: 50
                        }
                    }
                }
            };

            mockChallenges.getActiveChallenges.mockResolvedValue({
                challenges: [challengeWithBoost]
            });

            // Mock voting logic to indicate boost should be applied
            mockVotingLogic.shouldApplyBoost.mockReturnValue(true);
            mockVotingLogic.getEffectiveBoostTime.mockReturnValue(1800); // 30 minutes
            // Ensure boost logic is triggered
            mockVotingLogic.evaluateVotingDecision.mockReturnValue({
                shouldVote: false,
                voteReason: 'No voting needed',
                targetExposure: 100
            });

            // Import the main module
            const {fetchChallengesAndVote} = require('../../src/js/api/main');

            await fetchChallengesAndVote(mockToken);

            // Verify that voting logic was called for boost decision
            expect(mockVotingLogic.shouldApplyBoost).toHaveBeenCalledWith(challengeWithBoost, now);
            expect(mockVotingLogic.getEffectiveBoostTime).toHaveBeenCalledWith('12345');

            // Verify that applyBoost was called (because shouldApplyBoost returned true)
            expect(mockBoost.applyBoost).toHaveBeenCalledWith(challengeWithBoost, mockToken);

            // Verify that boost operation was started and ended
            const logger = require('../../src/js/logger');
            expect(logger.withCategory).toHaveBeenCalledWith('boost');
            expect(logger.__mockStartOperationFn).toHaveBeenCalledWith(
                'boost-12345',
                expect.stringContaining('Applying boost to challenge')
            );
            expect(logger.__mockEndOperationFn).toHaveBeenCalledWith(
                'boost-12345',
                expect.stringContaining('Boost applied successfully')
            );
        });

        test('should not apply boost when deadline is outside custom boost time setting', async () => {
            // Create a challenge with boost available but deadline outside threshold
            const now = Math.floor(Date.now() / 1000);
            const challengeWithBoost = {
                id: '12345',
                title: 'Test Challenge',
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    boost: {
                        state: 'AVAILABLE',
                        timeout: now + 2400 // Available for 40 minutes
                    },
                    ranking: {
                        exposure: {
                            exposure_factor: 50
                        }
                    }
                }
            };

            mockChallenges.getActiveChallenges.mockResolvedValue({
                challenges: [challengeWithBoost]
            });

            // Mock voting logic to indicate boost should NOT be applied (deadline is outside threshold)
            mockVotingLogic.shouldApplyBoost.mockReturnValue(false);
            mockVotingLogic.getEffectiveBoostTime.mockReturnValue(1800); // 30 minutes

            // Import the main module
            const {fetchChallengesAndVote} = require('../../src/js/api/main');

            await fetchChallengesAndVote(mockToken);

            // Verify that voting logic was called for boost decision
            expect(mockVotingLogic.shouldApplyBoost).toHaveBeenCalledWith(challengeWithBoost, now);
            expect(mockVotingLogic.getEffectiveBoostTime).toHaveBeenCalledWith('12345');

            // Verify that applyBoost was NOT called (because shouldApplyBoost returned false)
            expect(mockBoost.applyBoost).not.toHaveBeenCalled();
        });

        test('should use default boost time when no custom setting is provided', async () => {
            // Mock the default boost time setting (1 hour = 3600 seconds)
            mockSettings.getEffectiveSetting.mockReturnValue(3600);

            // Create a challenge with boost available and deadline within 1 hour
            const now = Math.floor(Date.now() / 1000);
            const challengeWithBoost = {
                id: '12345',
                title: 'Test Challenge',
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    boost: {
                        state: 'AVAILABLE',
                        timeout: now + 1800 // Available for 30 minutes (within 1-hour default)
                    },
                    ranking: {
                        exposure: {
                            exposure_factor: 50
                        }
                    }
                }
            };

            mockChallenges.getActiveChallenges.mockResolvedValue({
                challenges: [challengeWithBoost]
            });

            // Mock voting logic to indicate boost should be applied with default settings
            mockVotingLogic.shouldApplyBoost.mockReturnValue(true);
            mockVotingLogic.getEffectiveBoostTime.mockReturnValue(3600); // 1 hour default

            // Import the main module
            const {fetchChallengesAndVote} = require('../../src/js/api/main');

            await fetchChallengesAndVote(mockToken);

            // Verify that getEffectiveSetting was called with boostTime
            expect(mockVotingLogic.getEffectiveBoostTime).toHaveBeenCalledWith('12345');

            // Verify that applyBoost was called (because deadline is within 1 hour)
            expect(mockBoost.applyBoost).toHaveBeenCalledWith(challengeWithBoost, mockToken);
        });

        test('should handle per-challenge boost time overrides', async () => {
            // Mock different boost time settings for different challenges
            mockSettings.getEffectiveSetting
                .mockReturnValueOnce(1800) // 30 minutes for first challenge
                .mockReturnValueOnce(7200); // 2 hours for second challenge

            const now = Math.floor(Date.now() / 1000);
            const challenges = [
                {
                    id: '12345',
                    title: 'Challenge 1',
                    start_time: now - 3600,
                    member: {
                        boost: {
                            state: 'AVAILABLE',
                            timeout: now + 1200 // 20 minutes (within 30-minute setting)
                        },
                        ranking: {
                            exposure: {
                                exposure_factor: 50
                            }
                        }
                    }
                },
                {
                    id: '67890',
                    title: 'Challenge 2',
                    start_time: now - 3600,
                    member: {
                        boost: {
                            state: 'AVAILABLE',
                            timeout: now + 3600 // 1 hour (within 2-hour setting)
                        },
                        ranking: {
                            exposure: {
                                exposure_factor: 50
                            }
                        }
                    }
                }
            ];

            mockChallenges.getActiveChallenges.mockResolvedValue({
                challenges: challenges
            });

            // Mock voting logic to indicate boost should be applied for both challenges
            mockVotingLogic.shouldApplyBoost.mockReturnValue(true);
            mockVotingLogic.getEffectiveBoostTime
                .mockReturnValueOnce(1800) // 30 minutes for first challenge
                .mockReturnValueOnce(7200); // 2 hours for second challenge

            // Import the main module
            const {fetchChallengesAndVote} = require('../../src/js/api/main');

            await fetchChallengesAndVote(mockToken);

            // Verify that getEffectiveSetting was called for each challenge
            expect(mockVotingLogic.getEffectiveBoostTime).toHaveBeenCalledWith('12345');
            expect(mockVotingLogic.getEffectiveBoostTime).toHaveBeenCalledWith('67890');

            // Verify that applyBoost was called for both challenges
            expect(mockBoost.applyBoost).toHaveBeenCalledTimes(2);
            expect(mockBoost.applyBoost).toHaveBeenCalledWith(challenges[0], mockToken);
            expect(mockBoost.applyBoost).toHaveBeenCalledWith(challenges[1], mockToken);
        });
    });
}); 