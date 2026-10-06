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
    settings.getDefaultSettings.mockReturnValue(invalid({ token: '', lastUsername: '', chosenPhotosMemberId: '' }));
    settings.loadSettings.mockReturnValue(
        invalid({
            token: 'tok-secret',
            lastUsername: 'me@example.com',
            chosenPhotosMemberId: 'member-secret',
            note: 'password: hunter2',
            challengeSettings: {
                globalDefaults: { chosenPhotos: ['photo-secret'] },
                perChallenge: { '7': { chosenPhotos: ['photo-secret-2'] } },
            },
        }),
    );
});

test('list-settings prints to the console only, with the account masked', () => {
    listSettings();
    expect(persisted.filter((line) => line.level !== 'error')).toEqual([]);
    const printed = consoleLines.join('\n');
    for (const secret of ['tok-secret', 'me@example.com', 'member-secret', 'photo-secret', 'hunter2']) {
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
