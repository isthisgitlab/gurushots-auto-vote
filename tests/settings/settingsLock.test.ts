/**
 * The settings lock a desktop changes settings.json, config.json and the import marker under: held once per take, and a
 * change that needs it again inside a hold (the mirror's own marker writes) does not wait for itself.
 */

const mockAcquireWithin = jest.fn<unknown, unknown[]>();
jest.mock('../../src/ts/lockWait', () => ({ acquireWithin: (...args: unknown[]) => mockAcquireWithin(...args) }));

import type * as settingsLockModule from '../../src/ts/settings/settingsLock';

const { acquireSettingsLock, underSettingsLock } =
    require('../../src/ts/settings/settingsLock') as typeof settingsLockModule;

const heldLock = () => ({ ok: true, release: jest.fn() });

describe('the settings lock', () => {
    beforeEach(() => {
        mockAcquireWithin.mockReset();
    });

    test('a change made under a hold takes no second one', () => {
        const lock = heldLock();
        mockAcquireWithin.mockReturnValue(lock);
        const held = acquireSettingsLock(10);
        expect(mockAcquireWithin).toHaveBeenCalledTimes(1);

        const answer = underSettingsLock(10, () => 'done', 'busy');

        expect(answer).toBe('done');
        expect(mockAcquireWithin).toHaveBeenCalledTimes(1);
        if (typeof held !== 'string') held.release();
    });

    test('a hold released twice is released once, in the count and on the lock: the next change still sees the lock it holds, and no more', () => {
        const lock = heldLock();
        mockAcquireWithin.mockReturnValue(lock);
        const first = acquireSettingsLock(10);
        if (typeof first === 'string') throw new Error('expected a lock');
        first.release();
        first.release();
        expect(lock.release).toHaveBeenCalledTimes(1);
        const second = acquireSettingsLock(10);
        const calls = mockAcquireWithin.mock.calls.length;

        underSettingsLock(10, () => 1, 0);

        // Inside the one real hold, nothing is taken again (a count gone negative would take it again).
        expect(mockAcquireWithin).toHaveBeenCalledTimes(calls);
        if (typeof second !== 'string') second.release();
        underSettingsLock(10, () => 1, 0);
        expect(mockAcquireWithin).toHaveBeenCalledTimes(calls + 1);
    });

    test('takes the lock for the run when none is held, releases it after, and answers `busy` when it cannot be had', () => {
        const lock = heldLock();
        mockAcquireWithin.mockReturnValueOnce(lock);
        expect(underSettingsLock(10, () => 'made', 'busy')).toBe('made');
        expect(lock.release).toHaveBeenCalledTimes(1);

        mockAcquireWithin.mockReturnValueOnce('busy');
        expect(underSettingsLock(10, () => 'made', 'busy')).toBe('busy');
        mockAcquireWithin.mockReturnValueOnce('unavailable');
        expect(underSettingsLock(10, () => 'made', 'busy')).toBe('busy');
    });

    test('releases the lock when the run throws', () => {
        const lock = heldLock();
        mockAcquireWithin.mockReturnValueOnce(lock);

        expect(() =>
            underSettingsLock(
                10,
                () => {
                    throw new Error('boom');
                },
                'busy',
            ),
        ).toThrow('boom');
        expect(lock.release).toHaveBeenCalledTimes(1);
    });
});
