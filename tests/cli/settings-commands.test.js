/**
 * Unit tests for the CLI settings commands' per-challenge support. The
 * commands are thin shells over the settings facade, so we mock the facade
 * and assert each command routes to the right per-challenge function with
 * the right arguments. A file-local logger mock supplies sanitizeForLog
 * (used by formatSettingForLog) which the global setup mock omits.
 */

jest.mock('../../src/js/settings');

jest.mock('../../src/js/logger.js', () => {
    const withCategory = () => ({
        info: jest.fn(),
        error: jest.fn(),
        success: jest.fn(),
        warning: jest.fn(),
        debug: jest.fn(),
    });
    return {
        withCategory: jest.fn(withCategory),
        // formatSettingForLog redacts via this; return a passthrough shape.
        sanitizeForLog: jest.fn((obj) => obj),
    };
});

const settings = require('../../src/js/settings');
const { getSetting, setSetting, resetSetting } = require('../../src/js/cli/commands/settings');

describe('CLI settings commands — per-challenge support', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        settings.SETTINGS_SCHEMA = {
            exposure: { type: 'number', perChallenge: true, default: 50 },
            theme: { type: 'string', perChallenge: false, default: 'light' },
        };
    });

    test('setSetting with a challengeId routes to setChallengeOverride and parses the value', () => {
        settings.setChallengeOverride.mockReturnValue(true);
        setSetting('exposure', '80', '12345');
        expect(settings.setChallengeOverride).toHaveBeenCalledWith('exposure', '12345', 80);
        expect(settings.setSetting).not.toHaveBeenCalled();
    });

    test('setSetting with a challengeId rejects keys that do not support per-challenge overrides', () => {
        setSetting('theme', 'dark', '12345');
        expect(settings.setChallengeOverride).not.toHaveBeenCalled();
        expect(settings.setSetting).not.toHaveBeenCalled();
    });

    test('setSetting without a challengeId uses the global facade', () => {
        setSetting('exposure', '80');
        expect(settings.setSetting).toHaveBeenCalledWith('exposure', 80);
        expect(settings.setChallengeOverride).not.toHaveBeenCalled();
    });

    test('getSetting with a challengeId reads the effective value for that challenge', () => {
        settings.getEffectiveSetting.mockReturnValue(80);
        settings.getChallengeOverride.mockReturnValue(80);
        getSetting('exposure', '12345');
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('exposure', '12345');
    });

    test('resetSetting with a challengeId removes the override', () => {
        settings.removeChallengeOverride.mockReturnValue(true);
        resetSetting('exposure', '12345');
        expect(settings.removeChallengeOverride).toHaveBeenCalledWith('exposure', '12345');
    });
});
