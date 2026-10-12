/**
 * The markers a running process holds in the user-data directory, each a file naming the process: a CLI session
 * (`start`, continuous voting) holds `cli-session.lock`, the desktop app holds `desktop-app.lock` for its lifetime. The
 * desktop app reads the CLI marker at startup so it does not clear a login the CLI session is using, and the
 * local-data wipe refuses to run under either (the CLI checks for a live app, the app for a live CLI session).
 *
 * A marker counts only while its process exists and the marker was refreshed lately: the holder rewrites it every
 * HEARTBEAT_MS, so one left by a crash or a reboot goes stale even when its process id has since been given to another
 * process.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getUserDataPath } from './storage';
import { isPlainObject } from '../plainObject';
import { isInteger } from '../numbers';

const LOCK_FILE_NAME = 'cli-session.lock';
const APP_LOCK_FILE_NAME = 'desktop-app.lock';

// How often a running holder refreshes its marker, and how long a marker may go unrefreshed before it is stale
// (three beats: one late beat, such as the machine waking from sleep, does not make a live session look gone).
const HEARTBEAT_MS = 30_000;
const STALE_AFTER_MS = 3 * HEARTBEAT_MS;

const markerPath = (fileName: string) => path.join(getUserDataPath(), fileName);

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
 * The process id a marker file names; null when it is missing or not a marker.
 */
const readHolder = (file: string): number | null => {
    try {
        const held: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
        return isPlainObject(held) && isInteger(held.pid) ? held.pid : null;
    } catch {
        return null;
    }
};

/**
 * Whether another process holds the marker: it is alive, and the marker was refreshed within STALE_AFTER_MS.
 */
const isMarkerActive = (fileName: string): boolean => {
    try {
        const file = markerPath(fileName);
        const pid = readHolder(file);
        if (pid === null || pid === process.pid) return false;
        if (Date.now() - fs.statSync(file).mtimeMs > STALE_AFTER_MS) return false;
        return processExists(pid);
    } catch {
        return false;
    }
};

const writeMarker = (file: string) => {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
        encoding: 'utf8',
        mode: 0o600,
    });
};

/**
 * Takes the marker for this process and keeps it fresh until released.
 *
 * @returns release: stops refreshing and removes the marker, only while it is still this process's
 */
const holdMarker = (fileName: string): (() => void) => {
    const file = markerPath(fileName);
    writeMarker(file);
    const heartbeat = setInterval(() => {
        try {
            // A missing or unreadable marker is written again; one another process has taken over is left alone.
            const holder = readHolder(file);
            if (holder === null || holder === process.pid) writeMarker(file);
        } catch {
            // the directory is gone or not writable: the next beat tries again
        }
    }, HEARTBEAT_MS);
    // A held marker never keeps the process alive.
    heartbeat.unref();
    return () => {
        clearInterval(heartbeat);
        try {
            if (readHolder(file) === process.pid) fs.unlinkSync(file);
        } catch {
            // already gone
        }
    };
};

/** Whether another process holds the CLI session marker. */
const isCliSessionActive = (): boolean => isMarkerActive(LOCK_FILE_NAME);

/** Takes the CLI session marker for this process (see holdMarker). */
const holdCliSessionLock = (): (() => void) => holdMarker(LOCK_FILE_NAME);

/** Whether another process (the desktop app) holds the desktop-app marker. */
const isDesktopAppActive = (): boolean => isMarkerActive(APP_LOCK_FILE_NAME);

/** Takes the desktop-app marker for this process (see holdMarker). */
const holdDesktopAppLock = (): (() => void) => holdMarker(APP_LOCK_FILE_NAME);

export {
    LOCK_FILE_NAME,
    APP_LOCK_FILE_NAME,
    HEARTBEAT_MS,
    STALE_AFTER_MS,
    isCliSessionActive,
    holdCliSessionLock,
    isDesktopAppActive,
    holdDesktopAppLock,
};
