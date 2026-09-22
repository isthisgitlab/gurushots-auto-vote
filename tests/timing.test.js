/**
 * timing.js — the shared sleep / randomized-delay primitives.
 */

const { sleep, getRandomDelay } = require('../src/js/timing');

describe('sleep', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('resolves only once the requested time has elapsed', async () => {
        const done = jest.fn();
        const p = sleep(500).then(done);
        await jest.advanceTimersByTimeAsync(499);
        expect(done).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(1);
        await p;
        expect(done).toHaveBeenCalledTimes(1);
    });
});

describe('getRandomDelay', () => {
    afterEach(() => jest.restoreAllMocks());

    test.each([
        [0, 2000],
        [0.5, 3500],
        [0.99999, 5000],
    ])('Math.random()=%p maps to %p within the inclusive [2000, 5000] range', (random, expected) => {
        jest.spyOn(Math, 'random').mockReturnValue(random);
        expect(getRandomDelay(2000, 5000)).toBe(expected);
    });

    test('min === max always yields that value', () => {
        jest.spyOn(Math, 'random').mockReturnValue(0.7);
        expect(getRandomDelay(42, 42)).toBe(42);
    });
});
