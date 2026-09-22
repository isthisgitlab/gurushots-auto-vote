/**
 * Edge-case coverage for VotingLogic's defensive paths: missing ids, missing
 * member subtrees, non-finite close times, the manual-mode block message,
 * the pre-final-window top-up rule and shouldPlayAutoTurbo's state machine.
 * Each test pins the observable fallback, not just that the line ran.
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');
const { buildChallenge } = require('../helpers/challengeFixtures');

jest.mock('../../src/js/settings');

const NOW = 1_700_000_000;

const DEFAULTS = {
    onlyBoost: false,
    voteOnlyInLastMinute: false,
    exposure: 50,
    lastMinuteThreshold: 10,
    finalWindowExposure: 40,
    useFinalWindowExposure: false,
    exposureTarget: 0,
    finalWindowExposureTarget: 0,
    finalWindowDuration: 3600,
    voteBeforeFinalWindow: false,
    voteBeforeFinalWindowLeadMin: 15,
    autoBoost: false,
    autoTurbo: false,
    useTurbo: false,
    boostTime: 600,
    keyUnlockedBoostTime: 900,
    turboTime: 7200,
    emergencyFill: 0,
};

const mockSettings = (overrides = {}) => {
    const values = { ...DEFAULTS, ...overrides };
    settings.getEffectiveSetting = jest.fn((key) => values[key]);
};

const regular = (overrides = {}) =>
    buildChallenge({ id: '42', type: 'regular', start_time: NOW - 3600, close_time: NOW + 7200, ...overrides });

beforeEach(() => {
    jest.clearAllMocks();
    mockSettings();
});

describe('getBoostPrefillState', () => {
    test('is inactive when the challenge has no readable close_time even with both toggles on', () => {
        mockSettings({ voteBeforeBoost: true, autoBoost: true });
        const challenge = regular({ close_time: undefined });
        expect(VotingLogic.getBoostPrefillState(challenge, '42', NOW)).toEqual({ active: false, inWindow: false });
    });
});

describe('_runVotingRules via evaluateVotingDecision', () => {
    test('treats a missing exposure subtree as 0% exposure (votes under the normal rule)', () => {
        const challenge = regular({ member: { ranking: { exposure: undefined } } });
        const result = VotingLogic.evaluateVotingDecision(challenge, NOW);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toBe('normal threshold: exposure 0% < 50%');
    });

    test('pre-final-window top-up votes to the STANDARD trigger inside the straddle window', () => {
        mockSettings({ useFinalWindowExposure: true, voteBeforeFinalWindow: true, exposureTarget: 80 });
        // 3600s window + 5 min before the boundary: inside [close-3600-900, close-3600+900].
        const challenge = regular({
            close_time: NOW + 3600 + 300,
            member: { ranking: { exposure: { exposure_factor: 45 } } },
        });
        const result = VotingLogic.evaluateVotingDecision(challenge, NOW);
        expect(result.shouldVote).toBe(true);
        expect(result.targetExposure).toBe(80);
        expect(result.voteReason).toBe('pre-final-window top-up: exposure 45% < 50% (vote up to 80%)');
    });

    test('pre-final-window overrides the lower final-window trigger during the in-window grace part', () => {
        mockSettings({ useFinalWindowExposure: true, voteBeforeFinalWindow: true });
        // 3600 - 300: already inside the final window (trigger 40) but within the lead.
        const challenge = regular({
            close_time: NOW + 3600 - 300,
            member: { ranking: { exposure: { exposure_factor: 45 } } },
        });
        const result = VotingLogic.evaluateVotingDecision(challenge, NOW);
        expect(result.shouldVote).toBe(true);
        expect(result.voteReason).toContain('pre-final-window top-up');
    });
});

describe('evaluateManualVotingDecision', () => {
    test('a vote-only-in-last-minute block produces the manual "restricted" message', () => {
        mockSettings({ voteOnlyInLastMinute: true, lastMinuteThreshold: 7 });
        const result = VotingLogic.evaluateManualVotingDecision(regular(), NOW, 'Sunsets');
        expect(result.shouldAllowVoting).toBe(false);
        expect(result.errorMessage).toBe('Challenge "Sunsets" voting is restricted to last 7 minutes only');
        expect(result.targetExposure).toBe(100);
    });
});

describe('isWithinEmergencyWindow', () => {
    test('reads the setting under an empty id when the challenge has none', () => {
        mockSettings({ emergencyFill: 300 });
        const challenge = { close_time: NOW + 100 };
        expect(VotingLogic.isWithinEmergencyWindow(challenge, NOW)).toBe(true);
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('emergencyFill', '');
    });
});

describe('shouldApplyBoost', () => {
    test('returns false for a missing challenge', () => {
        expect(VotingLogic.shouldApplyBoost(null, NOW)).toBe(false);
    });

    test('returns false once the challenge has closed', () => {
        mockSettings({ autoBoost: true });
        expect(VotingLogic.shouldApplyBoost(regular({ close_time: NOW }), NOW)).toBe(false);
    });

    test('an id-less challenge reads autoBoost under the empty id', () => {
        const challenge = { close_time: NOW + 60, member: { boost: { state: 'AVAILABLE_KEY' } } };
        expect(VotingLogic.shouldApplyBoost(challenge, NOW)).toBe(false);
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('autoBoost', '');
    });

    test('a non-available boost state never auto-applies', () => {
        mockSettings({ autoBoost: true });
        const challenge = regular({ close_time: NOW + 60, member: { boost: { state: 'USED', timeout: NOW + 30 } } });
        expect(VotingLogic.shouldApplyBoost(challenge, NOW)).toBe(false);
    });
});

describe('pickBoostEntry', () => {
    test('returns null when the challenge has no entries', () => {
        expect(VotingLogic.pickBoostEntry(regular(), '42')).toBeNull();
        expect(VotingLogic.pickBoostEntry({ member: {} }, '42')).toBeNull();
    });
});

describe('shouldPlayAutoTurbo', () => {
    const turboChallenge = (turbo, extra = {}) => regular({ member: { turbo }, ...extra });

    test('false for a missing or closed challenge', () => {
        mockSettings({ autoTurbo: true });
        expect(VotingLogic.shouldPlayAutoTurbo(null, NOW)).toBe(false);
        expect(VotingLogic.shouldPlayAutoTurbo(turboChallenge({ state: 'FREE' }, { close_time: NOW }), NOW)).toBe(
            false,
        );
    });

    test('false when autoTurbo is off, even for a FREE turbo', () => {
        expect(VotingLogic.shouldPlayAutoTurbo(turboChallenge({ state: 'FREE' }), NOW)).toBe(false);
    });

    test.each(['FREE', 'IN_PROGRESS'])('plays a %s turbo', (state) => {
        mockSettings({ autoTurbo: true });
        expect(VotingLogic.shouldPlayAutoTurbo(turboChallenge({ state }), NOW)).toBe(true);
    });

    test('plays a TIMER turbo only once its open time has arrived', () => {
        mockSettings({ autoTurbo: true });
        expect(VotingLogic.shouldPlayAutoTurbo(turboChallenge({ state: 'TIMER', time_to_open: NOW }), NOW)).toBe(true);
        expect(VotingLogic.shouldPlayAutoTurbo(turboChallenge({ state: 'TIMER', time_to_open: NOW + 1 }), NOW)).toBe(
            false,
        );
        expect(VotingLogic.shouldPlayAutoTurbo(turboChallenge({ state: 'TIMER' }), NOW)).toBe(false);
    });

    test('an id-less challenge with no member reads autoTurbo under the empty id and does not play', () => {
        mockSettings({ autoTurbo: true });
        expect(VotingLogic.shouldPlayAutoTurbo({ close_time: NOW + 60 }, NOW)).toBe(false);
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('autoTurbo', '');
    });
});

describe('shouldApplyTurbo defensive paths', () => {
    test('no challenge', () => {
        expect(VotingLogic.shouldApplyTurbo(null, NOW)).toEqual({
            apply: false,
            imageId: null,
            fillNew: false,
            reason: 'no challenge',
        });
    });

    test('an id-less, member-less challenge reports an unknown turbo state', () => {
        mockSettings({ useTurbo: true });
        const result = VotingLogic.shouldApplyTurbo({ close_time: NOW + 60 }, NOW);
        expect(result.apply).toBe(false);
        expect(result.reason).toBe('turbo state unknown');
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('useTurbo', '');
    });
});

describe('deadline-action helpers with sparse challenges', () => {
    test('getAutoFillThresholdSec treats non-array entries as zero entries', () => {
        mockSettings({ autoFillSchedule: [] });
        const sparse = VotingLogic.getAutoFillThresholdSec({ member: {} }, '42');
        const empty = VotingLogic.getAutoFillThresholdSec(regular(), '42');
        expect(sparse).toBe(empty);
    });

    test('orderDeadlineActions tolerates an id-less challenge', () => {
        mockSettings({ emergencyFill: 300, turboTime: 600 });
        const order = VotingLogic.orderDeadlineActions({ close_time: NOW + 100 });
        expect(order.map((a) => a.action)).toEqual(['turbo', 'emergencyFill', 'autoFill', 'boost']);
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('turboTime', '');
    });

    test('describeDeadlineActions returns null dueAt when close_time is unreadable', () => {
        mockSettings({ useTurbo: true, turboTime: 600 });
        const { actions, boostBlocked } = VotingLogic.describeDeadlineActions(
            { member: { turbo: { state: 'WON' } } },
            NOW,
        );
        expect(boostBlocked).toBe(false);
        expect(actions).toEqual([{ action: 'turbo', thresholdSec: 600, dueAt: null }]);
    });
});

describe('shouldJoinChallenge', () => {
    test('a non-string type counts as typeless and fails a non-empty include list', () => {
        const result = VotingLogic.shouldJoinChallenge({
            challenge: { type: 42, join_coins: 0 },
            bankroll: { coins: 0 },
            remainingBudget: 0,
            includeTypes: ['regular'],
            excludeTypes: [],
            maxCoins: 0,
        });
        expect(result).toEqual({ join: false, needsCoins: 0, reason: 'out-of-scope' });
    });
});

describe('shouldApplyBoost with no boost subtree', () => {
    test('a member without a boost object never applies', () => {
        mockSettings({ autoBoost: true });
        const challenge = { id: '42', close_time: NOW + 60, member: {} };
        expect(VotingLogic.shouldApplyBoost(challenge, NOW)).toBe(false);
    });
});
