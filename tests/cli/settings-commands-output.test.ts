/**
 * Output / failure-path tests for the CLI settings commands
 * (commands/settings.ts). settings-commands.test.ts covers the per-challenge
 * routing; this file covers what each command prints, the validation
 * failures, the facade-throws paths, and the schema / global-default dumps
 * shared with scripts/settings-cli.ts. The settings facade is a hand-rolled
 * mock so every return value is explicit.
 */

jest.mock('../../src/ts/logger', () => {
    const calls: { level: string; msg: unknown }[] = [];
    const rec = (level: string) => (msg: unknown) => calls.push({ level, msg });
    const cat = { info: rec('info'), error: rec('error'), success: rec('success') };
    return {
        __calls: calls,
        withCategory: jest.fn(() => cat),
        printLine: rec('stdout'),
        printDocument: rec('stdout'),
        sanitizeForLog: jest.fn((obj: object) => (Object.hasOwn(obj, 'token') ? { token: '[REDACTED]' } : obj)),
    };
});

jest.mock('../../src/ts/settings', () => ({
    // Tests replace entries on this object; the marker makes it the very
    // namespace commands/settings.ts imports rather than a copy.
    __esModule: true,
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

import { invalid } from '../helpers/invalid';
import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(invalid<typeof loggerModule & { __calls: { level: string; msg: unknown }[] }>(loggerModule));
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import cmd = require('../../src/ts/cli/commands/settings');

const msgs = (level: string) => logger.__calls.filter((c) => c.level === level).map((c) => String(c.msg));
const boom = () => {
    throw new Error('facade exploded');
};

beforeEach(() => {
    logger.__calls.length = 0;
    Object.values(settings).forEach((v) => typeof v === 'function' && v.mockReset());
    settings.SETTINGS_SCHEMA = invalid({
        exposure: { type: 'number', perChallenge: true, default: 50, label: 'Exposure', description: 'Target %' },
        lastMinuteCheckFrequency: { type: 'number', perChallenge: false, default: 1 },
        emergencyFill: { type: 'time', perChallenge: true, default: 300 },
    });
});

describe('formatSettingForLog', () => {
    test('redacts sensitive keys', () => {
        expect(cmd.formatSettingForLog('token', 'secret')).toBe('[REDACTED]');
    });

    test('a photo list prints its count, never the ids', () => {
        settings.SETTINGS_SCHEMA = invalid({ chosenPhotos: { type: 'photos', perChallenge: true, default: [] } });
        expect(cmd.formatSettingForLog('chosenPhotos', ['a', 'b', 'c'])).toBe('3 photo(s)');
        expect(cmd.formatSettingForLog('chosenPhotos', [])).toBe('0 photo(s)');
        // Anything that is not a list is printed as it is.
        expect(cmd.formatSettingForLog('chosenPhotos', 'oops')).toBe('"oops"');
    });

    test('the account is masked: the login name, the owner record, and photo lists nested in other values', () => {
        expect(cmd.formatSettingForLog('lastUsername', 'me@example.com')).toBe('[REDACTED]');
        expect(cmd.formatSettingForLog('chosenPhotosMemberId', 'member-1')).toBe('[REDACTED]');
        // An unset private value reads as unset, not as a hidden one.
        expect(cmd.formatSettingForLog('lastUsername', '')).toBe('(not set)');
        expect(cmd.formatSettingForLog('chosenPhotosMemberId', undefined)).toBe('(not set)');
        expect(cmd.formatSettingForLog('chosenPhotosMemberId', null)).toBe('(not set)');
        const nested = {
            perChallenge: { '7': { chosenPhotos: ['secret1', 'secret2'], exposure: 50 } },
            titleRules: [{ title: 'Hats', chosenPhotos: ['secret3'] }],
            profiles: { Mine: { chosenPhotos: [] } },
        };
        const printed = cmd.formatSettingForLog('challengeSettings', nested);
        expect(printed).not.toContain('secret');
        expect(JSON.parse(printed)).toEqual({
            perChallenge: { '7': { chosenPhotos: '2 photo(s)', exposure: 50 } },
            titleRules: [{ title: 'Hats', chosenPhotos: '1 photo(s)' }],
            profiles: { Mine: { chosenPhotos: '0 photo(s)' } },
        });
        // Other values are untouched, and a list that is not a photo list stays as it is.
        expect(cmd.formatSettingForLog('exposure', 5)).toBe('5');
        expect(cmd.formatSettingForLog('other', { chosenPhotos: 'x', list: [1, { chosenPhotos: [] }] })).toBe(
            '{"chosenPhotos":"x","list":[1,{"chosenPhotos":"0 photo(s)"}]}',
        );
    });

    test('a value masked inside another value is masked in the printed form, not only by its own key', () => {
        // The old path serialized the unmasked value and only checked the top-level key.
        const printed = cmd.formatSettingForLog('network', {
            apiHeaders: { 'x-api-key': 'k1' },
            auth: { token: 'k2' },
            ua: 'u',
        });
        expect(printed).not.toMatch(/k1|k2/);
        expect(JSON.parse(printed)).toEqual({ apiHeaders: '[REDACTED]', auth: { token: '[REDACTED]' }, ua: 'u' });
        expect(cmd.formatSettingForLog('apiHeaders', { 'x-api-key': 'k1' })).toBe('[REDACTED]');
        const account = cmd.formatSettingForLog('challengeSettings', { lastUsername: 'me@example.com', other: 1 });
        expect(JSON.parse(account)).toEqual({ lastUsername: '[REDACTED]', other: 1 });
    });

    test('a value nested deeper than any settings structure is cut off rather than printed', () => {
        let deep: Record<string, unknown> = { chosenPhotos: ['deep-secret'] };
        for (let i = 0; i < 12; i += 1) deep = { next: deep };
        const printed = cmd.formatSettingForLog('challengeSettings', deep);
        expect(printed).toContain('[Object]');
        expect(printed).not.toContain('deep-secret');
    });

    test('control and format characters in a stored value never reach the terminal', () => {
        const printed = cmd.formatSettingForLog('theme', 'a\u001b[31mb\u202Ec\u0085d');
        expect(printed).not.toMatch(/[\p{Cc}\p{Cf}]/u);
        expect(printed).toContain('mb');
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

    test('a photo list is confirmed and rejected as a count, a token is never printed', () => {
        settings.SETTINGS_SCHEMA = invalid({ chosenPhotos: { type: 'photos', perChallenge: true, default: [] } });
        settings.setChallengeOverride.mockReturnValue(true);
        cmd.setSetting('chosenPhotos', '["secret1","secret2"]', '7');
        expect(msgs('success')).toEqual(['Set chosenPhotos = 2 photo(s) for challenge 7']);
        logger.__calls.length = 0;
        settings.setGlobalDefault.mockReturnValue(false);
        cmd.setGlobalDefault('chosenPhotos', '["secret1","secret1"]');
        expect(msgs('error').join('\n')).not.toContain('secret1');
        expect(msgs('error')).toContain('Value 2 photo(s) is invalid for this setting');
        logger.__calls.length = 0;
        settings.setSetting.mockReturnValue(true);
        cmd.setSetting('token', 'abc123');
        expect(msgs('success')).toEqual(['Set token = [REDACTED]']);
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

    test('a global default photo list is confirmed as a count', () => {
        settings.SETTINGS_SCHEMA = invalid({ chosenPhotos: { type: 'photos', perChallenge: true, default: [] } });
        settings.setGlobalDefault.mockReturnValue(true);
        settings.getGlobalDefault.mockReturnValue(invalid(['secret1', 'secret2']));
        expect(cmd.setGlobalDefault('chosenPhotos', '["secret1","secret2"]')).toBe(true);
        expect(msgs('success')).toEqual(['Set global default chosenPhotos = 2 photo(s)']);
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
        // The listing goes to the console only, never into the log.
        expect(msgs('info')).toEqual([]);
        const info = msgs('stdout');
        expect(info[0]).toBe('=== Settings for challenge 7 ===');
        expect(info).toContain('emergencyFill: 0 (off)  [Inherited ✅]');
        expect(info).toContain('exposure: 80  [Override ✏️]');
        expect(info.some((l) => l.startsWith('lastMinuteCheckFrequency'))).toBe(false);
    });

    test('global view marks modified vs default values over the union of keys', () => {
        settings.loadSettings.mockReturnValue(invalid({ theme: 'dark', extra: 1 }));
        settings.getDefaultSettings.mockReturnValue(invalid({ theme: 'light', language: 'en' }));
        cmd.listSettings();
        const info = msgs('stdout');
        expect(info[0]).toBe('=== All Settings ===');
        const block = (key: string) => info.slice(info.indexOf(`${key}:`), info.indexOf(`${key}:`) + 4);
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
        settings.loadSettings.mockReturnValue(invalid({ theme: 'light' }));
        settings.getDefaultSettings.mockReturnValue(invalid({ theme: 'light' }));
        cmd.listSettings(null);
        expect(msgs('stdout')).toContain('  Status:  Default ✅');
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
        settings.getDefaultSettings.mockReturnValue(invalid({ theme: 'light' }));
        expect(cmd.resetSetting('theme')).toBe(true);
        expect(settings.setSetting).toHaveBeenCalledWith('theme', 'light');
        expect(msgs('success')).toEqual(['Reset theme to default: "light"']);
    });

    test('a key with no default is reported', () => {
        settings.getDefaultSettings.mockReturnValue(invalid({}));
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
        settings.loadSettings.mockReturnValue(invalid({ challengeSettings: { globalDefaults: { exposure: 70 } } }));
        cmd.listGlobalDefaults();
        expect(msgs('info')).toEqual([]);
        const info = msgs('stdout');
        expect(info).toContain('exposure: 70');
        expect(info).toContain('emergencyFill: 300 (5m)');
    });

    test('a photo list is counted in the dumps, never listed', () => {
        settings.SETTINGS_SCHEMA = invalid({ chosenPhotos: { type: 'photos', perChallenge: true, default: [] } });
        settings.loadSettings.mockReturnValue(
            invalid({ challengeSettings: { globalDefaults: { chosenPhotos: ['secret1', 'secret2'] } } }),
        );
        cmd.listGlobalDefaults();
        cmd.dumpSchema();
        expect(msgs('stdout')).toContain('chosenPhotos: 2 photo(s)');
        expect(msgs('info')).toContain('  Default: 0 photo(s)');
        expect([...msgs('stdout'), ...msgs('info')].join('\n')).not.toContain('secret');
    });

    test('listGlobalDefaults falls back to schema defaults with no stored map', () => {
        settings.loadSettings.mockReturnValue(invalid({}));
        cmd.listGlobalDefaults();
        expect(msgs('stdout')).toContain('exposure: 50');
    });
});

describe('profiles', () => {
    test('no profiles prints the save hint', () => {
        settings.getChallengeProfiles.mockReturnValue({});
        cmd.listProfiles();
        expect(msgs('stdout')).toEqual([
            'No saved challenge profiles',
            '💡 Save one with: save-profile "<name>" --challenge=<id>',
        ]);
    });

    test('profiles are listed by name with a summary of their values', () => {
        settings.getChallengeProfiles.mockReturnValue({ zeta: {}, alpha: { exposure: 80, emergencyFill: 0 } });
        cmd.listProfiles();
        expect(msgs('stdout')).toEqual([
            '=== Challenge Profiles ===',
            'alpha (2): emergencyFill=0 (off), exposure=80',
            'zeta (0): (no overrides — applying it resets the challenge to global defaults)',
        ]);
        // Console only: nothing of the profiles reaches the log files.
        expect(msgs('info')).toEqual([]);
    });

    test('a profile listing masks the account and counts photo lists, and strips control characters from names', () => {
        settings.SETTINGS_SCHEMA = invalid({ chosenPhotos: { type: 'photos', perChallenge: true, default: [] } });
        settings.getChallengeProfiles.mockReturnValue({
            'ev\u001b[31mil\u2028name': { chosenPhotos: ['secret1', 'secret2'], lastUsername: 'me@example.com' },
        });
        cmd.listProfiles();
        const printed = msgs('stdout').join('\n');
        expect(printed).toContain('evil');
        expect(printed).not.toMatch(/secret|example\.com|(?!\n)[\p{Cc}\p{Cf}\u2028\u2029]/u);
        expect(printed).toContain('chosenPhotos=2 photo(s)');
        expect(printed).toContain('lastUsername=[REDACTED]');
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

    test.each<
        [
            string,
            'getChallengeProfiles' | 'getChallengeOverrides' | 'applyChallengeProfile' | 'deleteChallengeProfile',
            string[],
            string,
        ]
    >([
        ['listProfiles', 'getChallengeProfiles', [], 'Error listing profiles'],
        ['saveProfileFromChallenge', 'getChallengeOverrides', ['p', '7'], 'Error saving profile'],
        ['applyProfile', 'applyChallengeProfile', ['p', '7'], 'Error applying profile'],
        ['deleteProfile', 'deleteChallengeProfile', ['p'], 'Error deleting profile'],
    ])('%s: a throwing facade is reported, not thrown', (fn, facadeFn, args, message) => {
        settings[facadeFn].mockImplementation(boom);
        expect(() => invalid<Record<string, (...args: string[]) => unknown>>(cmd)[fn](...args)).not.toThrow();
        expect(msgs('error')).toEqual([message]);
    });
});

describe('help and window reset', () => {
    test('helpSettings prints the command and profile reference', () => {
        cmd.helpSettings();
        // Printed whole, with its line breaks, on the console only.
        expect(msgs('info')).toEqual([]);
        const [text] = msgs('stdout');
        expect(text).toContain('\n=== Settings Management Help ===\n\nAvailable Commands:\n  get-setting <key>');
        expect(text.split('\n').length).toBeGreaterThan(20);
        expect(text).toContain('save-profile "2-pic tactic" --challenge=12345');
    });

    test('resetWindows restores the default window bounds and saves', () => {
        settings.loadSettings.mockReturnValue(invalid({ theme: 'dark', windowBounds: { x: 5 } }));
        settings.getDefaultSettings.mockReturnValue(invalid({ windowBounds: { x: 0, y: 0 } }));
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
