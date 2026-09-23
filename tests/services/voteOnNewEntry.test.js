/**
 * Tests for the `voteOnNewEntry` forced-vote path in VotingLogic.
 *
 * Adding a photo to a challenge can leave it between a rule's trigger and target.
 * With the setting on, a detected new entry bridges that gap, but it must not
 * trigger another vote-pool fetch once the target is already met.
 *
 * Two contracts are load-bearing here:
 *   1. It may defeat the trigger check only while exposure remains below the
 *      target. onlyBoost, vote-only-in-last-minute, scheduled-fill-only and
 *      not-yet-started all still block — the user chose "no precedence overrides".
 *   2. The emitted reason must never contain a false comparison. Forcing flips
 *      `atTarget`, and the organic per-label templates pick their `<` / `>=`
 *      wording off that flag, so reusing them would print "exposure 100% < 90%".
 *
 * Note VotingLogic does NOT read the setting: it takes an already-gated
 * `hasNewEntry` boolean from the orchestrator, so these tests pass the flag
 * directly.
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');
const { buildChallenge: buildBaseChallenge } = require('../helpers/challengeFixtures');

jest.mock('../../src/js/settings');

const NOW = Math.floor(Date.now() / 1000);

const buildChallenge = ({ exposureFactor, closeInSeconds = 7200, type = 'regular', startOffset = -3600 }) =>
    buildBaseChallenge({
        id: '777',
        title: 'New Entry Challenge',
        type,
        close_time: NOW + closeInSeconds,
        start_time: NOW + startOffset,
        member: { ranking: { exposure: { exposure_factor: exposureFactor } } },
    });

const mockSettings = (overrides = {}) => {
    const defaults = {
        onlyBoost: false,
        voteOnlyInLastMinute: false,
        exposure: 90,
        lastMinuteThreshold: 10,
        finalWindowExposure: 40,
        useFinalWindowExposure: false,
        exposureTarget: 0,
        finalWindowExposureTarget: 0,
        useScheduledFill: false,
        scheduledFillReplaces: false,
        scheduledFillTime: [],
        scheduledFillBeforeEnd: [],
        scheduledFillWindowMinutes: 60,
        timezone: 'UTC',
    };
    settings.getEffectiveSetting = jest.fn((key) => ({ ...defaults, ...overrides })[key]);
};

/** Assert a reason line never claims X < Y when X >= Y. */
const expectNoFalseComparison = (reason) => {
    const match = reason.match(/(\d+)% < (\d+)%/);
    if (match) {
        const [, left, right] = match;
        expect(Number(left)).toBeLessThan(Number(right));
    }
};

describe('voteOnNewEntry — forcing past the at-target check', () => {
    beforeEach(() => jest.clearAllMocks());

    test('without the flag, exposure at the trigger still blocks (unchanged behavior)', () => {
        mockSettings({ exposure: 90 });
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ exposureFactor: 95 }), NOW);

        expect(result.shouldVote).toBe(false);
        expect(result.forcedByNewEntry).toBe(false);
        expect(result.voteReason).toContain('95% >= 90%');
    });

    test('a new entry does not vote when the target follows an already-met trigger', () => {
        mockSettings({ exposure: 90, exposureTarget: 0 });
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ exposureFactor: 95 }), NOW, {
            hasNewEntry: true,
        });

        expect(result.shouldVote).toBe(false);
        expect(result.forcedByNewEntry).toBe(false);
        // Sentinel 0 target means "follow the trigger".
        expect(result.targetExposure).toBe(90);
        expect(result.voteReason).toContain('95% >= 90%');
        expectNoFalseComparison(result.voteReason);
    });

    test('an explicit exposureTarget becomes the forced ceiling', () => {
        mockSettings({ exposure: 90, exposureTarget: 100 });
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ exposureFactor: 95 }), NOW, {
            hasNewEntry: true,
        });

        expect(result.shouldVote).toBe(true);
        expect(result.targetExposure).toBe(100);
        expect(result.voteReason).toContain('voting up to 100%');
    });

    test('exposure exactly at a trigger below the target is reported without a tautology', () => {
        mockSettings({ exposure: 90, exposureTarget: 100 });
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ exposureFactor: 90 }), NOW, {
            hasNewEntry: true,
        });

        expect(result.shouldVote).toBe(true);
        expect(result.forcedByNewEntry).toBe(true);
        expect(result.voteReason).toContain('new entry detected (exposure already at 90%)');
        expect(result.voteReason).not.toContain('90% >= 90%');
    });

    test('a new entry does not request another vote when exposure already meets the target', () => {
        mockSettings({ exposure: 70, exposureTarget: 100 });
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ exposureFactor: 100 }), NOW, {
            hasNewEntry: true,
        });

        expect(result.shouldVote).toBe(false);
        expect(result.forcedByNewEntry).toBe(false);
        expect(result.targetExposure).toBe(100);
        expect(result.voteReason).toContain('exposure 100% >= 70%');
    });

    test('exposure already below the trigger votes organically, not forced', () => {
        // Nothing to preserve across a failure here: the same eligibility recurs
        // by itself next cycle, so forcedByNewEntry must stay false.
        mockSettings({ exposure: 90 });
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ exposureFactor: 40 }), NOW, {
            hasNewEntry: true,
        });

        expect(result.shouldVote).toBe(true);
        expect(result.forcedByNewEntry).toBe(false);
        expect(result.voteReason).toContain('40% < 90%');
    });

    test('the final-window rule forces up to finalWindowExposureTarget', () => {
        mockSettings({
            useFinalWindowExposure: true,
            finalWindowExposure: 40,
            finalWindowExposureTarget: 80,
        });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 50, closeInSeconds: 1800 }),
            NOW,
            { hasNewEntry: true },
        );

        expect(result.shouldVote).toBe(true);
        expect(result.forcedByNewEntry).toBe(true);
        expect(result.targetExposure).toBe(80);
        expect(result.voteReason).toContain('final window threshold');
        expect(result.voteReason).toContain('50% >= 40%');
        expectNoFalseComparison(result.voteReason);
    });
});

