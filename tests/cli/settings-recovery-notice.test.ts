/**
 * The CLI's notice that the saved settings are not in use: plain English, naming the file, saying
 * what happens next, on stderr, and nothing when the settings are in use.
 */

jest.mock('../../src/ts/settings', () => ({ getSettingsRecovery: jest.fn() }));
jest.mock('../../src/ts/logger', () => ({ printStderr: jest.fn() }));

import loggerModule = require('../../src/ts/logger');
import settingsModule = require('../../src/ts/settings');
import type * as noticeModule from '../../src/ts/cli/commands/settingsRecovery';

const logger = jest.mocked(loggerModule);
const settings = jest.mocked(settingsModule);
const { describeSettingsRecovery, reportSettingsRecovery } =
    require('../../src/ts/cli/commands/settingsRecovery') as typeof noticeModule;

beforeEach(() => jest.clearAllMocks());

describe('describeSettingsRecovery', () => {
    test('a damaged file says where it went and that defaults apply', () => {
        const text = describeSettingsRecovery({ code: 'settings-corrupt', path: '/u/settings.json.corrupt-2026' });
        expect(text).toContain('/u/settings.json.corrupt-2026');
        expect(text).toContain('default settings are in use');
    });

    test('an unreadable file says that nothing will be saved until it is fixed, and what to check', () => {
        const text = describeSettingsRecovery({ code: 'settings-unreadable', path: '/u/settings.json' });
        expect(text).toContain('/u/settings.json');
        expect(text).toContain('nothing will be saved');
        expect(text).toContain('can be read and written');
    });

    test('a file that cannot be migrated says it was left as it is', () => {
        const text = describeSettingsRecovery({ code: 'settings-migration-failed', path: '/u/settings.json' });
        expect(text).toContain('left as it is');
        expect(text).toContain('nothing will be saved');
    });
});

describe('reportSettingsRecovery', () => {
    test('prints the notice on stderr', () => {
        settings.getSettingsRecovery.mockReturnValue({ code: 'settings-corrupt', path: '/u/settings.json.corrupt-1' });

        reportSettingsRecovery();

        expect(logger.printStderr).toHaveBeenCalledTimes(1);
        expect(logger.printStderr).toHaveBeenCalledWith(expect.stringContaining('/u/settings.json.corrupt-1'));
    });

    test('says nothing when the settings are in use', () => {
        settings.getSettingsRecovery.mockReturnValue(null);

        reportSettingsRecovery();

        expect(logger.printStderr).not.toHaveBeenCalled();
    });
});
