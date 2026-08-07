const {
    parseTimeOfDay,
    tzOffsetSeconds,
    epochForWallTime,
    occurrencesOf,
} = require('../../src/js/scheduling/wallClock');

const utc = (y, m, d, hh = 0, mm = 0, ss = 0) => Date.UTC(y, m - 1, d, hh, mm, ss) / 1000;

describe('parseTimeOfDay', () => {
    test.each([
        ['00:00', { hours: 0, minutes: 0 }],
        ['09:05', { hours: 9, minutes: 5 }],
        ['21:30', { hours: 21, minutes: 30 }],
        ['23:59', { hours: 23, minutes: 59 }],
    ])('accepts %s', (input, expected) => {
        expect(parseTimeOfDay(input)).toEqual(expected);
    });

    test.each([['24:00'], ['9:5'], ['21:30:00'], ['25:99'], [''], ['21.30'], [' 21:30'], ['21:30 ']])(
        'rejects %s',
        (input) => {
            expect(parseTimeOfDay(input)).toBeNull();
        },
    );

    test.each([[null], [undefined], [5], [2130], [{}], [[]], [{ hours: 21, minutes: 30 }], [true]])(
        'rejects non-string input %p without throwing',
        (input) => {
            expect(() => parseTimeOfDay(input)).not.toThrow();
            expect(parseTimeOfDay(input)).toBeNull();
        },
    );
});

describe('tzOffsetSeconds', () => {
    test('Europe/Riga is +02:00 in winter', () => {
        expect(tzOffsetSeconds(utc(2026, 1, 15, 12), 'Europe/Riga')).toBe(2 * 3600);
    });

    test('Europe/Riga is +03:00 in summer (DST)', () => {
        expect(tzOffsetSeconds(utc(2026, 7, 15, 12), 'Europe/Riga')).toBe(3 * 3600);
    });

    test('UTC is always 0', () => {
        expect(tzOffsetSeconds(utc(2026, 1, 15, 12), 'UTC')).toBe(0);
        expect(tzOffsetSeconds(utc(2026, 7, 15, 12), 'UTC')).toBe(0);
    });

    test('handles non-whole-hour zones (Asia/Kolkata +05:30)', () => {
        expect(tzOffsetSeconds(utc(2026, 1, 15, 12), 'Asia/Kolkata')).toBe(5.5 * 3600);
        expect(tzOffsetSeconds(utc(2026, 7, 15, 12), 'Asia/Kolkata')).toBe(5.5 * 3600);
    });

    test('handles midnight in the target zone (h23, no "24" hour)', () => {
        // 22:00 UTC on Jan 15 is exactly 00:00 Jan 16 in Europe/Riga (+02:00).
        expect(tzOffsetSeconds(utc(2026, 1, 15, 22), 'Europe/Riga')).toBe(2 * 3600);
    });
});

describe('epochForWallTime', () => {
    test('inverts a normal winter wall time in Europe/Riga', () => {
        // 21:30 Riga winter time (+02:00) is 19:30 UTC.
        expect(epochForWallTime(2026, 1, 15, 21, 30, 'Europe/Riga')).toBe(utc(2026, 1, 15, 19, 30));
    });

    test('inverts a summer wall time in Europe/Riga', () => {
        // 21:30 Riga summer time (+03:00) is 18:30 UTC.
        expect(epochForWallTime(2026, 7, 15, 21, 30, 'Europe/Riga')).toBe(utc(2026, 7, 15, 18, 30));
    });

    test('inverts a half-hour-offset wall time in Asia/Kolkata', () => {
        // 09:00 Kolkata (+05:30) is 03:30 UTC.
        expect(epochForWallTime(2026, 1, 15, 9, 0, 'Asia/Kolkata')).toBe(utc(2026, 1, 15, 3, 30));
    });

    test('UTC is the identity mapping', () => {
        expect(epochForWallTime(2026, 1, 15, 21, 30, 'UTC')).toBe(utc(2026, 1, 15, 21, 30));
    });
});

