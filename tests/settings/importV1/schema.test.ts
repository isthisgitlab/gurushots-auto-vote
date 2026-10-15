/**
 * The frozen 1.x schema and list sanitizers against the live ones as of the freeze: same keys in the same order, same
 * defaults, same verdict on every probe value. The live comparison is deleted when the live schema changes.
 */

import { V1_SETTINGS_SCHEMA, v1SchemaEntry, validateV1Setting } from '../../../src/ts/settings/importV1/schema';
import {
    sanitizeBeforeEndList,
    sanitizeFillSchedule,
    sanitizeTimeOfDayList,
} from '../../../src/ts/settings/importV1/validators';
import type * as liveSchemaModule from '../../../src/ts/settings/schema';

const live = require('../../../src/ts/settings/schema') as typeof liveSchemaModule;

const PROBES: unknown[] = [
    undefined,
    null,
    0,
    1,
    -1,
    4,
    5,
    59,
    60,
    99,
    100,
    101,
    720,
    721,
    1439,
    3600,
    1e9,
    2592000,
    2592001,
    1_000_000,
    1_000_001,
    0.5,
    NaN,
    Infinity,
    '',
    'a',
    'x'.repeat(61),
    '12:30',
    true,
    false,
    [],
    [1],
    [1, 1],
    ['a'],
    ['12:30'],
    ['12:30', '12:30'],
    ['25:00'],
    [{ count: 2, seconds: 60 }],
    [
        { count: 2, seconds: 60 },
        { count: 2, seconds: 90 },
    ],
    [{ count: 5, seconds: 1 }],
    [{ count: 2, seconds: 60, extra: 1 }],
    {},
    { a: 1 },
    ['a'.repeat(51)],
    [' '],
    ['pic_1'],
    ['bad id'],
    Array.from({ length: 21 }, (_, i) => `p${i}`),
    Array.from({ length: 7 }, (_, i) => i + 1),
    Array.from({ length: 51 }, () => 't'),
];

describe('the frozen 1.x schema', () => {
    const keys = Object.keys(V1_SETTINGS_SCHEMA);

    test('has the live schema keys, in the live order', () => {
        expect(keys).toEqual(Object.keys(live.SETTINGS_SCHEMA));
    });

    test.each(keys)('%s has the live default', (key) => {
        expect(V1_SETTINGS_SCHEMA[key as keyof typeof V1_SETTINGS_SCHEMA].default).toEqual(
            live.schemaEntry(key)?.default,
        );
    });

    test.each(keys)('%s gives the live verdict on every probe value', (key) => {
        for (const probe of PROBES) {
            expect([key, probe, validateV1Setting(key, probe)]).toEqual([
                key,
                probe,
                live.schemaEntry(key)?.validation.safeParse(probe).success,
            ]);
        }
    });

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

    test.each([
        ...PROBES,
        [
            { count: 4, seconds: 1 },
            { count: 2, seconds: 2 },
        ],
        ['08:00', '07:00', 'x'],
        [3, 2, 2, 'x'],
    ])('agree with the live sanitizers on %j', (probe) => {
        expect(sanitizeFillSchedule(probe)).toEqual(live.sanitizeFillSchedule(probe));
        expect(sanitizeTimeOfDayList(probe)).toEqual(live.sanitizeTimeOfDayList(probe));
        expect(sanitizeBeforeEndList(probe)).toEqual(live.sanitizeBeforeEndList(probe));
    });
});
