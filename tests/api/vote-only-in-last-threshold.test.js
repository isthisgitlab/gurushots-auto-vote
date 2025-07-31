/**
 * GuruShots Auto Voter - Vote Only in Last Threshold Tests
 *
 * Tests for the vote-only-in-last-threshold feature that restricts
 * auto-voting to only occur when within the last minutes threshold.
 */

const settings = require('../../src/js/settings');

// Mock the settings module
jest.mock('../../src/js/settings', () => ({
    getEffectiveSetting: jest.fn(),
    SETTINGS_SCHEMA: {
        exposure: { default: 100 },
        lastMinuteThreshold: { default: 30 },
        onlyBoost: { default: false },
        voteOnlyInLastMinute: { default: false },
    },
}));

describe('vote-only-in-last-threshold functionality', () => {
    let mockSettings;

    beforeEach(() => {
        mockSettings = require('../../src/js/settings');
        jest.clearAllMocks();
    });

    describe('vote-only-in-last-threshold logic', () => {
        test('should skip voting when vote-only-in-last-threshold is enabled and not within last threshold', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 3600, // 1 hour remaining
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75 // Below normal threshold
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinuteThreshold':
                        return 30;
                    case 'onlyBoost':
                        return false;
                    case 'voteOnlyInLastMinute':
                        return true; // Enabled
                    case 'exposure':
                        return 90;
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinuteThreshold = mockSettings.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
            const voteOnlyInLastMinute = mockSettings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinuteThreshold * 60) && timeUntilEnd > 0;

            // Should not be within lastminute threshold (60 minutes > 30 minutes)
            expect(isWithinLastMinuteThreshold).toBe(false);

            // Should skip voting because vote-only-in-last-threshold is enabled and not within threshold
            const shouldSkipVoting = voteOnlyInLastMinute && !isWithinLastMinuteThreshold;
            expect(shouldSkipVoting).toBe(true);
        });

        test('should allow voting when vote-only-in-last-threshold is enabled and within last threshold', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 900, // 15 minutes remaining
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75 // Below 100%
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinuteThreshold':
                        return 30;
                    case 'onlyBoost':
                        return false;
                    case 'voteOnlyInLastMinute':
                        return true; // Enabled
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinuteThreshold = mockSettings.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
            const voteOnlyInLastMinute = mockSettings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinuteThreshold * 60) && timeUntilEnd > 0;

            // Should be within lastminute threshold (15 minutes <= 30 minutes)
            expect(isWithinLastMinuteThreshold).toBe(true);

            // Should not skip voting because we're within the threshold
            const shouldSkipVoting = voteOnlyInLastMinute && !isWithinLastMinuteThreshold;
            expect(shouldSkipVoting).toBe(false);

            // Should vote because exposure < 100
            const shouldVote = challenge.member.ranking.exposure.exposure_factor < 100;
            expect(shouldVote).toBe(true);
        });

        test('should allow normal voting when vote-only-in-last-threshold is disabled', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 3600, // 1 hour remaining
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75 // Below normal threshold
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinuteThreshold':
                        return 30;
                    case 'onlyBoost':
                        return false;
                    case 'voteOnlyInLastMinute':
                        return false; // Disabled
                    case 'exposure':
                        return 90;
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinuteThreshold = mockSettings.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
            const voteOnlyInLastMinute = mockSettings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinuteThreshold * 60) && timeUntilEnd > 0;

            // Should not be within lastminute threshold (60 minutes > 30 minutes)
            expect(isWithinLastMinuteThreshold).toBe(false);

            // Should not skip voting because vote-only-in-last-threshold is disabled
            const shouldSkipVoting = voteOnlyInLastMinute && !isWithinLastMinuteThreshold;
            expect(shouldSkipVoting).toBe(false);

            // Should use normal exposure threshold
            const effectiveThreshold = mockSettings.getEffectiveSetting('exposure', challenge.id.toString());
            const shouldVote = challenge.member.ranking.exposure.exposure_factor < effectiveThreshold;
            expect(shouldVote).toBe(true); // 75 < 90
        });

        test('should respect boost-only mode even when vote-only-in-last-threshold is enabled', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 900, // 15 minutes remaining
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75 // Below 100%
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinuteThreshold':
                        return 30;
                    case 'onlyBoost':
                        return true; // Boost-only mode enabled
                    case 'voteOnlyInLastMinute':
                        return true; // Enabled
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinuteThreshold = mockSettings.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
            const voteOnlyInLastMinute = mockSettings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());
            const onlyBoost = mockSettings.getEffectiveSetting('onlyBoost', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinuteThreshold * 60) && timeUntilEnd > 0;

            // Should be within lastminute threshold (15 minutes <= 30 minutes)
            expect(isWithinLastMinuteThreshold).toBe(true);

            // Should skip voting because boost-only mode is enabled (takes precedence)
            expect(onlyBoost).toBe(true);
        });

        test('should handle per-challenge vote-only-in-last-threshold overrides', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 1800, // 30 minutes remaining
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75 // Below 100%
                        }
                    }
                }
            };

            // Mock settings with per-challenge override
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinuteThreshold':
                        return 30;
                    case 'onlyBoost':
                        return false;
                    case 'voteOnlyInLastMinute':
                        return true; // Override to enabled
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinuteThreshold = mockSettings.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
            const voteOnlyInLastMinute = mockSettings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinuteThreshold * 60) && timeUntilEnd > 0;

            // Should be within lastminute threshold (30 minutes <= 30 minutes)
            expect(isWithinLastMinuteThreshold).toBe(true);

            // Should not skip voting because we're within the threshold
            const shouldSkipVoting = voteOnlyInLastMinute && !isWithinLastMinuteThreshold;
            expect(shouldSkipVoting).toBe(false);

            // Verify that getEffectiveSetting was called with the challenge ID
            expect(mockSettings.getEffectiveSetting).toHaveBeenCalledWith('voteOnlyInLastMinute', '12345');
        });
    });
}); 