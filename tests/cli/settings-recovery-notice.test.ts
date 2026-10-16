/**
 * The CLI's notice that the saved settings are not in use: plain English, naming the file, saying
 * what happens next, on stderr, and nothing when the settings are in use; and the `settings-recovery` command that acts
 * on it.
 */

jest.mock('../../src/ts/settings', () => ({
    getSettingsRecovery: jest.fn(),
    retryImport: jest.fn(),
    startFresh: jest.fn(),
    reimportFromV1: jest.fn(),
    getImportReport: jest.fn(),
    acknowledgeImportReport: jest.fn(),
}));
const mockCategory = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../src/ts/logger', () => ({
    printStderr: jest.fn(),
    printLine: jest.fn(),
    withCategory: jest.fn(() => mockCategory),
}));

import loggerModule = require('../../src/ts/logger');
import settingsModule = require('../../src/ts/settings');
import type * as noticeModule from '../../src/ts/cli/commands/settingsRecovery';
import type * as commandTableModule from '../../src/ts/cli/commandTable';

const logger = jest.mocked(loggerModule);
const settings = jest.mocked(settingsModule);
const { describeSettingsRecovery, reportSettingsRecovery, settingsRecoveryCmd } =
    require('../../src/ts/cli/commands/settingsRecovery') as typeof noticeModule;

beforeEach(() => jest.clearAllMocks());

describe('describeSettingsRecovery', () => {
    test('a damaged file that was restored says where the copy went and that the settings came from settings.json', () => {
        const text = describeSettingsRecovery({ code: 'settings-restored', path: '/u/config.json.corrupt-2026' });
        expect(text).toContain('config.json was damaged');
        expect(text).toContain('restored from settings.json');
        expect(text).toContain('/u/config.json.corrupt-2026');
        expect(text).not.toContain('default settings');
    });

    test('a damaged file with nothing to restore it from says where it went, that defaults apply, and how to import settings.json instead', () => {
        const text = describeSettingsRecovery({ code: 'settings-corrupt', path: '/u/config.json.corrupt-2026' });
        expect(text).toContain('config.json was damaged');
        expect(text).toContain('/u/config.json.corrupt-2026');
        expect(text).toContain('no usable settings.json');
        expect(text).toContain('default settings are in use');
        expect(text).toContain('settings-recovery reimport');
    });

    test('an unreadable file says that nothing will be saved until it is fixed, and what to check', () => {
        const text = describeSettingsRecovery({ code: 'settings-unreadable', path: '/u/settings.json' });
        expect(text).toContain('/u/settings.json');
        expect(text).toContain('nothing will be saved');
        expect(text).toContain('can be read and written');
    });

    test('a settings.json that could not be imported says the file was left as it is, and the two ways forward', () => {
        const text = describeSettingsRecovery({ code: 'settings-import-failed', path: '/u/settings.json' });
        expect(text).toContain('/u/settings.json');
        expect(text).toContain('left as it is');
        expect(text).toContain('nothing will be saved');
        expect(text).toContain('settings-recovery retry');
        expect(text).toContain('settings-recovery start-fresh');
        expect(text).toContain('settings.json.original');
    });
});

describe('reportSettingsRecovery', () => {
    test('prints the notice on stderr', () => {
        settings.getSettingsRecovery.mockReturnValue({
            code: 'settings-corrupt',
            path: '/u/config.json.corrupt-1',
            blocking: false,
        });

        reportSettingsRecovery();

        expect(logger.printStderr).toHaveBeenCalledTimes(1);
        expect(logger.printStderr).toHaveBeenCalledWith(expect.stringContaining('/u/config.json.corrupt-1'));
    });

    test('says nothing when the settings are in use', () => {
        settings.getSettingsRecovery.mockReturnValue(null);

        reportSettingsRecovery();

        expect(logger.printStderr).not.toHaveBeenCalled();
    });
});

describe('settingsRecoveryCmd', () => {
    test.each([
        ['retry', () => settings.retryImport, 'The settings were imported from settings.json.'],
        ['start-fresh', () => settings.startFresh, 'Started with default settings'],
        ['reimport', () => settings.reimportFromV1, 'imported again'],
    ] as const)('%s runs its action and says it worked', async (action, which, said) => {
        jest.mocked(which()).mockReturnValue(true);

        await expect(settingsRecoveryCmd([action])).resolves.toBe(0);

        expect(which()).toHaveBeenCalledTimes(1);
        expect(mockCategory.success).toHaveBeenCalledWith(expect.stringContaining(said));
    });

    test('an action that did not work exits 1 and points to the log', async () => {
        jest.mocked(settings.retryImport).mockReturnValue(false);

        await expect(settingsRecoveryCmd(['retry'])).resolves.toBe(1);

        expect(mockCategory.error).toHaveBeenCalledWith(expect.stringContaining('logs --settings'));
        expect(mockCategory.success).not.toHaveBeenCalled();
    });

    test('is registered in the command table', async () => {
        jest.mocked(settings.startFresh).mockReturnValue(true);
        const { COMMANDS } = require('../../src/ts/cli/commandTable') as typeof commandTableModule;

        await expect(COMMANDS['settings-recovery'](['start-fresh'])).resolves.toBe(0);
    });

    test.each([[[]], [['nope']], [['retry', 'extra']], [['constructor']], [['keep']], [['report', 'extra']]])(
        '%j is a usage error',
        async (argv) => {
            await expect(settingsRecoveryCmd(argv)).resolves.toBe(1);

            expect(settings.retryImport).not.toHaveBeenCalled();
            expect(settings.startFresh).not.toHaveBeenCalled();
            expect(settings.reimportFromV1).not.toHaveBeenCalled();
        },
    );

    test('acknowledge marks the import report as seen', async () => {
        jest.mocked(settings.acknowledgeImportReport).mockReturnValue(true);

        await expect(settingsRecoveryCmd(['acknowledge'])).resolves.toBe(0);

        expect(mockCategory.success).toHaveBeenCalledWith(expect.stringContaining('marked as seen'));
    });

    describe('report', () => {
        test('lists the references that were kept and still do not apply', async () => {
            settings.getImportReport.mockReturnValue({
                at: '2026-10-16T09:00:00.000Z',
                refsBlocked: ['rules[2].profile: "Night owl"', 'challenges.123.values.scenario: "Plan B"'],
                acknowledged: false,
            });

            await expect(settingsRecoveryCmd(['report'])).resolves.toBe(0);

            const [text] = jest.mocked(loggerModule.printLine).mock.calls[0];
            expect(text).toContain('2026-10-16T09:00:00.000Z');
            expect(text).toContain('  rules[2].profile: "Night owl"');
            expect(text).toContain('  challenges.123.values.scenario: "Plan B"');
        });

        test('says nothing needed attention when the list is empty', async () => {
            settings.getImportReport.mockReturnValue({
                at: '2026-10-16T09:00:00.000Z',
                refsBlocked: [],
                acknowledged: true,
            });

            await expect(settingsRecoveryCmd(['report'])).resolves.toBe(0);

            expect(jest.mocked(loggerModule.printLine)).toHaveBeenCalledWith(
                expect.stringContaining('nothing needed attention'),
            );
        });

        test('says so when the settings were not imported', async () => {
            settings.getImportReport.mockReturnValue(null);

            await expect(settingsRecoveryCmd(['report'])).resolves.toBe(0);

            expect(mockCategory.info).toHaveBeenCalledWith(expect.stringContaining('not imported'));
            expect(loggerModule.printLine).not.toHaveBeenCalled();
        });
    });
});
