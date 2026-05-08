/**
 * Tests for the exposure trigger/target split in VotingLogic.
 *
 * Today both `exposure` and `lastHourExposure` act as a single threshold that's
 * also the loop ceiling. The new `exposureTarget` and `lastHourExposureTarget`
 * settings let users decouple the "vote if below" trigger from the "vote up to"
 * target — with a sentinel value of 0 meaning "follow the trigger" (legacy
 * behavior, the default).
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');

jest.mock('../../src/js/settings');

const buildChallenge = ({ exposureFactor, closeInSeconds }) => {
    const now = Math.floor(Date.now() / 1000);
    return {
        id: '999',
        title: 'Target Split Challenge',
        type: 'regular',
        close_time: now + closeInSeconds,
        start_time: now - 3600,
        member: { ranking: { exposure: { exposure_factor: exposureFactor } } },
    };
};

const mockSettings = (overrides = {}) => {
    const defaults = {
        onlyBoost: false,
        voteOnlyInLastMinute: false,
        exposure: 50,
        lastMinuteThreshold: 10,
        lastHourExposure: 40,
        useLastHourExposure: false,
        exposureTarget: 0,
        lastHourExposureTarget: 0,
    };
    settings.getEffectiveSetting = jest.fn((key) => ({ ...defaults, ...overrides })[key]);
};

describe('exposureTarget — normal rule', () => {
    beforeEach(() => jest.clearAllMocks());

    test('sentinel 0 preserves legacy behavior (target == trigger)', () => {
        mockSettings({ exposure: 50, exposureTarget: 0 });
        const challenge = buildChallenge({ exposureFactor: 30, closeInSeconds: 7200 });
        const result = VotingLogic.evaluateVotingDecision(challenge, Math.floor(Date.now() / 1000));

        expect(result.shouldVote).toBe(true);
        expect(result.targetExposure).toBe(50);
        expect(result.voteReason).toContain('30% < 50%');
        expect(result.voteReason).not.toContain('vote up to');
    });

    test('explicit higher target keeps trigger eligibility but lifts the loop ceiling', () => {
        mockSettings({ exposure: 50, exposureTarget: 100 });
        const challenge = buildChallenge({ exposureFactor: 30, closeInSeconds: 7200 });
        const result = VotingLogic.evaluateVotingDecision(challenge, Math.floor(Date.now() / 1000));

        expect(result.shouldVote).toBe(true);
        expect(result.targetExposure).toBe(100);
        expect(result.voteReason).toContain('30% < 50%');
        expect(result.voteReason).toContain('vote up to 100%');
    });

    test('current exposure at trigger blocks voting even when target is higher', () => {
        mockSettings({ exposure: 50, exposureTarget: 100 });
        const challenge = buildChallenge({ exposureFactor: 50, closeInSeconds: 7200 });
        const result = VotingLogic.evaluateVotingDecision(challenge, Math.floor(Date.now() / 1000));

        // Trigger is the eligibility gate — once reached, we don't keep climbing toward the target.
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('50% >= 50%');
    });

    test('explicit equal target reads identically to legacy', () => {
        mockSettings({ exposure: 60, exposureTarget: 60 });
        const challenge = buildChallenge({ exposureFactor: 40, closeInSeconds: 7200 });
        const result = VotingLogic.evaluateVotingDecision(challenge, Math.floor(Date.now() / 1000));

        expect(result.shouldVote).toBe(true);
        expect(result.targetExposure).toBe(60);
        expect(result.voteReason).not.toContain('vote up to');
    });
});

describe('lastHourExposureTarget — last-hour rule', () => {
    beforeEach(() => jest.clearAllMocks());

    test('sentinel 0 preserves legacy behavior in the last-hour window', () => {
        mockSettings({
            useLastHourExposure: true,
            lastHourExposure: 40,
            lastHourExposureTarget: 0,
        });
        const challenge = buildChallenge({ exposureFactor: 25, closeInSeconds: 1800 });
        const result = VotingLogic.evaluateVotingDecision(challenge, Math.floor(Date.now() / 1000));

        expect(result.shouldVote).toBe(true);
        expect(result.targetExposure).toBe(40);
        expect(result.voteReason).toContain('last hour threshold');
        expect(result.voteReason).toContain('25% < 40%');
        expect(result.voteReason).not.toContain('vote up to');
    });

    test('explicit higher target lifts the loop ceiling in the last-hour window', () => {
        mockSettings({
            useLastHourExposure: true,
            lastHourExposure: 40,
            lastHourExposureTarget: 80,
        });
        const challenge = buildChallenge({ exposureFactor: 25, closeInSeconds: 1800 });
        const result = VotingLogic.evaluateVotingDecision(challenge, Math.floor(Date.now() / 1000));

        expect(result.shouldVote).toBe(true);
        expect(result.targetExposure).toBe(80);
        expect(result.voteReason).toContain('vote up to 80%');
    });
});

describe('flash and lastminute rules ignore the target setting', () => {
    beforeEach(() => jest.clearAllMocks());

    test('flash type stays pinned to 100', () => {
        mockSettings({ exposure: 50, exposureTarget: 70 });
        const challenge = buildChallenge({ exposureFactor: 30, closeInSeconds: 7200 });
        challenge.type = 'flash';

        const result = VotingLogic.evaluateVotingDecision(challenge, Math.floor(Date.now() / 1000));
        expect(result.targetExposure).toBe(100);
        expect(result.voteReason).toContain('flash type');
    });

    test('lastminute window stays pinned to 100', () => {
        mockSettings({ exposure: 50, exposureTarget: 70, lastMinuteThreshold: 10 });
        // 5 minutes left → within 10-minute lastminute threshold.
        const challenge = buildChallenge({ exposureFactor: 30, closeInSeconds: 5 * 60 });

        const result = VotingLogic.evaluateVotingDecision(challenge, Math.floor(Date.now() / 1000));
        expect(result.targetExposure).toBe(100);
        expect(result.voteReason).toContain('lastminute threshold');
    });
});

describe('resolver helpers', () => {
    beforeEach(() => jest.clearAllMocks());

    test('getEffectiveExposureTarget returns trigger when sentinel is 0', () => {
        mockSettings({ exposure: 60, exposureTarget: 0 });
        expect(VotingLogic.getEffectiveExposureTarget('999')).toBe(60);
    });

    test('getEffectiveExposureTarget returns the configured value when set', () => {
        mockSettings({ exposure: 60, exposureTarget: 95 });
        expect(VotingLogic.getEffectiveExposureTarget('999')).toBe(95);
    });

    test('getEffectiveLastHourExposureTarget returns trigger when sentinel is 0', () => {
        mockSettings({ lastHourExposure: 35, lastHourExposureTarget: 0 });
        expect(VotingLogic.getEffectiveLastHourExposureTarget('999')).toBe(35);
    });

    test('getEffectiveLastHourExposureTarget returns the configured value when set', () => {
        mockSettings({ lastHourExposure: 35, lastHourExposureTarget: 90 });
        expect(VotingLogic.getEffectiveLastHourExposureTarget('999')).toBe(90);
    });
});
