/**
 * `list-settings` and `list-global-defaults` print the account's settings to the
 * console only — never into the log files — through the redacting printer, so a
 * credential that formatSettingForLog does not recognise is still masked.
 */

const consoleLines: string[] = [];
const persisted: { level: string; msg: string }[] = [];

jest.mock('../../src/ts/logger', () => {
    const { redactMessage } =
        jest.requireActual<typeof import('../../src/ts/logger/sanitize')>('../../src/ts/logger/sanitize');
    const { sanitizeForLog } =
        jest.requireActual<typeof import('../../src/ts/logger/sanitize')>('../../src/ts/logger/sanitize');
    const rec = (level: string) => (msg: unknown) => persisted.push({ level, msg: String(msg) });
    const cat = { info: rec('info'), error: rec('error'), success: rec('success'), warning: rec('warning') };
    return {
        withCategory: jest.fn(() => cat),
        sanitizeForLog,
        // As the real printLine: redacted, console only (never persisted).
        printLine: (text: string) => consoleLines.push(redactMessage(text)),
    };
});
jest.mock('../../src/ts/settings', () => ({
    __esModule: true,
    SETTINGS_SCHEMA: { chosenPhotos: { type: 'photos', perChallenge: true, default: [] } },
    loadSettings: jest.fn(),
    getDefaultSettings: jest.fn(),
}));

import { invalid } from '../helpers/invalid';
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import type * as listingModule from '../../src/ts/cli/commands/settings/listing';
const { listSettings, listGlobalDefaults } =
    require('../../src/ts/cli/commands/settings/listing') as typeof listingModule;

beforeEach(() => {
    consoleLines.length = 0;
    persisted.length = 0;
    settings.getDefaultSettings.mockReturnValue(invalid({ app: {}, auth: { token: '', lastUsername: '' } }));
    settings.loadSettings.mockReturnValue(
        invalid({
            app: { note: 'password: hunter2' },
            auth: { token: 'tok-secret', lastUsername: 'me@example.com' },
            defaults: { chosenPhotos: ['photo-secret'] },
            challenges: { '7': { values: { chosenPhotos: ['photo-secret-2'] } } },
        }),
    );
});

test('list-settings prints to the console only, with the account masked', () => {
    listSettings();
    expect(persisted.filter((line) => line.level !== 'error')).toEqual([]);
    const printed = consoleLines.join('\n');
    for (const secret of ['tok-secret', 'me@example.com', 'photo-secret', 'hunter2']) {
        expect(printed).not.toContain(secret);
    }
    // The keys keep their case (a log entry would have capitalised them).
    expect(consoleLines).toContain('lastUsername:');
    expect(consoleLines).toContain('  Current: [REDACTED]');
});

test('what formatSettingForLog does not recognise is still masked by the printer', () => {
    // "note" is no sensitive key, so its value passes the formatter, and the printer masks it.
    listSettings();
    const note = consoleLines.findIndex((line) => line === 'note:');
    expect(consoleLines[note + 1]).toBe('  Current: "password: [REDACTED]');
});

test('list-global-defaults prints to the console only, photo lists as counts', () => {
    listGlobalDefaults();
    expect(persisted).toEqual([]);
    expect(consoleLines.join('\n')).not.toContain('photo-secret');
    expect(consoleLines.at(-1)).toMatch(/^chosenPhotos: /);
});

test('an empty private setting reads "(not set)" rather than "[REDACTED]"', () => {
    settings.loadSettings.mockReturnValue(invalid({ auth: { lastUsername: '' } }));
    listSettings();
    const lines = (key: string) =>
        consoleLines.slice(consoleLines.indexOf(`${key}:`) + 1, consoleLines.indexOf(`${key}:`) + 4);
    expect(lines('lastUsername')).toEqual(['  Current: (not set)', '  Default: (not set)', '  Status:  Default ✅']);
});

test('control and format characters in a stored key or value never reach the terminal', () => {
    settings.loadSettings.mockReturnValue(invalid({ app: { 'ev\u001b[31mil\u2028key': 'a\u202Eb\u0085c' } }));
    listSettings();
    const printed = consoleLines.join('\n');
    expect(printed).toContain('evil');
    expect(printed).not.toMatch(/(?!\n)[\p{Cc}\p{Cf}\u2028\u2029]/u);
});
