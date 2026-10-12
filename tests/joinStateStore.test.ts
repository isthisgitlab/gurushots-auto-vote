/**
 * joinStateStore.ts — the persisted paid-join markers plus the cross-process
 * unlock lock. The lock must: block a genuinely-held lock, reap a stale one,
 * and fail OPEN on any other lock-infra error (never deadlock a join).
 */

jest.mock('path', () => jest.requireActual<typeof import('path')>('path'));

// A small in-memory file system, faithful where the lock depends on it: exclusive creation fails with EEXIST,
// rename and link are atomic and fail the way the real ones do, a file carries its modification time, and an open
// file stays the file it was opened as when the path is replaced.
type MockFile = { content: string; mtimeMs: number };
const mockFiles = new Map<string, MockFile>();
const mockFds = new Map<number, MockFile>();
let mockNextFd = 10;
const mockFsError = (code: string) => Object.assign(new Error(code), { code });
const mockOpen = (file: string, flag: string): number => {
    const existing = mockFiles.get(file);
    if (flag === 'r' && !existing) throw mockFsError('ENOENT');
    if (flag === 'wx' && existing) throw mockFsError('EEXIST');
    const entry = existing ?? { content: '', mtimeMs: Date.now() };
    mockFiles.set(file, entry);
    mockNextFd += 1;
    mockFds.set(mockNextFd, entry);
    return mockNextFd;
};
jest.mock('fs', () => ({
    openSync: jest.fn(mockOpen),
    writeSync: jest.fn((fd: number, data: string) => {
        const file = mockFds.get(fd);
        if (file) file.content += data;
    }),
    closeSync: jest.fn(),
    fstatSync: jest.fn((fd: number) => ({ mtimeMs: mockFds.get(fd)?.mtimeMs ?? 0 })),
    readFileSync: jest.fn((target: string | number) => {
        const found = typeof target === 'number' ? mockFds.get(target) : mockFiles.get(target);
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
        mockFiles.set(to, found);
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
        expect(createJsonStoreCalls).toEqual([
            [{ fileName: 'joinState.json', prefKey: 'gs_join_state', atomic: true }],
        ]);
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

    describe('the takeover is atomic: of two processes finding the same stale lock only one gets it', () => {
        const realOpen = () => fs.openSync.getMockImplementation()!;
        const realRename = () => fs.renameSync.getMockImplementation()!;
        const realLink = () => fs.linkSync.getMockImplementation()!;
        const grave = (name = '') =>
            [...mockFiles.keys()].filter((file) => file.includes('.stale-') && file.includes(name));

        test('a stale lock another process removed first is simply free', () => {
            plant('crashed-owner', 61_000);
            fs.openSync
                .mockImplementationOnce(realOpen()) // the create: EEXIST
                .mockImplementationOnce(() => {
                    // The look at the stale file: it is gone by now.
                    mockFiles.delete(LOCK);
                    throw mockFsError('ENOENT');
                });
            expect(joinState.acquireUnlockLock('c1').ok).toBe(true);
        });

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

        test('mtime and token are read through one open file: a path replaced right after the look cannot mix them', () => {
            plant('old-token', 61_000);
            fs.openSync
                .mockImplementationOnce(realOpen()) // the create: EEXIST
                .mockImplementationOnce((file, flag) => {
                    // The look opens the stale file, and only then is the path replaced by a live lock.
                    const fd = realOpen()(file, flag);
                    mockFiles.set(LOCK, { content: 'live-token', mtimeMs: Date.now() });
                    return fd;
                });
            // What was seen is the stale file, whole; what is then renamed away is the live one, which is put back.
            expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
            expect(lockFile()?.content).toBe('live-token');
            expect([...mockFiles.keys()]).toEqual([LOCK]);
        });

        test('what was renamed is a live lock that replaced the stale one meanwhile: put back with a link, and busy', () => {
            plant('crashed-owner', 61_000);
            fs.renameSync.mockImplementationOnce((from, to) => {
                // Between the look and the rename the stale lock was replaced by a live one.
                mockFiles.set(LOCK, { content: 'live-token', mtimeMs: Date.now() });
                realRename()(from, to);
            });
            expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
            expect(lockFile()?.content).toBe('live-token');
            expect([...mockFiles.keys()]).toEqual([LOCK]);
        });

        test('the owner touched the lock in the moment between the look and the rename: it is live, put back', () => {
            plant('slow-owner', 61_000);
            fs.renameSync.mockImplementationOnce((from, to) => {
                const held = mockFiles.get(LOCK);
                if (held) held.mtimeMs = Date.now();
                realRename()(from, to);
            });
            expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
            expect(lockFile()?.content).toBe('slow-owner');
            expect(grave()).toEqual([]);
        });

        describe('the live lock that was moved is put back with a link, which never replaces a lock', () => {
            // Between the look and the rename the stale lock was replaced by a live one.
            const replacedByLive = () =>
                fs.renameSync.mockImplementationOnce((from, to) => {
                    mockFiles.set(LOCK, { content: 'live-token', mtimeMs: Date.now() });
                    realRename()(from, to);
                });

            test('a lock created in its place in the moment before the put-back is not replaced, and the moved file goes', () => {
                plant('crashed-owner', 61_000);
                replacedByLive();
                fs.linkSync.mockImplementationOnce((from, to) => {
                    // The check for an empty place, if there were one, has passed: now a rival creates its lock.
                    mockFiles.set(LOCK, { content: 'newer-token', mtimeMs: Date.now() });
                    realLink()(from, to);
                });
                expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
                expect(lockFile()?.content).toBe('newer-token');
                expect(grave()).toEqual([]);
            });

            test('a filesystem without hard links gets a rename, while the place is empty', () => {
                plant('crashed-owner', 61_000);
                replacedByLive();
                fs.linkSync.mockImplementationOnce(() => {
                    throw mockFsError('EPERM');
                });
                expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
                expect(lockFile()?.content).toBe('live-token');
                expect(grave()).toEqual([]);
            });

            test('…and none when a lock is there already: the moved file is left as it is', () => {
                plant('crashed-owner', 61_000);
                replacedByLive();
                fs.linkSync.mockImplementationOnce(() => {
                    mockFiles.set(LOCK, { content: 'newer-token', mtimeMs: Date.now() });
                    throw mockFsError('ENOTSUP');
                });
                expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
                expect(lockFile()?.content).toBe('newer-token');
                expect(grave()).toHaveLength(1);
            });

            test('a link that fails for another reason leaves the moved file where it is', () => {
                plant('crashed-owner', 61_000);
                replacedByLive();
                fs.linkSync.mockImplementationOnce(() => {
                    throw mockFsError('EIO');
                });
                expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
                expect(grave()).toHaveLength(1);
            });

            test('a moved file that cannot be removed after the put-back does not fail the lock', () => {
                plant('crashed-owner', 61_000);
                replacedByLive();
                fs.unlinkSync.mockImplementationOnce(() => {
                    throw mockFsError('EACCES');
                });
                expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
                expect(lockFile()?.content).toBe('live-token');
            });
        });

        test('a rename that fails for a reason other than a lost race leaves the lock busy', () => {
            plant('crashed-owner', 61_000);
            fs.renameSync.mockImplementationOnce(() => {
                throw mockFsError('EACCES');
            });
            expect(joinState.acquireUnlockLock('c1').ok).toBe(false);
            expect(lockFile()?.content).toBe('crashed-owner');
        });
    });

    describe('renewal tolerates one failed read, not two, and never outlives the lock', () => {
        beforeEach(() => {
            jest.useFakeTimers();
            mockFiles.clear();
            jest.clearAllMocks();
        });
        afterEach(() => jest.useRealTimers());

        test('one read that finds nothing is passed over; the renewal goes on', () => {
            const lock = joinState.acquireUnlockLock('c1');
            const realRead = fs.readFileSync.getMockImplementation()!;
            fs.readFileSync.mockImplementationOnce(() => {
                throw mockFsError('EIO');
            });
            jest.advanceTimersByTime(20_000);
            expect(fs.utimesSync).not.toHaveBeenCalled();
            fs.readFileSync.mockImplementation(realRead);
            jest.advanceTimersByTime(20_000);
            expect(fs.utimesSync).toHaveBeenCalledTimes(1);
            lock.release();
        });

        test('two in a row end it', () => {
            const lock = joinState.acquireUnlockLock('c1');
            fs.readFileSync.mockImplementation(() => {
                throw mockFsError('EIO');
            });
            jest.advanceTimersByTime(60_000);
            fs.readFileSync.mockImplementation((target) =>
                typeof target === 'string' ? (lockFile()?.content ?? '') : '',
            );
            jest.advanceTimersByTime(5 * 60_000);
            expect(fs.utimesSync).not.toHaveBeenCalled();
            lock.release();
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

    test('the challenge id is sanitized in what is logged', () => {
        const warning = jest.fn();
        jest.mocked(logger.withCategory).mockReturnValueOnce(invalid({ warning }));
        fs.openSync.mockImplementationOnce(() => {
            throw mockFsError('EACCES');
        });
        joinState.acquireUnlockLock('c9\nforged line');
        expect(warning).toHaveBeenCalledWith('cross-process join lock unavailable for c9 forged line: EACCES', null);
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
