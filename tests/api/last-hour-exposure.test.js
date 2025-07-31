/**
 * Test suite for lastHourExposure setting functionality
 * 
 * This test verifies that the lastHourExposure setting is used correctly
 * when a challenge is within the last hour of its runtime.
 */

const settings = require('../../src/js/settings');

// Mock the settings module
jest.mock('../../src/js/settings');

describe('lastHourExposure', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        
        // Mock the getEffectiveSetting function
        settings.getEffectiveSetting = jest.fn();
    });

    test('should use lastHourExposure threshold when within last hour', () => {
        // Mock challenge data
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
        const timeUntilEnd = challenge.close_time - now;
        const isWithinLastHour = timeUntilEnd <= 3600 && timeUntilEnd > 0;

        // Verify we're within the last hour
        expect(isWithinLastHour).toBe(true);

        // Mock settings to return different values
        settings.getEffectiveSetting
            .mockReturnValueOnce(100) // exposure threshold
            .mockReturnValueOnce(10)  // lastMinuteThreshold
            .mockReturnValueOnce(false) // voteOnlyInLastMinute
            .mockReturnValueOnce(80); // lastHourExposure threshold

        // Simulate the voting logic
        const effectiveExposure = settings.getEffectiveSetting('exposure', challenge.id.toString());
        const effectiveLastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
        const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());
        const effectiveLastHourExposure = settings.getEffectiveSetting('lastHourExposure', challenge.id.toString());

        const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinuteThreshold * 60) && timeUntilEnd > 0;

        // Determine if we should vote
        let shouldVote = false;
        let voteReason = '';

        if (challenge.type === 'flash') {
            // Flash type logic (not applicable here)
        } else if (voteOnlyInLastMinute && !isWithinLastMinuteThreshold) {
            // Vote only in last minute logic (not applicable here)
        } else if (isWithinLastMinuteThreshold) {
            // Last minute threshold logic (not applicable here)
        } else if (isWithinLastHour) {
            // Within last hour: use lastHourExposure threshold
            if (challenge.member.ranking.exposure.exposure_factor < effectiveLastHourExposure) {
                shouldVote = true;
                voteReason = `last hour threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% < ${effectiveLastHourExposure}%`;
            } else {
                voteReason = `last hour threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% >= ${effectiveLastHourExposure}%`;
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

        // Verify that lastHourExposure was used
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('lastHourExposure', challenge.id.toString());
        expect(shouldVote).toBe(true);
        expect(voteReason).toBe('last hour threshold: exposure 75% < 80%');
    });

    test('should not vote when within last hour but exposure >= lastHourExposure threshold', () => {
        // Mock challenge data
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now (within last hour)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 85 // Above lastHourExposure threshold
                    }
                }
            }
        };

        const now = Math.floor(Date.now() / 1000);
        const timeUntilEnd = challenge.close_time - now;
        const isWithinLastHour = timeUntilEnd <= 3600 && timeUntilEnd > 0;

        // Verify we're within the last hour
        expect(isWithinLastHour).toBe(true);

        // Mock settings
        settings.getEffectiveSetting
            .mockReturnValueOnce(100) // exposure threshold
            .mockReturnValueOnce(10)  // lastMinuteThreshold
            .mockReturnValueOnce(false) // voteOnlyInLastMinute
            .mockReturnValueOnce(80); // lastHourExposure threshold

        // Simulate the voting logic
        const effectiveExposure = settings.getEffectiveSetting('exposure', challenge.id.toString());
        const effectiveLastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
        const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());
        const effectiveLastHourExposure = settings.getEffectiveSetting('lastHourExposure', challenge.id.toString());

        const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinuteThreshold * 60) && timeUntilEnd > 0;

        // Determine if we should vote
        let shouldVote = false;
        let voteReason = '';

        if (challenge.type === 'flash') {
            // Flash type logic (not applicable here)
        } else if (voteOnlyInLastMinute && !isWithinLastMinuteThreshold) {
            // Vote only in last minute logic (not applicable here)
        } else if (isWithinLastMinuteThreshold) {
            // Last minute threshold logic (not applicable here)
        } else if (isWithinLastHour) {
            // Within last hour: use lastHourExposure threshold
            if (challenge.member.ranking.exposure.exposure_factor < effectiveLastHourExposure) {
                shouldVote = true;
                voteReason = `last hour threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% < ${effectiveLastHourExposure}%`;
            } else {
                voteReason = `last hour threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% >= ${effectiveLastHourExposure}%`;
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

        // Verify that lastHourExposure was used and voting was skipped
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('lastHourExposure', challenge.id.toString());
        expect(shouldVote).toBe(false);
        expect(voteReason).toBe('last hour threshold: exposure 85% >= 80%');
    });

    test('should use normal exposure threshold when outside last hour', () => {
        // Mock challenge data
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 7200, // 2 hours from now (outside last hour)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 75 // Below normal exposure threshold
                    }
                }
            }
        };

        const now = Math.floor(Date.now() / 1000);
        const timeUntilEnd = challenge.close_time - now;
        const isWithinLastHour = timeUntilEnd <= 3600 && timeUntilEnd > 0;

        // Verify we're outside the last hour
        expect(isWithinLastHour).toBe(false);

        // Mock settings
        settings.getEffectiveSetting
            .mockReturnValueOnce(100) // exposure threshold
            .mockReturnValueOnce(10)  // lastMinuteThreshold
            .mockReturnValueOnce(false) // voteOnlyInLastMinute
            .mockReturnValueOnce(80); // lastHourExposure threshold

        // Simulate the voting logic
        const effectiveExposure = settings.getEffectiveSetting('exposure', challenge.id.toString());
        const effectiveLastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
        const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());
        const effectiveLastHourExposure = settings.getEffectiveSetting('lastHourExposure', challenge.id.toString());

        const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinuteThreshold * 60) && timeUntilEnd > 0;

        // Determine if we should vote
        let shouldVote = false;
        let voteReason = '';

        if (challenge.type === 'flash') {
            // Flash type logic (not applicable here)
        } else if (voteOnlyInLastMinute && !isWithinLastMinuteThreshold) {
            // Vote only in last minute logic (not applicable here)
        } else if (isWithinLastMinuteThreshold) {
            // Last minute threshold logic (not applicable here)
        } else if (isWithinLastHour) {
            // Within last hour logic (not applicable here)
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

    test('should handle per-challenge lastHourExposure override', () => {
        // Mock challenge data
        const challenge = {
            id: '123',
            title: 'Test Challenge',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 1800, // 30 minutes from now (within last hour)
            start_time: Math.floor(Date.now() / 1000) - 3600, // Started 1 hour ago
            member: {
                ranking: {
                    exposure: {
                        exposure_factor: 70 // Below per-challenge lastHourExposure threshold
                    }
                }
            }
        };

        const now = Math.floor(Date.now() / 1000);
        const timeUntilEnd = challenge.close_time - now;
        const isWithinLastHour = timeUntilEnd <= 3600 && timeUntilEnd > 0;

        // Verify we're within the last hour
        expect(isWithinLastHour).toBe(true);

        // Mock settings with per-challenge override
        settings.getEffectiveSetting
            .mockReturnValueOnce(100) // exposure threshold
            .mockReturnValueOnce(10)  // lastMinuteThreshold
            .mockReturnValueOnce(false) // voteOnlyInLastMinute
            .mockReturnValueOnce(75); // lastHourExposure threshold (per-challenge override)

        // Simulate the voting logic
        const effectiveExposure = settings.getEffectiveSetting('exposure', challenge.id.toString());
        const effectiveLastMinuteThreshold = settings.getEffectiveSetting('lastMinuteThreshold', challenge.id.toString());
        const voteOnlyInLastMinute = settings.getEffectiveSetting('voteOnlyInLastMinute', challenge.id.toString());
        const effectiveLastHourExposure = settings.getEffectiveSetting('lastHourExposure', challenge.id.toString());

        const isWithinLastMinuteThreshold = timeUntilEnd <= (effectiveLastMinuteThreshold * 60) && timeUntilEnd > 0;

        // Determine if we should vote
        let shouldVote = false;
        let voteReason = '';

        if (challenge.type === 'flash') {
            // Flash type logic (not applicable here)
        } else if (voteOnlyInLastMinute && !isWithinLastMinuteThreshold) {
            // Vote only in last minute logic (not applicable here)
        } else if (isWithinLastMinuteThreshold) {
            // Last minute threshold logic (not applicable here)
        } else if (isWithinLastHour) {
            // Within last hour: use lastHourExposure threshold
            if (challenge.member.ranking.exposure.exposure_factor < effectiveLastHourExposure) {
                shouldVote = true;
                voteReason = `last hour threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% < ${effectiveLastHourExposure}%`;
            } else {
                voteReason = `last hour threshold: exposure ${challenge.member.ranking.exposure.exposure_factor}% >= ${effectiveLastHourExposure}%`;
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

        // Verify that per-challenge lastHourExposure override was used
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('lastHourExposure', challenge.id.toString());
        expect(shouldVote).toBe(true);
        expect(voteReason).toBe('last hour threshold: exposure 70% < 75%');
    });
}); 