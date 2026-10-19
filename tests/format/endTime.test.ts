/**
 * formatEndTimeIn: a challenge's end time as the card writes it: day, month, year and 24-hour time, in the named
 * timezone, in the given locale.
 */

import { endTimeOf, formatEndTimeIn } from '../../src/ts/format/endTime';

// 2023-11-14 22:13 UTC.
const END = 1_700_000_000;

describe('formatEndTimeIn', () => {
    test.each([
        ['UTC', 'en-GB', '14/11/2023, 22:13'],
        ['Europe/Riga', 'en-GB', '15/11/2023, 00:13'],
        ['Asia/Tokyo', 'en-GB', '15/11/2023, 07:13'],
        ['UTC', 'lv-LV', '14.11.2023 22:13'],
    ])('writes the instant in %s for %s', (timezone, locale, expected) => {
        expect(formatEndTimeIn(END, timezone, locale)).toBe(expected);
    });

    describe('the device clock', () => {
        afterEach(() => {
            jest.restoreAllMocks();
        });

        // Without a timeZone option toLocaleString reads the device clock. A sentinel makes that branch observable
        // on any host (process.env.TZ does not reach Node under Jest); a call that names a zone goes through, so an
        // invalid one still throws its real RangeError into the fallback.
        const pinDeviceClock = (): void => {
            const real = Date.prototype.toLocaleString;
            jest.spyOn(Date.prototype, 'toLocaleString').mockImplementation(function (
                this: Date,
                locales?: Intl.LocalesArgument,
                options?: Intl.DateTimeFormatOptions,
            ) {
                return options?.timeZone ? real.call(this, locales, options) : 'DEVICE';
            });
        };

        test('“local” reads the device clock', () => {
            pinDeviceClock();
            expect(formatEndTimeIn(END, 'local', 'en-GB')).toBe('DEVICE');
        });

        test('a zone that is not valid reads as UTC, not the device clock', () => {
            pinDeviceClock();
            expect(formatEndTimeIn(END, 'Not/AZone', 'en-GB')).toBe('14/11/2023, 22:13');
        });
    });
});

describe('endTimeOf', () => {
    test.each([
        [END, END],
        [String(END), END],
        [1.5, 1.5],
        [8.64e12, 8.64e12],
    ])('%p is a time worth showing: %p', (raw, seconds) => {
        expect(endTimeOf(raw)).toBe(seconds);
    });

    test.each([
        ['missing', undefined],
        ['null', null],
        ['zero', 0],
        ['negative', -1],
        ['text', 'soon'],
        ['blank text', '  '],
        ['infinite', Infinity],
        ['not a number', NaN],
        ['true, which Number() would read as 1', true],
        ['false', false],
        ['an object', {}],
        ['a list', [1, 2]],
        ['past the dates a clock can write', 1e13],
        ['just past them', 8.64e12 + 1],
    ])('%s is not a time', (_name, raw) => {
        expect(endTimeOf(raw)).toBeNull();
    });
});
