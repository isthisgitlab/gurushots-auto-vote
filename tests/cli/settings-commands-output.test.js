/**
 * Output / failure-path tests for the CLI settings commands
 * (commands/settings.js). settings-commands.test.js covers the per-challenge
 * routing; this file covers what each command prints, the validation
 * failures, the facade-throws paths, and the schema / global-default dumps
 * shared with scripts/settings-cli.js. The settings facade is a hand-rolled
 * mock so every return value is explicit.
 */

jest.mock('../../src/js/logger.js', () => {
    const calls = [];
    const rec = (level) => (msg) => calls.push({ level, msg });
    const cat = { info: rec('info'), error: rec('error'), success: rec('success') };
    return {
        __calls: calls,
        withCategory: jest.fn(() => cat),
        sanitizeForLog: jest.fn((obj) => (Object.hasOwn(obj, 'token') ? { token: '[REDACTED]' } : obj)),
    };
});

jest.mock('../../src/js/settings', () => ({
    SETTINGS_SCHEMA: {},
    getSetting: jest.fn(),
    setSetting: jest.fn(),
    getEffectiveSetting: jest.fn(),
    getChallengeOverride: jest.fn(),
    setChallengeOverride: jest.fn(),
    removeChallengeOverride: jest.fn(),
    setGlobalDefault: jest.fn(),
    getGlobalDefault: jest.fn(),
    resetGlobalDefault: jest.fn(),
    resetAllSettings: jest.fn(),
    loadSettings: jest.fn(),
    saveSettings: jest.fn(),
    getDefaultSettings: jest.fn(),
    getChallengeProfiles: jest.fn(),
    getChallengeOverrides: jest.fn(),
    saveChallengeProfile: jest.fn(),
    applyChallengeProfile: jest.fn(),
    deleteChallengeProfile: jest.fn(),
}));

const logger = require('../../src/js/logger.js');
const settings = require('../../src/js/settings');
const cmd = require('../../src/js/cli/commands/settings');

const msgs = (level) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));
const boom = () => {
    throw new Error('facade exploded');
};

beforeEach(() => {
    logger.__calls.length = 0;
    Object.values(settings).forEach((v) => typeof v === 'function' && v.mockReset());
    settings.SETTINGS_SCHEMA = {
        exposure: { type: 'number', perChallenge: true, default: 50, label: 'Exposure', description: 'Target %' },
        lastMinuteCheckFrequency: { type: 'number', perChallenge: false, default: 1 },
        emergencyFill: { type: 'time', perChallenge: true, default: 300 },
    };
});

describe('formatSettingForLog', () => {
    test('redacts sensitive keys', () => {
        expect(cmd.formatSettingForLog('token', 'secret')).toBe('[REDACTED]');
    });

    test('a non-finite or non-number time value is printed raw', () => {
        expect(cmd.formatSettingForLog('emergencyFill', 'soon')).toBe('"soon"');
        expect(cmd.formatSettingForLog('emergencyFill', Infinity)).toBe('null');
    });
});

describe('getSetting', () => {
    test('rejects a key that has no per-challenge support', () => {
        expect(cmd.getSetting('lastMinuteCheckFrequency', '7')).toBeUndefined();
        expect(msgs('error')).toEqual(["Setting 'lastMinuteCheckFrequency' does not support per-challenge overrides"]);
    });

    test('rejects an unknown key when scoped to a challenge', () => {
        cmd.getSetting('nope', '7');
        expect(msgs('error')).toEqual(["Setting 'nope' does not support per-challenge overrides"]);
    });

    test.each([
        [80, 'override'],
        [null, 'inherited from global default'],
    ])('per-challenge value labelled by whether an override exists (%p)', (override, status) => {
        settings.getEffectiveSetting.mockReturnValue(80);
        settings.getChallengeOverride.mockReturnValue(override);
        expect(cmd.getSetting('exposure', '7')).toBe(true);
        expect(msgs('info')).toEqual([`exposure [challenge 7]: 80 (${status})`]);
    });

    test('prints a global value', () => {
        settings.getSetting.mockReturnValue(30);
        expect(cmd.getSetting('apiTimeout')).toBe(true);
        expect(msgs('info')).toEqual(['apiTimeout: 30']);
    });

    test('reports an unknown global key', () => {
        settings.getSetting.mockReturnValue(undefined);
        expect(cmd.getSetting('ghost')).toBe(false);
        expect(msgs('error')).toEqual(["Setting 'ghost' not found"]);
    });

    test('a throwing facade is reported, not thrown', () => {
        settings.getSetting.mockImplementation(boom);
        expect(cmd.getSetting('apiTimeout')).toBe(false);
        expect(msgs('error')).toEqual(["Error getting setting 'apiTimeout'"]);
    });
});

