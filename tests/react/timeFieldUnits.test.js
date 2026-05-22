const {
    secondsToHoursMinutes,
    hoursMinutesToSeconds,
    formatSecondsAsHoursMinutes,
} = require('../../src/js/react/utils/timeFieldUnits');

describe('timeFieldUnits', () => {
    describe('secondsToHoursMinutes', () => {
        test('schema default turboTime (7200) → 2h 0m', () => {
            expect(secondsToHoursMinutes(7200)).toEqual({ hours: 2, minutes: 0 });
        });

        test('schema default boostTime (3600) → 1h 0m', () => {
            expect(secondsToHoursMinutes(3600)).toEqual({ hours: 1, minutes: 0 });
        });

        test('zero → 0h 0m', () => {
            expect(secondsToHoursMinutes(0)).toEqual({ hours: 0, minutes: 0 });
        });

        test('24h (86400) → 24h 0m (no upper cap)', () => {
            expect(secondsToHoursMinutes(86400)).toEqual({ hours: 24, minutes: 0 });
        });

        test('mixed value (5h 30m = 19800) → 5h 30m', () => {
            expect(secondsToHoursMinutes(19800)).toEqual({ hours: 5, minutes: 30 });
        });

        test('drops sub-minute remainder', () => {
            expect(secondsToHoursMinutes(3661)).toEqual({ hours: 1, minutes: 1 });
        });

        test('coerces invalid input to 0', () => {
            expect(secondsToHoursMinutes(undefined)).toEqual({ hours: 0, minutes: 0 });
            expect(secondsToHoursMinutes(null)).toEqual({ hours: 0, minutes: 0 });
            expect(secondsToHoursMinutes(NaN)).toEqual({ hours: 0, minutes: 0 });
            expect(secondsToHoursMinutes(-100)).toEqual({ hours: 0, minutes: 0 });
        });
    });

    describe('hoursMinutesToSeconds', () => {
        test('2h 0m → 7200', () => {
            expect(hoursMinutesToSeconds(2, 0)).toBe(7200);
        });

        test('1h 0m → 3600', () => {
            expect(hoursMinutesToSeconds(1, 0)).toBe(3600);
        });

        test('5h 30m → 19800', () => {
            expect(hoursMinutesToSeconds(5, 30)).toBe(19800);
        });

        test('0h 0m → 0', () => {
            expect(hoursMinutesToSeconds(0, 0)).toBe(0);
        });

        test('clamps minutes to [0, 59]', () => {
            expect(hoursMinutesToSeconds(1, 75)).toBe(3600 + 59 * 60);
            expect(hoursMinutesToSeconds(1, -10)).toBe(3600);
        });

        test('clamps negative hours to 0', () => {
            expect(hoursMinutesToSeconds(-3, 30)).toBe(30 * 60);
        });

        test('accepts large hours (no upper cap)', () => {
            expect(hoursMinutesToSeconds(100, 0)).toBe(360000);
        });

        test('coerces invalid input to 0', () => {
            expect(hoursMinutesToSeconds(undefined, undefined)).toBe(0);
            expect(hoursMinutesToSeconds(NaN, NaN)).toBe(0);
        });
    });

    describe('formatSecondsAsHoursMinutes', () => {
        test('720 → "0 hours, 12 minutes"', () => {
            expect(formatSecondsAsHoursMinutes(720, 'hours', 'minutes')).toBe('0 hours, 12 minutes');
        });

        test('schema defaults format as whole hours', () => {
            expect(formatSecondsAsHoursMinutes(3600, 'hours', 'minutes')).toBe('1 hours, 0 minutes');
            expect(formatSecondsAsHoursMinutes(7200, 'hours', 'minutes')).toBe('2 hours, 0 minutes');
        });

        test('zero → "0 hours, 0 minutes"', () => {
            expect(formatSecondsAsHoursMinutes(0, 'hours', 'minutes')).toBe('0 hours, 0 minutes');
        });

        test('invalid input coerces to "0 hours, 0 minutes"', () => {
            expect(formatSecondsAsHoursMinutes(undefined, 'hours', 'minutes')).toBe('0 hours, 0 minutes');
            expect(formatSecondsAsHoursMinutes(NaN, 'hours', 'minutes')).toBe('0 hours, 0 minutes');
            expect(formatSecondsAsHoursMinutes(-100, 'hours', 'minutes')).toBe('0 hours, 0 minutes');
        });

        test('uses the provided unit labels', () => {
            expect(formatSecondsAsHoursMinutes(720, 'stunda(s)', 'minūte(s)')).toBe('0 stunda(s), 12 minūte(s)');
        });
    });

    describe('round-trip', () => {
        test.each([[0], [60], [3600], [7200], [19800], [86400], [360000]])(
            'seconds=%i survives round-trip',
            (seconds) => {
                const { hours, minutes } = secondsToHoursMinutes(seconds);
                expect(hoursMinutesToSeconds(hours, minutes)).toBe(seconds);
            },
        );
    });
});
