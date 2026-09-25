/**
 * Scenario durations: seconds or "5d" / "90m" / "1d 6h" strings.
 */

const { parseDuration, MAX_DURATION_SEC } = require('../../src/js/scenarios/duration');

describe('parseDuration', () => {
    test.each([
        [0, 0],
        [240, 240],
        ['4m', 240],
        ['5d', 432000],
        ['1d 6h', 108000],
        ['1D6H', 108000],
        [' 2h 30m 15s ', 9015],
    ])('%p → %p seconds', (value, seconds) => {
        expect(parseDuration(value)).toBe(seconds);
    });

    test.each([[-1], [1.5], [Number.NaN], [''], ['5'], ['5x'], ['d5'], ['1d -2h'], [null], [undefined], [{}], [true]])(
        '%p is not a duration',
        (value) => {
            expect(parseDuration(value)).toBeNull();
        },
    );

    test('caps at 60 days', () => {
        expect(parseDuration(MAX_DURATION_SEC)).toBe(MAX_DURATION_SEC);
        expect(parseDuration(MAX_DURATION_SEC + 1)).toBeNull();
        expect(parseDuration('61d')).toBeNull();
    });
});
