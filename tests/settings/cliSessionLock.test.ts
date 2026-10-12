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

    test('no marker: no session', () => {
        expect(isCliSessionActive()).toBe(false);
    });

    test('a marker of another live process is an active session', () => {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
        expect(isCliSessionActive()).toBe(true);
    });

    test('a process this account may not signal is still alive', () => {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: 4242 }));
        jest.spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        });
        expect(isCliSessionActive()).toBe(true);
    });

    test('a marker whose process is gone is stale', () => {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 12345 }));
        expect(isCliSessionActive()).toBe(false);
    });

    test('a process error that is not an EPERM counts as gone, as does one that is no Error', () => {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: 4242 }));
        const kill = jest.spyOn(process, 'kill');
        kill.mockImplementationOnce(() => {
            throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
        });
        expect(isCliSessionActive()).toBe(false);
        kill.mockImplementationOnce(() => {
            throw 'odd';
        });
        expect(isCliSessionActive()).toBe(false);
    });

    test('this process\'s own marker is not "another" session', () => {
        fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid }));
        expect(isCliSessionActive()).toBe(false);
    });

    test.each([
        ['unparseable', 'not json'],
        ['not an object', '[1]'],
        ['without a pid', '{"startedAt":"x"}'],
        ['a pid that is no integer', '{"pid":"12"}'],
    ])('a marker that is %s is no session', (_name, text) => {
        fs.writeFileSync(lockFile, text);
        expect(isCliSessionActive()).toBe(false);
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
        test('is stale even when its process id is alive (the id was reused after a crash or a reboot)', () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid, startedAt: '2020-01-01T00:00:00.000Z' }));

            age(lockFile, STALE_AFTER_MS - 5_000);
            expect(isCliSessionActive()).toBe(true);

            age(lockFile, STALE_AFTER_MS + 5_000);
            expect(isCliSessionActive()).toBe(false);
        });

        test('is stale after a reboot: a marker a day old, whatever process now has its id', () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            age(lockFile, 24 * 60 * 60 * 1000);
            expect(isCliSessionActive()).toBe(false);
        });

        test('is no session when the marker cannot be examined', () => {
            fs.writeFileSync(lockFile, JSON.stringify({ pid: process.ppid }));
            jest.spyOn(fs, 'statSync').mockImplementationOnce(() => {
                throw new Error('gone');
            });
            expect(isCliSessionActive()).toBe(false);
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

        test('is a file of its own, separate from the CLI session marker', () => {
            fs.writeFileSync(appLockFile, JSON.stringify({ pid: process.ppid }));

            expect(isDesktopAppActive()).toBe(true);
            expect(isCliSessionActive()).toBe(false);
        });

        test("is stale when it was not refreshed lately, or its process is gone, or it is this process's own", () => {
            fs.writeFileSync(appLockFile, JSON.stringify({ pid: process.ppid }));
            age(appLockFile, STALE_AFTER_MS + 5_000);
            expect(isDesktopAppActive()).toBe(false);

            fs.writeFileSync(appLockFile, JSON.stringify({ pid: 2 ** 22 + 12345 }));
            expect(isDesktopAppActive()).toBe(false);

            fs.writeFileSync(appLockFile, JSON.stringify({ pid: process.pid }));
            expect(isDesktopAppActive()).toBe(false);
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
