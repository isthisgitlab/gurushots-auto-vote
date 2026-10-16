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
    reimportFromV1: jest.fn(),
    reimportFromV1Detailed: jest.fn(),
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
    test('a damaged file that was restored says where the copy went and that the settings came from settings.json', () => {
        const text = describeSettingsRecovery({ code: 'settings-restored', path: '/u/config.json.corrupt-2026' });
        expect(text).toContain('config.json was damaged');
        expect(text).toContain('restored from settings.json');
        expect(text).toContain('/u/config.json.corrupt-2026');
        expect(text).not.toContain('default settings');
    });

    test('a damaged file whose unusable settings.json was set aside says where that went', () => {
        const text = describeSettingsRecovery({
            code: 'settings-corrupt',
            path: '/u/config.json.corrupt-2026',
            settingsSetAside: '/u/settings.json.unimportable-2026',
        });
        expect(text).toContain('The unusable settings.json was kept at /u/settings.json.unimportable-2026');
        // After the set-aside the guidance names that file, and no placeholder.
        expect(text).toContain(
            'fix the file at /u/settings.json.unimportable-2026 and run "settings-recovery reimport"',
        );
        expect(text).not.toContain('<time>');
    });

    test('a damaged file with nothing to restore it from says where it went, that defaults apply, and how to import settings.json instead', () => {
        const text = describeSettingsRecovery({ code: 'settings-corrupt', path: '/u/config.json.corrupt-2026' });
        expect(text).toContain('config.json was damaged');
        expect(text).toContain('/u/config.json.corrupt-2026');
        expect(text).toContain('no usable settings.json');
        expect(text).toContain('default settings are in use');
        expect(text).toContain('fix settings.json and run "settings-recovery reimport"');
        expect(text).not.toContain('<time>');
    });

    test('an unreadable file says that nothing will be saved until it is fixed, and what to check', () => {
        const text = describeSettingsRecovery({ code: 'settings-unreadable', path: '/u/settings.json' });
        expect(text).toContain('/u/settings.json');
        expect(text).toContain('nothing will be saved');
        expect(text).toContain('can be read and written');
    });

    test('a settings.json that cannot be read just now says it is tried again, with the damaged copy named when there is one, and the sign-in it holds', () => {
        const withCopy = describeSettingsRecovery({
            code: 'settings-import-retrying',
            path: '/u/settings.json',
            damagedAt: '/u/config.json.corrupt-2026',
        });
        expect(withCopy).toContain('config.json was damaged and moved to /u/config.json.corrupt-2026');
        expect(withCopy).toContain('the settings.json at /u/settings.json');
        expect(withCopy).toContain('could not be read just now');
        expect(withCopy).toContain('Nothing was overwritten');
        expect(withCopy).toContain('settings-recovery retry');
        expect(withCopy).toContain('may still hold the sign-in');
        expect(withCopy).toContain('delete it once you no longer need it');
        // Giving the import up is not offered while it may pass.
        expect(withCopy).not.toContain('start-fresh');

        const without = describeSettingsRecovery({ code: 'settings-import-retrying', path: '/u/settings.json' });
        expect(without).toContain('The settings.json at /u/settings.json could not be read just now');
        expect(without).not.toContain('config.json was damaged');
        expect(without).not.toContain('sign-in');
    });

    test('a settings.json that could not be imported says the file was left as it is, and the two ways forward', () => {
        const text = describeSettingsRecovery({ code: 'settings-import-failed', path: '/u/settings.json' });
        expect(text).toContain('/u/settings.json');
        expect(text).toContain('left as it is');
        expect(text).toContain('nothing will be saved');
        expect(text).toContain('settings-recovery retry');
        expect(text).toContain('settings-recovery start-fresh');
        expect(text).toContain('settings.json.original');
        expect(text).toContain('settings.json.unimportable-<timestamp>');
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

    test('retry that finds the settings in place already says nothing was imported, and how to load settings.json over them', async () => {
        jest.mocked(settings.retryImportDetailed).mockReturnValue({ ok: true, adopted: true });

        await expect(settingsRecoveryCmd(['retry'])).resolves.toBe(0);

        expect(mockCategory.success).toHaveBeenCalledWith(
            'Nothing was imported: the settings are already in place. To load settings.json over them, run "settings-recovery reimport".',
        );
    });

    describe('start-fresh', () => {
        test('says where settings.json was kept', async () => {
            settings.startFreshDetailed.mockReturnValue({ ok: true, keptAt: '/u/settings.json.original' });

            await expect(settingsRecoveryCmd(['start-fresh'])).resolves.toBe(0);

            expect(mockCategory.success).toHaveBeenCalledWith(
                'Started with default settings; a copy of settings.json was kept at /u/settings.json.original.',
            );
        });

        test('says nothing was reset when the settings were in place already (a restore that came through)', async () => {
            settings.startFreshDetailed.mockReturnValue({ ok: true, keptAt: null, adopted: true });

            await expect(settingsRecoveryCmd(['start-fresh'])).resolves.toBe(0);

            expect(mockCategory.success).toHaveBeenCalledWith(
                'Nothing was reset: the settings were already in place (restored or imported meanwhile), and they are in use.',
            );
        });

        test('says the file was left as it is when settings.json could not be read', async () => {
            settings.startFreshDetailed.mockReturnValue({ ok: true, keptAt: null, unreadable: true });

            await expect(settingsRecoveryCmd(['start-fresh'])).resolves.toBe(0);

            expect(mockCategory.success).toHaveBeenCalledWith(
                'Started with default settings; settings.json could not be read, so it was left as it is and no copy was kept.',
            );
            expect(mockCategory.success).not.toHaveBeenCalledWith(
                expect.stringContaining('there was no settings.json'),
            );
        });

        describe('while settings.json could not be read just now and is tried again by itself', () => {
            beforeEach(() => {
                settings.getSettingsRecovery.mockReturnValue({
                    code: 'settings-import-retrying',
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
                settings.startFreshDetailed.mockReturnValue({ ok: true, keptAt: null });

                await expect(settingsRecoveryCmd(['start-fresh', '--force'])).resolves.toBe(0);

                expect(settings.startFreshDetailed).toHaveBeenCalledTimes(1);
            });

            test('anything else after it is a usage error', async () => {
                await expect(settingsRecoveryCmd(['start-fresh', '--now'])).resolves.toBe(1);

                expect(settings.startFreshDetailed).not.toHaveBeenCalled();
            });
        });

        test('says nothing was kept when there was no settings.json', async () => {
            settings.startFreshDetailed.mockReturnValue({ ok: true, keptAt: null });

            await expect(settingsRecoveryCmd(['start-fresh'])).resolves.toBe(0);

            expect(mockCategory.success).toHaveBeenCalledWith(
                'Started with default settings; there was no settings.json, so no copy was kept.',
            );
        });

        test('that did not work exits 1 and points to the log', async () => {
            settings.startFreshDetailed.mockReturnValue({ ok: false, keptAt: null });

            await expect(settingsRecoveryCmd(['start-fresh'])).resolves.toBe(1);

            expect(mockCategory.error).toHaveBeenCalledWith(expect.stringContaining('logs --settings'));
        });
    });

    describe('reimport', () => {
        test('says where the settings and sign-in that were in use were set aside', async () => {
            settings.reimportFromV1Detailed.mockReturnValue({
                ok: true,
                setAside: '/u/config.json.corrupt-2026',
                source: '/u/settings.json.unimportable-2026',
            });

            await expect(settingsRecoveryCmd(['reimport'])).resolves.toBe(0);

            expect(mockCategory.success).toHaveBeenCalledWith(
                '/u/settings.json.unimportable-2026 was imported again; the settings and sign-in that were in use were set aside at /u/config.json.corrupt-2026.',
            );
        });

        test('says nothing of a move when nothing was set aside', async () => {
            settings.reimportFromV1Detailed.mockReturnValue({ ok: true, setAside: null, source: '/u/settings.json' });

            await expect(settingsRecoveryCmd(['reimport'])).resolves.toBe(0);

            expect(mockCategory.success).toHaveBeenCalledWith('/u/settings.json was imported again.');
        });

        test('that did not work exits 1 and points to the log', async () => {
            settings.reimportFromV1Detailed.mockReturnValue({ ok: false, setAside: null, source: '/u/settings.json' });

            await expect(settingsRecoveryCmd(['reimport'])).resolves.toBe(1);

            expect(mockCategory.error).toHaveBeenCalledWith(expect.stringContaining('logs --settings'));
        });

        test('that did not work names the file it tried (the copy to fix, not settings.json)', async () => {
            settings.reimportFromV1Detailed.mockReturnValue({
                ok: false,
                setAside: null,
                source: '/u/settings.json.unimportable-2026',
            });

            await expect(settingsRecoveryCmd(['reimport'])).resolves.toBe(1);

            expect(mockCategory.error).toHaveBeenCalledWith(
                expect.stringContaining('/u/settings.json.unimportable-2026 is missing'),
            );
        });

        test('with anything after it is a usage error', async () => {
            await expect(settingsRecoveryCmd(['reimport', 'now'])).resolves.toBe(1);

            expect(settings.reimportFromV1Detailed).not.toHaveBeenCalled();
        });
    });

    test('an action that did not work exits 1 and points to the log', async () => {
        jest.mocked(settings.retryImportDetailed).mockReturnValue({ ok: false });

        await expect(settingsRecoveryCmd(['retry'])).resolves.toBe(1);

        expect(mockCategory.error).toHaveBeenCalledWith(expect.stringContaining('logs --settings'));
        expect(mockCategory.success).not.toHaveBeenCalled();
    });

    test('is registered in the command table', async () => {
        jest.mocked(settings.startFreshDetailed).mockReturnValue({ ok: true, keptAt: null });
        const { COMMANDS } = require('../../src/ts/cli/commandTable') as typeof commandTableModule;

        await expect(COMMANDS['settings-recovery'](['start-fresh'])).resolves.toBe(0);
    });

    test.each([[[]], [['nope']], [['retry', 'extra']], [['constructor']], [['keep']], [['report', 'extra']]])(
        '%j is a usage error',
        async (argv) => {
            await expect(settingsRecoveryCmd(argv)).resolves.toBe(1);

            expect(settings.retryImportDetailed).not.toHaveBeenCalled();
            expect(settings.startFreshDetailed).not.toHaveBeenCalled();
            expect(settings.reimportFromV1Detailed).not.toHaveBeenCalled();
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
