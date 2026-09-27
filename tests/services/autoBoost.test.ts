/**
 * shouldApplyBoost is gated by the per-challenge `autoBoost` setting so a
 * user can opt a specific challenge out of the auto-apply loop while still
 * being able to apply boost manually. Mirrors the autoTurbo gate that
 * shouldPlayAutoTurbo enforces.
 */

import settingsModule = require('../../src/js/settings');
const settings = jest.mocked(settingsModule);
import VotingLogic = require('../../src/js/services/VotingLogic');
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
const { buildChallenge }: typeof challengeFixturesModule = require('../helpers/challengeFixtures');
import type { Challenge } from '../../src/js/types/gurushots';
import { invalid } from '../helpers/invalid';

jest.mock('../../src/js/settings');

const NOW = () => Math.floor(Date.now() / 1000);

const buildChallengeWithBoostExpiring = (now: number) =>
    buildChallenge({
        id: '777',
        close_time: now + 3600,
        member: { boost: { state: 'AVAILABLE', timeout: now + 60 } },
    });

// A boost is available (timer-based, far-future timeout) but the challenge is
// seconds from closing — the normal boostTime window would not fire here, so
// only the emergency override can apply it.
const buildClosingChallengeWithBoost = (now: number, closeInSeconds = 120) =>
    buildChallenge({
        id: '777',
        close_time: now + closeInSeconds,
        member: { boost: { state: 'AVAILABLE', timeout: now + 1800 } },
    });

const mockSettings = (overrides = {}) => {
    const defaults = {
        autoBoost: true,
        boostTime: 3600,
        emergencyFill: 300,
    };
    settings.getEffectiveSetting = invalid(
        jest.fn((key: keyof typeof defaults) => ({ ...defaults, ...overrides })[key]),
    );
};

describe('shouldApplyBoost — autoBoost gate', () => {
    beforeEach(() => jest.clearAllMocks());

    test('applies when autoBoost is true and timer is inside the window', () => {
        mockSettings();
        const now = NOW();
        expect(VotingLogic.shouldApplyBoost(buildChallengeWithBoostExpiring(now), now)).toBe(true);
    });

    test('does not apply when autoBoost is false even though timer is inside the window', () => {
        mockSettings({ autoBoost: false });
        const now = NOW();
        expect(VotingLogic.shouldApplyBoost(buildChallengeWithBoostExpiring(now), now)).toBe(false);
    });
});

describe('shouldApplyBoost — emergency override', () => {
    beforeEach(() => jest.clearAllMocks());

    test('applies an available boost in the emergency window even when autoBoost is off', () => {
        mockSettings({ autoBoost: false, emergencyFill: 300 });
        const now = NOW();
        expect(VotingLogic.shouldApplyBoost(buildClosingChallengeWithBoost(now), now, { emergency: true })).toBe(true);
    });

    test('emergency override has no effect without the option flag (default behavior unchanged)', () => {
        mockSettings({ autoBoost: false, emergencyFill: 300 });
        const now = NOW();
        expect(VotingLogic.shouldApplyBoost(buildClosingChallengeWithBoost(now), now)).toBe(false);
    });

    test('does not override outside the emergency window', () => {
        mockSettings({ autoBoost: false, emergencyFill: 300 });
        const now = NOW();
        // Closes in 10 minutes — beyond the 5-minute emergency window.
        const challenge = buildClosingChallengeWithBoost(now, 600);
        expect(VotingLogic.shouldApplyBoost(challenge, now, { emergency: true })).toBe(false);
    });

    test('does not override when Emergency Fill is disabled (0)', () => {
        mockSettings({ autoBoost: false, emergencyFill: 0 });
        const now = NOW();
        expect(VotingLogic.shouldApplyBoost(buildClosingChallengeWithBoost(now), now, { emergency: true })).toBe(false);
    });

    test('still requires a boost to actually be available', () => {
        mockSettings({ autoBoost: false, emergencyFill: 300 });
        const now = NOW();
        const challenge = invalid<Challenge>({
            id: '777',
            close_time: now + 120,
            member: { boost: { state: 'NONE' } },
        });
        expect(VotingLogic.shouldApplyBoost(challenge, now, { emergency: true })).toBe(false);
    });

    test('applies a key-unlocked boost (AVAILABLE_KEY) in the emergency window with autoBoost off', () => {
        mockSettings({ autoBoost: false, emergencyFill: 300 });
        const now = NOW();
        const challenge = invalid<Challenge>({
            id: '777',
            close_time: now + 120,
            member: { boost: { state: 'AVAILABLE_KEY', timeout: null } },
        });
        expect(VotingLogic.shouldApplyBoost(challenge, now, { emergency: true })).toBe(true);
    });

    test('does not apply an AVAILABLE boost whose timer has already expired (stale state)', () => {
        mockSettings({ autoBoost: false, emergencyFill: 300 });
        const now = NOW();
        const challenge = invalid<Challenge>({
            id: '777',
            close_time: now + 120,
            member: { boost: { state: 'AVAILABLE', timeout: now - 10 } },
        });
        expect(VotingLogic.shouldApplyBoost(challenge, now, { emergency: true })).toBe(false);
    });

    test('window boundary is inclusive (secondsRemaining === emergencyFill applies, +1 does not)', () => {
        mockSettings({ autoBoost: false, emergencyFill: 300 });
        const now = NOW();
        expect(VotingLogic.shouldApplyBoost(buildClosingChallengeWithBoost(now, 300), now, { emergency: true })).toBe(
            true,
        );
        expect(VotingLogic.shouldApplyBoost(buildClosingChallengeWithBoost(now, 301), now, { emergency: true })).toBe(
            false,
        );
    });
});

