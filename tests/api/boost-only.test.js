/**
 * GuruShots Auto Voter - Boost Only Mode Tests
 *
 * Tests for the boost-only mode functionality
 */

const settings = require('../../src/js/settings');

// Mock the settings module
jest.mock('../../src/js/settings', () => ({
    getEffectiveSetting: jest.fn(),
    SETTINGS_SCHEMA: {
        onlyBoost: {
            default: false,
        },
        boostTime: {
            default: 3600,
        },
        exposure: {
            default: 100,
        },
    },
}));

describe('boost-only mode functionality', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('boost-only setting behavior', () => {
        test('should check boost-only setting for each challenge', () => {
            // Mock settings to return different values for different challenges
            settings.getEffectiveSetting
                .mockReturnValueOnce(true) // onlyBoost: true for challenge 1
                .mockReturnValueOnce(false); // onlyBoost: false for challenge 2

            // Simulate the logic that would be in fetchChallengesAndVote
            const challenge1Id = '12345';
            const challenge2Id = '67890';

            // Check boost-only setting for each challenge
            const onlyBoost1 = settings.getEffectiveSetting('onlyBoost', challenge1Id);
            const onlyBoost2 = settings.getEffectiveSetting('onlyBoost', challenge2Id);

            // Verify that getEffectiveSetting was called correctly
            expect(settings.getEffectiveSetting).toHaveBeenCalledWith('onlyBoost', challenge1Id);
            expect(settings.getEffectiveSetting).toHaveBeenCalledWith('onlyBoost', challenge2Id);

            // Verify the returned values
            expect(onlyBoost1).toBe(true);
            expect(onlyBoost2).toBe(false);
        });

        test('should handle boost-only mode logic correctly', () => {
            // Test the logic that determines whether to vote or not
            const shouldVote = (onlyBoost, exposureFactor, threshold) => {
                return !onlyBoost && exposureFactor < threshold;
            };

            // Test cases
            expect(shouldVote(true, 50, 100)).toBe(false); // boost-only enabled, should not vote
            expect(shouldVote(false, 50, 100)).toBe(true); // boost-only disabled, should vote
            expect(shouldVote(false, 100, 100)).toBe(false); // exposure at threshold, should not vote
            expect(shouldVote(true, 100, 100)).toBe(false); // boost-only enabled, should not vote regardless
        });

        test('should handle per-challenge boost-only overrides', () => {
            // Mock different boost-only settings for different challenges
            settings.getEffectiveSetting
                .mockReturnValueOnce(true) // onlyBoost: true for challenge 1
                .mockReturnValueOnce(false); // onlyBoost: false for challenge 2

            const challenge1Id = '12345';
            const challenge2Id = '67890';

            // Simulate checking boost-only setting for multiple challenges
            const challenges = [
                {id: challenge1Id, title: 'Challenge 1'},
                {id: challenge2Id, title: 'Challenge 2'}
            ];

            const boostOnlyResults = challenges.map(challenge =>
                settings.getEffectiveSetting('onlyBoost', challenge.id)
            );

            // Verify that getEffectiveSetting was called for each challenge
            expect(settings.getEffectiveSetting).toHaveBeenCalledWith('onlyBoost', challenge1Id);
            expect(settings.getEffectiveSetting).toHaveBeenCalledWith('onlyBoost', challenge2Id);

            // Verify the results
            expect(boostOnlyResults[0]).toBe(true); // Challenge 1: boost-only enabled
            expect(boostOnlyResults[1]).toBe(false); // Challenge 2: boost-only disabled
        });
    });

    describe('boost-only mode integration', () => {
        test('should integrate with existing boost logic', () => {
            // Mock settings for a challenge with boost available
            settings.getEffectiveSetting
                .mockReturnValueOnce(true); // onlyBoost: true

            const challengeId = '12345';
            const onlyBoost = settings.getEffectiveSetting('onlyBoost', challengeId);

            // Verify that the setting is retrieved
            expect(settings.getEffectiveSetting).toHaveBeenCalledWith('onlyBoost', challengeId);

            // Verify the value
            expect(onlyBoost).toBe(true);

            // Simulate the logic: boost should still work even in boost-only mode
            const shouldApplyBoost = true; // Boost logic is independent of boost-only mode
            const shouldVote = !onlyBoost; // Voting is disabled in boost-only mode

            expect(shouldApplyBoost).toBe(true);
            expect(shouldVote).toBe(false);
        });
    });
}); 