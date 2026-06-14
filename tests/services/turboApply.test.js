/**
 * shouldApplyTurbo decides whether to apply a previously-won Turbo to
 * one of the user's entries on a challenge. The evaluator combines
 * timing (turboTime threshold), boost-window interaction
 * (turboApplyWhenBoostActive), and entry index (per-entry boost/turbo
 * are mutually exclusive — turbo applies to a specific entry).
 */

const settings = require('../../src/js/settings');
const VotingLogic = require('../../src/js/services/VotingLogic');

jest.mock('../../src/js/settings');

const buildChallenge = ({
    turboState = 'WON',
    closeInSeconds = 600,
    entries = [{ id: 'entry-1' }, { id: 'entry-2' }, { id: 'entry-3' }],
    boostState = 'NONE',
    boostTimeout = 0,
}) => {
    const now = Math.floor(Date.now() / 1000);
    return {
        id: '222',
        close_time: now + closeInSeconds,
        member: {
            turbo: { state: turboState },
            boost: { state: boostState, timeout: boostTimeout },
            ranking: { entries },
        },
    };
};

const mockSettings = (overrides = {}) => {
    const defaults = {
        useTurbo: true,
        turboTime: 7200,
        turboApplyWhenBoostActive: false,
        turboImageIndex: 1,
        turboFillNew: false,
        emergencyFill: 300,
    };
    settings.getEffectiveSetting = jest.fn((key) => ({ ...defaults, ...overrides })[key]);
};

const NOW = () => Math.floor(Date.now() / 1000);

