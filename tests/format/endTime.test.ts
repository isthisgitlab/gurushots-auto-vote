/**
 * formatEndTimeIn: a challenge's end time as the card writes it: day, month, year and 24-hour time, in the named
 * timezone, in the given locale.
 */

import { formatEndTimeIn } from '../../src/ts/format/endTime';

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

    test('“local” and a zone that is not valid read the device clock', () => {
        const device = new Date(END * 1000).toLocaleString('en-GB', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
        expect(formatEndTimeIn(END, 'local', 'en-GB')).toBe(device);
        expect(formatEndTimeIn(END, 'Not/AZone', 'en-GB')).toBe(device);
    });
});
