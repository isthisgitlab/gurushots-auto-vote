/**
 * Persisted state for the paid-join flow, plus a cross-process unlock lock.
 *
 * joinStateStore holds "unlocked-but-not-yet-submitted" markers so a submit that
 * fails after a successful coins_unlock never triggers a second (re-charging)
 * unlock on a later cycle. It uses the same platform-aware transport as
 * settings/metadata (fs on Electron/CLI, @capacitor/preferences on Android),
 * so — exactly like metadata — its Capacitor cache MUST be hydrated at boot via
 * initializeJoinStateAsync() (wired in Capacitor.tsx) or the marker is invisible
 * after an app relaunch and a paid retry would double-charge.
 *
 * acquireUnlockLock gives cross-process mutual exclusion around the
 * check→unlock→mark critical section on the real-fs platforms (Electron/CLI),
 * where the same account can be driven by two processes at once (GUI + CLI). It
 * is a best-effort OS lockfile: it blocks a genuinely-held lock, keeps its own lock fresh while held, takes a
 * lock over only when its owner stopped touching it (atomically, by renaming it away), releases only a lock
 * that still holds its own token, and fails OPEN on any other lock-infra error (never deadlocks a join). On Android there
 * is no file lock: the app window and the background service share one process and one store, and the claims are
 * changed only by the native compare-and-write (`shared` above), which is the mutual exclusion there.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as runtime from './runtime';
import * as logger from './logger';
import { createJsonStore, getSettingsPath } from './settings/storage';
import { storeLoaded } from './settings/storeTransport';
import { errorMessage } from './errorMessage';
import { isPlainObject } from './plainObject';
import { sanitizeLogString } from './logger/sanitize';

const JOIN_STATE_KEY = 'gs_join_state';
// `strict`: a claim the service's native bridge did not persist is not recorded, and nothing paid is spent on it.
// `shared`: the app window and the background service both change the claims, and each change is saved by the native
// compare-and-write, so that neither erases the other's (and exactly one of them records the claim of a challenge).
const joinStateFile = createJsonStore({
    fileName: 'joinState.json',
    prefKey: JOIN_STATE_KEY,
    atomic: true,
    strict: true,
    shared: true,
});

// A store that could not be read (the service's bridge threw, the app's start-up read failed) throws when read, so
// that the claims read as unreadable, never as none: a claim forgotten is a paid unlock charged twice. Nor is a
// change made on a cache that was never filled.
const joinStateStore = {
    ...joinStateFile,
    readRaw: (): string | null => {
        const raw = joinStateFile.readRaw();
        if (!storeLoaded(JOIN_STATE_KEY)) throw new Error('the saved claims have not loaded');
        return raw;
    },
    updateThrough: (update: (current: string | null) => string | null) =>
        storeLoaded(JOIN_STATE_KEY) ? joinStateFile.updateThrough(update) : Promise.resolve('failed' as const),
};

// A held lock whose file has not been touched for this long is treated as stale (its owner crashed) and taken over.
const LOCK_TTL_MS = 60_000;
// A lock that is held is touched this often, so a join that outlasts the TTL (a retried submit can) is not stale.
const LOCK_RENEW_MS = LOCK_TTL_MS / 3;

// `unavailable`: not held by another, but not to be had: the lock files cannot be made (only the app's own locks).
// `held`: whether this holder still owns the lock, asked right before something that must not be done twice (a lock
// that is not asked about, or has no file, is as held as it was got).
type UnlockLock = { ok: boolean; release: () => void; unavailable?: true; held?: () => boolean };

const NOT_HELD: UnlockLock = { ok: false, release: () => {} };
const UNAVAILABLE: UnlockLock = { ok: false, release: () => {}, unavailable: true };
const NO_LOCK: UnlockLock = { ok: true, release: () => {} };

// A challenge's unlock lock and the app's own locks (the claims file's, the scenario state file's, a challenge's
// scenario steps) are different files whatever their names: an id can never name one of the app's.
const lockPathFor = (id: string | number, internal: boolean): string => {
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(path.dirname(getSettingsPath()), `${internal ? 'statelock' : 'joinlock'}-${safeId}.lock`);
};

/**
 * Whether a caught value is a Node error with this code.
 */
const isErrnoCode = (caught: unknown, code: string): boolean => isPlainObject(caught) && caught.code === code;

/**
 * The owner token a lock file holds, or null when there is no such file (or it cannot be read). Never throws.
 */
