/**
 * Voting-pause rule in VotingLogic.
 *
 * The inverse of scheduled fill: windows in which automatic voting is REFUSED,
 * so exposure isn't spent during the overnight lull between match rounds (the
 * motivating report: the last match is at 01:10 and the next at 10:10, so
 * 01:30-06:00 fills buy almost no votes).
 *
 * Precedence is the load-bearing part and is asserted from both sides here:
 * the pause blocks the threshold rules, the pre-final-window top-up,
 * final-window and scheduled fill, but NEVER flash or last-minute — a
 * challenge that genuinely closes mid-pause must still get its final fill.
 *
 * Structure mirrors scheduledFill.test.js: before-end cases are pure
 * close_time math, time-of-day cases pin `now` to a fixed epoch and run
 * through the real wallClock module with timezone mocked to 'UTC'.
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');
const { buildChallenge: buildBaseChallenge } = require('../helpers/challengeFixtures');

jest.mock('../../src/js/settings');

const NOW = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);

const buildChallenge = ({ exposureFactor = 50, closeInSeconds = 7200, type = 'regular' } = {}) =>
    buildBaseChallenge({
        id: '777',
        title: 'Voting Pause Challenge',
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
        finalWindowExposure: 40,
        useFinalWindowExposure: false,
        exposureTarget: 0,
        finalWindowExposureTarget: 0,
        voteBeforeFinalWindow: false,
        voteBeforeFinalWindowLeadMin: 15,
        finalWindowDuration: 3600,
        useScheduledFill: false,
        scheduledFillTime: [],
        scheduledFillBeforeEnd: [],
        scheduledFillWindowMinutes: 60,
        scheduledFillReplaces: false,
        useVotingPause: false,
        votingPauseTime: [],
        votingPauseBeforeEnd: [],
        votingPauseDurationMinutes: 240,
    };
    settings.getEffectiveSetting = jest.fn((key) => ({ ...defaults, ...overrides })[key]);
    settings.getSetting = jest.fn((key) => (key === 'timezone' ? 'UTC' : undefined));
};

beforeEach(() => jest.clearAllMocks());

describe('getVotingPauseState — active semantics', () => {
    test('inactive when useVotingPause is off, even with times configured', () => {
        mockSettings({ useVotingPause: false, votingPauseTime: ['12:00'], votingPauseBeforeEnd: [300] });
        expect(VotingLogic.getVotingPauseState(buildChallenge(), '777', NOW)).toEqual({
            active: false,
            inWindow: false,
        });
    });

    test('inactive when enabled but NO time form is configured — an empty pause must never block', () => {
        mockSettings({ useVotingPause: true, votingPauseTime: [], votingPauseBeforeEnd: [] });
        expect(VotingLogic.getVotingPauseState(buildChallenge(), '777', NOW)).toEqual({
            active: false,
            inWindow: false,
        });
    });

    test('active via the time-of-day form alone', () => {
        // NOW is 12:00 UTC; an 11:30 pause with the 240m default covers it.
        mockSettings({ useVotingPause: true, votingPauseTime: ['11:30'] });
        const state = VotingLogic.getVotingPauseState(buildChallenge(), '777', NOW);
        expect(state).toEqual({ active: true, inWindow: true });
    });

    test('active but OUT of window once the duration has elapsed', () => {
        // 07:00 + 60m ended at 08:00; NOW is 12:00.
        mockSettings({ useVotingPause: true, votingPauseTime: ['07:00'], votingPauseDurationMinutes: 60 });
        const state = VotingLogic.getVotingPauseState(buildChallenge(), '777', NOW);
        expect(state).toEqual({ active: true, inWindow: false });
    });

    test('active via the before-end form alone', () => {
        // Pause starts 2h before a close that is 2h away → starts exactly now.
        mockSettings({ useVotingPause: true, votingPauseBeforeEnd: [7200] });
        const state = VotingLogic.getVotingPauseState(buildChallenge({ closeInSeconds: 7200 }), '777', NOW);
        expect(state).toEqual({ active: true, inWindow: true });
    });

    test('both forms configured → in-window via either (OR)', () => {
        // The 07:00 daily pause is long over; the before-end one covers now.
        mockSettings({
            useVotingPause: true,
            votingPauseTime: ['07:00'],
            votingPauseBeforeEnd: [7200],
            votingPauseDurationMinutes: 60,
        });
        const state = VotingLogic.getVotingPauseState(buildChallenge({ closeInSeconds: 7200 }), '777', NOW);
        expect(state).toEqual({ active: true, inWindow: true });
    });

    test('the reported 01:30-06:00 night pause covers 03:00 and not 07:00', () => {
        // 270 minutes from 01:30 == 06:00.
        const at = (h, m) => Math.floor(Date.UTC(2026, 0, 15, h, m, 0) / 1000);
        mockSettings({ useVotingPause: true, votingPauseTime: ['01:30'], votingPauseDurationMinutes: 270 });
        const challenge = buildChallenge({ closeInSeconds: 86400 });
        expect(VotingLogic.getVotingPauseState(challenge, '777', at(3, 0)).inWindow).toBe(true);
        expect(VotingLogic.getVotingPauseState(challenge, '777', at(5, 59)).inWindow).toBe(true);
        // The window is inclusive at both ends, matching scheduled fill.
        expect(VotingLogic.getVotingPauseState(challenge, '777', at(6, 0)).inWindow).toBe(true);
        expect(VotingLogic.getVotingPauseState(challenge, '777', at(6, 1)).inWindow).toBe(false);
        expect(VotingLogic.getVotingPauseState(challenge, '777', at(7, 0)).inWindow).toBe(false);
        // And it is still a pause the evening BEFORE it next opens.
        expect(VotingLogic.getVotingPauseState(challenge, '777', at(23, 0)).active).toBe(true);
    });
});

describe('getVotingPauseState — corrupt values fail OPEN (keep voting)', () => {
    test('a non-array times value turns that form off rather than throwing', () => {
        mockSettings({ useVotingPause: true, votingPauseTime: 'nonsense', votingPauseBeforeEnd: [] });
        expect(VotingLogic.getVotingPauseState(buildChallenge(), '777', NOW)).toEqual({
            active: false,
            inWindow: false,
        });
    });

    test('an unparseable entry inside the list is skipped and does not make the feature active', () => {
        mockSettings({ useVotingPause: true, votingPauseTime: ['25:99', 'midnight'] });
        expect(VotingLogic.getVotingPauseState(buildChallenge(), '777', NOW)).toEqual({
            active: false,
            inWindow: false,
        });
    });

    test('a corrupt duration falls back to the schema default instead of pausing forever', () => {
        // 11:30 + the 240m default covers NOW (12:00); a NaN duration must not
        // widen or void the window.
        mockSettings({ useVotingPause: true, votingPauseTime: ['11:30'], votingPauseDurationMinutes: 'soon' });
        expect(VotingLogic.getVotingPauseState(buildChallenge(), '777', NOW)).toEqual({
            active: true,
            inWindow: true,
        });
    });

    test('a throwing settings read degrades to "not paused" rather than aborting the pass', () => {
        settings.getEffectiveSetting = jest.fn((key) => {
            if (key === 'useVotingPause') return true;
            throw new Error('corrupt override');
        });
        settings.getSetting = jest.fn(() => 'UTC');
        expect(VotingLogic.getVotingPauseState(buildChallenge(), '777', NOW)).toEqual({
            active: false,
            inWindow: false,
        });
    });
});

describe('voting pause in the auto rule chain', () => {
    const pausedNow = { useVotingPause: true, votingPauseBeforeEnd: [7200], votingPauseDurationMinutes: 240 };

    test('blocks the normal threshold rule while in window', () => {
        mockSettings({ ...pausedNow, exposure: 100 });
        const decision = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds: 7200 }), NOW);
        expect(decision.shouldVote).toBe(false);
        expect(decision.voteReason).toMatch(/paused/i);
    });

    test('votes normally once the pause has elapsed', () => {
        // Pause ran from 10h before close for 60m; close is 2h away, so it is over.
        mockSettings({
            useVotingPause: true,
            votingPauseBeforeEnd: [36000],
            votingPauseDurationMinutes: 60,
            exposure: 100,
        });
        const decision = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds: 7200 }), NOW);
        expect(decision.shouldVote).toBe(true);
    });

    test('blocks the final-window rule', () => {
        mockSettings({
            useVotingPause: true,
            votingPauseBeforeEnd: [3000],
            useFinalWindowExposure: true,
            finalWindowExposure: 90,
        });
        // 3000s to close: inside the 1h final window, and the pause started 3000s
        // before close — i.e. exactly now.
        const decision = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds: 3000 }), NOW);
        expect(decision.shouldVote).toBe(false);
        expect(decision.voteReason).toMatch(/paused/i);
    });

    test('blocks the pre-final-window top-up', () => {
        mockSettings({
            useVotingPause: true,
            votingPauseBeforeEnd: [4000],
            useFinalWindowExposure: true,
            voteBeforeFinalWindow: true,
            exposure: 100,
        });
        const decision = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds: 4000 }), NOW);
        expect(decision.shouldVote).toBe(false);
        expect(decision.voteReason).toMatch(/paused/i);
    });

    test('OUTRANKS scheduled fill — an overlapping fill window does not defeat the pause', () => {
        mockSettings({
            ...pausedNow,
            useScheduledFill: true,
            scheduledFillBeforeEnd: [7200],
            scheduledFillWindowMinutes: 60,
        });
        const decision = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds: 7200 }), NOW);
        expect(decision.shouldVote).toBe(false);
        expect(decision.voteReason).toMatch(/paused/i);
    });

    test('a new entry does NOT defeat the pause', () => {
        mockSettings({ ...pausedNow, exposure: 100 });
        const decision = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds: 7200 }), NOW, {
            hasNewEntry: true,
        });
        expect(decision.shouldVote).toBe(false);
        expect(decision.forcedByNewEntry).toBe(false);
    });
});

describe('voting pause never abandons a closing challenge', () => {
    test('last-minute voting still runs inside a pause', () => {
        // 5 minutes to close, lastMinuteThreshold 10m → last-minute rule applies.
        mockSettings({
            useVotingPause: true,
            votingPauseBeforeEnd: [600],
            votingPauseDurationMinutes: 240,
            lastMinuteThreshold: 10,
        });
        const decision = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds: 300 }), NOW);
        expect(decision.shouldVote).toBe(true);
        expect(decision.targetExposure).toBe(100);
    });

    test('flash challenges still vote inside a pause', () => {
        mockSettings({ useVotingPause: true, votingPauseBeforeEnd: [7200] });
        const decision = VotingLogic.evaluateVotingDecision(
            buildChallenge({ closeInSeconds: 7200, type: 'flash' }),
            NOW,
        );
        expect(decision.shouldVote).toBe(true);
    });

    test('manual voting is never blocked by a pause', () => {
        mockSettings({ useVotingPause: true, votingPauseBeforeEnd: [7200] });
        const decision = VotingLogic.evaluateManualVotingDecision(
            buildChallenge({ closeInSeconds: 7200 }),
            NOW,
            'Voting Pause Challenge',
        );
        expect(decision.shouldAllowVoting).toBe(true);
    });
});

describe('voting pause is independent of scheduled fill', () => {
    test('scheduled fill still fills when only the FILL window is open', () => {
        mockSettings({
            useVotingPause: true,
            votingPauseTime: ['02:00'],
            votingPauseDurationMinutes: 60, // 02:00-03:00, long over at 12:00
            useScheduledFill: true,
            scheduledFillBeforeEnd: [7200],
            exposure: 10,
        });
        const decision = VotingLogic.evaluateVotingDecision(buildChallenge({ closeInSeconds: 7200 }), NOW);
        expect(decision.shouldVote).toBe(true);
        expect(decision.targetExposure).toBe(100);
    });

    test('a pause with the feature off leaves scheduled-fill replace mode untouched', () => {
        mockSettings({
            useVotingPause: false,
            votingPauseBeforeEnd: [7200],
            useScheduledFill: true,
            scheduledFillBeforeEnd: [7200],
            scheduledFillReplaces: true,
        });
        const state = VotingLogic.getScheduledFillState(buildChallenge({ closeInSeconds: 7200 }), '777', NOW);
        expect(state).toEqual({ active: true, inWindow: true, replaces: true });
    });
});
