/**
 * The marker a CLI session holds while it runs: another process's live marker is
 * seen, a stale or unreadable one is not, and release removes only its own.
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

const runtime = require('../../src/ts/runtime') as typeof runtimeModule;
const { holdCliSessionLock, isCliSessionActive, LOCK_FILE_NAME } =
    require('../../src/ts/settings/cliSessionLock') as typeof lockModule;

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

        const held = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number; startedAt: string };
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
});
