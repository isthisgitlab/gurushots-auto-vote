/**
 * The lock settings.json and config.json are changed under on a desktop, where two processes (the app and the CLI) share
 * the user-data directory: the import, and the mirror's compare-and-write of settings.json, hold it, so that neither
 * runs while the other is in the middle of its change. Android has no file lock (the native compare-and-write of each
 * key decides there), so the lock is always free.
 */

import { acquireUnlockLock } from '../joinStateStore';
import { acquireWithin } from '../lockWait';

const SETTINGS_LOCK_ID = 'config-import';

/**
 * Takes the lock, waiting up to `waitMs` for it.
 *
 * @returns the lock; `'busy'` when another process held it for the whole wait; `'unavailable'` when it cannot be had
 */
const acquireSettingsLock = (waitMs: number) =>
    acquireWithin(() => acquireUnlockLock(SETTINGS_LOCK_ID, { category: 'settings', internal: true }), waitMs);

export { acquireSettingsLock };
