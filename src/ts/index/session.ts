import * as fs from 'node:fs';
import * as path from 'node:path';
import * as logger from '../logger';

/**
 * The session partition every app window uses (index/windows.ts), locked down by index/permissions.ts and cleared by
 * the local-data wipe (settings/localData.ts). No `persist:` prefix makes it an in-memory session: its cookies, local
 * storage and cache never reach the disk, and nothing in the app relies on them (the auth token lives in the settings
 * store, API calls go through Node).
 */
const APP_PARTITION = 'gurushots';

/**
 * Removes the directory a persistent partition of this name keeps under the user-data directory
 * (`Partitions/gurushots`). The in-memory partition never writes it, so a copy found there is stale browser data.
 * Best effort: a failure is logged and never stops the startup.
 */
const removeStalePartitionData = (getUserDataPath: () => string): void => {
    try {
        const stale = path.join(getUserDataPath(), 'Partitions', APP_PARTITION);
        if (!fs.existsSync(stale)) return;
        fs.rmSync(stale, { recursive: true, force: true });
        logger.withCategory('ui').info('Removed stale on-disk browser session data', null);
    } catch (error) {
        logger.withCategory('ui').warning('Could not remove stale on-disk browser session data (non-fatal):', error);
    }
};

export { APP_PARTITION, removeStalePartitionData };
