/**
 * Waiting for a lock that something else holds for a moment.
 */

type Lock = { ok: boolean; release: () => void };

const STEP_MS = 10;

const sleepSync = (ms: number): void => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * A lock waited for in small steps. The wait blocks the calling thread (the callers change small files
 * synchronously, rarely and for a few milliseconds), so it is short on purpose: a lock still held after it means
 * another process is in the middle of a change, and the caller fails safe instead of waiting longer.
 *
 * @param acquire - takes the lock once, as acquireUnlockLock does
 * @returns the lock, or null when it was not free within `waitMs`
 */
const acquireWithin = <L extends Lock>(acquire: () => L, waitMs: number): L | null => {
    const deadline = Date.now() + waitMs;
    for (;;) {
        const lock = acquire();
        if (lock.ok) return lock;
        if (Date.now() >= deadline) return null;
        sleepSync(STEP_MS);
    }
};

export { acquireWithin };
