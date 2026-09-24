/**
 * Test suite for useFinalWindowExposure setting functionality
 *
 * This test verifies that the useFinalWindowExposure setting correctly controls
 * whether the final window exposure logic is applied or not.
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');

// Mock the settings module
jest.mock('../../src/js/settings');

describe('useFinalWindowExposure setting', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // Mock the getEffectiveSetting function
        settings.getEffectiveSetting = jest.fn();
    });

    test('should use final window exposure logic when useFinalWindowExposure is true', () => {
        // Mock challenge data within final window
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now (within final window)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 75, // Below finalWindowExposure threshold
                    },
                },
            },
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings - useFinalWindowExposure is TRUE
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
                case 'finalWindowExposure':
                    return 80;
                case 'useFinalWindowExposure':
                    return true; // This is the key setting
                default:
                    return undefined;
            }
        });

        // Evaluate voting decision
        const result = VotingLogic.evaluateVotingDecision(challenge, now);

        // Should vote because exposure (75%) < finalWindowExposure (80%) and useFinalWindowExposure is true
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('final window threshold');
        expect(result.voteReason).toContain('75% < 80%');
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('useFinalWindowExposure', '123');
    });

    test('should NOT use final window exposure logic when useFinalWindowExposure is false', () => {
        // Mock challenge data within final window
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now (within final window)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 75, // Below normal exposure threshold but above finalWindowExposure
                    },
                },
            },
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings - useFinalWindowExposure is FALSE
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
                case 'finalWindowExposure':
                    return 80;
                case 'useFinalWindowExposure':
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
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('useFinalWindowExposure', '123');
    });

    test('should not vote when useFinalWindowExposure is false and exposure is above normal threshold', () => {
        // Mock challenge data within final window
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now (within final window)
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

        // Mock settings - useFinalWindowExposure is FALSE
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
                case 'finalWindowExposure':
                    return 80;
                case 'useFinalWindowExposure':
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

    test('should still use normal logic when outside final window even if useFinalWindowExposure is true', () => {
        // Mock challenge data outside final window
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 7200, // 2 hours from now (outside final window)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 85, // Above finalWindowExposure but below normal
                    },
                },
            },
        };

        const now = Math.floor(Date.now() / 1000);

        // Mock settings - useFinalWindowExposure is TRUE but we're outside final window
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
                case 'finalWindowExposure':
                    return 80;
                case 'useFinalWindowExposure':
                    return true; // This setting is true
                default:
                    return undefined;
            }
        });

        // Evaluate voting decision
        const result = VotingLogic.evaluateVotingDecision(challenge, now);

        // Should vote using normal logic because we're outside the final window
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
            close_time: now + 7200, // 2 hours out — outside final window and last minute
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
                case 'finalWindowExposure':
                    return 100;
                case 'useFinalWindowExposure':
                    return false;
                default:
                    return undefined;
            }
        });

        const result = VotingLogic.evaluateVotingDecision(challenge, now);

        // The target is the configured 70% ceiling, not a hardcoded 100: 80 >= 70, so no vote.
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('normal threshold');
        expect(result.voteReason).toContain('80% >= 70%');
    });

    test('should handle per-challenge useFinalWindowExposure override correctly', () => {
        // Mock challenge data within final window
        const challenge = {
            id: '456',
            title: 'Test Challenge with Override',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now (within final window)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 70, // Below finalWindowExposure threshold
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
                case 'finalWindowExposure':
                    return 75; // Per-challenge override
                case 'useFinalWindowExposure':
                    return true; // Per-challenge override enabled
                default:
                    return undefined;
            }
        });

        // Evaluate voting decision
        const result = VotingLogic.evaluateVotingDecision(challenge, now);

        // Should vote because exposure (70%) < finalWindowExposure (75%) and useFinalWindowExposure is true
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('final window threshold');
        expect(result.voteReason).toContain('70% < 75%');
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('useFinalWindowExposure', '456');
    });
});

describe('voteBeforeFinalWindow pre-final-window top-up', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        settings.getEffectiveSetting = jest.fn();
    });

    // Shared mock: standard exposure 100, a LOWER final-window trigger 60, both
    // final-window and the new top-up feature ON, lead 15 min. Overridable per test.
    const mockSettings = (over = {}) => {
        const base = {
            onlyBoost: false,
            voteOnlyInLastMinute: false,
            exposure: 100,
            lastMinuteThreshold: 10,
            finalWindowExposure: 60,
            useFinalWindowExposure: true,
            voteBeforeFinalWindow: true,
            voteBeforeFinalWindowLeadMin: 15,
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

    test('in-hour grace: tops up to the STANDARD target, overriding the lower final-window trigger', () => {
        // 50 min out → within the final window AND within the 15-min grace (>= 45 min).
        // Exposure 70 is ABOVE the final-window trigger (60) — the final-window rule alone
        // would NOT vote — but the top-up carries it to standard (100): 70 < 100.
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3000, 70), now);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('pre-final-window top-up');
        expect(result.voteReason).toContain('70% < 100%');
    });

    test('before the boundary: labels the decision pre-final-window and votes to standard', () => {
        // 61 min out → inside the [close-75m, close-45m] window, before the final window.
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3660, 80), now);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('pre-final-window top-up');
        expect(result.voteReason).toContain('80% < 100%');
    });

    test('after the grace window: defers to the final-window rule', () => {
        // 33 min out → within the final window but past the 15-min grace (< 45 min).
        // Exposure 70 >= final-window trigger 60 → final-window rule declines.
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(2000, 70), now);
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('final window threshold');
        expect(result.voteReason).toContain('70% >= 60%');
    });

    test('feature OFF: the lower final-window trigger applies as before (no top-up)', () => {
        const now = Math.floor(Date.now() / 1000);
        mockSettings({ voteBeforeFinalWindow: false });
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3000, 70), now);
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('final window threshold');
        expect(result.voteReason).toContain('70% >= 60%');
    });

    test('gated on useFinalWindowExposure: no top-up branch when the final-window feature is off', () => {
        // In the grace window with the top-up flag on but useFinalWindowExposure off,
        // the normal rule runs (not pre-final-window): exposure 100 >= standard 100.
        const now = Math.floor(Date.now() / 1000);
        mockSettings({ useFinalWindowExposure: false });
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3000, 100), now);
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('normal threshold');
        expect(result.voteReason).not.toContain('pre-final-window');
    });

    test('stops at target: no vote once exposure already reached the standard target', () => {
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3000, 100), now);
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('pre-final-window top-up');
        expect(result.voteReason).toContain('100% >= 100%');
    });

    test('a NaN lead minutes falls back to the 15-min default window', () => {
        // 50 min out is inside a 15-min grace; leave the lead unset so it resolves
        // to undefined → NaN → the fallback keeps the window at 15 min.
        const now = Math.floor(Date.now() / 1000);
        mockSettings({ voteBeforeFinalWindowLeadMin: undefined });
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3000, 70), now);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('pre-final-window top-up');
    });

    // Exact-boundary edges of the straddle window [close-3600-lead, close-3600+lead].
    // Both comparisons in _runVotingRules are inclusive (<= upper, >= lower), so the
    // instant AT each edge is inside and one second outside is not. Lead 15 → the
    // window is [close-4500s, close-2700s].
    test('upper edge (timeUntilEnd === 3600 + lead): inclusive — still tops up to standard', () => {
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3600 + 900, 80), now);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('pre-final-window top-up');
        expect(result.voteReason).toContain('80% < 100%');
    });

    test('one second past the upper edge: the normal rule runs, not the top-up', () => {
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        // 4501s out is before the final window AND outside the top-up window, so the
        // decision falls through to the normal threshold (standard 100).
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3600 + 901, 80), now);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('normal threshold');
        expect(result.voteReason).not.toContain('pre-final-window');
    });

    test('lower edge (timeUntilEnd === 3600 - lead): inclusive — the top-up still wins over final-window', () => {
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        // 2700s out is inside the final window but exactly on the grace edge; the top-up
        // overrides the lower final-window trigger and votes 70 up to standard.
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3600 - 900, 70), now);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('pre-final-window top-up');
        expect(result.voteReason).toContain('70% < 100%');
    });

    test('one second past the lower edge: defers to the final-window rule', () => {
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        // 2699s out is past the grace edge; the final-window rule takes over and, with
        // exposure 70 above its 60 trigger, declines.
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3600 - 901, 70), now);
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('final window threshold');
        expect(result.voteReason).toContain('70% >= 60%');
    });

    test('scheduled fill outranks the top-up: a live fill window forces 100 first', () => {
        const now = Math.floor(Date.now() / 1000);
        // In the top-up window (3000s out) but a before-end scheduled-fill window is
        // also open right now (start = close - 3000 = now). Scheduled fill sits ABOVE
        // pre-final-window in the precedence, so the decision is 'scheduled', not the top-up.
        mockSettings({
            useScheduledFill: true,
            scheduledFillBeforeEnd: [3000],
            scheduledFillWindowMinutes: 60,
        });
        const result = VotingLogic.evaluateVotingDecision(challengeClosingIn(3000, 70), now);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('scheduled fill window');
        expect(result.voteReason).not.toContain('pre-final-window');
    });

    // Manual path reuses the same rule engine (mode 'manual'); its at-target branch
    // must surface the pre-final-window message, and below-target must allow the vote.
    test('manual path: at standard target inside the window reports the pre-final-window message', () => {
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        const result = VotingLogic.evaluateManualVotingDecision(challengeClosingIn(3000, 100), now, 'Test Challenge');
        expect(result.shouldAllowVoting).toBe(false);
        expect(result.errorMessage).toContain('pre-final-window top-up');
        expect(result.errorMessage).toContain('100%');
    });

    test('manual path: below the standard target inside the window allows voting', () => {
        const now = Math.floor(Date.now() / 1000);
        mockSettings();
        const result = VotingLogic.evaluateManualVotingDecision(challengeClosingIn(3000, 70), now, 'Test Challenge');
        expect(result.shouldAllowVoting).toBe(true);
        expect(result.errorMessage).toBe('');
    });
});
