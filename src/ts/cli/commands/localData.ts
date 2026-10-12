/**
 * CLI commands over the app's local data and legal notices: `reset-data` deletes everything stored on this device,
 * `licenses` prints the third-party notices.
 */

import * as logger from '../../logger';
import { wipeLocalData } from '../../settings/localData';
import { loadThirdPartyNotices } from '../../thirdPartyNotices';
import { errorMessage } from '../../errorMessage';
import { usageError } from '../commandKit';

import type { WipeBusyCode } from '../../settings/localData';

const RESET_DATA_USAGE = 'Usage: reset-data --yes';

// What to do next when the wipe was refused because something is running.
const BUSY_NEXT_STEP: Record<WipeBusyCode, string> = {
    'busy-pass': 'a voting pass is running. Stop it, then run reset-data again.',
    'busy-cli': 'a CLI session is running. Stop it (Ctrl+C in its terminal), then run reset-data again.',
    'busy-app': 'the desktop app is running. Quit it, then run reset-data again.',
};

/**
 * Deletes every file the app keeps on this device: settings and the saved login, every store, logs and the extracted
 * vision runtime. It cannot be undone, so it does nothing without --yes, and nothing while a voting pass, a CLI session
 * or the desktop app is running.
 *
 * @returns the exit code
 */
const resetDataCmd = async (argv: string[]): Promise<number> => {
    if (argv.length !== 1 || argv[0] !== '--yes') {
        return usageError(
            'reset-data deletes all local data: settings, the saved login, every store, logs and the extracted vision runtime. It cannot be undone, so it needs --yes.',
            RESET_DATA_USAGE,
        );
    }
    // Console only, never the log: the log directory is one of the things deleted, and writing to it would bring it back.
    const result = await wipeLocalData();
    if (!result.success) {
        const nextStep = Object.entries(BUSY_NEXT_STEP).find(([code]) => code === result.error)?.[1];
        if (nextStep) {
            logger.printStderr(`Nothing was deleted: ${nextStep}`);
        } else {
            logger.printStderr(`Some data could not be deleted: ${result.error}`);
            const removed = result.removed ?? [];
            if (removed.length > 0) logger.printLine('Already deleted:');
            for (const path of removed) logger.printLine(`  ${path}`);
        }
        return 1;
    }
    logger.printLine('Deleted all local data:');
    for (const removed of result.removed) logger.printLine(`  ${removed}`);
    return 0;
};

/**
 * Prints the third-party license notices.
 *
 * @returns the exit code
 */
const licensesCmd = async (): Promise<number> => {
    try {
        logger.printDocument((await loadThirdPartyNotices()).replace(/\n$/, ''));
        return 0;
    } catch (error) {
        logger
            .withCategory('ui')
            .error(`The third-party notices could not be read: ${errorMessage(error) ?? 'unknown error'}`);
        return 1;
    }
};

export { resetDataCmd, licensesCmd };
