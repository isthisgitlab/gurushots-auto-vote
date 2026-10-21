/**
 * The CLI's notice that the saved settings are not in use: plain English, naming the file, saying
 * what happens next, on stderr, and nothing when the settings are in use; and the `settings-recovery` command that acts
 * on it.
 */

jest.mock('../../src/ts/settings', () => ({
    loadSettings: jest.fn(),
    getSettingsRecovery: jest.fn(),
    retryImportDetailed: jest.fn(),
    startFresh: jest.fn(),
    startFreshDetailed: jest.fn(),
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
    test('a damaged file says where it went, that defaults apply, and what the copy still holds', () => {
        const text = describeSettingsRecovery({
            code: 'settings-corrupt',
            path: '/u/config.json.corrupt-2026',
            blocking: false,
        });
        expect(text).toContain('config.json was damaged');
        expect(text).toContain('/u/config.json.corrupt-2026');
        expect(text).toContain('the default settings are in use');
        expect(text).toContain('still holds the old settings, including the sign-in');
        expect(text).toContain('delete it once you no longer need it');
    });

    test('an unreadable file says that nothing will be saved until it is fixed, and what to check', () => {
        const text = describeSettingsRecovery({ code: 'settings-unreadable', path: '/u/config.json', blocking: true });
        expect(text).toContain('/u/config.json');
        expect(text).toContain('nothing will be saved');
        expect(text).toContain('can be read and written');
        expect(text).toContain('every read tries again');
    });

    test('an import that may pass by itself says nothing was overwritten, and the two ways forward', () => {
        const text = describeSettingsRecovery({
            code: 'settings-import-failed',
            path: '/u/settings.json',
            blocking: true,
        });
        expect(text).toContain('The settings.json at /u/settings.json could not be imported just now');
        expect(text).toContain('Nothing was overwritten');
        expect(text).toContain('The next start tries the import again');
        expect(text).toContain('settings-recovery retry');
        expect(text).toContain('settings-recovery start-fresh');
    });

    test('an import that may pass names the reason when there is one, and none when there is not', () => {
        const said = describeSettingsRecovery({
            code: 'settings-import-failed',
            path: '/u/settings.json',
            blocking: true,
            detail: 'busy',
        });
        expect(said).toContain('could not be imported just now (busy), so nothing will be saved');

        const unsaid = describeSettingsRecovery({
            code: 'settings-import-failed',
            path: '/u/settings.json',
            blocking: true,
            detail: undefined,
        });
        expect(unsaid).toContain('could not be imported just now, so nothing will be saved');
        expect(unsaid).toContain('settings-recovery retry');
    });

    test('an import that cannot pass says the defaults were stored, the file was left as it is, and how to import it once fixed', () => {
        const corrupt = describeSettingsRecovery({
            code: 'settings-import-failed',
            path: '/u/settings.json',
            blocking: false,
            detail: 'corrupt',
        });
        expect(corrupt).toContain('it is not a readable settings file');
        expect(corrupt).toContain('the default settings were saved in its place');
        expect(corrupt).toContain('the file was left as it is');
        expect(corrupt).toContain('delete config.json and v2-import.json');
        expect(corrupt).toContain('(keep settings.json)');
        expect(corrupt).not.toContain('start-fresh');
        expect(corrupt).not.toContain('delete all local data');

        const migration = describeSettingsRecovery({
            code: 'settings-import-failed',
            path: '/u/settings.json',
            blocking: false,
            detail: 'migration-failed',
        });
        expect(migration).toContain('cannot be converted to the current settings format');
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
    test('retry runs its action and says it worked', async () => {
        jest.mocked(settings.retryImportDetailed).mockReturnValue({ ok: true });

        await expect(settingsRecoveryCmd(['retry'])).resolves.toBe(0);

        expect(settings.retryImportDetailed).toHaveBeenCalledTimes(1);
        expect(mockCategory.success).toHaveBeenCalledWith('The settings were imported from settings.json.');
    });

    test('retry that finds the settings in place already says nothing was imported', async () => {
        jest.mocked(settings.retryImportDetailed).mockReturnValue({ ok: true, adopted: true });

        await expect(settingsRecoveryCmd(['retry'])).resolves.toBe(0);

        expect(mockCategory.success).toHaveBeenCalledWith('Nothing was imported: the settings are already in place.');
    });

    describe('start-fresh', () => {
        test('says the file was left as it is', async () => {
            settings.startFreshDetailed.mockReturnValue({ ok: true });

            await expect(settingsRecoveryCmd(['start-fresh'])).resolves.toBe(0);

            expect(mockCategory.success).toHaveBeenCalledWith(
                'Started with default settings; settings.json was left as it is and is not imported again unasked.',
            );
        });

        test('says nothing was reset when the settings were in place already', async () => {
            settings.startFreshDetailed.mockReturnValue({ ok: true, adopted: true });

            await expect(settingsRecoveryCmd(['start-fresh'])).resolves.toBe(0);

            expect(mockCategory.success).toHaveBeenCalledWith(
                'Nothing was reset: the settings were already in place (saved meanwhile), and they are in use.',
            );
        });

        describe('while the import may pass by itself', () => {
            beforeEach(() => {
                settings.getSettingsRecovery.mockReturnValue({
                    code: 'settings-import-failed',
                    path: '/u/settings.json',
                    blocking: true,
                });
            });
            afterEach(() => settings.getSettingsRecovery.mockReset());

            test('is refused, pointing to retry and to --force', async () => {
                await expect(settingsRecoveryCmd(['start-fresh'])).resolves.toBe(1);

                expect(settings.startFreshDetailed).not.toHaveBeenCalled();
                expect(mockCategory.error).toHaveBeenCalledWith(
                    expect.stringContaining('settings-recovery start-fresh --force'),
                );
            });

            test('goes ahead when it is asked for with --force', async () => {
                settings.startFreshDetailed.mockReturnValue({ ok: true });

                await expect(settingsRecoveryCmd(['start-fresh', '--force'])).resolves.toBe(0);

                expect(settings.startFreshDetailed).toHaveBeenCalledTimes(1);
            });

            test('anything else after it is a usage error', async () => {
                await expect(settingsRecoveryCmd(['start-fresh', '--now'])).resolves.toBe(1);

                expect(settings.startFreshDetailed).not.toHaveBeenCalled();
            });
        });

        test('that did not work exits 1 and points to the log', async () => {
            settings.startFreshDetailed.mockReturnValue({ ok: false });

            await expect(settingsRecoveryCmd(['start-fresh'])).resolves.toBe(1);

            expect(mockCategory.error).toHaveBeenCalledWith(expect.stringContaining('logs --settings'));
        });
    });

    test('an action that did not work exits 1 and points to the log', async () => {
        jest.mocked(settings.retryImportDetailed).mockReturnValue({ ok: false });

        await expect(settingsRecoveryCmd(['retry'])).resolves.toBe(1);

        expect(mockCategory.error).toHaveBeenCalledWith(expect.stringContaining('logs --settings'));
        expect(mockCategory.success).not.toHaveBeenCalled();
    });

    test('is registered in the command table', async () => {
        jest.mocked(settings.startFreshDetailed).mockReturnValue({ ok: true });
        const { COMMANDS } = require('../../src/ts/cli/commandTable') as typeof commandTableModule;

        await expect(COMMANDS['settings-recovery'](['start-fresh'])).resolves.toBe(0);
    });

    test.each([[[]], [['nope']], [['retry', 'extra']], [['constructor']], [['keep']], [['report', 'extra']]])(
        '%j is a usage error',
        async (argv) => {
            await expect(settingsRecoveryCmd(argv)).resolves.toBe(1);

            expect(settings.retryImportDetailed).not.toHaveBeenCalled();
            expect(settings.startFreshDetailed).not.toHaveBeenCalled();
        },
    );

    test('acknowledge with no import report has nothing to acknowledge, which is no failure', async () => {
        settings.getImportReport.mockReturnValue(null);

        await expect(settingsRecoveryCmd(['acknowledge'])).resolves.toBe(0);

        expect(settings.acknowledgeImportReport).not.toHaveBeenCalled();
        expect(mockCategory.info).toHaveBeenCalledWith(expect.stringContaining('nothing to acknowledge'));
        expect(mockCategory.error).not.toHaveBeenCalled();
    });

    test('acknowledge marks the import report as seen', async () => {
        settings.getImportReport.mockReturnValue({
            at: '2026-10-16T09:00:00.000Z',
            refsBlocked: [],
            acknowledged: false,
        });
        jest.mocked(settings.acknowledgeImportReport).mockReturnValue(true);

        await expect(settingsRecoveryCmd(['acknowledge'])).resolves.toBe(0);

        expect(mockCategory.success).toHaveBeenCalledWith(expect.stringContaining('marked as seen'));
    });

    describe('report', () => {
        test('lists the references that were kept and still do not apply, in the words the window uses', async () => {
            settings.getImportReport.mockReturnValue({
                at: '2026-10-16T09:00:00.000Z',
                refsBlocked: [
                    { holder: { kind: 'rule', number: 3, title: 'Macro' }, refers: 'profile', name: 'Night owl' },
                    { holder: { kind: 'challenge', id: '123', title: 'Sunset' }, refers: 'scenario', name: 'Plan B' },
                    { holder: { kind: 'challenge', id: '7' }, refers: 'scenario', name: 'Plan C', invalid: true },
                    { holder: { kind: 'profile', name: 'Night' }, refers: 'profile', name: 'Day', invalid: true },
                    'rules[2].profile: "Stored by an earlier build"',
                ],
                acknowledged: false,
            });

            await expect(settingsRecoveryCmd(['report'])).resolves.toBe(0);

            const [text] = jest.mocked(loggerModule.printLine).mock.calls[0];
            expect(text).toContain('2026-10-16T09:00:00.000Z');
            expect(text).toContain('  Rule 3 (Macro): the profile "Night owl" doesn\'t exist');
            expect(text).toContain('  Challenge "Sunset" (123): the scenario "Plan B" doesn\'t exist');
            expect(text).toContain('  Challenge 7: the scenario "Plan C" can\'t be used');
            expect(text).toContain('  Profile "Night": the profile "Day" can\'t be used');
            expect(text).toContain('  rules[2].profile: "Stored by an earlier build"');
        });

        test('what the user named never reaches the terminal as a control sequence', async () => {
            settings.getImportReport.mockReturnValue({
                at: '2026-10-16T09:00:00.000Z',
                refsBlocked: [
                    {
                        holder: { kind: 'rule', number: 1, title: 'a\u001b[31mb' },
                        refers: 'profile',
                        name: 'x\ny\u202E',
                    },
                    'old\u001b[2Jtext',
                ],
                acknowledged: false,
            });

            await expect(settingsRecoveryCmd(['report'])).resolves.toBe(0);

            const [text] = jest.mocked(loggerModule.printLine).mock.calls[0];
            expect(text).toContain('  Rule 1 (ab): the profile "x y" doesn\'t exist');
            expect(text).toContain('  oldtext');
            expect(text).not.toContain('\u001b');
            expect(text).not.toContain('\u202E');
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