describe('isWithinEmergencyWindow', () => {
    beforeEach(() => jest.clearAllMocks());

    const challengeClosingIn = (now: number, secs: number) => invalid<Challenge>({ id: '777', close_time: now + secs });

    test('true inside the window, false outside', () => {
        mockSettings({ emergencyFill: 300 });
        const now = NOW();
        expect(VotingLogic.isWithinEmergencyWindow(challengeClosingIn(now, 120), now)).toBe(true);
        expect(VotingLogic.isWithinEmergencyWindow(challengeClosingIn(now, 600), now)).toBe(false);
    });

    test('boundary is inclusive at exactly emergencyFill seconds', () => {
        mockSettings({ emergencyFill: 300 });
        const now = NOW();
        expect(VotingLogic.isWithinEmergencyWindow(challengeClosingIn(now, 300), now)).toBe(true);
        expect(VotingLogic.isWithinEmergencyWindow(challengeClosingIn(now, 301), now)).toBe(false);
    });

    test('false when Emergency Fill is disabled (0)', () => {
        mockSettings({ emergencyFill: 0 });
        const now = NOW();
        expect(VotingLogic.isWithinEmergencyWindow(challengeClosingIn(now, 120), now)).toBe(false);
    });

    test('false for already-closed or missing close_time', () => {
        mockSettings({ emergencyFill: 300 });
        const now = NOW();
        expect(VotingLogic.isWithinEmergencyWindow(challengeClosingIn(now, 0), now)).toBe(false);
        expect(VotingLogic.isWithinEmergencyWindow(invalid({ id: '777' }), now)).toBe(false);
        expect(VotingLogic.isWithinEmergencyWindow(invalid(null), now)).toBe(false);
    });
});

/**
 * Key-unlocked boosts have no timer of their own, so boostTime — which counts down that
 * timer — cannot describe them. Their window is its own setting, deliberately separate
 * from boostTime so one user-facing number is not reinterpreted as two things.
 */