describe('shouldApplyTurbo', () => {
    beforeEach(() => jest.clearAllMocks());

    test('applies when state is WON and within turboTime window', () => {
        mockSettings();
        const challenge = buildChallenge({ closeInSeconds: 600 }); // 10 min < 7200 default
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());

        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('entry-1'); // turboImageIndex=1 → first entry
    });

    test('does not apply when useTurbo is disabled', () => {
        mockSettings({ useTurbo: false });
        const challenge = buildChallenge({ closeInSeconds: 600 });
        expect(VotingLogic.shouldApplyTurbo(challenge, NOW()).apply).toBe(false);
    });

    test('does not apply when state is not WON', () => {
        mockSettings();
        const challenge = buildChallenge({ turboState: 'TIMER' });
        expect(VotingLogic.shouldApplyTurbo(challenge, NOW()).apply).toBe(false);
    });

    test('does not apply when challenge has ended', () => {
        mockSettings();
        const challenge = buildChallenge({ closeInSeconds: -10 });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(false);
        expect(result.reason).toBe('challenge ended');
    });

    test('does not apply when remaining time exceeds turboTime threshold', () => {
        mockSettings({ turboTime: 600 }); // 10 min threshold
        const challenge = buildChallenge({ closeInSeconds: 7200 }); // 2h remaining
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(false);
        expect(result.reason).toContain('threshold');
    });

    test('skips while boost window is open by default', () => {
        mockSettings({ turboApplyWhenBoostActive: false });
        const challenge = buildChallenge({
            closeInSeconds: 600,
            boostState: 'AVAILABLE',
            boostTimeout: NOW() + 1800, // boost window still alive
        });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(false);
        expect(result.reason).toBe('boost window currently open');
    });

    test('overrides boost-window block when turboApplyWhenBoostActive is true', () => {
        mockSettings({ turboApplyWhenBoostActive: true });
        const challenge = buildChallenge({
            closeInSeconds: 600,
            boostState: 'AVAILABLE',
            boostTimeout: NOW() + 1800,
        });
        expect(VotingLogic.shouldApplyTurbo(challenge, NOW()).apply).toBe(true);
    });

    test('turboImageIndex 0 maps to last entry (sentinel)', () => {
        mockSettings({ turboImageIndex: 0 });
        const challenge = buildChallenge({
            closeInSeconds: 600,
            entries: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('c');
    });

    test('turboImageIndex above entry count clamps to last entry', () => {
        mockSettings({ turboImageIndex: 99 });
        const challenge = buildChallenge({
            closeInSeconds: 600,
            entries: [{ id: 'a' }, { id: 'b' }],
        });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(true);
        expect(result.imageId).toBe('b');
    });

    test('does not apply (no entries) when challenge has no entries and fill-new is off', () => {
        mockSettings();
        const challenge = buildChallenge({ closeInSeconds: 600, entries: [] });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(false);
        expect(result.reason).toBe('no entries to apply turbo to');
    });

    test('reports fillNew=false on the normal (non fill-new) path', () => {
        mockSettings();
        const challenge = buildChallenge({ closeInSeconds: 600 });
        const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
        expect(result.apply).toBe(true);
        expect(result.fillNew).toBe(false);
    });

    describe('turboFillNew (fill-new)', () => {
        test('applies with fillNew=true and no entries (fill-new can create the first entry)', () => {
            mockSettings({ turboFillNew: true });
            const challenge = buildChallenge({ closeInSeconds: 600, entries: [] });
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(true);
            expect(result.fillNew).toBe(true);
            expect(result.imageId).toBeNull(); // no existing fallback target
        });

        test('still passes the existing entry as a fallback target when entries exist', () => {
            mockSettings({ turboFillNew: true });
            const challenge = buildChallenge({ closeInSeconds: 600 }); // entry-1..3
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(true);
            expect(result.fillNew).toBe(true);
            expect(result.imageId).toBe('entry-1'); // turboImageIndex=1 → first entry
        });

        test('still honors the WON gate when fill-new is on', () => {
            mockSettings({ turboFillNew: true });
            const challenge = buildChallenge({ turboState: 'TIMER', closeInSeconds: 600, entries: [] });
            expect(VotingLogic.shouldApplyTurbo(challenge, NOW()).apply).toBe(false);
        });

        test('still honors the timing threshold when fill-new is on', () => {
            mockSettings({ turboFillNew: true, turboTime: 600 });
            const challenge = buildChallenge({ closeInSeconds: 7200, entries: [] });
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(false);
            expect(result.reason).toContain('threshold');
        });

        test('applies with a null fallback when the only existing entry is already boosted', () => {
            // Picker returns null (single entry already boosted) — fill-new still
            // applies, with imageId=null so the caller knows there is no fallback.
            mockSettings({ turboFillNew: true });
            const challenge = buildChallenge({ closeInSeconds: 600, entries: [{ id: 'b1', boosted: true }] });
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(true);
            expect(result.fillNew).toBe(true);
            expect(result.imageId).toBeNull();
        });
    });

    describe('emergency override', () => {
        test('applies a won turbo in the emergency window even when useTurbo is off', () => {
            mockSettings({ useTurbo: false, emergencyFill: 300 });
            const challenge = buildChallenge({ closeInSeconds: 120 }); // inside 5-min window
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW(), { emergency: true });
            expect(result.apply).toBe(true);
            expect(result.imageId).toBe('entry-1');
        });

        test('has no effect without the option flag (default behavior unchanged)', () => {
            mockSettings({ useTurbo: false, emergencyFill: 300 });
            const challenge = buildChallenge({ closeInSeconds: 120 });
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW());
            expect(result.apply).toBe(false);
            expect(result.reason).toBe('useTurbo disabled');
        });

        test('bypasses the turboTime threshold in the emergency window', () => {
            mockSettings({ turboTime: 60, emergencyFill: 300 }); // 2 min remaining > 1 min threshold
            const challenge = buildChallenge({ closeInSeconds: 120 });
            expect(VotingLogic.shouldApplyTurbo(challenge, NOW()).apply).toBe(false); // blocked without emergency
            expect(VotingLogic.shouldApplyTurbo(challenge, NOW(), { emergency: true }).apply).toBe(true);
        });

        test('bypasses the open-boost-window guard in the emergency window', () => {
            mockSettings({ turboApplyWhenBoostActive: false, emergencyFill: 300 });
            const challenge = buildChallenge({
                closeInSeconds: 120,
                boostState: 'AVAILABLE',
                boostTimeout: NOW() + 1800,
            });
            expect(VotingLogic.shouldApplyTurbo(challenge, NOW()).apply).toBe(false); // blocked without emergency
            expect(VotingLogic.shouldApplyTurbo(challenge, NOW(), { emergency: true }).apply).toBe(true);
        });

        test('still honors the WON gate', () => {
            mockSettings({ useTurbo: false, emergencyFill: 300 });
            const challenge = buildChallenge({ turboState: 'TIMER', closeInSeconds: 120 });
            expect(VotingLogic.shouldApplyTurbo(challenge, NOW(), { emergency: true }).apply).toBe(false);
        });

        test('does not override outside the emergency window', () => {
            mockSettings({ useTurbo: false, emergencyFill: 300 });
            const challenge = buildChallenge({ closeInSeconds: 600 }); // 10 min > 5-min window
            const result = VotingLogic.shouldApplyTurbo(challenge, NOW(), { emergency: true });
            expect(result.apply).toBe(false);
            expect(result.reason).toBe('useTurbo disabled');
        });

        test('does not override when Emergency Fill is disabled (0)', () => {
            mockSettings({ useTurbo: false, emergencyFill: 0 });
            const challenge = buildChallenge({ closeInSeconds: 120 });
            expect(VotingLogic.shouldApplyTurbo(challenge, NOW(), { emergency: true }).apply).toBe(false);
        });
    });
});
