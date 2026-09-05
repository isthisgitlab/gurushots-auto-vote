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
                        exposure_factor: 75, // Below lastHourExposure threshold
                    },
                },
            },
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings - useLastHourExposure is TRUE
        settings.getEffectiveSetting.mockImplementation((key, _challengeId) => {
            switch (key) {
                case 'onlyBoost':
                    return false;
                case 'voteOnlyInLastMinute':
                    return false;
                case 'exposure':
                    return 100;
                case 'lastMinuteThreshold':
                    return 10;
                case 'lastHourExposure':
                    return 80;
                case 'useLastHourExposure':
                    return true; // This is the key setting
                default:
                    return undefined;
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
                        exposure_factor: 75, // Below normal exposure threshold but above lastHourExposure
                    },
                },
            },
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings - useLastHourExposure is FALSE
        settings.getEffectiveSetting.mockImplementation((key, _challengeId) => {
            switch (key) {
                case 'onlyBoost':
                    return false;
                case 'voteOnlyInLastMinute':
                    return false;
                case 'exposure':
                    return 100;
                case 'lastMinuteThreshold':
                    return 10;
                case 'lastHourExposure':
                    return 80;
                case 'useLastHourExposure':
                    return false; // This is the key setting
                default:
                    return undefined;
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
                        exposure_factor: 100, // At normal exposure threshold
                    },
                },
            },
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings - useLastHourExposure is FALSE
        settings.getEffectiveSetting.mockImplementation((key, _challengeId) => {
            switch (key) {
                case 'onlyBoost':
                    return false;
                case 'voteOnlyInLastMinute':
                    return false;
                case 'exposure':
                    return 100;
                case 'lastMinuteThreshold':
                    return 10;
                case 'lastHourExposure':
                    return 80;
                case 'useLastHourExposure':
                    return false; // This is the key setting
                default:
                    return undefined;
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
                        exposure_factor: 85, // Above lastHourExposure but below normal
                    },
                },
            },
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings - useLastHourExposure is TRUE but we're outside last hour
        settings.getEffectiveSetting.mockImplementation((key, _challengeId) => {
            switch (key) {
                case 'onlyBoost':
                    return false;
                case 'voteOnlyInLastMinute':
                    return false;
                case 'exposure':
                    return 100;
                case 'lastMinuteThreshold':
                    return 10;
                case 'lastHourExposure':
                    return 80;
                case 'useLastHourExposure':
                    return true; // This setting is true
                default:
                    return undefined;
            }
        });

        // Evaluate voting decision
        const result = VotingLogic.evaluateVotingDecision(challenge, now);

        // Should vote using normal logic because we're outside the last hour
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('normal threshold');
        expect(result.voteReason).toContain('85% < 100%');
    });

    test('should NOT auto-vote in normal path when current exposure is at or above the configured exposure ceiling', () => {
        const now = Math.floor(Date.now() / 1000);
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: now + 7200, // 2 hours out — outside last hour and last minute
            start_time: now - 3600,
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 80, // currentExposure is AT or ABOVE configured ceiling (70)
                    },
                },
            },
        };

        settings.getEffectiveSetting.mockImplementation((key) => {
            switch (key) {
                case 'onlyBoost':
                    return false;
                case 'voteOnlyInLastMinute':
                    return false;
                case 'exposure':
                    return 70;
                case 'lastMinuteThreshold':
                    return 10;
                case 'lastHourExposure':
                    return 100;
                case 'useLastHourExposure':
                    return false;
                default:
                    return undefined;
            }
        });

        const result = VotingLogic.evaluateVotingDecision(challenge, now);

        // Pre-fix: would return shouldVote=true because target was hardcoded to 100 and 80 < 100.
        // Post-fix: correctly returns shouldVote=false because 80 >= 70 (configured ceiling).
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('normal threshold');
        expect(result.voteReason).toContain('80% >= 70%');
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
                        exposure_factor: 70, // Below lastHourExposure threshold
                    },
                },
            },
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings with per-challenge override
        settings.getEffectiveSetting.mockImplementation((key, _challengeId) => {
            switch (key) {
                case 'onlyBoost':
                    return false;
                case 'voteOnlyInLastMinute':
                    return false;
                case 'exposure':
                    return 100;
                case 'lastMinuteThreshold':
                    return 10;
                case 'lastHourExposure':
                    return 75; // Per-challenge override
                case 'useLastHourExposure':
                    return true; // Per-challenge override enabled
                default:
                    return undefined;
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

describe('voteBeforeLastHour pre-last-hour top-up', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        settings.getEffectiveSetting = jest.fn();
    });

    // Shared mock: standard exposure 100, a LOWER last-hour trigger 60, both
    // last-hour and the new top-up feature ON, lead 15 min. Overridable per test.
    const mockSettings = (over = {}) => {
        const base = {
            onlyBoost: false,
            voteOnlyInLastMinute: false,
            exposure: 100,
            lastMinuteThreshold: 10,
            lastHourExposure: 60,
            useLastHourExposure: true,
            voteBeforeLastHour: true,
            voteBeforeLastHourLeadMin: 15,
            ...over,
        };
        settings.getEffectiveSetting.mockImplementation((key) => (key in base ? base[key] : undefined));
    };

    const challengeClosingIn = (secs, exposureFactor) => ({
        id: '123',
        title: 'Test Challenge',
        type: 'regular',
        close_time: Math.floor(Date.now() / 1000) + secs,
        start_time: Math.floor(Date.now() / 1000) - 7200,
        member: { ranking: { exposure: { exposure_factor: exposureFactor } } },
    });

    test('in-hour grace: tops up to the STANDARD target, overriding the lower last-hour trigger', () => {
        // 50 min out → within the last hour AND within the 15-min grace (>= 45 min).
        // Exposure 70 is ABOVE the last-hour trigger (60) — the last-hour rule alone
        // would NOT vote — but the top-up carries it to standard (100): 70 < 100.
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3000, 70), now);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('pre-last-hour top-up');
        expect(result.voteReason).toContain('70% < 100%');
    });

    test('before the boundary: labels the decision pre-last-hour and votes to standard', () => {
        // 61 min out → inside the [close-75m, close-45m] window, before the last hour.
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3660, 80), now);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('pre-last-hour top-up');
        expect(result.voteReason).toContain('80% < 100%');
    });

    test('after the grace window: defers to the last-hour rule', () => {
        // 33 min out → within the last hour but past the 15-min grace (< 45 min).
        // Exposure 70 >= last-hour trigger 60 → last-hour rule declines.
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(2000, 70), now);
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('last hour threshold');
        expect(result.voteReason).toContain('70% >= 60%');
    });

    test('feature OFF: the lower last-hour trigger applies as before (no top-up)', () => {
        const now = Math.floor(Date.now() / 1000);
        mockSettings({ voteBeforeLastHour: false });
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3000, 70), now);
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('last hour threshold');
        expect(result.voteReason).toContain('70% >= 60%');
    });

    test('gated on useLastHourExposure: no top-up branch when the last-hour feature is off', () => {
        // In the grace window with the top-up flag on but useLastHourExposure off,
        // the normal rule runs (not pre-last-hour): exposure 100 >= standard 100.
        const now = Math.floor(Date.now() / 1000);
        mockSettings({ useLastHourExposure: false });
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3000, 100), now);
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('normal threshold');
        expect(result.voteReason).not.toContain('pre-last-hour');
    });

    test('stops at target: no vote once exposure already reached the standard target', () => {
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3000, 100), now);
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('pre-last-hour top-up');
        expect(result.voteReason).toContain('100% >= 100%');
    });

    test('a NaN lead minutes falls back to the 15-min default window', () => {
        // 50 min out is inside a 15-min grace; leave the lead unset so it resolves
        // to undefined → NaN → the fallback keeps the window at 15 min.
        const now = Math.floor(Date.now() / 1000);
        mockSettings({ voteBeforeLastHourLeadMin: undefined });
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3000, 70), now);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('pre-last-hour top-up');
    });
});
