/**
 * The frozen 1.x schema and list sanitizers: every default passes its own validator, a key the schema does not know is
 * valid, and the list sanitizers do what 1.x did. Frozen code: nothing here follows the live schema.
 */

import { V1_SETTINGS_SCHEMA, v1SchemaEntry, validateV1Setting } from '../../../src/ts/settings/importV1/schema';
import {
    sanitizeBeforeEndList,
    sanitizeFillSchedule,
    sanitizeTimeOfDayList,
} from '../../../src/ts/settings/importV1/validators';

describe('the frozen 1.x schema', () => {
    const keys = Object.keys(V1_SETTINGS_SCHEMA);

    test('every default passes its own validator', () => {
        for (const key of keys) expect(validateV1Setting(key, v1SchemaEntry(key)?.default)).toBe(true);
    });

    test('a key it does not know has no entry and is valid', () => {
        expect(v1SchemaEntry('nope')).toBeUndefined();
        expect(validateV1Setting('nope', { anything: 1 })).toBe(true);
    });

    test.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('%s is no entry', (key) => {
        expect(v1SchemaEntry(key)).toBeUndefined();
    });
});

describe('the frozen list sanitizers', () => {
    test('autoFillSchedule: rows clamped, deduped by count, sorted; null when already clean or no array', () => {
        expect(sanitizeFillSchedule('x')).toBeNull();
        expect(sanitizeFillSchedule([{ count: 2, seconds: 60 }])).toBeNull();
        expect(
            sanitizeFillSchedule([
                { count: 4, seconds: 10 },
                { count: 2, seconds: 60 },
                { count: 2, seconds: 90 },
                { count: 20, seconds: 5 },
                { count: 3, seconds: -1 },
                { count: 3, seconds: 1.5 },
                { count: 1.5, seconds: 5 },
                'row',
                { count: 3, seconds: 5 },
            ]),
        ).toEqual([
            { count: 2, seconds: 60 },
            { count: 3, seconds: 5 },
            { count: 4, seconds: 10 },
        ]);
        expect(sanitizeFillSchedule([{ count: 2, seconds: 60, extra: true }])).toEqual([{ count: 2, seconds: 60 }]);
        expect(sanitizeFillSchedule([{ count: 2, seconds: 3_000_000 }])).toEqual([]);
    });

    test('scheduledFillTime: strict HH:MM, deduped, sorted, capped to 6; null when clean or no array', () => {
        expect(sanitizeTimeOfDayList(undefined)).toBeNull();
        expect(sanitizeTimeOfDayList(['08:00', '09:30'])).toBeNull();
        expect(sanitizeTimeOfDayList(['23:00', '9:00', '08:00', '08:00', 5, '24:00'])).toEqual(['08:00', '23:00']);
        expect(sanitizeTimeOfDayList(['07:00', '06:00', '05:00', '04:00', '03:00', '02:00', '01:00', '00:00'])).toEqual(
            ['00:00', '01:00', '02:00', '03:00', '04:00', '05:00'],
        );
    });

    test('scheduledFillBeforeEnd: integers within bounds, deduped, ascending, capped to 6; null when clean or no array', () => {
        expect(sanitizeBeforeEndList('x')).toBeNull();
        expect(sanitizeBeforeEndList([60, 120])).toBeNull();
        expect(sanitizeBeforeEndList([300, 60, 60, 0, 1.5, 3_000_000, 'a'])).toEqual([60, 300]);
        expect(sanitizeBeforeEndList([8, 7, 6, 5, 4, 3, 2, 1])).toEqual([1, 2, 3, 4, 5, 6]);
    });
});
