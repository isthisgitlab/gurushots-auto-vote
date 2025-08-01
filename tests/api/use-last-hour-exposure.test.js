/**
 * Test suite for useLastHourExposure setting functionality
 * 
 * This test verifies that the useLastHourExposure setting correctly controls
 * whether the last hour exposure logic is applied or not.
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');

// Mock the settings module
jest.mock('../../src/js/settings');

describe('useLastHourExposure setting', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Mock the getEffectiveSetting function
        settings.getEffectiveSetting = jest.fn();
    });

    test('should use last hour exposure logic when useLastHourExposure is true', () => {
        // Mock challenge data within last hour
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now (within last hour)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 75 // Below lastHourExposure threshold
                    }
                }
            }
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings - useLastHourExposure is TRUE
        settings.getEffectiveSetting.mockImplementation((key, challengeId) => {
            switch (key) {
            case 'onlyBoost': return false;
            case 'voteOnlyInLastMinute': return false;
            case 'exposure': return 100;
            case 'lastMinuteThreshold': return 10;
            case 'lastHourExposure': return 80;
            case 'useLastHourExposure': return true; // This is the key setting
            default: return undefined;
            }
        });

        // Evaluate voting decision
        const result = VotingLogic.evaluateVotingDecision(challenge, now);

        // Should vote because exposure (75%) < lastHourExposure (80%) and useLastHourExposure is true
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('last hour threshold');
        expect(result.voteReason).toContain('75% < 80%');
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('useLastHourExposure', '123');
    });

    test('should NOT use last hour exposure logic when useLastHourExposure is false', () => {
        // Mock challenge data within last hour
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now (within last hour)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 75 // Below normal exposure threshold but above lastHourExposure
                    }
                }
            }
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings - useLastHourExposure is FALSE
        settings.getEffectiveSetting.mockImplementation((key, challengeId) => {
            switch (key) {
            case 'onlyBoost': return false;
            case 'voteOnlyInLastMinute': return false;
            case 'exposure': return 100;
            case 'lastMinuteThreshold': return 10;
            case 'lastHourExposure': return 80;
            case 'useLastHourExposure': return false; // This is the key setting
            default: return undefined;
            }
        });

        // Evaluate voting decision
        const result = VotingLogic.evaluateVotingDecision(challenge, now);

        // Should vote because it uses normal logic: exposure (75%) < normal threshold (100%)
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('normal threshold');
        expect(result.voteReason).toContain('75% < 100%');
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('useLastHourExposure', '123');
    });

    test('should not vote when useLastHourExposure is false and exposure is above normal threshold', () => {
        // Mock challenge data within last hour
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now (within last hour)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 100 // At normal exposure threshold
                    }
                }
            }
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings - useLastHourExposure is FALSE
        settings.getEffectiveSetting.mockImplementation((key, challengeId) => {
            switch (key) {
            case 'onlyBoost': return false;
            case 'voteOnlyInLastMinute': return false;
            case 'exposure': return 100;
            case 'lastMinuteThreshold': return 10;
            case 'lastHourExposure': return 80;
            case 'useLastHourExposure': return false; // This is the key setting
            default: return undefined;
            }
        });

        // Evaluate voting decision
        const result = VotingLogic.evaluateVotingDecision(challenge, now);

        // Should NOT vote because exposure (100%) >= normal threshold (100%)
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('normal threshold');
        expect(result.voteReason).toContain('100% >= 100%');
    });

    test('should still use normal logic when outside last hour even if useLastHourExposure is true', () => {
        // Mock challenge data outside last hour
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 7200, // 2 hours from now (outside last hour)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 85 // Above lastHourExposure but below normal
                    }
                }
            }
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings - useLastHourExposure is TRUE but we're outside last hour
        settings.getEffectiveSetting.mockImplementation((key, challengeId) => {
            switch (key) {
            case 'onlyBoost': return false;
            case 'voteOnlyInLastMinute': return false;
            case 'exposure': return 100;
            case 'lastMinuteThreshold': return 10;
            case 'lastHourExposure': return 80;
            case 'useLastHourExposure': return true; // This setting is true
            default: return undefined;
            }
        });

        // Evaluate voting decision
        const result = VotingLogic.evaluateVotingDecision(challenge, now);

        // Should vote using normal logic because we're outside the last hour
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('normal threshold');
        expect(result.voteReason).toContain('85% < 100%');
    });

    test('should handle per-challenge useLastHourExposure override correctly', () => {
        // Mock challenge data within last hour
        const challenge = {
            id: '456',
            title: 'Test Challenge with Override',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now (within last hour)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 70 // Below lastHourExposure threshold
                    }
                }
            }
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings with per-challenge override
        settings.getEffectiveSetting.mockImplementation((key, challengeId) => {
            switch (key) {
            case 'onlyBoost': return false;
            case 'voteOnlyInLastMinute': return false;
            case 'exposure': return 100;
            case 'lastMinuteThreshold': return 10;
            case 'lastHourExposure': return 75; // Per-challenge override
            case 'useLastHourExposure': return true; // Per-challenge override enabled
            default: return undefined;
            }
        });

        // Evaluate voting decision
        const result = VotingLogic.evaluateVotingDecision(challenge, now);

        // Should vote because exposure (70%) < lastHourExposure (75%) and useLastHourExposure is true
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('last hour threshold');
        expect(result.voteReason).toContain('70% < 75%');
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('useLastHourExposure', '456');
    });
});