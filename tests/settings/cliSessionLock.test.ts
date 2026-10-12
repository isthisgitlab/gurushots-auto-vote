/**
 * The markers a running process holds (the CLI session's, the desktop app's): another process's live, fresh marker is
 * seen, a stale or unreadable one is not (a process id reused after a crash or a reboot does not make a dead
 * session live), the holder keeps its marker fresh, and release removes only its own.
 */

jest.mock('node:fs', () => {
    const actual = jest.requireActual<typeof import('node:fs')>('node:fs');
    return { __esModule: true, ...actual, default: actual };
});
jest.unmock('path');
jest.unmock('node:path');
jest.mock('../../src/ts/runtime', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/runtime')>('../../src/ts/runtime'),
}));

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as runtimeModule from '../../src/ts/runtime';
import type * as lockModule from '../../src/ts/settings/cliSessionLock';
import { isNumber, isShape, isString, parseJsonAs } from '../helpers/parseJson';

const runtime = require('../../src/ts/runtime') as typeof runtimeModule;
const {
    holdCliSessionLock,
    isCliSessionActive,
    holdDesktopAppLock,
    isDesktopAppActive,
    LOCK_FILE_NAME,
    APP_LOCK_FILE_NAME,
    HEARTBEAT_MS,
    STALE_AFTER_MS,
    TICK_MS,
    SETTLE_MS,
    refreshDesktopAppLock,
} = require('../../src/ts/settings/cliSessionLock') as typeof lockModule;

// Sets the age of a marker file: the time it was last refreshed.
const age = (file: string, ms: number) => {
    const when = new Date(Date.now() - ms);
    fs.utimesSync(file, when, when);
};

