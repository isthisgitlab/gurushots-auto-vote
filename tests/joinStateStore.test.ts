/**
 * joinStateStore.ts — the persisted paid-join markers plus the cross-process
 * unlock lock. The lock must: block a genuinely-held lock, reap a stale one,
 * and fail OPEN on any other lock-infra error (never deadlock a join).
 */

jest.mock('path', () => jest.requireActual<typeof import('path')>('path'));

// A small in-memory file system, faithful where the lock depends on it: exclusive creation fails with EEXIST,
// rename and link are atomic and fail the way the real ones do, and a file carries its modification time.
type MockFile = { content: string; mtimeMs: number };
const mockFiles = new Map<string, MockFile>();
const mockFds = new Map<number, string>();
let mockNextFd = 10;
const mockFsError = (code: string) => Object.assign(new Error(code), { code });
jest.mock('fs', () => ({
    openSync: jest.fn((file: string, flag: string) => {
        if (flag === 'wx' && mockFiles.has(file)) throw mockFsError('EEXIST');
        mockFiles.set(file, { content: '', mtimeMs: Date.now() });
        mockNextFd += 1;
        mockFds.set(mockNextFd, file);
        return mockNextFd;
    }),
    writeSync: jest.fn((fd: number, data: string) => {
        const file = mockFiles.get(mockFds.get(fd) ?? '');
        if (file) file.content += data;
    }),
    closeSync: jest.fn(),
    statSync: jest.fn((file: string) => {
        const found = mockFiles.get(file);
        if (!found) throw mockFsError('ENOENT');
        return { mtimeMs: found.mtimeMs };
    }),
    readFileSync: jest.fn((file: string) => {
        const found = mockFiles.get(file);
        if (!found) throw mockFsError('ENOENT');
        return found.content;
    }),
    renameSync: jest.fn((from: string, to: string) => {
        const found = mockFiles.get(from);
        if (!found) throw mockFsError('ENOENT');
        mockFiles.delete(from);
        mockFiles.set(to, found);
    }),
    linkSync: jest.fn((from: string, to: string) => {
        const found = mockFiles.get(from);
        if (!found) throw mockFsError('ENOENT');
        if (mockFiles.has(to)) throw mockFsError('EEXIST');
        mockFiles.set(to, { ...found });
    }),
    unlinkSync: jest.fn((file: string) => {
        if (!mockFiles.delete(file)) throw mockFsError('ENOENT');
    }),
    utimesSync: jest.fn((file: string, _atime: Date, mtime: Date) => {
        const found = mockFiles.get(file);
        if (!found) throw mockFsError('ENOENT');
        found.mtimeMs = mtime.getTime();
    }),
}));

jest.mock('../src/ts/runtime', () => ({
    isCapacitor: jest.fn(() => false),
    isHeadlessService: jest.fn(() => false),
}));

const mockStore = { initializeAsync: jest.fn(), flushPendingWrites: jest.fn() };
jest.mock('../src/ts/settings/storage', () => ({
    createJsonStore: jest.fn(() => mockStore),
    getSettingsPath: jest.fn(() => '/cfg/settings.json'),
}));

import fsModule = require('node:fs');
const fs = jest.mocked(fsModule);
import runtimeModule = require('../src/ts/runtime');
const runtime = jest.mocked(runtimeModule);
import logger = require('../src/ts/logger');
import storageModule = require('../src/ts/settings/storage');
const storage = jest.mocked(storageModule);
import joinState = require('../src/ts/joinStateStore');
import { invalid } from './helpers/invalid';

// Captured at require time: tests/setup.ts clears every mock before each test.
const createJsonStoreCalls = [...storage.createJsonStore.mock.calls];

describe('store wiring', () => {
    test('uses the platform-aware JSON store and re-exports its hydrate/flush hooks', () => {
        expect(createJsonStoreCalls).toEqual([[{ fileName: 'joinState.json', prefKey: 'gs_join_state' }]]);
        expect(joinState.joinStateStore).toBe(mockStore);
        expect(joinState.initializeJoinStateAsync).toBe(mockStore.initializeAsync);
        expect(joinState.flushJoinStateWrites).toBe(mockStore.flushPendingWrites);
    });
});

const LOCK = '/cfg/joinlock-c1.lock';
const lockFile = (file = LOCK) => mockFiles.get(file);
const plant = (content: string, ageMs: number, file = LOCK) =>
    mockFiles.set(file, { content, mtimeMs: Date.now() - ageMs });