describe('voteOnNewEntry — target ceilings stay authoritative for every rule label', () => {
    beforeEach(() => jest.clearAllMocks());

    const cases = [
        {
            label: 'flash',
            setup: () => mockSettings({}),
            challenge: () => buildChallenge({ exposureFactor: 100, type: 'flash' }),
            expectText: 'flash type',
        },
        {
            label: 'lastminute',
            setup: () => mockSettings({ lastMinuteThreshold: 10 }),
            challenge: () => buildChallenge({ exposureFactor: 100, closeInSeconds: 300 }),
            expectText: 'lastminute threshold',
        },
        {
            label: 'final-window',
            setup: () => mockSettings({ useFinalWindowExposure: true, finalWindowExposure: 40 }),
            challenge: () => buildChallenge({ exposureFactor: 100, closeInSeconds: 1800 }),
            expectText: 'final window threshold',
        },
        {
            label: 'normal',
            setup: () => mockSettings({ exposure: 90 }),
            challenge: () => buildChallenge({ exposureFactor: 100 }),
            expectText: 'normal threshold',
        },
    ];

    test.each(cases)('$label: a new entry does not vote past the target', ({ setup, challenge, expectText }) => {
        setup();
        const result = VotingLogic.evaluateVotingDecision(challenge(), NOW, { hasNewEntry: true });

        expect(result.shouldVote).toBe(false);
        expect(result.forcedByNewEntry).toBe(false);
        expect(result.voteReason).toContain(expectText);
        expect(result.voteReason).not.toContain('new entry detected');
        expect(result.voteReason).not.toMatch(/100% < /);
        expectNoFalseComparison(result.voteReason);
    });

    test('scheduled fill window: a new entry does not vote past 100%', () => {
        mockSettings({
            useScheduledFill: true,
            scheduledFillBeforeEnd: [3600],
            scheduledFillWindowMinutes: 60,
        });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 100, closeInSeconds: 1800 }),
            NOW,
            { hasNewEntry: true },
        );

        expect(result.shouldVote).toBe(false);
        expect(result.forcedByNewEntry).toBe(false);
        expect(result.voteReason).toContain('scheduled fill');
        expect(result.voteReason).not.toContain('new entry detected');
        expect(result.voteReason).not.toMatch(/100% < /);
    });
});

describe('voteOnNewEntry — overrides nothing that blocks', () => {
    beforeEach(() => jest.clearAllMocks());

    test('onlyBoost still blocks', () => {
        mockSettings({ onlyBoost: true });
        const result = VotingLogic.evaluateVotingDecision(buildChallenge({ exposureFactor: 100 }), NOW, {
            hasNewEntry: true,
        });

        expect(result.shouldVote).toBe(false);
        expect(result.forcedByNewEntry).toBe(false);
        expect(result.voteReason).toContain('boost-only mode enabled');
    });

    test('voteOnlyInLastMinute still blocks outside the window', () => {
        mockSettings({ voteOnlyInLastMinute: true, lastMinuteThreshold: 10 });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 100, closeInSeconds: 7200 }),
            NOW,
            { hasNewEntry: true },
        );

        expect(result.shouldVote).toBe(false);
        expect(result.forcedByNewEntry).toBe(false);
        expect(result.voteReason).toContain('vote-only-in-last-threshold');
    });

    test('scheduled-fill-only still blocks outside the window', () => {
        mockSettings({
            useScheduledFill: true,
            scheduledFillReplaces: true,
            scheduledFillBeforeEnd: [600],
            scheduledFillWindowMinutes: 5,
        });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 100, closeInSeconds: 7200 }),
            NOW,
            { hasNewEntry: true },
        );

        expect(result.shouldVote).toBe(false);
        expect(result.forcedByNewEntry).toBe(false);
        expect(result.voteReason).toContain('scheduled-fill-only');
    });

    test('a challenge that has not started still blocks', () => {
        mockSettings({});
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 100, startOffset: 3600 }),
            NOW,
            { hasNewEntry: true },
        );

        expect(result.shouldVote).toBe(false);
        expect(result.forcedByNewEntry).toBe(false);
        expect(result.voteReason).toContain('challenge not started');
    });
});

describe('voteOnNewEntry — manual voting is unaffected', () => {
    beforeEach(() => jest.clearAllMocks());

    test('manual evaluator still refuses a challenge already at its threshold', () => {
        mockSettings({ exposure: 90 });
        const result = VotingLogic.evaluateManualVotingDecision(buildChallenge({ exposureFactor: 95 }), NOW, 'Title');

        expect(result.shouldAllowVoting).toBe(false);
        expect(result.errorMessage).toContain('already has 90% exposure');
    });
});