describe('setSetting', () => {
    test('a per-challenge set that fails validation is reported', () => {
        settings.setChallengeOverride.mockReturnValue(false);
        expect(cmd.setSetting('exposure', '999', '7')).toBe(false);
        expect(msgs('error')).toEqual(['Failed to set exposure for challenge 7 — validation failed']);
    });

    test('a successful per-challenge set is confirmed', () => {
        settings.setChallengeOverride.mockReturnValue(true);
        expect(cmd.setSetting('exposure', '80', '7')).toBe(true);
        expect(msgs('success')).toEqual(['Set exposure = 80 for challenge 7']);
    });

    test('a per-challenge-capable schema key without --challenge redirects and suggests --challenge', () => {
        settings.setGlobalDefault.mockReturnValue(true);
        settings.getGlobalDefault.mockReturnValue(80);
        expect(cmd.setSetting('exposure', '80')).toBe(true);
        expect(msgs('info')).toEqual([
            "'exposure' is a voting setting — applying it as the global default",
            'Use --challenge <id> to override it for a single challenge instead',
        ]);
        expect(msgs('success')).toEqual(['Set global default exposure = 80']);
    });

    test('a global-only schema key redirects without the --challenge hint', () => {
        settings.setGlobalDefault.mockReturnValue(true);
        settings.getGlobalDefault.mockReturnValue(2);
        cmd.setSetting('lastMinuteCheckFrequency', '2');
        expect(msgs('info')).toEqual([
            "'lastMinuteCheckFrequency' is a voting setting — applying it as the global default",
        ]);
    });

    test('an app-level key that fails validation is reported', () => {
        settings.setSetting.mockReturnValue(false);
        expect(cmd.setSetting('theme', 'purple')).toBe(false);
        expect(msgs('error')).toEqual(["Failed to save setting 'theme' - validation failed"]);
    });

    test('an app-level key success is confirmed with the parsed value', () => {
        settings.setSetting.mockReturnValue(true);
        expect(cmd.setSetting('mock', 'true')).toBe(true);
        expect(settings.setSetting).toHaveBeenCalledWith('mock', true);
        expect(msgs('success')).toEqual(['Set mock = true']);
    });

    test('a throwing facade is reported, not thrown', () => {
        settings.setSetting.mockImplementation(boom);
        expect(cmd.setSetting('theme', 'dark')).toBe(false);
        expect(msgs('error')).toEqual(["Error setting 'theme'"]);
    });
});

describe('setGlobalDefault', () => {
    test('an unknown schema key lists the available keys, sorted', () => {
        expect(cmd.setGlobalDefault('exposre', '80')).toBe(false);
        expect(msgs('error')).toEqual(["Unknown schema setting 'exposre'"]);
        expect(msgs('info')).toEqual(['Available settings: emergencyFill, exposure, lastMinuteCheckFrequency']);
    });

    test('an invalid value explains the type and default', () => {
        settings.setGlobalDefault.mockReturnValue(false);
        expect(cmd.setGlobalDefault('exposure', '"x"')).toBe(false);
        expect(msgs('error')).toEqual([
            "Failed to set global default 'exposure' - validation failed",
            'Value "x" is invalid for this setting',
        ]);
        expect(msgs('info')).toEqual(['Setting info: number type, default: 50']);
    });

    test('a throwing facade is reported, not thrown', () => {
        settings.setGlobalDefault.mockImplementation(boom);
        expect(cmd.setGlobalDefault('exposure', '1')).toBe(false);
        expect(msgs('error')).toEqual(["Error setting global default 'exposure'"]);
    });
});

describe('listSettings', () => {
    test('per-challenge view lists only per-challenge keys with their status', () => {
        settings.getEffectiveSetting.mockImplementation((key) => (key === 'exposure' ? 80 : 0));
        settings.getChallengeOverride.mockImplementation((key) => (key === 'exposure' ? 80 : null));
        cmd.listSettings('7');
        const info = msgs('info');
        expect(info[0]).toBe('=== Settings for challenge 7 ===');
        expect(info).toContain('emergencyFill: 0 (off)  [Inherited ✅]');
        expect(info).toContain('exposure: 80  [Override ✏️]');
        expect(info.some((l) => l.startsWith('lastMinuteCheckFrequency'))).toBe(false);
    });

    test('global view marks modified vs default values over the union of keys', () => {
        settings.loadSettings.mockReturnValue({ theme: 'dark', extra: 1 });
        settings.getDefaultSettings.mockReturnValue({ theme: 'light', language: 'en' });
        cmd.listSettings();
        const info = msgs('info');
        expect(info[0]).toBe('=== All Settings ===');
        const block = (key) => info.slice(info.indexOf(`${key}:`), info.indexOf(`${key}:`) + 4);
        expect(block('theme')).toEqual(['theme:', '  Current: "dark"', '  Default: "light"', '  Status:  Modified ✏️']);
        expect(block('language')).toEqual([
            'language:',
            '  Current: undefined',
            '  Default: "en"',
            '  Status:  Modified ✏️',
        ]);
        expect(block('extra')[3]).toBe('  Status:  Modified ✏️');
        expect(info.at(-1)).toMatch(/help-settings/);
    });

    test('an unmodified value is marked default', () => {
        settings.loadSettings.mockReturnValue({ theme: 'light' });
        settings.getDefaultSettings.mockReturnValue({ theme: 'light' });
        cmd.listSettings(null);
        expect(msgs('info')).toContain('  Status:  Default ✅');
    });

    test('a throwing facade is reported, not thrown', () => {
        settings.loadSettings.mockImplementation(boom);
        cmd.listSettings();
        expect(msgs('error')).toEqual(['Error listing settings']);
    });
});

