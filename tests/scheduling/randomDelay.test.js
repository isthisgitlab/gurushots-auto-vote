const {getRandomCheckFrequencyMs, DEFAULT_MINUTES, MS_PER_MINUTE} = require('../../src/js/scheduling/randomDelay');

describe('getRandomCheckFrequencyMs', () => {
    test('returns a fixed delay when min === max', () => {
        const settings = {checkFrequencyMin: 5, checkFrequencyMax: 5};
        for (let i = 0; i < 50; i++) {
            expect(getRandomCheckFrequencyMs(settings)).toBe(5 * MS_PER_MINUTE);
        }
    });

    test('produces delays inside [min, max] over many samples', () => {
        const settings = {checkFrequencyMin: 2, checkFrequencyMax: 8};
        const minMs = 2 * MS_PER_MINUTE;
        const maxMs = 8 * MS_PER_MINUTE;
        for (let i = 0; i < 500; i++) {
            const delay = getRandomCheckFrequencyMs(settings);
            expect(delay).toBeGreaterThanOrEqual(minMs);
            expect(delay).toBeLessThanOrEqual(maxMs);
        }
    });

    test('eventually emits values across the range (samples spread)', () => {
        const settings = {checkFrequencyMin: 2, checkFrequencyMax: 10};
        const seen = new Set();
        for (let i = 0; i < 200; i++) {
            seen.add(getRandomCheckFrequencyMs(settings));
        }
        // With 8 minutes of spread we expect more than a single bucket of values.
        expect(seen.size).toBeGreaterThan(20);
    });

    test('clamps when max < min by treating min as the floor and using min as the ceiling', () => {
        const settings = {checkFrequencyMin: 10, checkFrequencyMax: 3};
        for (let i = 0; i < 20; i++) {
            expect(getRandomCheckFrequencyMs(settings)).toBe(10 * MS_PER_MINUTE);
        }
    });

    test('falls back to the legacy default when settings are missing', () => {
        expect(getRandomCheckFrequencyMs({})).toBe(DEFAULT_MINUTES * MS_PER_MINUTE);
        expect(getRandomCheckFrequencyMs(undefined)).toBe(DEFAULT_MINUTES * MS_PER_MINUTE);
    });

    test('rejects non-finite or sub-1-minute values and falls back', () => {
        // Non-finite min → fallback to default; non-finite max → fallback to (now-default) min.
        expect(getRandomCheckFrequencyMs({checkFrequencyMin: NaN, checkFrequencyMax: NaN})).toBe(DEFAULT_MINUTES * MS_PER_MINUTE);
        expect(getRandomCheckFrequencyMs({checkFrequencyMin: 0, checkFrequencyMax: 0})).toBe(DEFAULT_MINUTES * MS_PER_MINUTE);
        expect(getRandomCheckFrequencyMs({checkFrequencyMin: -5, checkFrequencyMax: -2})).toBe(DEFAULT_MINUTES * MS_PER_MINUTE);
    });

    test('coerces numeric strings (handy for CLI input that lands in JSON)', () => {
        const settings = {checkFrequencyMin: '4', checkFrequencyMax: '4'};
        expect(getRandomCheckFrequencyMs(settings)).toBe(4 * MS_PER_MINUTE);
    });
});
