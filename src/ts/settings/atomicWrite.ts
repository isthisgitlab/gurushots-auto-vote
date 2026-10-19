/**
 * Atomic replacement of a JSON store's file, for the stores that are read outside any lock (createJsonStore `atomic`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Makes a rename in `dir` durable. Best effort: Windows cannot open a directory, and a filesystem may refuse.
 */
const syncDirectory = (dir: string) => {
    if (process.platform === 'win32') return;
    let fd: number | undefined;
    try {
        fd = fs.openSync(dir, 'r');
        fs.fsyncSync(fd);
    } catch {
        // the rename itself has happened; only its durability is not assured
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
};

// Waits between the attempts to rename a temp file over its target: Windows reports a rename over a file another
// process has open (an antivirus scan, a search indexer, a second reader) as EPERM or EBUSY, which passes in moments.
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];

const sleepSync = (ms: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const isBusyRenameError = (err: unknown) =>
    err instanceof Error && 'code' in err && (err.code === 'EPERM' || err.code === 'EBUSY');

/**
 * Renames `from` over `to`, trying again a few times, briefly apart, when the rename is refused as busy.
 */
const renameWithRetry = (from: string, to: string) => {
    for (let attempt = 0; ; attempt++) {
        try {
            fs.renameSync(from, to);
            return;
        } catch (err) {
            if (!isBusyRenameError(err) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
            sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
        }
    }
};

// A temp file of a write that was cut short; one younger than this may belong to a write still under way.
const STALE_TEMP_MS = 60_000;

/**
 * Removes the temp files `writeAtomicOwnerOnly` left beside `filePath` when a write was cut short (a crash between
 * creating and renaming one). Only names of exactly that pattern, only ones untouched for a while. Best effort.
 */
export const sweepStaleTemps = (filePath: string) => {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const own = new RegExp(`^${base}\\.\\d+\\.[0-9a-f]{8}\\.tmp$`);
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return; // a directory that cannot be listed has only clutter to lose
    }
    for (const name of names.filter((candidate) => own.test(candidate))) {
        try {
            const leftover = path.join(dir, name);
            if (Date.now() - fs.statSync(leftover).mtimeMs > STALE_TEMP_MS) fs.unlinkSync(leftover);
        } catch {
            // one that vanished meanwhile, or cannot be removed, does not stop the others
        }
    }
};

/**
 * Writes a JSON store's file so that a reader never sees it half written: the data goes to a temp file next to it
 * (mode 0o600) and is renamed over it, which replaces it atomically. The settings file is written this way, and so
 * are the stores that ask for it (`atomic`): the claims file asks, because a claim read by a process that does not
 * hold the claims-file lock must never see an empty or cut-off file.
 */
export const writeAtomicOwnerOnly = (filePath: string, data: string) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const temp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        // The data is on disk before the rename makes it the file, so a power loss leaves the old file or the new
        // one, never an empty or cut-off one. (fsync is best effort where the platform's does not reach the drive's
        // own cache: macOS needs F_FULLFSYNC for that, which node does not offer.) writeFileSync on the descriptor
        // goes on until every byte is written, which a single writeSync does not promise.
        const fd = fs.openSync(temp, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, data);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        renameWithRetry(temp, filePath);
        syncDirectory(dir);
    } catch (err) {
        try {
            fs.unlinkSync(temp);
        } catch {
            // nothing was written, or it is already gone
        }
        throw err;
    }
};
