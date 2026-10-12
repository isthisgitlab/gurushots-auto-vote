/**
 * The markers a running process holds in the user-data directory, each a file naming the process: a CLI session
 * (`start`, continuous voting) holds `cli-session.lock`, the desktop app holds `desktop-app.lock` for its lifetime. The
 * desktop app reads the CLI marker at startup so it does not clear a login the CLI session is using, and the
 * local-data wipe refuses to run under either (the CLI checks for a live app, the app for a live CLI session).
 *
 * A marker counts only while its process exists and the marker was refreshed lately: the holder rewrites it every
 * HEARTBEAT_MS, so one left by a crash or a reboot goes stale even when its process id has since been given to another
 * process. Node's timers do not count the time a machine is suspended, so the holder ticks every TICK_MS and compares
 * wall-clock time: after a sleep (or a clock set back) it writes the marker again within a tick of waking. An old
 * marker whose process exists is read again after SETTLE_MS (five ticks) before it is taken as inactive; one still old
 * and unchanged then is not counted. It is removed only when the same holder and mtime were also judged old more than
 * one HEARTBEAT_MS earlier by this process, so a holder that is merely slow is never deleted, and then only by moving
 * the file aside and checking what was moved (see removeLeftover).
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getUserDataPath } from './storage';
import { isPlainObject } from '../plainObject';
import { isInteger } from '../numbers';

const LOCK_FILE_NAME = 'cli-session.lock';
const APP_LOCK_FILE_NAME = 'desktop-app.lock';

// How often a running holder refreshes its marker, and how long a marker may go unrefreshed before it is stale
// (three beats: one late beat does not make a live session look gone). The holder checks the clock every TICK_MS and
// writes once a beat has passed, so a holder that slept through its beats writes again within a tick of waking. An old
// marker with a live process is read once more after SETTLE_MS, which a holder that just woke has used to write it.
// A marker whose mtime lies more than a tick ahead of the clock (the clock was set back) is old too.
const HEARTBEAT_MS = 30_000;
const STALE_AFTER_MS = 3 * HEARTBEAT_MS;
const TICK_MS = 2_000;
const SETTLE_MS = 5 * TICK_MS;

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

type MarkerState = 'fresh' | 'old' | 'none';

/** What was judged of a marker: its state, and (when another live process holds it) the holder and the mtime judged. */
type MarkerJudgement = { state: MarkerState; pid: number; mtimeMs: number };

const NO_MARKER: MarkerJudgement = { state: 'none', pid: 0, mtimeMs: 0 };

/**
 * Another process's marker: `fresh` when it is alive and was refreshed within STALE_AFTER_MS (and not more than a tick
 * ahead of the clock), `old` when it is alive but was not (a holder that slept or whose clock was set back, or a process
 * id reused after a crash or a reboot), `none` otherwise.
 */
const judgeMarker = (fileName: string): MarkerJudgement => {
    try {
        const file = markerPath(fileName);
        const pid = readHolder(file);
        if (pid === null || pid === process.pid || !processExists(pid)) return NO_MARKER;
        const mtimeMs = fs.statSync(file).mtimeMs;
        const sinceRefresh = Date.now() - mtimeMs;
        return { state: sinceRefresh > STALE_AFTER_MS || sinceRefresh < -TICK_MS ? 'old' : 'fresh', pid, mtimeMs };
    } catch {
        return NO_MARKER;
    }
};

/** What this process last judged old, by marker file: the holder and mtime, and when it first saw them so. */
const oldSince = new Map<string, { pid: number; mtimeMs: number; at: number }>();

/**
 * Removes a marker that was judged old, so the settle wait is not paid at every start. Reading a file and then
 * unlinking it is not atomic (another process may write a new marker in between), so the file is first moved to a name
 * of its own and the moved file is what is checked: it goes only while it still names the judged holder and has the
 * judged mtime. Any other file is put back with a hard link, which fails when a newer marker has appeared meanwhile
 * (the newer one stays). The marker is missing for the instant it is moved: a holder's beat writes it again, and a
 * reader in that instant sees no marker, as for any marker that is not there.
 */