describe('acquireUnlockLock', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        mockFiles.clear();
        mockFds.clear();
        runtime.isCapacitor.mockReturnValue(false);
        runtime.isHeadlessService.mockReturnValue(false);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test.each<[string, 'isCapacitor' | 'isHeadlessService']>([
        ['Capacitor', 'isCapacitor'],
        ['headless service', 'isHeadlessService'],
    ])('is a no-op on %s (single-process surfaces)', (_label, fn) => {
        runtime[fn].mockReturnValue(true);
        const lock = joinState.acquireUnlockLock('c1');
        expect(lock.ok).toBe(true);
        expect(() => lock.release()).not.toThrow();
        expect(fs.openSync).not.toHaveBeenCalled();
    });

    test('creates an exclusive lockfile next to settings with a sanitized id, holding a random owner token', () => {
        const lock = joinState.acquireUnlockLock('a/b..c');
        expect(lock.ok).toBe(true);
        expect(fs.openSync).toHaveBeenCalledWith('/cfg/joinlock-a_b__c.lock', 'wx');
        expect(lockFile('/cfg/joinlock-a_b__c.lock')?.content).toMatch(new RegExp(`^${process.pid}-[0-9a-f]{16}$`));
        expect(fs.closeSync).toHaveBeenCalled();
        lock.release();
        expect(lockFile('/cfg/joinlock-a_b__c.lock')).toBeUndefined();
    });

    test('two holders never share a token', () => {
        const first = joinState.acquireUnlockLock('c1');
        const tokenOne = lockFile()?.content;
        first.release();
        const second = joinState.acquireUnlockLock('c1');
        expect(lockFile()?.content).not.toBe(tokenOne);
        second.release();
    });

    test('a lock held by someone is busy, and a busy lock releases nothing', () => {
        const held = joinState.acquireUnlockLock('c1');
        const other = joinState.acquireUnlockLock('c1');
        expect(other.ok).toBe(false);
        other.release();
        expect(lockFile()).toBeDefined();
        held.release();
        expect(lockFile()).toBeUndefined();
    });

    test('release removes only a lock that still holds its own token: one taken over is left to its new owner', () => {
        const lock = joinState.acquireUnlockLock('c1');
        mockFiles.set(LOCK, { content: 'another-process-token', mtimeMs: Date.now() });
        lock.release();
        expect(lockFile()?.content).toBe('another-process-token');
        expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    test('release swallows a lockfile that went away between the check and the removal', () => {
        const lock = joinState.acquireUnlockLock(5);
        fs.unlinkSync.mockImplementationOnce(() => {
            throw mockFsError('ENOENT');
        });
        expect(() => lock.release()).not.toThrow();
    });

    test('releasing stops the renewal', () => {
        const lock = joinState.acquireUnlockLock('c1');
        lock.release();
        jest.advanceTimersByTime(10 * 60_000);
        expect(fs.utimesSync).not.toHaveBeenCalled();
    });

    test('closes the fd even when writing the token fails, and then fails open', () => {
        fs.writeSync.mockImplementationOnce(() => {
            throw new Error('EIO');
        });
        const lock = joinState.acquireUnlockLock('c1');
        expect(fs.closeSync).toHaveBeenCalled();
        expect(lock.ok).toBe(true);
    });

    test('takes over a stale lock: the owner stopped touching it for longer than the TTL', () => {
        plant('crashed-owner', 61_000);
        const lock = joinState.acquireUnlockLock('c1');
        expect(lock.ok).toBe(true);
        expect(lockFile()?.content).not.toBe('crashed-owner');
        // The stale file was renamed away, to a name no other taker shares, and dropped, not left behind.
        expect(fs.renameSync).toHaveBeenCalledWith(
            LOCK,
            expect.stringMatching(/^\/cfg\/joinlock-c1\.lock\.stale-\d+-[0-9a-f]{16}$/),
        );
        expect([...mockFiles.keys()]).toEqual([LOCK]);
        lock.release();
    });

    test('a fresh lock is left alone', () => {
        plant('live-owner', 5_000);
        expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
        expect(lockFile()?.content).toBe('live-owner');
    });

    test('a held lock is kept fresh, so a join that outlasts the TTL is not taken over', () => {
        const lock = joinState.acquireUnlockLock('c1');
        // Five minutes of a retried submit: far past the TTL, in renewal steps.
        jest.advanceTimersByTime(5 * 60_000);
        expect(fs.utimesSync).toHaveBeenCalled();
        expect(Date.now() - (lockFile()?.mtimeMs ?? 0)).toBeLessThan(60_000);
        expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
        expect(lockFile()).toBeDefined();
        lock.release();
        expect(joinState.acquireUnlockLock('c1').ok).toBe(true);
    });

    test('renewal stops when the lock was lost to another owner, and when the file cannot be touched', () => {
        const lost = joinState.acquireUnlockLock('c1');
        mockFiles.set(LOCK, { content: 'another-process-token', mtimeMs: Date.now() });
        jest.advanceTimersByTime(2 * 60_000);
        expect(fs.utimesSync).not.toHaveBeenCalled();
        lost.release();

        mockFiles.clear();
        const unwritable = joinState.acquireUnlockLock('c1');
        fs.utimesSync.mockImplementationOnce(() => {
            throw mockFsError('EPERM');
        });
        jest.advanceTimersByTime(30_000);
        expect(fs.utimesSync).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(2 * 60_000);
        expect(fs.utimesSync).toHaveBeenCalledTimes(1);
        unwritable.release();
    });

    test('a stale lock another process removes first is simply free', () => {
        plant('crashed-owner', 61_000);
        fs.statSync.mockImplementationOnce(() => {
            mockFiles.delete(LOCK);
            throw mockFsError('ENOENT');
        });
        expect(joinState.acquireUnlockLock('c1').ok).toBe(true);
    });

    describe('the takeover is atomic: of two processes finding the same stale lock only one gets it', () => {
        test('the other renamed it first and created its own lock: busy, and that lock is untouched', () => {
            plant('crashed-owner', 61_000);
            fs.renameSync.mockImplementationOnce(() => {
                // The rival got there first: it moved the stale file away and made its own lock.
                mockFiles.delete(LOCK);
                mockFiles.set(LOCK, { content: 'rival-token', mtimeMs: Date.now() });
                throw mockFsError('ENOENT');
            });
            expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
            expect(lockFile()?.content).toBe('rival-token');
        });

        test('the rival renamed it away and has not created a lock yet: free, and this one takes it', () => {
            plant('crashed-owner', 61_000);
            fs.renameSync.mockImplementationOnce(() => {
                mockFiles.delete(LOCK);
                throw mockFsError('ENOENT');
            });
            const lock = joinState.acquireUnlockLock('c1');
            expect(lock.ok).toBe(true);
            lock.release();
        });

        test('what was renamed is a live lock that replaced the stale one meanwhile: put back, and busy', () => {
            plant('crashed-owner', 61_000);
            const realRename = fs.renameSync.getMockImplementation()!;
            fs.renameSync.mockImplementationOnce((from, to) => {
                // Between the check and the rename the stale lock was replaced by a live one.
                mockFiles.set(LOCK, { content: 'live-token', mtimeMs: Date.now() });
                realRename(from, to);
            });
            expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
            expect(lockFile()?.content).toBe('live-token');
            expect([...mockFiles.keys()]).toEqual([LOCK]);
        });

        test('…and when a newer lock was made in its place meanwhile, the one renamed away is dropped', () => {
            plant('crashed-owner', 61_000);
            const realRename = fs.renameSync.getMockImplementation()!;
            fs.renameSync.mockImplementationOnce((from, to) => {
                mockFiles.set(LOCK, { content: 'live-token', mtimeMs: Date.now() });
                realRename(from, to);
                mockFiles.set(LOCK, { content: 'newer-token', mtimeMs: Date.now() });
            });
            expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
            expect(lockFile()?.content).toBe('newer-token');
            expect([...mockFiles.keys()]).toEqual([LOCK]);
        });
    });

    test('fails OPEN and warns when lock infrastructure errors (e.g. EACCES)', () => {
        const warning = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValueOnce(invalid({ warning }));
        fs.openSync.mockImplementationOnce(() => {
            throw mockFsError('EACCES');
        });
        const lock = joinState.acquireUnlockLock('c9');
        expect(lock.ok).toBe(true);
        expect(logger.withCategory).toHaveBeenCalledWith('join');
        expect(warning).toHaveBeenCalledWith('cross-process join lock unavailable for c9: EACCES', null);
    });

    test('a thrown non-Error value is still reported and fails open', () => {
        const warning = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValueOnce(invalid({ warning }));
        fs.openSync.mockImplementationOnce(() => {
            throw 'weird';
        });
        expect(joinState.acquireUnlockLock('c9').ok).toBe(true);
        expect(warning).toHaveBeenCalledWith('cross-process join lock unavailable for c9: weird', null);
    });

    test('an EEXIST that comes back after a takeover (lost the race for the new file) is busy, not a failure', () => {
        plant('crashed-owner', 61_000);
        const realOpen = fs.openSync.getMockImplementation()!;
        fs.openSync
            .mockImplementationOnce(realOpen) // the first create: EEXIST, the stale file is there
            .mockImplementationOnce(() => {
                throw mockFsError('EEXIST');
            });
        expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
    });
});
