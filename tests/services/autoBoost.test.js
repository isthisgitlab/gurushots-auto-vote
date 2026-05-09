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

const mockSettings = (overrides = {}) => {
    const defaults = {
        autoBoost: true,
        boostTime: 3600,
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
