/**
 * Scheduled-fill rule in VotingLogic (issue #26).
 *
 * The scheduled rule sits between last-minute (always wins) and the threshold
 * rules (which it can replace). `getScheduledFillState.active` requires
 * useScheduledFill AND at least one configured time form; corrupt persisted
 * values must degrade the feature to "off" for that challenge, never throw
 * into the per-challenge voting loop.
 *
 * Most rule-chain cases use the before-end form (pure close_time math, no
 * timezone dependency); the time-of-day cases pin `now` to fixed epochs and
 * run through the real wallClock module with timezone mocked to 'UTC'.
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');
const { buildChallenge: buildBaseChallenge } = require('../helpers/challengeFixtures');

jest.mock('../../src/js/settings');

const NOW = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);

const buildChallenge = ({ exposureFactor = 50, closeInSeconds = 7200, type = 'regular' } = {}) =>
    buildBaseChallenge({
        id: '777',
        title: 'Scheduled Fill Challenge',
        type,
        close_time: NOW + closeInSeconds,
        start_time: NOW - 3600,
        member: { ranking: { exposure: { exposure_factor: exposureFactor } } },
    });

const mockSettings = (overrides = {}) => {
    const defaults = {
        onlyBoost: false,
        voteOnlyInLastMinute: false,
        exposure: 100,
        lastMinuteThreshold: 10,
        lastHourExposure: 40,
        useLastHourExposure: false,
        exposureTarget: 0,
        lastHourExposureTarget: 0,
        useScheduledFill: false,
        scheduledFillTime: [],
        scheduledFillBeforeEnd: [],
        scheduledFillWindowMinutes: 60,
        scheduledFillReplaces: false,
    };
    settings.getEffectiveSetting = jest.fn((key) => ({ ...defaults, ...overrides })[key]);
    settings.getSetting = jest.fn((key) => (key === 'timezone' ? 'UTC' : undefined));
};

beforeEach(() => jest.clearAllMocks());

describe('getScheduledFillState — active semantics', () => {
    test('inactive when useScheduledFill is off, even with times configured', () => {
        mockSettings({ useScheduledFill: false, scheduledFillTime: ['12:00'], scheduledFillBeforeEnd: [300] });
        const state = VotingLogic.getScheduledFillState(buildChallenge(), '777', NOW);
        expect(state).toEqual({ active: false, inWindow: false, replaces: false });
    });

    test('inactive when enabled but NO time form is configured (replace mode must be a no-op)', () => {
        mockSettings({
            useScheduledFill: true,
            scheduledFillTime: [],
            scheduledFillBeforeEnd: [],
            scheduledFillReplaces: true,
        });
        const state = VotingLogic.getScheduledFillState(buildChallenge(), '777', NOW);
        expect(state).toEqual({ active: false, inWindow: false, replaces: false });
    });

    test('active via the before-end form alone', () => {
        // Window starts 2h before a close that is 2h away → starts exactly now.
        mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: [7200] });
        const state = VotingLogic.getScheduledFillState(buildChallenge({ closeInSeconds: 7200 }), '777', NOW);
        expect(state.active).toBe(true);
        expect(state.inWindow).toBe(true);
    });

    test('active via the time-of-day form alone', () => {
        // NOW is 12:00 UTC; a 11:30 daily time with a 60-minute window covers it.
        mockSettings({ useScheduledFill: true, scheduledFillTime: ['11:30'] });
        const state = VotingLogic.getScheduledFillState(buildChallenge(), '777', NOW);
        expect(state.active).toBe(true);
        expect(state.inWindow).toBe(true);
    });

    test('both forms configured → in-window via either (OR)', () => {
        // Time-of-day window (07:00 + 60m) is long past; before-end window covers now.
        mockSettings({ useScheduledFill: true, scheduledFillTime: ['07:00'], scheduledFillBeforeEnd: [7200] });
        const viaBeforeEnd = VotingLogic.getScheduledFillState(buildChallenge({ closeInSeconds: 7200 }), '777', NOW);
        expect(viaBeforeEnd.inWindow).toBe(true);

        // Before-end window (24h before a 2h-away close) is long past; time-of-day covers now.
        mockSettings({ useScheduledFill: true, scheduledFillTime: ['11:30'], scheduledFillBeforeEnd: [86400] });
        const viaTimeOfDay = VotingLogic.getScheduledFillState(buildChallenge({ closeInSeconds: 7200 }), '777', NOW);
        expect(viaTimeOfDay.inWindow).toBe(true);
    });

    test('two before-end entries each open their own window (the issue #26 case: 4h and 10h)', () => {
        // Challenge closes in 11h. Offsets [4h, 10h] → windows at close-10h
        // (= NOW + 1h) and close-4h (= NOW + 7h), 60 minutes each.
        mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: [4 * 3600, 10 * 3600] });
        const challenge = buildChallenge({ closeInSeconds: 11 * 3600 });

        const tenHourWindowStart = challenge.close_time - 10 * 3600;
        const fourHourWindowStart = challenge.close_time - 4 * 3600;

        expect(VotingLogic.getScheduledFillState(challenge, '777', tenHourWindowStart + 60).inWindow).toBe(true);
        expect(VotingLogic.getScheduledFillState(challenge, '777', fourHourWindowStart + 60).inWindow).toBe(true);
        // Between the two windows: neither covers.
        expect(VotingLogic.getScheduledFillState(challenge, '777', tenHourWindowStart + 2 * 3600).inWindow).toBe(false);
    });

    test('two daily times each open their own window', () => {
        // NOW is 12:00 UTC. Times 11:30 (open now) and 18:00 (later today).
        mockSettings({ useScheduledFill: true, scheduledFillTime: ['11:30', '18:00'] });
        expect(VotingLogic.getScheduledFillState(buildChallenge(), '777', NOW).inWindow).toBe(true);

        // At 14:00 neither window covers; at 18:30 the second one does.
        const at1400 = Math.floor(Date.UTC(2026, 0, 15, 14, 0, 0) / 1000);
        const at1830 = Math.floor(Date.UTC(2026, 0, 15, 18, 30, 0) / 1000);
        const challenge = buildChallenge({ closeInSeconds: 24 * 3600 });
        expect(VotingLogic.getScheduledFillState(challenge, '777', at1400).inWindow).toBe(false);
        expect(VotingLogic.getScheduledFillState(challenge, '777', at1830).inWindow).toBe(true);
    });

    test('window boundaries are inclusive [S, S+W]', () => {
        const windowSec = 60 * 60;
        const beforeEnd = 7200;
        mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: [beforeEnd], scheduledFillWindowMinutes: 60 });
        const challenge = buildChallenge({ closeInSeconds: 7200 + windowSec + 3600 });
        const start = challenge.close_time - beforeEnd;

        expect(VotingLogic.getScheduledFillState(challenge, '777', start - 1).inWindow).toBe(false);
        expect(VotingLogic.getScheduledFillState(challenge, '777', start).inWindow).toBe(true);
        expect(VotingLogic.getScheduledFillState(challenge, '777', start + windowSec).inWindow).toBe(true);
        expect(VotingLogic.getScheduledFillState(challenge, '777', start + windowSec + 1).inWindow).toBe(false);
    });
});

describe('getScheduledFillState — corrupt persisted values fail soft', () => {
    test.each([[null], [2130], [{ time: '21:30' }], ['21:30'], [true]])(
        'a NON-ARRAY scheduledFillTime %p turns the whole form off without throwing',
        (corrupt) => {
            mockSettings({ useScheduledFill: true, scheduledFillTime: corrupt });
            expect(() => VotingLogic.getScheduledFillState(buildChallenge(), '777', NOW)).not.toThrow();
            expect(VotingLogic.getScheduledFillState(buildChallenge(), '777', NOW).active).toBe(false);
        },
    );

    test.each([['abc'], [null], [{}], [NaN], [-100], [7200]])(
        'a NON-ARRAY scheduledFillBeforeEnd %p turns the whole form off',
        (corrupt) => {
            mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: corrupt });
            expect(VotingLogic.getScheduledFillState(buildChallenge(), '777', NOW).active).toBe(false);
        },
    );

    test('a corrupt ENTRY is skipped while a sibling entry still fills', () => {
        mockSettings({ useScheduledFill: true, scheduledFillTime: ['25:99', '11:30'] });
        const viaTime = VotingLogic.getScheduledFillState(buildChallenge(), '777', NOW);
        expect(viaTime.active).toBe(true);
        expect(viaTime.inWindow).toBe(true);

        mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: [-5, 7200] });
        const viaBefore = VotingLogic.getScheduledFillState(buildChallenge({ closeInSeconds: 7200 }), '777', NOW);
        expect(viaBefore.active).toBe(true);
        expect(viaBefore.inWindow).toBe(true);
    });

    test('a list of ONLY corrupt entries leaves the feature inactive (not even active)', () => {
        mockSettings({
            useScheduledFill: true,
            scheduledFillTime: ['25:99', 2130],
            scheduledFillBeforeEnd: [-5, NaN],
            scheduledFillReplaces: true,
        });
        expect(VotingLogic.getScheduledFillState(buildChallenge(), '777', NOW)).toEqual({
            active: false,
            inWindow: false,
            replaces: false,
        });
    });

    test('an oversized hand-edited list is sliced to the entry cap (Intl work stays bounded)', () => {
        // 100 entries, the only in-window one placed beyond the cap — it must
        // NOT be evaluated. Entries within the cap are all far from now.
        const times = Array.from({ length: 99 }, (_, i) => `0${Math.floor(i / 10)}:0${i % 10}`.slice(-5));
        times.push('11:30'); // in-window, but 100th
        mockSettings({ useScheduledFill: true, scheduledFillTime: times });
        const state = VotingLogic.getScheduledFillState(buildChallenge(), '777', NOW);
        expect(state.inWindow).toBe(false);
    });

    test('a hand-edited numeric-string ENTRY coerces to its numeric meaning instead of failing', () => {
        // The write path rejects ['7200'] (zod wants numbers), but a hand-edited
        // settings.json holding one degrades gracefully to the number it spells.
        mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: ['7200'] });
        expect(VotingLogic.getScheduledFillState(buildChallenge({ closeInSeconds: 7200 }), '777', NOW).inWindow).toBe(
            true,
        );
    });

    test('corrupt window minutes falls back to the 60-minute default, not "never in window"', () => {
        mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: [7200], scheduledFillWindowMinutes: 'sixty' });
        const state = VotingLogic.getScheduledFillState(buildChallenge({ closeInSeconds: 7200 }), '777', NOW);
        expect(state.inWindow).toBe(true);
    });

    test('a throwing settings read degrades to inactive instead of propagating', () => {
        mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: [300] });
        settings.getSetting = jest.fn(() => {
            throw new Error('corrupt settings blob');
        });
        expect(() => VotingLogic.getScheduledFillState(buildChallenge(), '777', NOW)).not.toThrow();
        expect(VotingLogic.getScheduledFillState(buildChallenge(), '777', NOW)).toEqual({
            active: false,
            inWindow: false,
            replaces: false,
        });
    });
});

describe('scheduled rule — auto voting decisions', () => {
    test('in-window below 100% votes with the scheduled reason and 100/100 target', () => {
        mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: [7200] });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 40, closeInSeconds: 7200 }),
            NOW,
        );
        expect(result.shouldVote).toBe(true);
        expect(result.targetExposure).toBe(100);
        expect(result.voteReason).toBe('scheduled fill window: exposure 40% < 100%');
    });

    test('in-window at 100% does not vote (atTarget)', () => {
        mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: [7200] });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 100, closeInSeconds: 7200 }),
            NOW,
        );
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toBe('scheduled fill: exposure already at 100%');
    });

    test('complement mode outside the window falls through to the normal rule', () => {
        // Window opens 1h before close (close is 4h away) → not in window now.
        mockSettings({
            useScheduledFill: true,
            scheduledFillBeforeEnd: [3600],
            exposure: 80,
            scheduledFillReplaces: false,
        });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 40, closeInSeconds: 14400 }),
            NOW,
        );
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('normal threshold');
    });

    test('replace mode outside the window blocks normal voting', () => {
        mockSettings({
            useScheduledFill: true,
            scheduledFillBeforeEnd: [3600],
            exposure: 80,
            scheduledFillReplaces: true,
        });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 40, closeInSeconds: 14400 }),
            NOW,
        );
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toBe('scheduled-fill-only: outside scheduled fill window');
    });

    test('replace mode outside the window blocks the last-hour rule too', () => {
        // Close is 30 minutes away (inside the last hour) but the 10-minute
        // before-end window has not opened yet.
        mockSettings({
            useScheduledFill: true,
            scheduledFillBeforeEnd: [600],
            scheduledFillReplaces: true,
            useLastHourExposure: true,
            lastHourExposure: 90,
            lastMinuteThreshold: 5,
        });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 40, closeInSeconds: 1800 }),
            NOW,
        );
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toBe('scheduled-fill-only: outside scheduled fill window');
    });

    test('replace mode keeps the flash rule', () => {
        mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: [600], scheduledFillReplaces: true });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 40, closeInSeconds: 14400, type: 'flash' }),
            NOW,
        );
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('flash type');
    });

    test('replace mode keeps the last-minute rule', () => {
        mockSettings({
            useScheduledFill: true,
            scheduledFillBeforeEnd: [60],
            scheduledFillReplaces: true,
            lastMinuteThreshold: 10,
        });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 40, closeInSeconds: 300 }),
            NOW,
        );
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('lastminute threshold');
    });

    test('onlyBoost keeps precedence over an in-window scheduled fill', () => {
        mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: [7200], onlyBoost: true });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 40, closeInSeconds: 7200 }),
            NOW,
        );
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toBe('boost-only mode enabled');
    });

    test('voteOnlyInLastMinute keeps precedence over an in-window scheduled fill', () => {
        mockSettings({
            useScheduledFill: true,
            scheduledFillBeforeEnd: [7200],
            voteOnlyInLastMinute: true,
            lastMinuteThreshold: 10,
        });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 40, closeInSeconds: 7200 }),
            NOW,
        );
        expect(result.shouldVote).toBe(false);
        expect(result.voteReason).toContain('vote-only-in-last-threshold');
    });

    test('feature fully off leaves the chain identical to today', () => {
        mockSettings({ exposure: 80 });
        const result = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 40, closeInSeconds: 14400 }),
            NOW,
        );
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('normal threshold');
    });

    test('time-of-day form drives the decision through the real wallClock module', () => {
        // NOW is 12:00 UTC; window [11:30, 12:30] covers it → scheduled vote.
        mockSettings({ useScheduledFill: true, scheduledFillTime: ['11:30'], exposure: 10 });
        const inWindow = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 40, closeInSeconds: 14400 }),
            NOW,
        );
        expect(inWindow.shouldVote).toBe(true);
        expect(inWindow.voteReason).toBe('scheduled fill window: exposure 40% < 100%');

        // A 13:00 time has not opened yet → falls through (and 40% >= 10% → no vote).
        mockSettings({ useScheduledFill: true, scheduledFillTime: ['13:00'], exposure: 10 });
        const outside = VotingLogic.evaluateVotingDecision(
            buildChallenge({ exposureFactor: 40, closeInSeconds: 14400 }),
            NOW,
        );
        expect(outside.shouldVote).toBe(false);
        expect(outside.voteReason).toContain('normal threshold');
    });
});

describe('scheduled rule — manual voting decisions', () => {
    test('manual mode ignores the replace-mode block outside the window', () => {
        mockSettings({
            useScheduledFill: true,
            scheduledFillBeforeEnd: [3600],
            exposure: 80,
            scheduledFillReplaces: true,
        });
        const result = VotingLogic.evaluateManualVotingDecision(
            buildChallenge({ exposureFactor: 40, closeInSeconds: 14400 }),
            NOW,
            'Scheduled Fill Challenge',
        );
        expect(result.shouldAllowVoting).toBe(true);
    });

    test('manual mode in-window at 100% surfaces the scheduled message', () => {
        mockSettings({ useScheduledFill: true, scheduledFillBeforeEnd: [7200] });
        const result = VotingLogic.evaluateManualVotingDecision(
            buildChallenge({ exposureFactor: 100, closeInSeconds: 7200 }),
            NOW,
            'Scheduled Fill Challenge',
        );
        expect(result.shouldAllowVoting).toBe(false);
        expect(result.errorMessage).toBe(
            'Challenge "Scheduled Fill Challenge" already has 100% exposure (scheduled fill window)',
        );
    });
});
