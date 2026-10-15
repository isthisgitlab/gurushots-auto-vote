/**
 * Tells a CLI user, on stderr, that the saved settings are not in use and why (see settings/persistence.ts
 * getSettingsRecovery), so a command's output is not mistaken for the result of the settings they had; and the
 * `settings-recovery` command that acts on it.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import { usageError } from '../commandKit';

import type { SettingsRecovery } from '../../settings';

const SETTINGS_RECOVERY_USAGE = 'Usage: settings-recovery retry | start-fresh | reimport | keep | report | acknowledge';

/**
 * The notice for one recovery state: what happened, why, and what comes next.
 */
const describeSettingsRecovery = ({ code, path }: Pick<SettingsRecovery, 'code' | 'path'>): string => {
    switch (code) {
        case 'settings-corrupt':
            return `The saved settings could not be read (config.json was damaged). It was moved to ${path} and the default settings are in use. Keep that file if you want to recover values from it by hand. To import your 1.x settings.json over the default settings instead, run "settings-recovery reimport".`;
        case 'settings-unreadable':
            return `The saved settings at ${path} cannot be read, or cannot be moved aside, so nothing will be saved until that is fixed. The default settings are in use. Check that the file belongs to this account and can be read and written.`;
        case 'settings-import-failed':
            return `Your 1.x settings at ${path} could not be imported, so nothing will be saved and the default settings are in use. The file was left as it is. Fix it and run "settings-recovery retry", or run "settings-recovery start-fresh" to begin with default settings (the 1.x file stays where it is, as a backup).`;
        case 'settings-v1-changed':
            return `The 1.x settings at ${path} changed after they were imported. Your current settings are unchanged and saving works. To import that file over them (the current settings are moved aside, your login is kept), run "settings-recovery reimport". To keep the current settings and stop this notice, run "settings-recovery keep".`;
    }
};

/**
 * Prints the notice when the stored settings are not in use; nothing otherwise.
 */
const reportSettingsRecovery = (): void => {
    const recovery = settings.getSettingsRecovery();
    if (recovery) logger.printStderr(describeSettingsRecovery(recovery));
};

const ACTIONS = {
    retry: { run: () => settings.retryImport(), done: 'The 1.x settings were imported.' },
    'start-fresh': {
        run: () => settings.startFresh(),
        done: 'Started with default settings; the 1.x settings.json was left where it is, as a backup.',
    },
    reimport: {
        run: () => settings.reimportFromV1(),
        done: 'The 1.x settings were imported again; the settings that were in use were moved aside to config.json.corrupt-<time>.',
    },
    keep: {
        run: () => settings.keepCurrentConfig(),
        done: 'Kept the current settings. The 1.x settings.json is offered for import again only if it changes once more.',
    },
    acknowledge: { run: () => settings.acknowledgeImportReport(), done: 'The import report is marked as seen.' },
} as const;

/**
 * Prints what the 1.x import left unresolved, or says there was none.
 */
const printImportReport = (): number => {
    const report = settings.getImportReport();
    if (!report) {
        logger.withCategory('settings').info('The settings were not imported from a 1.x settings.json.');
        return 0;
    }
    logger.printLine(
        report.refsBlocked.length === 0
            ? `Imported at ${report.at}: nothing needed attention.`
            : `Imported at ${report.at}. These references were kept and still do not apply, as before the import; create or fix the named profile or scenario:\n${report.refsBlocked.map((ref) => `  ${ref}`).join('\n')}`,
    );
    return 0;
};

/**
 * `settings-recovery retry | start-fresh | reimport | keep | report | acknowledge`: try the import of the 1.x settings
 * again, begin with default settings, import the 1.x file over the settings in use, keep the settings as they are after
 * the 1.x file changed, print what the import left unresolved, or mark that report as seen.
 *
 * @returns the process exit code
 */
const settingsRecoveryCmd = async (argv: string[]): Promise<number> => {
    const [action, ...extra] = argv;
    if (action === 'report' && extra.length === 0) return printImportReport();
    if (action === undefined || extra.length > 0 || !Object.hasOwn(ACTIONS, action)) {
        return usageError('Please name the recovery action', SETTINGS_RECOVERY_USAGE);
    }
    const { run, done } = ACTIONS[action as keyof typeof ACTIONS];
    if (!(await run())) {
        logger.withCategory('settings').error('The recovery did not work; see the log for why (logs --settings)');
        return 1;
    }
    logger.withCategory('settings').success(done);
    return 0;
};

export { describeSettingsRecovery, reportSettingsRecovery, settingsRecoveryCmd, SETTINGS_RECOVERY_USAGE };
