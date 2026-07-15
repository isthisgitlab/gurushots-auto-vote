const { formatSettingDefault } = require('../../src/js/react/utils/formatters');

// Minimal stand-in for the React translation function. Maps the keys this
// helper looks up to their English strings; unknown keys echo back so a
// missing mapping is visible in a failing assertion rather than silent.
const t = (key) => {
    const dict = {
        'app.none': '(none)',
        'app.hours': 'hours',
        'app.minutes': 'minutes',
    };
    return dict[key] ?? key;
};

describe('formatSettingDefault', () => {
    describe('time settings (seconds → hours/minutes)', () => {
        test('720s renders the same as the input: "0 hours, 12 minutes"', () => {
            expect(formatSettingDefault(720, { type: 'time' }, t)).toBe('0 hours, 12 minutes');
        });

        test('whole-hour schema defaults', () => {
            expect(formatSettingDefault(3600, { type: 'time' }, t)).toBe('1 hours, 0 minutes');
            expect(formatSettingDefault(7200, { type: 'time' }, t)).toBe('2 hours, 0 minutes');
        });

        test('zero and invalid seconds coerce to "0 hours, 0 minutes"', () => {
            expect(formatSettingDefault(0, { type: 'time' }, t)).toBe('0 hours, 0 minutes');
            expect(formatSettingDefault(undefined, { type: 'time' }, t)).toBe('0 hours, 0 minutes');
        });
    });

    describe('number settings with a unit', () => {
        test('appends the translated unit (emergencyFill → "5 minutes")', () => {
            expect(formatSettingDefault(5, { type: 'number', unit: 'app.minutes' }, t)).toBe('5 minutes');
        });

        test('number without a unit prints the bare value', () => {
            expect(formatSettingDefault(100, { type: 'number' }, t)).toBe('100');
        });
    });

    describe('tag arrays', () => {
        test('non-empty arrays join with ", "', () => {
            expect(formatSettingDefault(['cats', 'dogs'], { type: 'tags' }, t)).toBe('cats, dogs');
        });

        test('empty arrays render the "none" label', () => {
            expect(formatSettingDefault([], { type: 'tags' }, t)).toBe('(none)');
        });

        test('array branch wins regardless of config type', () => {
            expect(formatSettingDefault(['a'], { type: 'time' }, t)).toBe('a');
        });
    });

    describe('schedule settings ({count, seconds} rows)', () => {
        test('rows render sorted by count with the ≤ separator and h/m labels', () => {
            const value = [
                { count: 4, seconds: 600 },
                { count: 2, seconds: 1800 },
            ];
            expect(formatSettingDefault(value, { type: 'schedule' }, t)).toBe(
                '2 ≤ 0 hours, 30 minutes, 4 ≤ 0 hours, 10 minutes',
            );
        });

        test('schema default renders all three rows in count order', () => {
            const value = [
                { count: 2, seconds: 1800 },
                { count: 3, seconds: 1200 },
                { count: 4, seconds: 600 },
            ];
            expect(formatSettingDefault(value, { type: 'schedule' }, t)).toBe(
                '2 ≤ 0 hours, 30 minutes, 3 ≤ 0 hours, 20 minutes, 4 ≤ 0 hours, 10 minutes',
            );
        });

        test('empty schedule renders the "none" label', () => {
            expect(formatSettingDefault([], { type: 'schedule' }, t)).toBe('(none)');
        });

        test('non-array schedule value degrades to the "none" label (not a crash)', () => {
            expect(formatSettingDefault(undefined, { type: 'schedule' }, t)).toBe('(none)');
        });

        test('does not mutate the input array (sort works on a copy)', () => {
            const value = [
                { count: 4, seconds: 600 },
                { count: 2, seconds: 1800 },
            ];
            formatSettingDefault(value, { type: 'schedule' }, t);
            expect(value.map((r) => r.count)).toEqual([4, 2]);
        });
    });

    describe('fallback (boolean / string / unknown)', () => {
        test('booleans stringify', () => {
            expect(formatSettingDefault(true, { type: 'boolean' }, t)).toBe('true');
            expect(formatSettingDefault(false, { type: 'boolean' }, t)).toBe('false');
        });

        test('strings pass through', () => {
            expect(formatSettingDefault('1.2.3', { type: 'string' }, t)).toBe('1.2.3');
        });
    });

    describe('missing config is tolerated', () => {
        test('no config → String(value)', () => {
            expect(formatSettingDefault(42, undefined, t)).toBe('42');
        });

        test('no config still honors the array branch', () => {
            expect(formatSettingDefault([], null, t)).toBe('(none)');
        });
    });
});
