/**
 * Tells a CLI user, on stderr, that the saved settings are not in use and why (see settings/persistence.ts
 * getSettingsRecovery), so a command's output is not mistaken for the result of the settings they had.
 */

import * as logger from '../../logger';
import * as settings from '../../settings';

import type { SettingsRecovery } from '../../settings';

/**
 * The notice for one recovery state: what happened, why, and what comes next.
 */
const describeSettingsRecovery = ({ code, path }: SettingsRecovery): string => {
    switch (code) {
        case 'settings-corrupt':
            return `The saved settings could not be read (the file was damaged). It was moved to ${path} and the default settings are in use. Keep that file if you want to recover values from it by hand.`;
        case 'settings-unreadable':
            return `The saved settings at ${path} cannot be read, or cannot be moved aside, so nothing will be saved until that is fixed. The default settings are in use. Check that the file belongs to this account and can be read and written.`;
        case 'settings-migration-failed':
            return `The saved settings at ${path} could not be brought up to date, so nothing will be saved and the default settings are in use. The file was left as it is; update the app, or fix the file.`;
    }
};

/**
 * Prints the notice when the stored settings are not in use; nothing otherwise.
 */
const reportSettingsRecovery = (): void => {
    const recovery = settings.getSettingsRecovery();
    if (recovery) logger.printStderr(describeSettingsRecovery(recovery));
};

export { describeSettingsRecovery, reportSettingsRecovery };
