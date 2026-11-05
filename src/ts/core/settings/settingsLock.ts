/**
 * The lock config.json and the import marker are changed under on a desktop, where two processes (the app and the CLI)
 * share the user-data directory: the 1.x import, the import marker's change, and the settled-import defaults write hold
 * it, so that neither runs while the other is in the middle of its change. Android has no file lock (the native
 * compare-and-write of each key decides there), so the lock is always free.
 */

import { acquireUnlockLock } from '../joinStateStore';
import { acquireWithin } from '../lockWait';

const SETTINGS_LOCK_ID = 'config-import';

/**
 * Takes the lock, waiting up to `waitMs` for it.
 *
 * @returns the lock; `'busy'` when another process held it for the whole wait; `'unavailable'` when it cannot be had
 */
const acquireSettingsLock = (waitMs: number) => {
    const lock = acquireWithin(
        () => acquireUnlockLock(SETTINGS_LOCK_ID, { category: 'settings', internal: true }),
        waitMs,
    );
    if (lock === 'busy' || lock === 'unavailable') return lock;
    heldHere++;
    let released = false;
    return {
        ...lock,
        // Once only, so that the count of holds stays honest and the lock is let go of once.
        release: () => {
            if (released) return;
            released = true;
            heldHere--;
            lock.release();
        },
    };
};

// How many holds of the lock this process has now: a change made inside one (the import marker's change, made inside the
// import) that needs the lock again does not wait for itself.
let heldHere = 0;

/**
 * Runs `run` with the lock held, taking it for the run unless this process holds it already.
 *
 * @param waitMs - how long to wait for another process to let go
 * @param busy - the answer when the lock could not be had
 */
const underSettingsLock = <T>(waitMs: number, run: () => T, busy: T): T => {
    if (heldHere > 0) return run();
    const lock = acquireSettingsLock(waitMs);
    if (lock === 'busy' || lock === 'unavailable') return busy;
    try {
        return run();
    } finally {
        lock.release();
    }
};

export { acquireSettingsLock, underSettingsLock };
