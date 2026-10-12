/**
 * CLI commands over the app's local data and legal notices: `reset-data` deletes everything stored on this device,
 * `licenses` prints the third-party notices.
 */

import * as logger from '../../logger';
import { wipeLocalData } from '../../settings/localData';
import { loadThirdPartyNotices } from '../../thirdPartyNotices';
import { errorMessage } from '../../errorMessage';
import { usageError } from '../commandKit';

const RESET_DATA_USAGE = 'Usage: reset-data --yes';

/**
 * Deletes every file the app keeps on this device: settings and the saved login, every store, logs and the extracted
 * vision runtime. It cannot be undone, so it does nothing without --yes, and nothing while auto-vote is running.
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
        const reason =
            result.error === 'busy'
                ? 'Auto-vote is running (in the app or in a CLI session). Stop it first, then run reset-data again.'
                : result.error;
        logger.printStderr(`Nothing was deleted completely: ${reason}`);
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
