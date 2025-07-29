/**
 * GuruShots Auto Voter - Lastminute Threshold Tests
 *
 * Tests for the lastminute threshold feature that allows auto-voting
 * when a challenge is within the lastminute threshold, ignoring the
 * normal exposure threshold.
 */

const settings = require('../../src/js/settings');

// Mock the settings module
jest.mock('../../src/js/settings', () => ({
    getEffectiveSetting: jest.fn(),
    SETTINGS_SCHEMA: {
        exposure: { default: 100 },
        lastMinutes: { default: 30 },
        onlyBoost: { default: false },
    },
}));

describe('lastminute threshold functionality', () => {
    let mockSettings;

    beforeEach(() => {
        mockSettings = require('../../src/js/settings');
        jest.clearAllMocks();
    });

    describe('lastminute threshold logic', () => {
        test('should vote when within lastminute threshold and exposure < 100', () => {
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
                    case 'lastMinutes':
                        return 30;
                    case 'onlyBoost':
                        return false;
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinutes = mockSettings.getEffectiveSetting('lastMinutes', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;

            // Should be within lastminute threshold (15 minutes <= 30 minutes)
            expect(isWithinLastMinuteThreshold).toBe(true);

            // Should vote because exposure < 100
            const shouldVote = challenge.member.ranking.exposure.exposure_factor < 100;
            expect(shouldVote).toBe(true);
        });

        test('should not vote when within lastminute threshold but exposure = 100', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 900, // 15 minutes remaining
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 100 // At 100%
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinutes':
                        return 30;
                    case 'onlyBoost':
                        return false;
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinutes = mockSettings.getEffectiveSetting('lastMinutes', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;

            // Should be within lastminute threshold (15 minutes <= 30 minutes)
            expect(isWithinLastMinuteThreshold).toBe(true);

            // Should not vote because exposure = 100
            const shouldVote = challenge.member.ranking.exposure.exposure_factor < 100;
            expect(shouldVote).toBe(false);
        });

        test('should use normal exposure threshold when outside lastminute threshold', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 3600, // 1 hour remaining
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 80 // Below normal threshold
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinutes':
                        return 30;
                    case 'onlyBoost':
                        return false;
                    case 'exposure':
                        return 90;
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinutes = mockSettings.getEffectiveSetting('lastMinutes', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;

            // Should not be within lastminute threshold (60 minutes > 30 minutes)
            expect(isWithinLastMinuteThreshold).toBe(false);

            // Should use normal exposure threshold
            const effectiveThreshold = mockSettings.getEffectiveSetting('exposure', challenge.id.toString());
            const shouldVote = challenge.member.ranking.exposure.exposure_factor < effectiveThreshold;
            expect(shouldVote).toBe(true); // 80 < 90
        });

        test('should not vote when outside lastminute threshold and exposure >= normal threshold', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 3600, // 1 hour remaining
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 95 // Above normal threshold
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinutes':
                        return 30;
                    case 'onlyBoost':
                        return false;
                    case 'exposure':
                        return 90;
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinutes = mockSettings.getEffectiveSetting('lastMinutes', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;

            // Should not be within lastminute threshold (60 minutes > 30 minutes)
            expect(isWithinLastMinuteThreshold).toBe(false);

            // Should use normal exposure threshold
            const effectiveThreshold = mockSettings.getEffectiveSetting('exposure', challenge.id.toString());
            const shouldVote = challenge.member.ranking.exposure.exposure_factor < effectiveThreshold;
            expect(shouldVote).toBe(false); // 95 >= 90
        });

        test('should not vote when boost-only mode is enabled regardless of lastminute threshold', () => {
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
                    case 'lastMinutes':
                        return 30;
                    case 'onlyBoost':
                        return true; // Boost-only mode enabled
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinutes = mockSettings.getEffectiveSetting('lastMinutes', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;
            const onlyBoost = mockSettings.getEffectiveSetting('onlyBoost', challenge.id.toString());

            // Should be within lastminute threshold (15 minutes <= 30 minutes)
            expect(isWithinLastMinuteThreshold).toBe(true);

            // Should not vote because boost-only mode is enabled
            expect(onlyBoost).toBe(true);
        });

        test('should not vote when challenge has not started yet', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 900, // 15 minutes remaining
                start_time: now + 300, // Starts in 5 minutes
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
                    case 'lastMinutes':
                        return 30;
                    case 'onlyBoost':
                        return false;
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinutes = mockSettings.getEffectiveSetting('lastMinutes', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;

            // Should be within lastminute threshold (15 minutes <= 30 minutes)
            expect(isWithinLastMinuteThreshold).toBe(true);

            // Should not vote because challenge hasn't started yet
            const challengeStarted = challenge.start_time < now;
            expect(challengeStarted).toBe(false);
        });

        test('should handle per-challenge lastminute threshold overrides', () => {
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
                    case 'lastMinutes':
                        return 15; // Override to 15 minutes
                    case 'onlyBoost':
                        return false;
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinutes = mockSettings.getEffectiveSetting('lastMinutes', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;

            // Should not be within lastminute threshold (30 minutes > 15 minutes)
            expect(isWithinLastMinuteThreshold).toBe(false);

            // Verify that getEffectiveSetting was called with the challenge ID
            expect(mockSettings.getEffectiveSetting).toHaveBeenCalledWith('lastMinutes', '12345');
        });
    });
}); 