describe('occurrencesOf', () => {
    test('brackets now with today and yesterday/tomorrow (UTC)', () => {
        const now = utc(2026, 1, 15, 12);
        const occ = occurrencesOf('21:30', 'UTC', now);
        expect(occ).toEqual({ prev: utc(2026, 1, 14, 21, 30), next: utc(2026, 1, 15, 21, 30) });
    });

    test('after the time has passed today, next rolls to tomorrow', () => {
        const now = utc(2026, 1, 15, 22);
        const occ = occurrencesOf('21:30', 'UTC', now);
        expect(occ).toEqual({ prev: utc(2026, 1, 15, 21, 30), next: utc(2026, 1, 16, 21, 30) });
    });

    test('now exactly at an occurrence: prev is now, next is tomorrow', () => {
        const now = utc(2026, 1, 15, 21, 30);
        const occ = occurrencesOf('21:30', 'UTC', now);
        expect(occ).toEqual({ prev: now, next: utc(2026, 1, 16, 21, 30) });
    });

    test('crosses midnight correctly for an early-morning time', () => {
        const now = utc(2026, 1, 15, 23, 50);
        const occ = occurrencesOf('00:10', 'UTC', now);
        expect(occ).toEqual({ prev: utc(2026, 1, 15, 0, 10), next: utc(2026, 1, 16, 0, 10) });
    });

    test('resolves in the requested zone, not UTC (Europe/Riga winter)', () => {
        const now = utc(2026, 1, 15, 12);
        const occ = occurrencesOf('21:30', 'Europe/Riga', now);
        // 21:30 Riga (+02:00) = 19:30 UTC.
        expect(occ).toEqual({ prev: utc(2026, 1, 14, 19, 30), next: utc(2026, 1, 15, 19, 30) });
    });

    test('crosses a zone-local midnight that differs from the UTC date', () => {
        // 23:00 UTC Jan 15 is already 01:00 Jan 16 in Riga; a 00:30 Riga time
        // must bracket around the Riga date, not the UTC date.
        const now = utc(2026, 1, 15, 23);
        const occ = occurrencesOf('00:30', 'Europe/Riga', now);
        // 00:30 Riga Jan 16 = 22:30 UTC Jan 15.
        expect(occ).toEqual({ prev: utc(2026, 1, 15, 22, 30), next: utc(2026, 1, 16, 22, 30) });
    });

    test('DST spring-forward: nonexistent wall time resolves within an hour, deterministically', () => {
        // Europe/Riga springs forward on 2026-03-29: 03:00 EET (+02) -> 04:00 EEST (+03),
        // i.e. at 01:00 UTC. Wall time 03:30 does not exist that day.
        const now = utc(2026, 3, 29, 12);
        const occ = occurrencesOf('03:30', 'Europe/Riga', now);
        // Intended instants under the two offsets are 00:30/01:30 UTC; the fixed
        // point must land inside that bracket and be stable across calls.
        expect(occ.prev).toBeGreaterThanOrEqual(utc(2026, 3, 29, 0, 30));
        expect(occ.prev).toBeLessThanOrEqual(utc(2026, 3, 29, 1, 30));
        expect(occurrencesOf('03:30', 'Europe/Riga', now)).toEqual(occ);
    });

    test('DST fall-back: ambiguous wall time resolves to one of the two instants, deterministically', () => {
        // Europe/Riga falls back on 2026-10-25: 04:00 EEST (+03) -> 03:00 EET (+02),
        // i.e. at 01:00 UTC. Wall time 03:30 happens twice: 00:30 UTC and 01:30 UTC.
        const now = utc(2026, 10, 25, 12);
        const occ = occurrencesOf('03:30', 'Europe/Riga', now);
        expect([utc(2026, 10, 25, 0, 30), utc(2026, 10, 25, 1, 30)]).toContain(occ.prev);
        expect(occurrencesOf('03:30', 'Europe/Riga', now)).toEqual(occ);
    });

    test('unknown timezone falls back to UTC instead of throwing', () => {
        const now = utc(2026, 1, 15, 12);
        expect(() => occurrencesOf('21:30', 'Not/AZone', now)).not.toThrow();
        expect(occurrencesOf('21:30', 'Not/AZone', now)).toEqual(occurrencesOf('21:30', 'UTC', now));
    });

    test.each([[null], [undefined], [7], [{}], ['24:00'], ['']])('unparsable time %p yields null', (input) => {
        expect(occurrencesOf(input, 'UTC', utc(2026, 1, 15, 12))).toBeNull();
    });
});