describe('resetSetting', () => {
    test('a per-challenge reset of an unsupported key is refused', () => {
        expect(cmd.resetSetting('lastMinuteCheckFrequency', '7')).toBe(false);
        expect(settings.removeChallengeOverride).not.toHaveBeenCalled();
    });

    test('a per-challenge reset is confirmed', () => {
        settings.removeChallengeOverride.mockReturnValue(true);
        expect(cmd.resetSetting('exposure', '7')).toBe(true);
        expect(msgs('success')[0]).toMatch(/^Reset exposure for challenge 7/);
    });

    test('a global reset writes the default', () => {
        settings.getDefaultSettings.mockReturnValue({ theme: 'light' });
        expect(cmd.resetSetting('theme')).toBe(true);
        expect(settings.setSetting).toHaveBeenCalledWith('theme', 'light');
        expect(msgs('success')).toEqual(['Reset theme to default: "light"']);
    });

    test('a key with no default is reported', () => {
        settings.getDefaultSettings.mockReturnValue({});
        expect(cmd.resetSetting('ghost')).toBe(false);
        expect(msgs('error')).toEqual(["Setting 'ghost' not found in defaults"]);
    });

    test('a throwing facade is reported, not thrown', () => {
        settings.getDefaultSettings.mockImplementation(boom);
        expect(cmd.resetSetting('theme')).toBe(false);
        expect(msgs('error')).toEqual(["Error resetting setting 'theme'"]);
    });
});

describe('resetGlobalDefault', () => {
    test('an unknown key lists the available keys', () => {
        expect(cmd.resetGlobalDefault('ghost')).toBe(false);
        expect(msgs('error')).toEqual(["Unknown schema setting 'ghost'"]);
    });

    test('a facade refusal is reported', () => {
        settings.resetGlobalDefault.mockReturnValue(false);
        expect(cmd.resetGlobalDefault('exposure')).toBe(false);
        expect(msgs('error')).toEqual(["Failed to reset global default 'exposure'"]);
    });

    test('success prints the schema default', () => {
        settings.resetGlobalDefault.mockReturnValue(true);
        expect(cmd.resetGlobalDefault('exposure')).toBe(true);
        expect(msgs('success')).toEqual(['Reset global default exposure to: 50']);
    });

    test('a throwing facade is reported, not thrown', () => {
        settings.resetGlobalDefault.mockImplementation(boom);
        expect(cmd.resetGlobalDefault('exposure')).toBe(false);
        expect(msgs('error')).toEqual(["Error resetting global default 'exposure'"]);
    });
});

describe('resetAllSettings', () => {
    test('delegates to the facade and confirms', () => {
        settings.resetAllSettings.mockReturnValue(true);
        expect(cmd.resetAllSettings()).toBe(true);
        expect(msgs('success')[0]).toMatch(/token, mock flag, and API headers preserved/);
    });

    test('a facade refusal is reported', () => {
        settings.resetAllSettings.mockReturnValue(false);
        expect(cmd.resetAllSettings()).toBe(false);
        expect(msgs('error')).toEqual(['Failed to reset all settings']);
    });

    test('a throwing facade is reported, not thrown', () => {
        settings.resetAllSettings.mockImplementation(boom);
        expect(cmd.resetAllSettings()).toBe(false);
        expect(msgs('error')).toEqual(['Error resetting all settings']);
    });
});

