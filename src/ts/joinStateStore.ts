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
 * that still holds its own token, and fails OPEN on any other lock-infra error (never deadlocks a join). Capacitor/headless are single-process for a given surface,
 * so the lock is a no-op there.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as runtime from './runtime';
import * as logger from './logger';
import { createJsonStore, getSettingsPath } from './settings/storage';

const joinStateStore = createJsonStore({ fileName: 'joinState.json', prefKey: 'gs_join_state' });

// A held lock whose file has not been touched for this long is treated as stale (its owner crashed) and taken over.
const LOCK_TTL_MS = 60_000;
// A lock that is held is touched this often, so a join that outlasts the TTL (a retried submit can) is not stale.
const LOCK_RENEW_MS = LOCK_TTL_MS / 3;

type UnlockLock = { ok: boolean; release: () => void };

const NOT_HELD: UnlockLock = { ok: false, release: () => {} };
const NO_LOCK: UnlockLock = { ok: true, release: () => {} };

const lockPathFor = (id: string | number): string => {
    const safeId = String(id).replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(path.dirname(getSettingsPath()), `joinlock-${safeId}.lock`);
};

/**
 * The owner token a lock file holds, or null when there is no such file. Never throws.
 */
const tokenIn = (lockPath: string): string | null => {
    try {
        return fs.readFileSync(lockPath, 'utf8');
    } catch {
        return null;
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

/**
 * Takes over a lock whose file has not been touched for the TTL. The stale file is renamed to a name of its own
 * — only one process can rename it — and the file that was renamed is checked to be the stale one that was seen:
 * if it is not (another process replaced it in between), it is put back and the lock stays held.
 *
 * @returns whether the lock is free to create now
 */
const takeOverStale = (lockPath: string, token: string): boolean => {
    let seen: { mtimeMs: number; token: string | null };
    try {
        seen = { mtimeMs: fs.statSync(lockPath).mtimeMs, token: tokenIn(lockPath) };
    } catch {
        return true; // gone since: free
    }
    if (Date.now() - seen.mtimeMs <= LOCK_TTL_MS) return false;
    const grave = `${lockPath}.stale-${token}`;
    try {
        fs.renameSync(lockPath, grave);
    } catch {
        // Another process renamed it first: free only if nothing has been created in its place since.
        return tokenIn(lockPath) === null;
    }
    if (tokenIn(grave) === seen.token) {
        fs.unlinkSync(grave);
        return true;
    }
    // What was renamed is not the stale lock seen: a live lock. Put it back (if nobody has created one since).
    try {
        fs.linkSync(grave, lockPath);
    } catch {
        // another lock has been created meanwhile: the live one is lost to that, and the stale name is dropped
    }
    fs.unlinkSync(grave);
    return false;
};

/**
 * Keeps a held lock fresh: its mtime is touched while the file still holds this owner's token, and the renewal
 * stops on its own if the lock has been lost.
 */
const keepFresh = (lockPath: string, token: string): NodeJS.Timeout => {
    const timer = setInterval(() => {
        if (tokenIn(lockPath) !== token) {
            clearInterval(timer);
            return;
        }
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
 * Acquire a cross-process lock for one challenge's unlock critical section (or, under any other id, for a shared
 * resource such as the claims file).
 *
 * The lock file holds a random owner token: release removes the file only while it still holds that token, so a
 * lock another process took over after this one went stale is never deleted by this one. A held lock is touched
 * every third of the TTL, so only the lock of a crashed owner goes stale, and a stale one is taken over atomically.
 *
 * @returns ok=false means another process
 *   holds it right now (caller should treat as busy). release() is always safe.
 */
const acquireUnlockLock = (id: string | number): UnlockLock => {
    // Only the real-fs platforms (Electron/CLI) can run two processes against one
    // account; Capacitor/headless are single-process for a given surface.
    if (runtime.isCapacitor() || runtime.isHeadlessService()) return NO_LOCK;

    const lockPath = lockPathFor(id);
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`;
    try {
        try {
            createLock(lockPath, token);
        } catch (caught) {
            if ((caught as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw caught;
            if (!takeOverStale(lockPath, token)) return NOT_HELD;
            createLock(lockPath, token);
        }
        const timer = keepFresh(lockPath, token);
        return {
            ok: true,
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
        const error = caught as NodeJS.ErrnoException | null | undefined;
        if (error && error.code === 'EEXIST') return NOT_HELD;
        // Lock infrastructure failed (permissions, etc.) — fail OPEN rather than
        // block joins forever; the in-process Set + persisted claim still apply.
        logger
            .withCategory('join')
            .warning(`cross-process join lock unavailable for ${id}: ${error?.message || error}`, null);
        return NO_LOCK;
    }
};

export const initializeJoinStateAsync = joinStateStore.initializeAsync;
export const flushJoinStateWrites = joinStateStore.flushPendingWrites;
export { joinStateStore, acquireUnlockLock };
