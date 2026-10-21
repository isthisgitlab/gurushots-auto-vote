/**
 * Tells a CLI user, on stderr, that the saved settings are not in use and why (see settings/persistence.ts
 * getSettingsRecovery), so a command's output is not mistaken for the result of the settings they had; and the
 * `settings-recovery` command that acts on it.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';
import { stripTerminalControl } from '../../format/logSafe';
import { describeImportRef, IMPORT_REF_ENGLISH } from '../../settings/importRefs';
import { usageError } from '../commandKit';

import type { SettingsRecovery } from '../../settings';

const SETTINGS_RECOVERY_USAGE = 'Usage: settings-recovery retry | start-fresh [--force] | report | acknowledge';

/**
 * The notice for one recovery state: what happened, why, and what comes next.
 */
const describeSettingsRecovery = ({
    code,
    path,
    blocking,
    detail,
}: Pick<SettingsRecovery, 'code' | 'path' | 'blocking' | 'detail'>): string => {
    switch (code) {
        case 'settings-corrupt':
            return `The saved settings could not be read (config.json was damaged). It was moved to ${path} and the default settings are in use. You can save new settings as usual. The damaged copy still holds the old settings, including the sign-in; keep it if you want to read the old values from it by hand, and delete it once you no longer need it.`;
        case 'settings-unreadable':
            return `The saved settings at ${path} cannot be read, or cannot be moved aside, so nothing will be saved until that is fixed. The default settings are in use. Check that the file belongs to this account and can be read and written; every read tries again, so nothing to do is left once it can.`;
        case 'settings-import-failed':
            return blocking
                ? `The settings.json at ${path} could not be imported just now${detail === undefined ? '' : ` (${detail})`}, so nothing will be saved and the default settings are in use. Nothing was overwritten. The next start tries the import again; run "settings-recovery retry" to try now, or run "settings-recovery start-fresh" to begin with default settings.`
                : `The settings.json at ${path} could not be imported (${detail === 'migration-failed' ? 'its settings cannot be converted to the current settings format' : 'it is not a readable settings file'}), so the default settings were saved in its place and the file was left as it is. To import it once it is fixed, run "settings-recovery start-fresh --force", delete all local data under About and data, and start the app again: the next start imports the file once.`;
    }
};

/**
 * Prints the notice when the stored settings are not in use; nothing otherwise.
 */
const reportSettingsRecovery = (): void => {
    const recovery = settings.getSettingsRecovery();
    if (recovery) logger.printStderr(describeSettingsRecovery(recovery));
};

/** What Start fresh came to: whether the default settings were written, or were already in place. */
const startFresh = (): { ok: boolean; done: string } => {
    const { ok, adopted } = settings.startFreshDetailed();
    return {
        ok,
        done: adopted
            ? 'Nothing was reset: the settings were already in place (saved meanwhile), and they are in use.'
            : 'Started with default settings; settings.json was left as it is and is not imported again unasked.',
    };
};

/**
 * What Retry came to: the settings were imported from settings.json, or were in place already and nothing was imported.
 */
const retry = (): { ok: boolean; done: string } => {
    const { ok, adopted } = settings.retryImportDetailed();
    return {
        ok,
        done: adopted
            ? 'Nothing was imported: the settings are already in place.'
            : 'The settings were imported from settings.json.',
    };
};

const ACTIONS = {
    acknowledge: { run: () => settings.acknowledgeImportReport(), done: () => 'The import report is marked as seen.' },
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
    // The names are the user's own: nothing in them reaches the terminal as a control sequence.
    const lines = report.refsBlocked.map(
        (ref) => `  ${describeImportRef(ref, IMPORT_REF_ENGLISH, (value) => stripTerminalControl(value))}`,
    );
    logger.printLine(
        lines.length === 0
            ? `Imported at ${report.at}: nothing needed attention.`
            : `Imported at ${report.at}. These references were kept and still do not apply, as before the import; create or fix the named profile or scenario:\n${lines.join('\n')}`,
    );
    return 0;
};

// The exit code of an action, and its words.
const finish = ({ ok, done, failed }: { ok: boolean; done: string; failed?: string }): number => {
    if (!ok) {
        logger
            .withCategory('settings')
            .error(failed ?? 'The recovery did not work; see the log for why (logs --settings)');
        return 1;
    }
    logger.withCategory('settings').success(done);
    return 0;
};

/**
 * `settings-recovery retry | start-fresh | report | acknowledge`: try the import of settings.json again, begin with
 * default settings, print what the import left unresolved, or mark that report as seen.
 *
 * @returns the process exit code
 */
const settingsRecoveryCmd = async (argv: string[]): Promise<number> => {
    const [action, ...extra] = argv;
    if (action === 'report' && extra.length === 0) return printImportReport();
    if (action === 'retry' && extra.length === 0) return finish(retry());
    if (action === 'start-fresh' && (extra.length === 0 || (extra.length === 1 && extra[0] === '--force'))) {
        // While the import may pass by itself (the file could not be read just now), giving it up is not offered: it is asked for.
        settings.loadSettings();
        const recovery = settings.getSettingsRecovery();
        if (extra.length === 0 && recovery?.code === 'settings-import-failed' && recovery.blocking) {
            logger
                .withCategory('settings')
                .error(
                    'settings.json could not be read just now, so starting fresh is not offered. Run "settings-recovery retry" to try now, or "settings-recovery start-fresh --force" to start with default settings anyway.',
                );
            return 1;
        }
        return finish(startFresh());
    }
    if (action === undefined || extra.length > 0 || !Object.hasOwn(ACTIONS, action)) {
        return usageError('Please name the recovery action', SETTINGS_RECOVERY_USAGE);
    }
    if (action === 'acknowledge' && settings.getImportReport() === null) {
        logger
            .withCategory('settings')
            .info('The settings were not imported from a settings.json: nothing to acknowledge.');
        return 0;
    }
    const { run, done } = ACTIONS[action as keyof typeof ACTIONS];
    return finish({ ok: run(), done: done() });
};

export { describeSettingsRecovery, reportSettingsRecovery, settingsRecoveryCmd, SETTINGS_RECOVERY_USAGE };