describe('schema and global-default dumps', () => {
    test('dumpSchema prints type/default/per-challenge and optional label/description', () => {
        cmd.dumpSchema();
        const info = msgs('info');
        expect(info).toEqual(
            expect.arrayContaining([
                '\nexposure:',
                '  Type: number',
                '  Default: 50',
                '  Per-Challenge: Yes',
                '  Label: Exposure',
                '  Description: Target %',
                '  Per-Challenge: No',
            ]),
        );
        expect(info.filter((l) => l.startsWith('  Label:'))).toHaveLength(1);
        expect(info.filter((l) => l.startsWith('  Description:'))).toHaveLength(1);
    });

    test('listGlobalDefaults prefers stored overrides over schema defaults', () => {
        settings.loadSettings.mockReturnValue({ challengeSettings: { globalDefaults: { exposure: 70 } } });
        cmd.listGlobalDefaults();
        const info = msgs('info');
        expect(info).toContain('exposure: 70');
        expect(info).toContain('emergencyFill: 300');
    });

    test('listGlobalDefaults falls back to schema defaults with no stored map', () => {
        settings.loadSettings.mockReturnValue({});
        cmd.listGlobalDefaults();
        expect(msgs('info')).toContain('exposure: 50');
    });
});

describe('profiles', () => {
    test('no profiles prints the save hint', () => {
        settings.getChallengeProfiles.mockReturnValue({});
        cmd.listProfiles();
        expect(msgs('info')).toEqual([
            'No saved challenge profiles',
            '💡 Save one with: save-profile "<name>" --challenge=<id>',
        ]);
    });

    test('profiles are listed by name with a summary of their values', () => {
        settings.getChallengeProfiles.mockReturnValue({ zeta: {}, alpha: { exposure: 80, emergencyFill: 0 } });
        cmd.listProfiles();
        expect(msgs('info')).toEqual([
            '=== Challenge Profiles ===',
            'alpha (2): emergencyFill=0 (off), exposure=80',
            'zeta (0): (no overrides — applying it resets the challenge to global defaults)',
        ]);
    });

    test('a successful save reports the override count', () => {
        settings.getChallengeOverrides.mockReturnValue({ exposure: 80 });
        settings.saveChallengeProfile.mockReturnValue(true);
        cmd.saveProfileFromChallenge('p', '7');
        expect(msgs('success')).toEqual(['Saved profile "p" with 1 override(s) from challenge 7']);
    });

    test('failed save / apply / delete each explain themselves', () => {
        settings.getChallengeOverrides.mockReturnValue({});
        settings.saveChallengeProfile.mockReturnValue(false);
        settings.applyChallengeProfile.mockReturnValue(false);
        settings.deleteChallengeProfile.mockReturnValue(false);
        cmd.saveProfileFromChallenge('p', '7');
        cmd.applyProfile('p', '7');
        cmd.deleteProfile('p');
        const errors = msgs('error');
        expect(errors[0]).toMatch(/^Failed to save profile/);
        expect(errors[1]).toMatch(/^Failed to apply profile "p" — no such profile/);
        expect(errors[2]).toBe('No profile named "p"');
    });

    test('successful apply / delete are confirmed', () => {
        settings.applyChallengeProfile.mockReturnValue(true);
        settings.deleteChallengeProfile.mockReturnValue(true);
        cmd.applyProfile('p', '7');
        cmd.deleteProfile('p');
        expect(msgs('success')).toEqual(['Applied profile "p" to challenge 7', 'Deleted profile "p"']);
        expect(msgs('info')).toEqual(['💡 Run "list-settings --challenge=7" to review the applied overrides']);
    });

    test.each([
        ['listProfiles', 'getChallengeProfiles', [], 'Error listing profiles'],
        ['saveProfileFromChallenge', 'getChallengeOverrides', ['p', '7'], 'Error saving profile'],
        ['applyProfile', 'applyChallengeProfile', ['p', '7'], 'Error applying profile'],
        ['deleteProfile', 'deleteChallengeProfile', ['p'], 'Error deleting profile'],
    ])('%s: a throwing facade is reported, not thrown', (fn, facadeFn, args, message) => {
        settings[facadeFn].mockImplementation(boom);
        expect(() => cmd[fn](...args)).not.toThrow();
        expect(msgs('error')).toEqual([message]);
    });
});

describe('help and window reset', () => {
    test('helpSettings prints the command and profile reference', () => {
        cmd.helpSettings();
        const [text] = msgs('info');
        expect(text).toContain('=== Settings Management Help ===');
        expect(text).toContain('save-profile "2-pic tactic" --challenge=12345');
    });

    test('resetWindows restores the default window bounds and saves', () => {
        settings.loadSettings.mockReturnValue({ theme: 'dark', windowBounds: { x: 5 } });
        settings.getDefaultSettings.mockReturnValue({ windowBounds: { x: 0, y: 0 } });
        cmd.resetWindows();
        expect(settings.saveSettings).toHaveBeenCalledWith({ theme: 'dark', windowBounds: { x: 0, y: 0 } });
        expect(msgs('success')).toEqual(['Window positions reset to default']);
    });

    test('resetWindows reports a failure', () => {
        settings.loadSettings.mockImplementation(boom);
        cmd.resetWindows();
        expect(msgs('error')).toEqual(['Error resetting window positions']);
    });
});
