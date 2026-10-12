/**
 * Waiting for a lock that something else holds for a moment: tried in small steps within a bound, never longer.
 */

import { acquireWithin } from '../src/ts/lockWait';

describe('acquireWithin', () => {
    let clock = 0;
    beforeEach(() => {
        clock = 1_000;
        jest.spyOn(Date, 'now').mockImplementation(() => clock);
        jest.spyOn(Atomics, 'wait').mockImplementation(() => {
            clock += 10;
            return 'timed-out';
        });
    });
    afterEach(() => jest.restoreAllMocks());

    const lock = { ok: true, release: () => {} };
    const busy = { ok: false, release: () => {} };

    test('a lock that is free is taken at once, without waiting', () => {
        const acquire = jest.fn(() => lock);
        expect(acquireWithin(acquire, 500)).toBe(lock);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(Atomics.wait).not.toHaveBeenCalled();
    });

    test('a lock held for a moment is taken once it is let go', () => {
        const acquire = jest.fn().mockReturnValueOnce(busy).mockReturnValueOnce(busy).mockReturnValue(lock);
        expect(acquireWithin(acquire, 500)).toBe(lock);
        expect(Atomics.wait).toHaveBeenCalledTimes(2);
    });

    test('one that is not free within the bound is given up on, after about that long', () => {
        const acquire = jest.fn(() => busy);
        expect(acquireWithin(acquire, 100)).toBeNull();
        expect(Atomics.wait).toHaveBeenCalledTimes(10);
        expect(clock).toBe(1_100);
    });
});
