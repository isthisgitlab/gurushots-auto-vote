/**
 * joinStateStore.js — the persisted paid-join markers plus the cross-process
 * unlock lock. The lock must: block a genuinely-held lock, reap a stale one,
 * and fail OPEN on any other lock-infra error (never deadlock a join).
 */

jest.mock('path', () => jest.requireActual('path'));

jest.mock('fs', () => ({
    statSync: jest.fn(),
    unlinkSync: jest.fn(),
    openSync: jest.fn(),
    writeSync: jest.fn(),
    closeSync: jest.fn(),
}));

jest.mock('../src/js/runtime', () => ({
    isCapacitor: jest.fn(() => false),
    isHeadlessService: jest.fn(() => false),
}));

const mockStore = { initializeAsync: jest.fn(), flushPendingWrites: jest.fn() };
jest.mock('../src/js/settings/storage', () => ({
    createJsonStore: jest.fn(() => mockStore),
    getSettingsPath: jest.fn(() => '/cfg/settings.json'),
}));

const fs = require('fs');
const runtime = require('../src/js/runtime');
const logger = require('../src/js/logger');
const storage = require('../src/js/settings/storage');
const joinState = require('../src/js/joinStateStore');

// Captured at require time: tests/setup.js clears every mock before each test.
const createJsonStoreCalls = [...storage.createJsonStore.mock.calls];

const enoent = () => Object.assign(new Error('no such file'), { code: 'ENOENT' });

describe('store wiring', () => {
    test('uses the platform-aware JSON store and re-exports its hydrate/flush hooks', () => {
        expect(createJsonStoreCalls).toEqual([[{ fileName: 'joinState.json', prefKey: 'gs_join_state' }]]);
        expect(joinState.joinStateStore).toBe(mockStore);
        expect(joinState.initializeJoinStateAsync).toBe(mockStore.initializeAsync);
        expect(joinState.flushJoinStateWrites).toBe(mockStore.flushPendingWrites);
    });
});

describe('acquireUnlockLock', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        runtime.isCapacitor.mockReturnValue(false);
        runtime.isHeadlessService.mockReturnValue(false);
        fs.statSync.mockImplementation(() => {
            throw enoent();
        });
        fs.openSync.mockReturnValue(11);
    });

    test.each([
        ['Capacitor', 'isCapacitor'],
        ['headless service', 'isHeadlessService'],
    ])('is a no-op on %s (single-process surfaces)', (_label, fn) => {
        runtime[fn].mockReturnValue(true);
        const lock = joinState.acquireUnlockLock('c1');
        expect(lock.ok).toBe(true);
        expect(() => lock.release()).not.toThrow();
        expect(fs.openSync).not.toHaveBeenCalled();
    });

    test('creates an exclusive lockfile next to settings with a sanitized id, writes the pid', () => {
        const lock = joinState.acquireUnlockLock('a/b..c');
        expect(lock.ok).toBe(true);
        expect(fs.openSync).toHaveBeenCalledWith('/cfg/joinlock-a_b__c.lock', 'wx');
        expect(fs.writeSync).toHaveBeenCalledWith(11, String(process.pid));
        expect(fs.closeSync).toHaveBeenCalledWith(11);
        expect(fs.unlinkSync).not.toHaveBeenCalled();

        lock.release();
        expect(fs.unlinkSync).toHaveBeenCalledWith('/cfg/joinlock-a_b__c.lock');
    });

    test('release() swallows an already-removed lockfile', () => {
        const lock = joinState.acquireUnlockLock(5);
        fs.unlinkSync.mockImplementationOnce(() => {
            throw enoent();
        });
        expect(() => lock.release()).not.toThrow();
    });

    test('closes the fd even when writing the pid fails, and then fails open', () => {
        fs.writeSync.mockImplementationOnce(() => {
            throw new Error('EIO');
        });
        const lock = joinState.acquireUnlockLock('c1');
        expect(fs.closeSync).toHaveBeenCalledWith(11);
        expect(lock.ok).toBe(true);
    });

    test('reaps a stale lock older than the TTL before acquiring', () => {
        fs.statSync.mockReturnValue({ mtimeMs: Date.now() - 61_000 });
        const lock = joinState.acquireUnlockLock('c1');
        expect(fs.unlinkSync).toHaveBeenCalledWith('/cfg/joinlock-c1.lock');
        expect(lock.ok).toBe(true);
    });

    test('leaves a fresh lock alone and reports busy when it is held (EEXIST)', () => {
        fs.statSync.mockReturnValue({ mtimeMs: Date.now() });
        fs.openSync.mockImplementation(() => {
            throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        });
        const lock = joinState.acquireUnlockLock('c1');
        expect(fs.unlinkSync).not.toHaveBeenCalled();
        expect(lock.ok).toBe(false);
        expect(() => lock.release()).not.toThrow();
        expect(fs.unlinkSync).not.toHaveBeenCalled();
    });

    test('fails OPEN and warns when lock infrastructure errors (e.g. EACCES)', () => {
        const warning = jest.fn();
        logger.withCategory.mockReturnValueOnce({ warning });
        fs.openSync.mockImplementation(() => {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        });
        const lock = joinState.acquireUnlockLock('c9');
        expect(lock.ok).toBe(true);
        expect(logger.withCategory).toHaveBeenCalledWith('join');
        expect(warning).toHaveBeenCalledWith('cross-process join lock unavailable for c9: permission denied', null);
    });

    test('a thrown non-Error value is still reported and fails open', () => {
        const warning = jest.fn();
        logger.withCategory.mockReturnValueOnce({ warning });
        fs.openSync.mockImplementation(() => {
            throw 'weird';
        });
        expect(joinState.acquireUnlockLock('c9').ok).toBe(true);
        expect(warning).toHaveBeenCalledWith('cross-process join lock unavailable for c9: weird', null);
    });
});
