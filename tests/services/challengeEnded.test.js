/**
 * Tests for the "challenge has ended" guard in VotingLogic.
 *
 * `isWithinLastHour` and `isWithinLastMinuteThreshold` both require `timeUntilEnd > 0`, so
 * before this guard existed a challenge whose close_time had passed fell through every
 * time-window rule and landed on the *normal* threshold rule — voting on a closed challenge
 * at the ordinary exposure target. The orchestrator does no close-time filtering of its own
 * (it trusts getActiveChallenges), and it captures `now` per challenge, so a challenge that
 * closes partway through a pass reaches this code with a close_time in the past.
 *
 * The guard is deliberately symmetric with the existing "challenge not started" rule: auto
 * mode only, and positioned ahead of the flash branch so a closed flash challenge is skipped
 * too rather than being voted to 100%.
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');
const { buildChallenge: buildBaseChallenge } = require('../helpers/challengeFixtures');

jest.mock('../../src/js/settings');

const NOW = Math.floor(Date.now() / 1000);

const buildChallenge = ({ closeInSeconds, type = 'regular' }) =>
    buildBaseChallenge({
        id: '999',
        title: 'Ended Challenge',
        type,
        close_time: NOW + closeInSeconds,
        start_time: NOW - 3600,
        member: { ranking: { exposure: { exposure_factor: 10 } } },
    });

const mockSettings = (overrides = {}) => {
    const defaults = {
        onlyBoost: false,
        voteOnlyInLastMinute: false,
        exposure: 50,
        exposureTarget: 0,
        lastMinuteThreshold: 10,
        lastHourExposure: 40,
        useLastHourExposure: false,
        lastHourExposureTarget: 0,
        useScheduledFill: false,
        scheduledFillTime: [],
        scheduledFillBeforeEnd: [],
        scheduledFillReplaces: false,
    };
    settings.getEffectiveSetting = jest.fn((key) => ({ ...defaults, ...overrides })[key]);
    settings.getSetting = jest.fn((key) => ({ ...defaults, ...overrides })[key]);
};

describe('VotingLogic — challenge has ended', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockSettings();
    });

    test.each([0, -1, -60, -86400])('blocks voting when close_time has passed (closeIn=%is)', (closeInSeconds) => {
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds }), NOW);

        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('ended');
    });

    test('still votes with one second left', () => {
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds: 1 }), NOW);

        expect(result.shouldVote).toBe(true);
        // Inside the last-minute window, so the exposure cap is ignored.
        expect(result.targetExposure).toBe(100);
    });

    test('does not disturb an ordinary open challenge', () => {
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds: 7200 }), NOW);

        expect(result.shouldVote).toBe(true);
        expect(result.targetExposure).toBe(50);
    });

    test('blocks a closed flash challenge instead of voting it to 100%', () => {
        // Flash otherwise wins unconditionally, which is why the guard sits above it.
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds: -60, type: 'flash' }), NOW);

        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('ended');
    });

    test('an open flash challenge is unaffected', () => {
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds: 7200, type: 'flash' }), NOW);

        expect(result.shouldVote).toBe(true);
        expect(result.targetExposure).toBe(100);
    });
});