describe('cli session lock', () => {
    let root: string;
    let lockFile: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-lock-'));
        jest.spyOn(runtime, 'getAppUserDataPath').mockReturnValue(root);
        lockFile = path.join(root, LOCK_FILE_NAME);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('no marker: no session', async () => {
        await expect(isCliSessionActive()).resolves.toBe(false);
    });

    test('a marker of another live process is an active session', async () => {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
        await expect(isCliSessionActive()).resolves.toBe(true);
    });

    test('a process this account may not signal is still alive', async () => {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: 4242 }));
        jest.spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        });
        await expect(isCliSessionActive()).resolves.toBe(true);
    });

    test('a marker whose process is gone is stale', async () => {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 12345 }));
        await expect(isCliSessionActive()).resolves.toBe(false);
    });

    test('a process error that is not an EPERM counts as gone, as does one that is no Error', async () => {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: 4242 }));
        const kill = jest.spyOn(process, 'kill');
        kill.mockImplementationOnce(() => {
            throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
        });
        await expect(isCliSessionActive()).resolves.toBe(false);
        kill.mockImplementationOnce(() => {
            throw 'odd';
        });
        await expect(isCliSessionActive()).resolves.toBe(false);
    });

    test('this process\'s own marker is not "another" session', async () => {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));
        await expect(isCliSessionActive()).resolves.toBe(false);
    });

    test.each([
        ['unparseable', 'not json'],
        ['not an object', '[1]'],
        ['without a pid', '{"startedAt":"x"}'],
        ['a pid that is no integer', '{"pid":"12"}'],
    ])('a marker that is %s is no session', async (_name, text) => {
        fs.writeFileSync(lockFile, text);
        await expect(isCliSessionActive()).resolves.toBe(false);
    });

    test('holding writes the marker for this process; release removes it', () => {
        const release = holdCliSessionLock();

        const held = parseJsonAs(
            fs.readFileSync(lockFile, 'utf8'),
            isShape<{ pid: number; startedAt: string }>({ pid: isNumber, startedAt: isString }),
        );
        expect(held.pid).toBe(process.pid);
        expect(Number.isNaN(Date.parse(held.startedAt))).toBe(false);
        if (process.platform !== 'win32') expect(fs.statSync(lockFile).mode & 0o777).toBe(0o600);

        release();
        expect(fs.existsSync(lockFile)).toBe(false);
        // Releasing twice (the marker is gone) is harmless.
        expect(() => release()).not.toThrow();
    });

    test('release leaves a marker another session has taken over', () => {
        const release = holdCliSessionLock();
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));

        release();

        expect(fs.existsSync(lockFile)).toBe(true);
    });

    test('release leaves a marker it cannot read', () => {
        const release = holdCliSessionLock();
        fs.writeFileSync(lockFile, 'garbage');

        release();

        expect(fs.readFileSync(lockFile, 'utf8')).toBe('garbage');
    });

    describe('a marker that has not been refreshed lately', () => {
        // An old marker whose process exists is read again after SETTLE_MS before it is taken as stale.
        const settled = async (check: Promise<boolean>) => {
            await jest.advanceTimersByTimeAsync(SETTLE_MS);
            return check;
        };

        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('is stale when its process id is alive and nothing refreshes it (the id was reused after a crash or a reboot)', async () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, startedAt: '2020-01-01T00:00:00.000Z' }));

            age(lockFile, STALE_AFTER_MS - 5_000);
            await expect(isCliSessionActive()).resolves.toBe(true);

            age(lockFile, STALE_AFTER_MS + 5_000);
            await expect(settled(isCliSessionActive())).resolves.toBe(false);
        });

        test('a leftover (its process id was reused) is removed once judged, so the next check does not wait', async () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            age(lockFile, STALE_AFTER_MS + 5_000);

            await expect(settled(isCliSessionActive())).resolves.toBe(false);
            expect(fs.existsSync(lockFile)).toBe(false);

            expect(jest.getTimerCount()).toBe(0);
            await expect(isCliSessionActive()).resolves.toBe(false);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('a marker refreshed between the two reads is live and is not removed', async () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            age(lockFile, STALE_AFTER_MS + 5_000);

            const active = isCliSessionActive();
            await jest.advanceTimersByTimeAsync(SETTLE_MS - 1);
            age(lockFile, 0);

            await expect(settled(active)).resolves.toBe(true);
            expect(fs.existsSync(lockFile)).toBe(true);
        });

        test.each([
            ['another process took the marker over', 'holder'],
            ['the marker was refreshed', 'mtime'],
        ])('a marker that changes after it was judged old, as %s, is left alone', async (_name, change) => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            age(lockFile, STALE_AFTER_MS + 5_000);
            const realStat = fs.statSync;
            const realRead = fs.readFileSync;
            let reads = 0;
            // The read that decides the removal is the last of three reads of the marker (two judgements, then it).
            jest.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: never[]) => {
                reads += 1;
                if (reads === 3 && change === 'holder') return JSON.stringify({ pid: process.pid + 1 });
                return (realRead as (f: fs.PathOrFileDescriptor, ...r: never[]) => unknown)(file, ...rest);
            }) as typeof fs.readFileSync);
            let stats = 0;
            jest.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, ...rest: never[]) => {
                stats += 1;
                const stat = (realStat as (f: fs.PathLike, ...r: never[]) => fs.Stats)(file, ...rest);
                return stats === 3 && change === 'mtime' ? Object.assign(stat, { mtimeMs: stat.mtimeMs + 1 }) : stat;
            }) as typeof fs.statSync);

            await expect(settled(isCliSessionActive())).resolves.toBe(false);

            expect(fs.existsSync(lockFile)).toBe(true);
        });

        test('a leftover that cannot be removed is still no session', async () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            age(lockFile, STALE_AFTER_MS + 5_000);
            jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
                throw new Error('busy');
            });

            await expect(settled(isCliSessionActive())).resolves.toBe(false);
        });

        test('is live when its holder woke and writes it again within a tick', async () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            age(lockFile, STALE_AFTER_MS + 5_000);

            const active = isCliSessionActive();
            await jest.advanceTimersByTimeAsync(TICK_MS);
            const now = new Date();
            fs.utimesSync(lockFile, now, now);

            await expect(settled(active)).resolves.toBe(true);
        });

        test('waits no longer than a tick and a margin, and not at all for a fresh one', async () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            age(lockFile, STALE_AFTER_MS + 5_000);
            let answered = false;
            void isCliSessionActive().then(() => {
                answered = true;
            });

            await jest.advanceTimersByTimeAsync(SETTLE_MS - 1);
            expect(answered).toBe(false);
            await jest.advanceTimersByTimeAsync(1);
            expect(answered).toBe(true);
            expect(SETTLE_MS).toBeGreaterThan(TICK_MS);
            expect(SETTLE_MS).toBeLessThan(HEARTBEAT_MS);

            // The leftover went with the wait; a holder that is alive writes its marker again.
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            expect(jest.getTimerCount()).toBe(0);
            await expect(isCliSessionActive()).resolves.toBe(true);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('is stale at once when its process is gone, whatever its age', async () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 12345 }));
            age(lockFile, STALE_AFTER_MS + 5_000);

            await expect(isCliSessionActive()).resolves.toBe(false);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('is stale after a reboot: a marker a day old, whatever process now has its id', async () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            age(lockFile, 24 * 60 * 60 * 1000);
            await expect(settled(isCliSessionActive())).resolves.toBe(false);
        });

        test('is no session when the marker cannot be examined', async () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            jest.spyOn(fs, 'statSync').mockImplementationOnce(() => {
                throw new Error('gone');
            });
            await expect(isCliSessionActive()).resolves.toBe(false);
        });
    });

    describe('while held', () => {
        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        const mtime = () => fs.statSync(lockFile).mtimeMs;

        test('the marker is refreshed every beat, so a long session never goes stale', () => {
            const release = holdCliSessionLock();
            age(lockFile, STALE_AFTER_MS + 5_000);
            const stale = mtime();

            jest.advanceTimersByTime(HEARTBEAT_MS);

            expect(mtime()).toBeGreaterThan(stale);
            expect(
                parseJsonAs(fs.readFileSync(lockFile, 'utf8'), isShape<{ pid: number }>({ pid: isNumber })).pid,
            ).toBe(process.pid);
            release();
        });

        test('after a sleep the marker is written again within a tick of waking, not a beat', () => {
            const release = holdCliSessionLock();
            jest.advanceTimersByTime(HEARTBEAT_MS / 2);
            age(lockFile, STALE_AFTER_MS + 5_000);
            const stale = mtime();

            // The machine sleeps: the timers stood still but the clock moved on.
            jest.setSystemTime(Date.now() + 10 * HEARTBEAT_MS);
            jest.advanceTimersByTime(TICK_MS);

            expect(mtime()).toBeGreaterThan(stale);
            release();
        });

        test('between beats it only checks the clock: the marker is not rewritten every tick', () => {
            const release = holdCliSessionLock();
            const write = jest.spyOn(fs, 'writeFileSync');

            jest.advanceTimersByTime(HEARTBEAT_MS - TICK_MS);
            expect(write).not.toHaveBeenCalled();

            jest.advanceTimersByTime(TICK_MS);
            expect(write).toHaveBeenCalledTimes(1);
            release();
        });

        test('a marker removed meanwhile is written again', () => {
            const release = holdCliSessionLock();
            fs.rmSync(lockFile);

            jest.advanceTimersByTime(HEARTBEAT_MS);

            expect(fs.existsSync(lockFile)).toBe(true);
            release();
        });

        test('a marker another session has taken over is left alone', () => {
            const release = holdCliSessionLock();
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            age(lockFile, 1_000);
            const before = mtime();

            jest.advanceTimersByTime(HEARTBEAT_MS);

            expect(mtime()).toBe(before);
            expect(fs.readFileSync(lockFile, 'utf8')).toBe(JSON.stringify({ pid: process.ppid }));
            release();
        });

        test('a beat that cannot write is survived, and the next one tries again', () => {
            const release = holdCliSessionLock();
            const write = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
                throw new Error('disk full');
            });
            fs.rmSync(lockFile);

            expect(() => jest.advanceTimersByTime(HEARTBEAT_MS)).not.toThrow();
            expect(fs.existsSync(lockFile)).toBe(false);

            write.mockRestore();
            jest.advanceTimersByTime(HEARTBEAT_MS);
            expect(fs.existsSync(lockFile)).toBe(true);
            release();
        });

        test('release stops the beat: nothing writes the marker again', () => {
            const release = holdCliSessionLock();
            release();

            jest.advanceTimersByTime(HEARTBEAT_MS * 3);

            expect(fs.existsSync(lockFile)).toBe(false);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('release survives a marker that cannot be removed', () => {
            const release = holdCliSessionLock();
            jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
                throw new Error('busy');
            });

            expect(() => release()).not.toThrow();
        });

        test('the beat does not keep the process alive', () => {
            const unref = jest.fn();
            const realSetInterval = global.setInterval;
            jest.spyOn(global, 'setInterval').mockImplementation(((...args: Parameters<typeof setInterval>) => {
                const timer = realSetInterval(...args);
                timer.unref = () => {
                    unref();
                    return timer;
                };
                return timer;
            }) as typeof setInterval);

            const release = holdCliSessionLock();

            expect(unref).toHaveBeenCalledTimes(1);
            release();
        });
    });

    describe('the desktop-app marker', () => {
        let appLockFile: string;

        beforeEach(() => {
            appLockFile = path.join(root, APP_LOCK_FILE_NAME);
        });

        test('is a file of its own, separate from the CLI session marker', async () => {
            fs.writeFileSync(appLockFile, JSON.stringify({ pid: process.ppid }));

            await expect(isDesktopAppActive()).resolves.toBe(true);
            await expect(isCliSessionActive()).resolves.toBe(false);
        });

        test("is stale when it was not refreshed lately, or its process is gone, or it is this process's own", async () => {
            jest.useFakeTimers();
            try {
                fs.writeFileSync(appLockFile, JSON.stringify({ pid: process.ppid }));
                age(appLockFile, STALE_AFTER_MS + 5_000);
                const old = isDesktopAppActive();
                await jest.advanceTimersByTimeAsync(SETTLE_MS);
                await expect(old).resolves.toBe(false);
            } finally {
                jest.useRealTimers();
            }

            fs.writeFileSync(appLockFile, JSON.stringify({ pid: 2 ** 22 + 12345 }));
            await expect(isDesktopAppActive()).resolves.toBe(false);

            fs.writeFileSync(appLockFile, JSON.stringify({ pid: process.pid }));
            await expect(isDesktopAppActive()).resolves.toBe(false);
        });

        test('refreshing writes it again now, without waiting for the beat', () => {
            const release = holdDesktopAppLock();
            age(appLockFile, STALE_AFTER_MS + 5_000);
            const stale = fs.statSync(appLockFile).mtimeMs;

            refreshDesktopAppLock();

            expect(fs.statSync(appLockFile).mtimeMs).toBeGreaterThan(stale);
            release();
        });

        test('refreshing leaves a marker another process holds alone, and survives a directory that is gone', () => {
            fs.writeFileSync(appLockFile, JSON.stringify({ pid: process.ppid }));
            age(appLockFile, 1_000);
            const before = fs.statSync(appLockFile).mtimeMs;

            refreshDesktopAppLock();
            expect(fs.statSync(appLockFile).mtimeMs).toBe(before);

            fs.rmSync(root, { recursive: true, force: true });
            expect(() => refreshDesktopAppLock()).not.toThrow();
        });

        test('holding writes it for this process; release removes it', () => {
            const release = holdDesktopAppLock();

            expect(fs.existsSync(appLockFile)).toBe(true);
            expect(fs.existsSync(lockFile)).toBe(false);

            release();
            expect(fs.existsSync(appLockFile)).toBe(false);
        });
    });
});