const removeLeftover = (file: string, judged: MarkerJudgement) => {
    const aside = `${file}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
        fs.renameSync(file, aside);
    } catch {
        // already gone, or not movable: it is judged again next time
        return;
    }
    let judgedFile = false;
    try {
        judgedFile = readHolder(aside) === judged.pid && fs.statSync(aside).mtimeMs === judged.mtimeMs;
    } catch {
        // the moved file cannot be examined: it is not taken for the judged one
    }
    if (!judgedFile) {
        try {
            fs.linkSync(aside, file);
        } catch {
            // a newer marker has been written since (it stays), or the moved file is gone
        }
    }
    try {
        fs.unlinkSync(aside);
    } catch {
        // already gone
    }
};

/**
 * Notes that a marker was judged old, and answers whether the same holder and mtime were already judged old more than
 * one HEARTBEAT_MS ago (by an earlier check in this process), which is what lets it be removed.
 */
const oldLongEnough = (file: string, judged: MarkerJudgement): boolean => {
    const earlier = oldSince.get(file);
    if (earlier?.pid === judged.pid && earlier.mtimeMs === judged.mtimeMs) {
        return Date.now() - earlier.at > HEARTBEAT_MS;
    }
    oldSince.set(file, { pid: judged.pid, mtimeMs: judged.mtimeMs, at: Date.now() });
    return false;
};

/**
 * Whether another process holds the marker. An old marker with a live process is read again after SETTLE_MS: a holder
 * that was asleep has written it by then, so a marker that is fresh or whose mtime changed counts as held. One still
 * old and unchanged is not (its process id was reused); it is removed only if it was also judged old, with the same
 * holder and mtime, more than one HEARTBEAT_MS earlier (an earlier check in this process), so a first check never
 * deletes and the wait is paid until a later check does. A check that waits is bounded by SETTLE_MS.
 */
const isMarkerActive = async (fileName: string): Promise<boolean> => {
    const file = markerPath(fileName);
    const first = judgeMarker(fileName);
    if (first.state !== 'old') {
        oldSince.delete(file);
        return first.state === 'fresh';
    }
    await new Promise<void>((resolve) => {
        setTimeout(resolve, SETTLE_MS);
    });
    const second = judgeMarker(fileName);
    if (second.state !== 'old') {
        oldSince.delete(file);
        return second.state === 'fresh';
    }
    if (second.pid !== first.pid || second.mtimeMs !== first.mtimeMs) return true;
    if (oldLongEnough(file, second)) {
        oldSince.delete(file);
        removeLeftover(file, second);
    }
    return false;
};

const writeMarker = (file: string) => {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), {
        encoding: 'utf8',
        mode: 0o600,
    });
};

/** Writes the marker again when it is missing or unreadable; one another process has taken over is left alone. */
const beat = (file: string) => {
    try {
        const holder = readHolder(file);
        if (holder === null || holder === process.pid) writeMarker(file);
    } catch {
        // the directory is gone or not writable: the next beat tries again
    }
};

/**
 * Takes the marker for this process and keeps it fresh until released.
 *
 * @returns release: stops refreshing and removes the marker, only while it is still this process's
 */
const holdMarker = (fileName: string): (() => void) => {
    const file = markerPath(fileName);
    writeMarker(file);
    let lastBeat = Date.now();
    const heartbeat = setInterval(() => {
        const sinceBeat = Date.now() - lastBeat;
        // A clock set back (a negative delta) writes at once, so readers do not see a marker from the future for long.
        if (sinceBeat >= 0 && sinceBeat < HEARTBEAT_MS) return;
        lastBeat = Date.now();
        beat(file);
    }, TICK_MS);
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
const isCliSessionActive = (): Promise<boolean> => isMarkerActive(LOCK_FILE_NAME);

/** Takes the CLI session marker for this process (see holdMarker). */
const holdCliSessionLock = (): (() => void) => holdMarker(LOCK_FILE_NAME);

/** Whether another process (the desktop app) holds the desktop-app marker. */
const isDesktopAppActive = (): Promise<boolean> => isMarkerActive(APP_LOCK_FILE_NAME);

/** Takes the desktop-app marker for this process (see holdMarker). */
const holdDesktopAppLock = (): (() => void) => holdMarker(APP_LOCK_FILE_NAME);

/** Refreshes the desktop-app marker now (the machine just woke from sleep, which its timer did not count). */
const refreshDesktopAppLock = () => beat(markerPath(APP_LOCK_FILE_NAME));

export {
    LOCK_FILE_NAME,
    APP_LOCK_FILE_NAME,
    HEARTBEAT_MS,
    STALE_AFTER_MS,
    TICK_MS,
    SETTLE_MS,
    isCliSessionActive,
    holdCliSessionLock,
    isDesktopAppActive,
    holdDesktopAppLock,
    refreshDesktopAppLock,
};
