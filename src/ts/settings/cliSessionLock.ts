/**
 * The marker a CLI session (`start`, continuous voting) holds while it runs: a file in the user-data directory naming
 * its process. The desktop app reads it at startup so it does not clear a login the CLI session is using, and the
 * local-data wipe refuses to run under it. A marker whose process is gone is stale and ignored.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getUserDataPath } from './storage';
import { isPlainObject } from '../plainObject';
import { isInteger } from '../numbers';

const LOCK_FILE_NAME = 'cli-session.lock';

const lockPath = () => path.join(getUserDataPath(), LOCK_FILE_NAME);

/**
 * Whether a process with this id is running (one this account may not signal still is).
 */
const processExists = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return err instanceof Error && 'code' in err && err.code === 'EPERM';
    }
};

/**
 * Whether another process holds the marker.
 */
const isCliSessionActive = (): boolean => {
    try {
        const held: unknown = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
        return isPlainObject(held) && isInteger(held.pid) && held.pid !== process.pid && processExists(held.pid);
    } catch {
        return false;
    }
};

/**
 * Takes the marker for this process.
 *
 * @returns release: removes the marker, only while it is still this process's
 */
const holdCliSessionLock = (): (() => void) => {
    const file = lockPath();
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
        encoding: 'utf8',
        mode: 0o600,
    });
    return () => {
        try {
            const held: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (isPlainObject(held) && held.pid === process.pid) fs.unlinkSync(file);
        } catch {
            // already gone, or replaced by another session's
        }
    };
};

export { LOCK_FILE_NAME, isCliSessionActive, holdCliSessionLock };
