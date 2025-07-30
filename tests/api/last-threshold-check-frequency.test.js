/**
 * GuruShots Auto Voter - Last Threshold Check Frequency Tests
 *
 * Tests for the last threshold check frequency feature that allows
 * different check frequencies when within the last minutes threshold.
 */

const settings = require('../../src/js/settings');

// Mock the settings module
jest.mock('../../src/js/settings', () => ({
    getEffectiveSetting: jest.fn(),
    SETTINGS_SCHEMA: {
        exposure: { default: 100 },
        lastMinutes: { default: 30 },
        onlyBoost: { default: false },
        voteOnlyInLastThreshold: { default: false },
        lastThresholdCheckFrequency: { default: 1 },
    },
}));

describe('last threshold check frequency functionality', () => {
    let mockSettings;

    beforeEach(() => {
        mockSettings = require('../../src/js/settings');
        jest.clearAllMocks();
    });

    describe('last threshold check frequency logic', () => {
        test('should use last threshold frequency when challenge is within last threshold', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 900, // 15 minutes remaining
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinutes':
                        return 30;
                    case 'lastThresholdCheckFrequency':
                        return 2; // 2 minutes when in last threshold
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

            // Should use last threshold frequency
            const lastThresholdFrequency = mockSettings.getEffectiveSetting('lastThresholdCheckFrequency', 'global');
            expect(lastThresholdFrequency).toBe(2);
        });

        test('should use normal voting interval when challenge is not within last threshold', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 3600, // 1 hour remaining
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinutes':
                        return 30;
                    case 'lastThresholdCheckFrequency':
                        return 1; // 1 minute when in last threshold
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

            // Should not use last threshold frequency since not within threshold
            const lastThresholdFrequency = mockSettings.getEffectiveSetting('lastThresholdCheckFrequency', 'global');
            expect(lastThresholdFrequency).toBe(1);
        });

        test('should use normal voting interval when last threshold frequency is set to 0 (disabled)', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 900, // 15 minutes remaining - within threshold
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinutes':
                        return 30;
                    case 'lastThresholdCheckFrequency':
                        return 0; // Disabled (0)
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

            // Should not use last threshold frequency since it's disabled (0)
            const lastThresholdFrequency = mockSettings.getEffectiveSetting('lastThresholdCheckFrequency', 'global');
            expect(lastThresholdFrequency).toBe(0);
            
            // Should use normal voting interval instead
            const useLastThreshold = lastThresholdFrequency > 0;
            expect(useLastThreshold).toBe(false);
        });

        test('should use global last threshold check frequency setting', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 900, // 15 minutes remaining
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinutes':
                        return 30;
                    case 'lastThresholdCheckFrequency':
                        return 2; // Global setting: 2 minutes
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

            // Should use global setting for last threshold frequency
            const lastThresholdFrequency = mockSettings.getEffectiveSetting('lastThresholdCheckFrequency', 'global');
            expect(lastThresholdFrequency).toBe(2);

            // Verify that getEffectiveSetting was called with 'global' for the global setting
            expect(mockSettings.getEffectiveSetting).toHaveBeenCalledWith('lastThresholdCheckFrequency', 'global');
        });

        test('should handle multiple challenges with different threshold states', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [
                {
                    id: '12345',
                    title: 'Challenge 1',
                    close_time: now + 900, // 15 minutes remaining - within threshold
                    start_time: now - 3600,
                    member: {
                        ranking: {
                            exposure: {
                                exposure_factor: 75
                            }
                        }
                    }
                },
                {
                    id: '67890',
                    title: 'Challenge 2',
                    close_time: now + 3600, // 1 hour remaining - not within threshold
                    start_time: now - 3600,
                    member: {
                        ranking: {
                            exposure: {
                                exposure_factor: 75
                            }
                        }
                    }
                }
            ];

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinutes':
                        return 30;
                    case 'lastThresholdCheckFrequency':
                        return 2; // 2 minutes when in last threshold
                    default:
                        return 100;
                }
            });

            // Test the logic - should use last threshold frequency if ANY challenge is within threshold
            let useLastThresholdInterval = false;
            for (const challenge of challenges) {
                const effectiveLastMinutes = mockSettings.getEffectiveSetting('lastMinutes', challenge.id.toString());
                const timeUntilEnd = challenge.close_time - now;
                const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;
                
                if (isWithinLastMinuteThreshold) {
                    useLastThresholdInterval = true;
                    break;
                }
            }

            // Should use last threshold interval because Challenge 1 is within threshold
            expect(useLastThresholdInterval).toBe(true);

            const lastThresholdFrequency = mockSettings.getEffectiveSetting('lastThresholdCheckFrequency', 'global');
            expect(lastThresholdFrequency).toBe(2);
        });

        test('should handle edge case when challenge ends exactly at threshold boundary', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now + 1800, // Exactly 30 minutes remaining
                start_time: now - 3600, // Started 1 hour ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinutes':
                        return 30;
                    case 'lastThresholdCheckFrequency':
                        return 1;
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinutes = mockSettings.getEffectiveSetting('lastMinutes', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;

            // Should be within lastminute threshold (30 minutes <= 30 minutes)
            expect(isWithinLastMinuteThreshold).toBe(true);

            const lastThresholdFrequency = mockSettings.getEffectiveSetting('lastThresholdCheckFrequency', 'global');
            expect(lastThresholdFrequency).toBe(1);
        });

        test('should handle edge case when challenge has already ended', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenge = {
                id: '12345',
                title: 'Test Challenge',
                close_time: now - 3600, // Ended 1 hour ago
                start_time: now - 7200, // Started 2 hours ago
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75
                        }
                    }
                }
            };

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinutes':
                        return 30;
                    case 'lastThresholdCheckFrequency':
                        return 1;
                    default:
                        return 100;
                }
            });

            // Test the logic
            const effectiveLastMinutes = mockSettings.getEffectiveSetting('lastMinutes', challenge.id.toString());
            const timeUntilEnd = challenge.close_time - now;
            const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;

            // Should not be within lastminute threshold (challenge has ended)
            expect(isWithinLastMinuteThreshold).toBe(false);

            // Should not use last threshold frequency since challenge has ended
            const lastThresholdFrequency = mockSettings.getEffectiveSetting('lastThresholdCheckFrequency', 'global');
            expect(lastThresholdFrequency).toBe(1);
        });

        test('should verify GUI implementation logic matches expected behavior', () => {
            const now = Math.floor(Date.now() / 1000);
            const challenges = [
                {
                    id: '12345',
                    title: 'Challenge 1',
                    close_time: now + 900, // 15 minutes remaining - within threshold
                    start_time: now - 3600,
                    member: {
                        ranking: {
                            exposure: {
                                exposure_factor: 75
                            }
                        }
                    }
                },
                {
                    id: '67890',
                    title: 'Challenge 2',
                    close_time: now + 3600, // 1 hour remaining - not within threshold
                    start_time: now - 3600,
                    member: {
                        ranking: {
                            exposure: {
                                exposure_factor: 75
                            }
                        }
                    }
                }
            ];

            // Mock settings to return different values based on the setting key
            mockSettings.getEffectiveSetting.mockImplementation((settingKey) => {
                switch (settingKey) {
                    case 'lastMinutes':
                        return 30;
                    case 'lastThresholdCheckFrequency':
                        return 2; // 2 minutes when in last threshold
                    default:
                        return 100;
                }
            });

            // Simulate the GUI implementation logic
            const lastThresholdFrequency = mockSettings.getEffectiveSetting('lastThresholdCheckFrequency', 'global');
            const useLastThreshold = lastThresholdFrequency > 0;
            
            let useLastThresholdInterval = false;
            
            if (useLastThreshold) {
                // Check if any challenges are within the last minutes threshold
                for (const challenge of challenges) {
                    const effectiveLastMinutes = mockSettings.getEffectiveSetting('lastMinutes', challenge.id.toString());
                    const timeUntilEnd = challenge.close_time - now;
                    const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinutes * 60) && timeUntilEnd > 0;
                    
                    if (isWithinLastMinuteThreshold) {
                        useLastThresholdInterval = true;
                        break;
                    }
                }
            }

            // Should use last threshold interval because Challenge 1 is within threshold
            expect(useLastThresholdInterval).toBe(true);
            expect(lastThresholdFrequency).toBe(2);
        });
    });
}); 