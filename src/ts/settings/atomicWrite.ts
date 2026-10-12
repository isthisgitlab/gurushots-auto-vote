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

// A temp file of a write that was cut short; one younger than this may belong to a write still under way.
const STALE_TEMP_MS = 60_000;

/**
 * Removes the temp files `writeAtomicOwnerOnly` left beside `filePath` when a write was cut short (a crash between
 * creating and renaming one). Only names of exactly that pattern, only ones untouched for a while. Best effort.
 */
export const sweepStaleTemps = (filePath: string) => {
    const base = path.basename(filePath);
    const dir = path.dirname(filePath);
    try {
        for (const name of fs.readdirSync(dir)) {
            if (!name.startsWith(`${base}.`) || !/\.\d+\.[0-9a-f]{8}\.tmp$/.test(name)) continue;
            const leftover = path.join(dir, name);
            if (Date.now() - fs.statSync(leftover).mtimeMs > STALE_TEMP_MS) fs.unlinkSync(leftover);
        }
    } catch {
        // a leftover that cannot be listed or removed is only clutter
    }
};

/**
 * Writes a JSON store's file so that a reader never sees it half written: the data goes to a temp file next to it
 * (mode 0o600) and is renamed over it, which replaces it atomically. The settings file is not written this way —
 * its inode is watched — and neither are the stores that did not ask for it (`atomic`): the claims file asks, because
 * a claim read by a process that does not hold the claims-file lock must never see an empty or cut-off file.
 */
export const writeAtomicOwnerOnly = (filePath: string, data: string) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const temp = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
        // The data is on disk before the rename makes it the file, so a power loss leaves the old file or the new
        // one, never an empty or cut-off one.
        const fd = fs.openSync(temp, 'wx', 0o600);
        try {
            fs.writeSync(fd, data);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temp, filePath);
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