const tokenIn = (lockPath: string): string | null => {
    try {
        return fs.readFileSync(lockPath, 'utf8');
    } catch {
        return null;
    }
};

/**
 * A lock file as it is at one moment: its modification time and its owner token, both read through one open
 * file, so they describe the same file even if the path is replaced in between. Null when it cannot be opened.
 */
const inspectLock = (lockPath: string): { mtimeMs: number; token: string } | null => {
    let fd: number | undefined;
    try {
        fd = fs.openSync(lockPath, 'r');
        return { mtimeMs: fs.fstatSync(fd).mtimeMs, token: fs.readFileSync(fd, 'utf8') };
    } catch {
        return null;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
};

/**
 * Creates the lock file exclusively, holding the owner's token. Throws EEXIST while another holds it.
 */
const createLock = (lockPath: string, token: string): void => {
    const fd = fs.openSync(lockPath, 'wx');
    try {
        fs.writeSync(fd, token);
    } finally {
        fs.closeSync(fd);
    }
};

const quietly = (attempt: () => void): void => {
    try {
        attempt();
    } catch {
        // best effort
    }
};

/**
 * Puts a live lock that was renamed away back where it was, without ever replacing a lock that was created there
 * since: a hard link fails with EEXIST instead of overwriting. The moved file is then of no use (it is superseded
 * by the newer lock, or is back) and goes. Where hard links are not available (FAT, some network filesystems) a
 * rename is all there is, and it would replace a newer lock, so it is made only while the place is empty.
 */
const putBack = (grave: string, lockPath: string): void => {
    try {
        fs.linkSync(grave, lockPath);
    } catch (caught) {
        if (isErrnoCode(caught, 'EPERM') || isErrnoCode(caught, 'ENOTSUP')) {
            if (tokenIn(lockPath) === null) quietly(() => fs.renameSync(grave, lockPath));
            return;
        }
        if (!isErrnoCode(caught, 'EEXIST')) return; // the live lock stays under its other name
    }
    quietly(() => fs.unlinkSync(grave));
};

const isStale = (lock: { mtimeMs: number }): boolean => Date.now() - lock.mtimeMs > LOCK_TTL_MS;

/**
 * Takes over a lock whose file has not been touched for the TTL. The stale file is renamed to a name of its own —
 * only one process can rename it — and what was renamed is looked at again, through one open file: it must still
 * be past the TTL and hold the token that was seen. If it is not (another process replaced the stale lock between
 * the look and the rename, so a live lock was moved), it is put back, never over a lock created in its place
 * since (putBack), and the lock stays held.
 *
 * @returns whether the lock is free to create now
 */
const takeOverStale = (lockPath: string, token: string): boolean => {
    const seen = inspectLock(lockPath);
    if (seen === null) return true; // gone since: free
    if (!isStale(seen)) return false;
    const grave = `${lockPath}.stale-${token}`;
    try {
        fs.renameSync(lockPath, grave);
    } catch {
        // Another process renamed it first: free only if nothing has been created in its place since.
        return tokenIn(lockPath) === null;
    }
    const moved = inspectLock(grave);
    if (moved !== null && moved.token === seen.token && isStale(moved)) {
        fs.unlinkSync(grave);
        return true;
    }
    putBack(grave, lockPath);
    return false;
};

/**
 * Keeps a held lock fresh: its mtime is touched while the file still holds this owner's token. A read that finds
 * nothing is tolerated once (it can be a momentary failure); a lock another owner holds, a second miss or a file
 * that cannot be touched stop the renewal.
 */
const keepFresh = (lockPath: string, token: string): NodeJS.Timeout => {
    let missed = 0;
    const timer = setInterval(() => {
        const held = tokenIn(lockPath);
        if (held !== token) {
            missed += 1;
            if (held !== null || missed >= 2) clearInterval(timer);
            return;
        }
        missed = 0;
        try {
            const now = new Date();
            fs.utimesSync(lockPath, now, now);
        } catch {
            clearInterval(timer);
        }
    }, LOCK_RENEW_MS);
    timer.unref();
    return timer;
};

/**
 * Whether the lock file still holds this owner's token. A lock that went past the TTL without a renewal (the machine
 * slept: the timer that touches it did not run) is not yet anyone else's until another process renames it away, so it
 * is touched here, and the token is read again: a process that took it over in between has made it its own, and a
 * takeover that was in progress finds it live again (takeOverStale looks at what it moved).
 */
const holdsToken = (lockPath: string, token: string): boolean => {
    const seen = inspectLock(lockPath);
    if (seen === null || seen.token !== token) return false;
    if (!isStale(seen)) return true;
    try {
        const now = new Date();
        fs.utimesSync(lockPath, now, now);
    } catch {
        return false;
    }
    return tokenIn(lockPath) === token;
};

/**
 * Logs a lock that could not be made, with where and why. The ones that fail closed stop something the user can fix,
 * so they are errors (`logs --error`); the challenge's, which goes on without it, is a warning.
 */
const reportUnavailable = (
    caught: unknown,
    lock: { id: string | number; lockPath: string; category: 'join' | 'scenario'; internal: boolean },
): void => {
    const errno = isPlainObject(caught) && typeof caught.code === 'string' ? ` [${caught.code}]` : '';
    // The lock's file name, not its path: the path holds the user's home folder, and the log may be shared.
    const file = path.basename(lock.lockPath);
    const reason = sanitizeLogString((errorMessage(caught) || String(caught)).split(lock.lockPath).join(file));
    const said = `cross-process lock unavailable for ${sanitizeLogString(lock.id)} (${sanitizeLogString(file)}): ${reason}${errno}`;
    const log = logger.withCategory(lock.category);
    if (lock.internal) log.error(said, null);
    else log.warning(said, null);
};

/**
 * Acquire a cross-process lock for one challenge's unlock critical section, or (`internal`) one of the app's own, for
 * a shared file or a challenge's scenario steps.
 *
 * The lock file holds a random owner token: release removes the file only while it still holds that token, so a
 * lock another process took over after this one went stale is never deleted by this one. A held lock is touched
 * every third of the TTL, so only the lock of a crashed owner goes stale, and a stale one is taken over atomically.
 *
 * When the lock cannot be made at all (permissions, a full disk) the challenge's unlock lock fails OPEN, which its
 * claim already covers: no coins are spent without a claim recorded first, by compare-and-set under the claims-file
 * lock. The app's own locks fail CLOSED, as `unavailable` (not held by anyone, and not to be had: callers tell it
 * from busy and say so): nothing guards what they guard but them.
 *
 * @returns ok=false means another process
 *   holds it right now (caller should treat as busy), unless `unavailable`. release() is always safe.
 */
const acquireUnlockLock = (
    id: string | number,
    { category = 'join', internal = false }: { category?: 'join' | 'scenario'; internal?: boolean } = {},
): UnlockLock => {
    // Only the real-fs platforms (Electron/CLI) can run two processes against one
    // account; on Android the claims are changed by the native compare-and-write instead (see joinStateFile).
    if (runtime.isCapacitor() || runtime.isHeadlessService()) return NO_LOCK;

    const lockPath = lockPathFor(id, internal);
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
    try {
        try {
            createLock(lockPath, token);
        } catch (caught) {
            if (!isErrnoCode(caught, 'EEXIST')) throw caught;
            if (!takeOverStale(lockPath, token)) return NOT_HELD;
            createLock(lockPath, token);
        }
        const timer = keepFresh(lockPath, token);
        return {
            ok: true,
            held: () => holdsToken(lockPath, token),
            release: () => {
                clearInterval(timer);
                if (tokenIn(lockPath) !== token) return;
                try {
                    fs.unlinkSync(lockPath);
                } catch {
                    // already gone
                }
            },
        };
    } catch (caught) {
        if (isErrnoCode(caught, 'EEXIST')) return NOT_HELD;
        // Lock infrastructure failed (permissions, etc.): see above for which locks fail open.
        reportUnavailable(caught, { id, lockPath, category, internal });
        return internal ? UNAVAILABLE : NO_LOCK;
    }
};

export const initializeJoinStateAsync = joinStateStore.initializeAsync;
// Reads the claims again from Preferences, where the background service writes them (a no-op off the app window).
export const refreshJoinStateAsync = joinStateStore.refreshAsync;
// The window flushes on teardown without waiting on the answer: a write that did not persist is logged here, not left
// as a rejection nobody handles.
export const flushJoinStateWrites = (): Promise<void> =>
    joinStateStore.flushPendingWrites().catch(() => {
        logger.withCategory('settings').error('join-state writes were not persisted', null);
    });
export { joinStateStore, acquireUnlockLock };
