/**
 * shouldApplyBoost is gated by the per-challenge `autoBoost` setting so a
 * user can opt a specific challenge out of the auto-apply loop while still
 * being able to apply boost manually. Mirrors the autoTurbo gate that
 * shouldPlayAutoTurbo enforces.
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');

jest.mock('../../src/js/settings');

const NOW = () => Math.floor(Date.now() / 1000);

const buildChallengeWithBoostExpiring = (now) => ({
    id: '777',
    close_time: now + 3600,
    member: {
        boost: { state: 'AVAILABLE', timeout: now + 60 },
    },
});

// A boost is available (timer-based, far-future timeout) but the challenge is
// seconds from closing — the normal boostTime window would not fire here, so
// only the emergency override can apply it.
const buildClosingChallengeWithBoost = (now, closeInSeconds = 120) => ({
    id: '777',
    close_time: now + closeInSeconds,
    member: {
        boost: { state: 'AVAILABLE', timeout: now + 1800 },
    },
});

const mockSettings = (overrides = {}) => {
    const defaults = {
        autoBoost: true,
        boostTime: 3600,
        emergencyFill: 300,
    };
    settings.getEffectiveSetting = jest.fn((key) => ({ ...defaults, ...overrides })[key]);
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
        const challenge = {
            id: '777',
            close_time: now + 120,
            member: { boost: { state: 'NONE' } },
        };
        expect(VotingLogic.shouldApplyBoost(challenge, now, { emergency: true })).toBe(false);
    });

    test('applies a key-unlocked boost (AVAILABLE_KEY) in the emergency window with autoBoost off', () => {
        mockSettings({ autoBoost: false, emergencyFill: 300 });
        const now = NOW();
        const challenge = {
            id: '777',
            close_time: now + 120,
            member: { boost: { state: 'AVAILABLE_KEY', timeout: null } },
        };
        expect(VotingLogic.shouldApplyBoost(challenge, now, { emergency: true })).toBe(true);
    });

    test('does not apply an AVAILABLE boost whose timer has already expired (stale state)', () => {
        mockSettings({ autoBoost: false, emergencyFill: 300 });
        const now = NOW();
        const challenge = {
            id: '777',
            close_time: now + 120,
            member: { boost: { state: 'AVAILABLE', timeout: now - 10 } },
        };
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

    const challengeClosingIn = (now, secs) => ({ id: '777', close_time: now + secs });

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
        expect(VotingLogic.isWithinEmergencyWindow({ id: '777' }, now)).toBe(false);
        expect(VotingLogic.isWithinEmergencyWindow(null, now)).toBe(false);
    });
});
