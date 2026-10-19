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
    holdWebServerLock,
    isWebServerActive,
    holdDesktopAppLock,
    isDesktopAppActive,
    CLI_SESSION_PREFIX,
    WEB_SERVER_PREFIX,
    processMarkerName,
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
        // This process's own CLI marker; what is written into it names whichever process a test wants it to.
        lockFile = path.join(root, processMarkerName(CLI_SESSION_PREFIX));
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
        // An old marker whose process exists is read again after SETTLE_MS before it is taken as inactive.
        const settled = async (check: Promise<boolean>) => {
            await jest.advanceTimersByTimeAsync(SETTLE_MS);
            return check;
        };
        const writeOld = (pid = process.ppid) => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid }));
            age(lockFile, STALE_AFTER_MS + 5_000);
        };

        beforeEach(() => {
            jest.useFakeTimers();
        });

        afterEach(() => {
            jest.useRealTimers();
        });

        test('is inactive when its process id is alive and nothing refreshes it (the id was reused after a crash or a reboot)', async () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, startedAt: '2020-01-01T00:00:00.000Z' }));

            age(lockFile, STALE_AFTER_MS - 5_000);
            await expect(isCliSessionActive()).resolves.toBe(true);

            age(lockFile, STALE_AFTER_MS + 5_000);
            await expect(settled(isCliSessionActive())).resolves.toBe(false);
        });

        test('an old marker that stays unchanged is reported inactive and is left in place', async () => {
            writeOld();

            await expect(settled(isCliSessionActive())).resolves.toBe(false);

            // The marker stays, so the next check pays the same wait again.
            let second: boolean | undefined;
            void isCliSessionActive().then((active) => {
                second = active;
            });
            await jest.advanceTimersByTimeAsync(SETTLE_MS - 1);
            expect(second).toBeUndefined();
            await jest.advanceTimersByTimeAsync(1);
            expect(second).toBe(false);

            expect(fs.existsSync(lockFile)).toBe(true);
        });

        test('a marker refreshed between the two reads is live and is not removed', async () => {
            writeOld();

            const active = isCliSessionActive();
            await jest.advanceTimersByTimeAsync(SETTLE_MS - 1);
            age(lockFile, 0);

            await expect(settled(active)).resolves.toBe(true);
            expect(fs.existsSync(lockFile)).toBe(true);
        });

        test('a marker whose mtime changed between the two reads counts as held even when it is still old', async () => {
            writeOld();

            const active = isCliSessionActive();
            await jest.advanceTimersByTimeAsync(SETTLE_MS - 1);
            age(lockFile, STALE_AFTER_MS + 20_000);

            await expect(settled(active)).resolves.toBe(true);
            expect(fs.existsSync(lockFile)).toBe(true);
        });

        test('a marker another live process took over between the two reads counts as held', async () => {
            jest.spyOn(process, 'kill').mockReturnValue(true);
            writeOld(4242);

            const active = isCliSessionActive();
            await jest.advanceTimersByTimeAsync(SETTLE_MS - 1);
            fs.writeFileSync(lockFile, JSON.stringify({ pid: 4343 }));
            age(lockFile, STALE_AFTER_MS + 5_000);

            await expect(settled(active)).resolves.toBe(true);
            expect(fs.existsSync(lockFile)).toBe(true);
        });

        test('is live when its holder woke and writes it again within a tick', async () => {
            writeOld();

            const active = isCliSessionActive();
            await jest.advanceTimersByTimeAsync(TICK_MS);
            const now = new Date();
            fs.utimesSync(lockFile, now, now);

            await expect(settled(active)).resolves.toBe(true);
        });

        test('waits no longer than five ticks, and not at all for a fresh one', async () => {
            writeOld();
            let answered = false;
            void isCliSessionActive().then(() => {
                answered = true;
            });

            await jest.advanceTimersByTimeAsync(SETTLE_MS - 1);
            expect(answered).toBe(false);
            await jest.advanceTimersByTimeAsync(1);
            expect(answered).toBe(true);
            expect(SETTLE_MS).toBe(5 * TICK_MS);
            expect(SETTLE_MS).toBeLessThan(HEARTBEAT_MS);

            // A holder that is alive writes its marker again; a fresh one is answered without a timer.
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            expect(jest.getTimerCount()).toBe(0);
            await expect(isCliSessionActive()).resolves.toBe(true);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('is inactive at once when its process is gone, whatever its age', async () => {
            writeOld(2 ** 22 + 12345);

            await expect(isCliSessionActive()).resolves.toBe(false);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('is inactive after a reboot: a marker a day old, whatever process now has its id', async () => {
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

        describe("a marker from the future (the holder's clock was set back)", () => {
            test('within a tick of now is fresh', async () => {
                fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
                age(lockFile, -(TICK_MS - 500));

                await expect(isCliSessionActive()).resolves.toBe(true);
                expect(jest.getTimerCount()).toBe(0);
            });

            test('more than a tick ahead is old: it is read again after the settle wait', async () => {
                fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
                age(lockFile, -(TICK_MS + 5_000));
                let answered = false;
                const check = isCliSessionActive().then((active) => {
                    answered = true;
                    return active;
                });
                await jest.advanceTimersByTimeAsync(SETTLE_MS - 1);
                expect(answered).toBe(false);

                // The holder saw the clock go back and wrote the marker at once.
                age(lockFile, 0);
                await jest.advanceTimersByTimeAsync(1);

                await expect(check).resolves.toBe(true);
            });

            test('still ahead after the wait is not counted', async () => {
                fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
                age(lockFile, -(SETTLE_MS + TICK_MS + 5_000));

                await expect(settled(isCliSessionActive())).resolves.toBe(false);
            });
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

        test('after the clock is set back the marker is written at once, not after the next beat', () => {
            const release = holdCliSessionLock();
            const write = jest.spyOn(fs, 'writeFileSync');
            jest.advanceTimersByTime(HEARTBEAT_MS / 2);
            expect(write).not.toHaveBeenCalled();

            jest.setSystemTime(Date.now() - 10 * HEARTBEAT_MS);
            jest.advanceTimersByTime(TICK_MS);
            expect(write).toHaveBeenCalledTimes(1);

            // The beat counts from the new time: the next write is a beat later, not every tick.
            jest.advanceTimersByTime(HEARTBEAT_MS - TICK_MS);
            expect(write).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(TICK_MS);
            expect(write).toHaveBeenCalledTimes(2);
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

    describe('several holders', () => {
        const other = (prefix: string, pid: number) => path.join(root, `${prefix}-${pid}.lock`);

        test('each process has a file of its own: two holders are both seen, and one leaving leaves the other', async () => {
            const release = holdCliSessionLock();
            expect(path.basename(lockFile)).toBe(`cli-session-${process.pid}.lock`);
            fs.writeFileSync(other(CLI_SESSION_PREFIX, process.ppid), JSON.stringify({ pid: process.ppid }));
            await expect(isCliSessionActive()).resolves.toBe(true);

            // This process is done: the other one's marker is untouched and still counts.
            release();
            expect(fs.existsSync(lockFile)).toBe(false);
            expect(fs.existsSync(other(CLI_SESSION_PREFIX, process.ppid))).toBe(true);
            await expect(isCliSessionActive()).resolves.toBe(true);

            // The other one is gone too.
            fs.rmSync(other(CLI_SESSION_PREFIX, process.ppid));
            await expect(isCliSessionActive()).resolves.toBe(false);
        });

        test('a live holder among dead ones is enough, and the check reads them together', async () => {
            jest.useFakeTimers();
            try {
                fs.writeFileSync(other(CLI_SESSION_PREFIX, 2 ** 22 + 1), JSON.stringify({ pid: 2 ** 22 + 1 }));
                fs.writeFileSync(other(CLI_SESSION_PREFIX, process.ppid), JSON.stringify({ pid: process.ppid }));
                fs.writeFileSync(other(CLI_SESSION_PREFIX, 4242), JSON.stringify({ pid: process.ppid }));
                age(other(CLI_SESSION_PREFIX, 4242), STALE_AFTER_MS + 5_000);
                const mixed = isCliSessionActive();
                await jest.advanceTimersByTimeAsync(SETTLE_MS);
                await expect(mixed).resolves.toBe(true);

                // Two old markers cost one wait, not two.
                fs.rmSync(other(CLI_SESSION_PREFIX, process.ppid));
                fs.writeFileSync(other(CLI_SESSION_PREFIX, 4343), JSON.stringify({ pid: process.ppid }));
                age(other(CLI_SESSION_PREFIX, 4343), STALE_AFTER_MS + 5_000);
                const old = isCliSessionActive();
                await jest.advanceTimersByTimeAsync(SETTLE_MS);
                await expect(old).resolves.toBe(false);
            } finally {
                jest.useRealTimers();
            }
        });

        test('the CLI, web-server and desktop-app markers are separate kinds', async () => {
            fs.writeFileSync(other(WEB_SERVER_PREFIX, process.ppid), JSON.stringify({ pid: process.ppid }));
            // Files that are not markers of a kind, whatever they name.
            fs.writeFileSync(path.join(root, 'cli-session-x.lock'), JSON.stringify({ pid: process.ppid }));
            fs.writeFileSync(path.join(root, 'web-server.lock'), JSON.stringify({ pid: process.ppid }));

            await expect(isWebServerActive()).resolves.toBe(true);
            await expect(isCliSessionActive()).resolves.toBe(false);
            await expect(isDesktopAppActive()).resolves.toBe(false);
        });

        test('a CLI marker named just cli-session.lock counts as a live CLI session, by the same heartbeat rule', async () => {
            jest.useFakeTimers();
            try {
                const shared = path.join(root, 'cli-session.lock');
                fs.writeFileSync(shared, JSON.stringify({ pid: process.ppid }));
                await expect(isCliSessionActive()).resolves.toBe(true);
                await expect(isWebServerActive()).resolves.toBe(false);

                age(shared, STALE_AFTER_MS + 5_000);
                const old = isCliSessionActive();
                await jest.advanceTimersByTimeAsync(SETTLE_MS);
                await expect(old).resolves.toBe(false);

                fs.writeFileSync(shared, JSON.stringify({ pid: 2 ** 22 + 3 }));
                await expect(isCliSessionActive()).resolves.toBe(false);
            } finally {
                jest.useRealTimers();
            }
        });

        test('there are no holders when the user-data directory is gone', async () => {
            fs.rmSync(root, { recursive: true, force: true });

            await expect(isCliSessionActive()).resolves.toBe(false);
            await expect(isWebServerActive()).resolves.toBe(false);
        });

        test('a holder removes the markers of its kind whose process is gone, and no others', () => {
            const dead = other(CLI_SESSION_PREFIX, 2 ** 22 + 1);
            const alive = other(CLI_SESSION_PREFIX, process.ppid);
            const deadWeb = other(WEB_SERVER_PREFIX, 2 ** 22 + 2);
            const unreadable = other(CLI_SESSION_PREFIX, 77);
            fs.writeFileSync(dead, JSON.stringify({ pid: 2 ** 22 + 1 }));
            fs.writeFileSync(alive, JSON.stringify({ pid: process.ppid }));
            fs.writeFileSync(deadWeb, JSON.stringify({ pid: 2 ** 22 + 2 }));
            fs.writeFileSync(unreadable, 'garbage');

            const release = holdCliSessionLock();

            expect(fs.existsSync(dead)).toBe(false);
            expect(fs.existsSync(alive)).toBe(true);
            expect(fs.existsSync(deadWeb)).toBe(true);
            expect(fs.existsSync(unreadable)).toBe(true);
            release();
        });

        test('a leftover that cannot be removed does not stop the holder', () => {
            fs.writeFileSync(other(CLI_SESSION_PREFIX, 2 ** 22 + 1), JSON.stringify({ pid: 2 ** 22 + 1 }));
            jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
                throw new Error('busy');
            });

            expect(() => holdCliSessionLock()()).not.toThrow();
        });

        test('the web server holds a marker of its own while it runs', async () => {
            const release = holdWebServerLock();
            const file = path.join(root, `web-server-${process.pid}.lock`);

            expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(expect.objectContaining({ pid: process.pid }));
            fs.writeFileSync(file, JSON.stringify({ pid: process.ppid }));
            await expect(isWebServerActive()).resolves.toBe(true);
            fs.writeFileSync(file, JSON.stringify({ pid: process.pid }));
            release();
            expect(fs.existsSync(file)).toBe(false);
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
