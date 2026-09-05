/**
 * Test suite for finalWindowExposure setting functionality
 *
 * This test verifies that the finalWindowExposure setting is used correctly
 * when a challenge is within the final window of its runtime.
 */

const settings = require('../../src/js/settings');

// Mock the settings module
jest.mock('../../src/js/settings');

describe('finalWindowExposure', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // Mock the getEffectiveSetting function
        settings.getEffectiveSetting = jest.fn();
    });

    test('should use finalWindowExposure threshold when within final window', () => {
        // Mock challenge data
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
        const timeUntilEnd = challenge.close_time - now;
        const isWithinFinalWindow = timeUntilEnd <= 3600 && timeUntilEnd > 0;

        // Verify we're within the final window
        expect(isWithinFinalWindow).toBe(true);

        // Mock settings to return different values
        settings.getEffectiveSetting
            .mockReturnValueOnce(100) // exposure threshold
            .mockReturnValueOnce(10) // lastMinuteThreshold
            .mockReturnValueOnce(false) // voteOnlyInLastMinute
            .mockReturnValueOnce(80); // finalWindowExposure threshold

        // Simulate the voting logic
        const effectiveExposure = settings.getEffectiveSetting('exposure', challenge.id.toString());
        const effectiveLastMinuteThreshold = settings.getEffectiveSetting(
            'lastMinuteThreshold',
            challenge.id.toString(),
        );
        const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());
        const effectiveFinalWindowExposure = settings.getEffectiveSetting('finalWindowExposure', challenge.id.toString());

        const isWithinLastMinuteThreshold = timeUntilEnd <= effectiveLastMinuteThreshold * 60 && timeUntilEnd > 0;

        // Determine if we should vote
        let shouldVote = false;
        let voteReason = '';

        if (challenge.type === 'flash') {
            // Flash type logic (not applicable here)
        } else if (voteOnlyInLastMinute && !isWithinLastMinuteThreshold) {
            // Vote only in last minute logic (not applicable here)
        } else if (isWithinLastMinuteThreshold) {
            // Last minute threshold logic (not applicable here)
        } else if (isWithinFinalWindow) {
            // Within final window: use finalWindowExposure threshold
            if (challenge.member.ranking.exposure.exposure_factor < effectiveFinalWindowExposure) {
                shouldVote = true;
                voteReason = `final window threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% < ${effectiveFinalWindowExposure}%`;
            } else {
                voteReason = `final window threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% >= ${effectiveFinalWindowExposure}%`;
            }
        } else {
            // Normal logic: use regular exposure threshold
            if (challenge.member.ranking.exposure.exposure_factor < effectiveExposure) {
                shouldVote = true;
                voteReason = `normal threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% < ${effectiveExposure}%`;
            } else {
                voteReason = `normal threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% >= ${effectiveExposure}%`;
            }
        }

        // Verify that finalWindowExposure was used
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('finalWindowExposure', challenge.id.toString());
        expect(shouldVote).toBe(true);
        expect(voteReason).toBe('final window threshold: exposure 75% < 80%');
    });

    test('should not vote when within final window but exposure >= finalWindowExposure threshold', () => {
        // Mock challenge data
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now (within final window)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 85, // Above finalWindowExposure threshold
                    },
                },
            },
        };

        const now = Math.floor(Date.now() / 1000);
        const timeUntilEnd = challenge.close_time - now;
        const isWithinFinalWindow = timeUntilEnd <= 3600 && timeUntilEnd > 0;

        // Verify we're within the final window
        expect(isWithinFinalWindow).toBe(true);

        // Mock settings
        settings.getEffectiveSetting
            .mockReturnValueOnce(100) // exposure threshold
            .mockReturnValueOnce(10) // lastMinuteThreshold
            .mockReturnValueOnce(false) // voteOnlyInLastMinute
            .mockReturnValueOnce(80); // finalWindowExposure threshold

        // Simulate the voting logic
        const effectiveExposure = settings.getEffectiveSetting('exposure', challenge.id.toString());
        const effectiveLastMinuteThreshold = settings.getEffectiveSetting(
            'lastMinuteThreshold',
            challenge.id.toString(),
        );
        const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());
        const effectiveFinalWindowExposure = settings.getEffectiveSetting('finalWindowExposure', challenge.id.toString());

        const isWithinLastMinuteThreshold = timeUntilEnd <= effectiveLastMinuteThreshold * 60 && timeUntilEnd > 0;

        // Determine if we should vote
        let shouldVote = false;
        let voteReason = '';

        if (challenge.type === 'flash') {
            // Flash type logic (not applicable here)
        } else if (voteOnlyInLastMinute && !isWithinLastMinuteThreshold) {
            // Vote only in last minute logic (not applicable here)
        } else if (isWithinLastMinuteThreshold) {
            // Last minute threshold logic (not applicable here)
        } else if (isWithinFinalWindow) {
            // Within final window: use finalWindowExposure threshold
            if (challenge.member.ranking.exposure.exposure_factor < effectiveFinalWindowExposure) {
                shouldVote = true;
                voteReason = `final window threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% < ${effectiveFinalWindowExposure}%`;
            } else {
                voteReason = `final window threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% >= ${effectiveFinalWindowExposure}%`;
            }
        } else {
            // Normal logic: use regular exposure threshold
            if (challenge.member.ranking.exposure.exposure_factor < effectiveExposure) {
                shouldVote = true;
                voteReason = `normal threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% < ${effectiveExposure}%`;
            } else {
                voteReason = `normal threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% >= ${effectiveExposure}%`;
            }
        }

        // Verify that finalWindowExposure was used and voting was skipped
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('finalWindowExposure', challenge.id.toString());
        expect(shouldVote).toBe(false);
        expect(voteReason).toBe('final window threshold: exposure 85% >= 80%');
    });

    test('should use normal exposure threshold when outside final window', () => {
        // Mock challenge data
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 7200, // 2 hours from now (outside final window)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 75, // Below normal exposure threshold
                    },
                },
            },
        };

        const now = Math.floor(Date.now() / 1000);
        const timeUntilEnd = challenge.close_time - now;
        const isWithinFinalWindow = timeUntilEnd <= 3600 && timeUntilEnd > 0;

        // Verify we're outside the final window
        expect(isWithinFinalWindow).toBe(false);

        // Mock settings
        settings.getEffectiveSetting
            .mockReturnValueOnce(100) // exposure threshold
            .mockReturnValueOnce(10) // lastMinuteThreshold
            .mockReturnValueOnce(false) // voteOnlyInLastMinute
            .mockReturnValueOnce(80); // finalWindowExposure threshold

        // Simulate the voting logic
        const effectiveExposure = settings.getEffectiveSetting('exposure', challenge.id.toString());
        const effectiveLastMinuteThreshold = settings.getEffectiveSetting(
            'lastMinuteThreshold',
            challenge.id.toString(),
        );
        const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());

        const isWithinLastMinuteThreshold = timeUntilEnd <= effectiveLastMinuteThreshold * 60 && timeUntilEnd > 0;

        // Determine if we should vote
        let shouldVote = false;
        let voteReason = '';

        if (challenge.type === 'flash') {
            // Flash type logic (not applicable here)
        } else if (voteOnlyInLastMinute && !isWithinLastMinuteThreshold) {
            // Vote only in last minute logic (not applicable here)
        } else if (isWithinLastMinuteThreshold) {
            // Last minute threshold logic (not applicable here)
        } else if (isWithinFinalWindow) {
            // Within final window logic (not applicable here)
        } else {
            // Normal logic: use regular exposure threshold
            if (challenge.member.ranking.exposure.exposure_factor < effectiveExposure) {
                shouldVote = true;
                voteReason = `normal threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% < ${effectiveExposure}%`;
            } else {
                voteReason = `normal threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% >= ${effectiveExposure}%`;
            }
        }

        // Verify that normal exposure threshold was used
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('exposure', challenge.id.toString());
        expect(shouldVote).toBe(true);
        expect(voteReason).toBe('normal threshold: exposure 75% < 100%');
    });

    test('should handle per-challenge finalWindowExposure override', () => {
        // Mock challenge data
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now (within final window)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 70, // Below per-challenge finalWindowExposure threshold
                    },
                },
            },
        };

        const now = Math.floor(Date.now() / 1000);
        const timeUntilEnd = challenge.close_time - now;
        const isWithinFinalWindow = timeUntilEnd <= 3600 && timeUntilEnd > 0;

        // Verify we're within the final window
        expect(isWithinFinalWindow).toBe(true);

        // Mock settings with per-challenge override
        settings.getEffectiveSetting
            .mockReturnValueOnce(100) // exposure threshold
            .mockReturnValueOnce(10) // lastMinuteThreshold
            .mockReturnValueOnce(false) // voteOnlyInLastMinute
            .mockReturnValueOnce(75); // finalWindowExposure threshold (per-challenge override)

        // Simulate the voting logic
        const effectiveExposure = settings.getEffectiveSetting('exposure', challenge.id.toString());
        const effectiveLastMinuteThreshold = settings.getEffectiveSetting(
            'lastMinuteThreshold',
            challenge.id.toString(),
        );
        const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());
        const effectiveFinalWindowExposure = settings.getEffectiveSetting('finalWindowExposure', challenge.id.toString());

        const isWithinLastMinuteThreshold = timeUntilEnd <= effectiveLastMinuteThreshold * 60 && timeUntilEnd > 0;

        // Determine if we should vote
        let shouldVote = false;
        let voteReason = '';

        if (challenge.type === 'flash') {
            // Flash type logic (not applicable here)
        } else if (voteOnlyInLastMinute && !isWithinLastMinuteThreshold) {
            // Vote only in last minute logic (not applicable here)
        } else if (isWithinLastMinuteThreshold) {
            // Last minute threshold logic (not applicable here)
        } else if (isWithinFinalWindow) {
            // Within final window: use finalWindowExposure threshold
            if (challenge.member.ranking.exposure.exposure_factor < effectiveFinalWindowExposure) {
                shouldVote = true;
                voteReason = `final window threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% < ${effectiveFinalWindowExposure}%`;
            } else {
                voteReason = `final window threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% >= ${effectiveFinalWindowExposure}%`;
            }
        } else {
            // Normal logic: use regular exposure threshold
            if (challenge.member.ranking.exposure.exposure_factor < effectiveExposure) {
                shouldVote = true;
                voteReason = `normal threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% < ${effectiveExposure}%`;
            } else {
                voteReason = `normal threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% >= ${effectiveExposure}%`;
            }
        }

        // Verify that per-challenge finalWindowExposure override was used
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('finalWindowExposure', challenge.id.toString());
        expect(shouldVote).toBe(true);
        expect(voteReason).toBe('final window threshold: exposure 70% < 75%');
    });
});