describe('shouldApplyBoost — key-unlocked window', () => {
    beforeEach(() => jest.clearAllMocks());

    const keyUnlockedChallenge = (now: number, closeInSeconds: number) =>
        buildChallenge({
            id: '777',
            close_time: now + closeInSeconds,
            // AVAILABLE_KEY, and AVAILABLE with no timeout, both count as key-unlocked.
            member: { boost: { state: 'AVAILABLE_KEY', timeout: 0 } },
        });

    test('honours a configured window instead of the old constant', () => {
        mockSettings({ keyUnlockedBoostTime: 1800, emergencyFill: 0 });
        const now = NOW();

        // 20 minutes out: inside a 30m window, outside the previous 15m constant.
        expect(VotingLogic.shouldApplyBoost(keyUnlockedChallenge(now, 1200), now)).toBe(true);
        // 40 minutes out: still outside.
        expect(VotingLogic.shouldApplyBoost(keyUnlockedChallenge(now, 2400), now)).toBe(false);
    });

    test('falls back to 15 minutes when the setting is absent', () => {
        // Settings written before this key existed must keep a 15-minute window rather
        // than reading as 0 and silently disabling key-unlocked boosts altogether.
        mockSettings({ emergencyFill: 0 });
        const now = NOW();

        expect(VotingLogic.getEffectiveKeyUnlockedBoostTime('777')).toBe(900);
        expect(VotingLogic.shouldApplyBoost(keyUnlockedChallenge(now, 600), now)).toBe(true);
        expect(VotingLogic.shouldApplyBoost(keyUnlockedChallenge(now, 1200), now)).toBe(false);
    });

    test('an explicit 0 turns key-unlocked auto-apply off', () => {
        // 0-is-off is the convention boostTime and emergencyFill already use, and both the
        // schema and the GUI input accept 0 — so it must be honoured, not overridden by the
        // default. Silently substituting 900 here would ignore a value the user could set
        // through the UI with no indication it had been discarded.
        mockSettings({ keyUnlockedBoostTime: 0, emergencyFill: 0 });
        const now = NOW();

        expect(VotingLogic.getEffectiveKeyUnlockedBoostTime('777')).toBe(0);
        expect(VotingLogic.shouldApplyBoost(keyUnlockedChallenge(now, 600), now)).toBe(false);
        expect(VotingLogic.shouldApplyBoost(keyUnlockedChallenge(now, 1), now)).toBe(false);
    });

    test('an unusable value falls back rather than disabling boosts', () => {
        const now = NOW();
        // Reachable from an under-mocked caller or a hand-edited settings file — unlike an
        // explicit 0, none of these express an intent to switch the feature off.
        for (const bad of [-1, 'nonsense', null, undefined]) {
            mockSettings({ keyUnlockedBoostTime: bad, emergencyFill: 0 });
            expect(VotingLogic.getEffectiveKeyUnlockedBoostTime('777')).toBe(900);
            expect(VotingLogic.shouldApplyBoost(keyUnlockedChallenge(now, 600), now)).toBe(true);
        }
    });

    test('does not affect the timer-based window, which still reads boostTime', () => {
        mockSettings({ keyUnlockedBoostTime: 60, boostTime: 3600, emergencyFill: 0 });
        const now = NOW();
        const timerBased = buildChallenge({
            id: '777',
            close_time: now + 7200,
            member: { boost: { state: 'AVAILABLE', timeout: now + 60 } },
        });

        // Boost's own timer expires in 60s, well inside boostTime — the small
        // key-unlocked window must not interfere.
        expect(VotingLogic.shouldApplyBoost(timerBased, now)).toBe(true);
    });
});

describe('getBoostHoldUntil — fresh-entry wait', () => {
    const now = 1_800_000_000;
    const keyChallenge = (closeIn = 900) =>
        buildChallenge({ id: '777', close_time: now + closeIn, member: { boost: { state: 'AVAILABLE_KEY' } } });

    beforeEach(() => mockSettings({ boostFreshEntryWait: 180 }));

    test('holds until the target has been in the challenge the configured time', () => {
        expect(VotingLogic.getBoostHoldUntil(keyChallenge(), now - 30, now)).toBe(now + 150);
    });

    test('boosts now once the wait has passed, or when the entry time is unknown', () => {
        expect(VotingLogic.getBoostHoldUntil(keyChallenge(), now - 180, now)).toBeNull();
        expect(VotingLogic.getBoostHoldUntil(keyChallenge(), 0, now)).toBeNull();
        expect(VotingLogic.getBoostHoldUntil(keyChallenge(), null, now)).toBeNull();
    });

    test('0 (or an unusable value) turns the wait off', () => {
        mockSettings({ boostFreshEntryWait: 0 });
        expect(VotingLogic.getBoostHoldUntil(keyChallenge(), now, now)).toBeNull();
        mockSettings({ boostFreshEntryWait: undefined });
        expect(VotingLogic.getBoostHoldUntil(keyChallenge(), now, now)).toBeNull();
    });

    test('never holds a key-unlocked boost past a minute before close', () => {
        expect(VotingLogic.getBoostHoldUntil(keyChallenge(240), now, now)).toBe(now + 180);
        expect(VotingLogic.getBoostHoldUntil(keyChallenge(239), now, now)).toBeNull();
    });

    test('never holds a timer boost past a minute before its own timeout', () => {
        const timer = (timeout: number) =>
            buildChallenge({
                id: '777',
                close_time: now + 7200,
                member: { boost: { state: 'AVAILABLE', timeout: now + timeout } },
            });
        expect(VotingLogic.getBoostHoldUntil(timer(240), now, now)).toBe(now + 180);
        expect(VotingLogic.getBoostHoldUntil(timer(200), now, now)).toBeNull();
    });
});
