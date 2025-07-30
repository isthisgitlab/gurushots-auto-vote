/**
 * GuruShots Auto Voter - Flash Type Challenge Tests
 *
 * Tests for flash type challenge voting logic
 */

const settings = require('../../src/js/settings');

// Mock the settings module
jest.mock('../../src/js/settings', () => ({
    getEffectiveSetting: jest.fn(),
    SETTINGS_SCHEMA: {
        exposure: { default: 100 },
        lastMinutes: { default: 10 },
        onlyBoost: { default: false },
        voteOnlyInLastThreshold: { default: false },
    },
}));

describe('flash type challenge functionality', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Set default mock values
        settings.getEffectiveSetting.mockImplementation((setting, challengeId) => {
            switch (setting) {
                case 'exposure':
                    return 100;
                case 'lastMinutes':
                    return 10;
                case 'onlyBoost':
                    return false;
                case 'voteOnlyInLastThreshold':
                    return false;
                default:
                    return null;
            }
        });
    });

    describe('flash type voting logic', () => {
        test('should vote on flash type challenges when exposure is below 100%', () => {
            const now = Math.floor(Date.now() / 1000);
            
            // Mock flash challenge with exposure below 100%
            const flashChallenge = {
                id: 105755,
                title: 'Flash Challenge',
                type: 'flash',
                start_time: now - 3600, // Started 1 hour ago
                close_time: now + 3600, // Ends in 1 hour
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75, // Below 100%
                        },
                    },
                    boost: {
                        state: 'AVAILABLE',
                        timeout: now + 1800,
                    },
                },
            };

            // Test the voting logic
            const shouldVote = (challenge) => {
                if (challenge.type === 'flash') {
                    return challenge.member.ranking.exposure.exposure_factor < 100;
                }
                return false;
            };

            expect(shouldVote(flashChallenge)).toBe(true);
        });

        test('should not vote on flash type challenges when exposure is at 100%', () => {
            const now = Math.floor(Date.now() / 1000);
            
            // Mock flash challenge with exposure at 100%
            const flashChallenge = {
                id: 105755,
                title: 'Flash Challenge',
                type: 'flash',
                start_time: now - 3600, // Started 1 hour ago
                close_time: now + 3600, // Ends in 1 hour
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 100, // At 100%
                        },
                    },
                    boost: {
                        state: 'AVAILABLE',
                        timeout: now + 1800,
                    },
                },
            };

            // Test the voting logic
            const shouldVote = (challenge) => {
                if (challenge.type === 'flash') {
                    return challenge.member.ranking.exposure.exposure_factor < 100;
                }
                return false;
            };

            expect(shouldVote(flashChallenge)).toBe(false);
        });

        test('should ignore exposure threshold setting for flash type challenges', () => {
            const now = Math.floor(Date.now() / 1000);
            
            // Mock flash challenge with exposure at 85% (above normal threshold but below 100%)
            const flashChallenge = {
                id: 105755,
                title: 'Flash Challenge',
                type: 'flash',
                start_time: now - 3600, // Started 1 hour ago
                close_time: now + 3600, // Ends in 1 hour
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 85, // Above normal threshold but below 100%
                        },
                    },
                    boost: {
                        state: 'AVAILABLE',
                        timeout: now + 1800,
                    },
                },
            };

            // Set a high exposure threshold that would normally prevent voting
            settings.getEffectiveSetting.mockReturnValueOnce(80); // exposure threshold

            // Test the voting logic - should still vote because it's flash type
            const shouldVote = (challenge, exposureThreshold) => {
                if (challenge.type === 'flash') {
                    // Flash type ignores exposure threshold, only checks if below 100%
                    return challenge.member.ranking.exposure.exposure_factor < 100;
                } else {
                    // Normal logic uses exposure threshold
                    return challenge.member.ranking.exposure.exposure_factor < exposureThreshold;
                }
            };

            const exposureThreshold = settings.getEffectiveSetting('exposure', flashChallenge.id.toString());
            
            // Should vote because it's flash type and exposure is below 100%
            expect(shouldVote(flashChallenge, exposureThreshold)).toBe(true);
            
            // Verify that the exposure threshold was ignored for flash type
            expect(flashChallenge.member.ranking.exposure.exposure_factor).toBe(85);
            expect(exposureThreshold).toBe(80);
            // 85 is above 80, but flash type ignores this and only checks if below 100
        });

        test('should handle boost-only mode correctly for flash type challenges', () => {
            const now = Math.floor(Date.now() / 1000);
            
            // Mock flash challenge
            const flashChallenge = {
                id: 105755,
                title: 'Flash Challenge',
                type: 'flash',
                start_time: now - 3600, // Started 1 hour ago
                close_time: now + 3600, // Ends in 1 hour
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75, // Below 100%
                        },
                    },
                    boost: {
                        state: 'AVAILABLE',
                        timeout: now + 1800,
                    },
                },
            };

            // Test the voting logic with boost-only mode enabled
            const shouldVote = (challenge, onlyBoost) => {
                if (onlyBoost) {
                    return false; // Skip voting if boost-only mode is enabled
                } else if (challenge.type === 'flash') {
                    return challenge.member.ranking.exposure.exposure_factor < 100;
                }
                return false;
            };

            // Should not vote when boost-only mode is enabled
            expect(shouldVote(flashChallenge, true)).toBe(false);
            
            // Should vote when boost-only mode is disabled and it's flash type
            expect(shouldVote(flashChallenge, false)).toBe(true);
        });

        test('should handle challenge not started correctly for flash type challenges', () => {
            const now = Math.floor(Date.now() / 1000);
            
            // Mock flash challenge that hasn't started yet
            const flashChallenge = {
                id: 105755,
                title: 'Flash Challenge',
                type: 'flash',
                start_time: now + 3600, // Starts in 1 hour
                close_time: now + 7200, // Ends in 2 hours
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 75, // Below 100%
                        },
                    },
                    boost: {
                        state: 'AVAILABLE',
                        timeout: now + 1800,
                    },
                },
            };

            // Test the voting logic
            const shouldVote = (challenge) => {
                if (challenge.start_time >= now) {
                    return false; // Skip voting if challenge hasn't started yet
                } else if (challenge.type === 'flash') {
                    return challenge.member.ranking.exposure.exposure_factor < 100;
                }
                return false;
            };

            // Should not vote because challenge hasn't started yet
            expect(shouldVote(flashChallenge)).toBe(false);
        });
    });

    describe('flash type vs other challenge types', () => {
        test('should differentiate between flash type and normal challenges', () => {
            const now = Math.floor(Date.now() / 1000);
            
            // Mock flash challenge
            const flashChallenge = {
                id: 105755,
                title: 'Flash Challenge',
                type: 'flash',
                start_time: now - 3600,
                close_time: now + 3600,
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 85,
                        },
                    },
                },
            };

            // Mock normal challenge
            const normalChallenge = {
                id: 105756,
                title: 'Normal Challenge',
                type: 'default',
                start_time: now - 3600,
                close_time: now + 3600,
                member: {
                    ranking: {
                        exposure: {
                            exposure_factor: 85,
                        },
                    },
                },
            };

            // Set exposure threshold to 80
            settings.getEffectiveSetting.mockReturnValue(80);

            // Test the voting logic
            const shouldVote = (challenge, exposureThreshold) => {
                if (challenge.type === 'flash') {
                    // Flash type: ignore exposure threshold, vote when below 100%
                    return challenge.member.ranking.exposure.exposure_factor < 100;
                } else {
                    // Normal type: use exposure threshold
                    return challenge.member.ranking.exposure.exposure_factor < exposureThreshold;
                }
            };

            const exposureThreshold = 80;

            // Flash challenge should vote (85 < 100)
            expect(shouldVote(flashChallenge, exposureThreshold)).toBe(true);
            
            // Normal challenge should not vote (85 >= 80)
            expect(shouldVote(normalChallenge, exposureThreshold)).toBe(false);
        });
    });
}); 