/**
 * Tells a CLI user, on stderr, that the saved settings are not in use and why (see settings/persistence.ts
 * getSettingsRecovery), so a command's output is not mistaken for the result of the settings they had; and the
 * `settings-recovery` command that acts on it.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import { usageError } from '../commandKit';

import type { SettingsRecovery } from '../../settings';

const SETTINGS_RECOVERY_USAGE = 'Usage: settings-recovery retry | start-fresh | reimport | report | acknowledge';

/**
 * The notice for one recovery state: what happened, why, and what comes next.
 */
const describeSettingsRecovery = ({ code, path }: Pick<SettingsRecovery, 'code' | 'path'>): string => {
    switch (code) {
        case 'settings-restored':
            return `The saved settings could not be read (config.json was damaged), so they were restored from settings.json. The damaged file was moved to ${path}; keep it if you want to look at it, or delete it.`;
        case 'settings-corrupt':
            return `The saved settings could not be read (config.json was damaged). It was moved to ${path} and no usable settings.json was found to restore them from, so the default settings are in use. Keep that file if you want to recover values from it by hand. To import settings.json over the default settings once it is fixed, run "settings-recovery reimport".`;
        case 'settings-unreadable':
            return `The saved settings at ${path} cannot be read, or cannot be moved aside, so nothing will be saved until that is fixed. The default settings are in use. Check that the file belongs to this account and can be read and written.`;
        case 'settings-import-failed':
            return `The settings.json at ${path} could not be imported, so nothing will be saved and the default settings are in use. The file was left as it is. Fix it and run "settings-recovery retry", or run "settings-recovery start-fresh" to begin with default settings (a copy of the file is kept as settings.json.original).`;
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
    retry: { run: () => settings.retryImport(), done: 'The settings were imported from settings.json.' },
    'start-fresh': {
        run: () => settings.startFresh(),
        done: 'Started with default settings; a copy of settings.json is kept as settings.json.original.',
    },
    reimport: {
        run: () => settings.reimportFromV1(),
        done: 'settings.json was imported again; the settings that were in use were moved aside to config.json.corrupt-<time>.',
    },
    acknowledge: { run: () => settings.acknowledgeImportReport(), done: 'The import report is marked as seen.' },
} as const;

/**
 * Prints what the import left unresolved, or says there was none.
 */
const printImportReport = (): number => {
    const report = settings.getImportReport();
    if (!report) {
        logger.withCategory('settings').info('The settings were not imported from a settings.json.');
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
 * `settings-recovery retry | start-fresh | reimport | report | acknowledge`: try the import of settings.json again,
 * begin with default settings, import settings.json over the settings in use, print what the import left unresolved, or
 * mark that report as seen.
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
    if (!run()) {
        logger.withCategory('settings').error('The recovery did not work; see the log for why (logs --settings)');
        return 1;
    }
    logger.withCategory('settings').success(done);
    return 0;
};

export { describeSettingsRecovery, reportSettingsRecovery, settingsRecoveryCmd, SETTINGS_RECOVERY_USAGE };
