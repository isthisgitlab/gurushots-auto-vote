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

const SETTINGS_RECOVERY_USAGE =
    'Usage: settings-recovery retry | start-fresh [--force] | reimport | report | acknowledge';

/**
 * The notice for one recovery state: what happened, why, and what comes next.
 */
const describeSettingsRecovery = ({
    code,
    path,
    settingsSetAside,
    damagedAt,
}: Pick<SettingsRecovery, 'code' | 'path' | 'settingsSetAside' | 'damagedAt'>): string => {
    switch (code) {
        case 'settings-restored':
            return `The saved settings could not be read (config.json was damaged), so they were restored from settings.json. The damaged file was moved to ${path}; keep it if you want to look at it, or delete it.`;
        case 'settings-corrupt':
            return `The saved settings could not be read (config.json was damaged). It was moved to ${path} and no usable settings.json was found to restore them from, so the default settings are in use. Keep that file if you want to recover values from it by hand. ${
                settingsSetAside === undefined
                    ? 'To bring the values of settings.json back, fix settings.json and run "settings-recovery reimport". If it cannot be imported, the first save keeps it as a copy beside it before a new settings.json is written; the notice then names the copy to fix.'
                    : `The unusable settings.json was kept at ${settingsSetAside}, and a new settings.json was written from the saved settings. To bring its values back, fix the file at ${settingsSetAside} and run "settings-recovery reimport".`
            }`;
        case 'settings-unreadable':
            return `The saved settings at ${path} cannot be read, or cannot be moved aside, so nothing will be saved until that is fixed. The default settings are in use. Check that the file belongs to this account and can be read and written.`;
        case 'settings-import-retrying':
            return `${
                damagedAt === undefined
                    ? `The settings.json at ${path} could not be read just now (another program may be using it)`
                    : `config.json was damaged and moved to ${damagedAt}, and the settings.json at ${path}, the copy to restore the settings from, could not be read just now (another program may be using it)`
            }, so nothing will be saved and the default settings are in use for now. Nothing was overwritten. The next run tries again by itself; run "settings-recovery retry" to try now.${
                damagedAt === undefined
                    ? ''
                    : ' The damaged copy may still hold the sign-in it had, even after you log out; delete it once you no longer need it.'
            }`;
        case 'settings-import-failed':
            return `The settings.json at ${path} could not be imported, so nothing will be saved and the default settings are in use. The file was left as it is. Fix it and run "settings-recovery retry", or run "settings-recovery start-fresh" to begin with default settings (a copy of the file is kept beside it, as settings.json.original or, when that name is taken, as settings.json.unimportable-<timestamp>).`;
    }
};

/**
 * Prints the notice when the stored settings are not in use; nothing otherwise.
 */
const reportSettingsRecovery = (): void => {
    const recovery = settings.getSettingsRecovery();
    if (recovery) logger.printStderr(describeSettingsRecovery(recovery));
};

/**
 * What a re-import came to: it replaces the settings in use, the sign-in included, with what settings.json holds, after
 * setting the settings in use aside (when there were any).
 */
const reimport = (): { ok: boolean; done: string; failed: string } => {
    const { ok, setAside, source } = settings.reimportFromV1Detailed();
    return {
        ok,
        failed: `The re-import did not work: ${source} is missing, could not be read or converted, or the settings could not be saved. Nothing was changed; see the log for why (logs --settings)`,
        done:
            setAside === null
                ? `${source} was imported again.`
                : `${source} was imported again; the settings and sign-in that were in use were set aside at ${setAside}.`,
    };
};

/** What Start fresh came to: where settings.json was kept, or that there was none to keep. */
const startFresh = (): { ok: boolean; done: string } => {
    const { ok, keptAt, adopted, unreadable } = settings.startFreshDetailed();
    return {
        ok,
        done: adopted
            ? 'Nothing was reset: the settings were already in place (restored or imported meanwhile), and they are in use.'
            : unreadable
              ? 'Started with default settings; settings.json could not be read, so it was left as it is and no copy was kept.'
              : keptAt === null
                ? 'Started with default settings; there was no settings.json, so no copy was kept.'
                : `Started with default settings; a copy of settings.json was kept at ${keptAt}.`,
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
            ? 'Nothing was imported: the settings are already in place. To load settings.json over them, run "settings-recovery reimport".'
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
 * `settings-recovery retry | start-fresh | reimport | report | acknowledge`: try the import of settings.json again,
 * begin with default settings, import settings.json over the settings in use, print what the import left unresolved, or
 * mark that report as seen.
 *
 * @returns the process exit code
 */
const settingsRecoveryCmd = async (argv: string[]): Promise<number> => {
    const [action, ...extra] = argv;
    if (action === 'report' && extra.length === 0) return printImportReport();
    if (action === 'retry' && extra.length === 0) return finish(retry());
    if (action === 'reimport' && extra.length === 0) return finish(reimport());
    if (action === 'start-fresh' && (extra.length === 0 || (extra.length === 1 && extra[0] === '--force'))) {
        // While settings.json could not be read just now and may pass, giving the import up is not offered: it is asked for.
        settings.loadSettings();
        if (extra.length === 0 && settings.getSettingsRecovery()?.code === 'settings-import-retrying') {
            logger
                .withCategory('settings')
                .error(
                    'settings.json could not be read just now, and the import is tried again by itself, so starting fresh is not offered. Run "settings-recovery retry" to try now, or "settings-recovery start-fresh --force" to start with default settings anyway.',
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
