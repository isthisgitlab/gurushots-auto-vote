/**
 * The 1.x to 2.x setting-key renames: the table, and renaming the keys of a values map and of a scenario document.
 */

import {
    V1_KEY_RENAMES,
    renameV1Keys,
    renameV1ScenarioDocument,
    renameV1Value,
} from '../../../src/ts/settings/importV1/renames';
import { V1_SETTINGS_SCHEMA } from '../../../src/ts/settings/importV1/schema';
import { invalid } from '../../helpers/invalid';
import { parseJsonObject } from '../../helpers/parseJson';

describe('the rename table', () => {
    test('is frozen', () => {
        expect(Object.isFrozen(V1_KEY_RENAMES)).toBe(true);
    });

    test('every source is a frozen 1.x schema key and no target is', () => {
        for (const [from, to] of Object.entries(V1_KEY_RENAMES)) {
            expect(Object.hasOwn(V1_SETTINGS_SCHEMA, from)).toBe(true);
            expect(Object.hasOwn(V1_SETTINGS_SCHEMA, to)).toBe(false);
        }
    });

    test('no target is also a source', () => {
        const sources = new Set(Object.keys(V1_KEY_RENAMES));
        expect(Object.values(V1_KEY_RENAMES).filter((to) => sources.has(to))).toEqual([]);
    });

    test('covers the keys that mean submitting a photo and none of the currency keys', () => {
        expect(Object.keys(V1_KEY_RENAMES).sort()).toEqual(
            [
                'autoFill',
                'autoFillSchedule',
                'emergencyFill',
                'protectUncertainAutoFills',
                'fillWithoutTagMatch',
                'notifyOnAutoFill',
                'notifyOnEmergencyFill',
                'boostFillNew',
                'boostFillNewOnConflict',
                'turboFillNew',
                'turboFillNewOnConflict',
            ].sort(),
        );
        // Every other frozen key mentioning fill is a currency or a scheduled-voting key and keeps its name.
        const rest = Object.keys(V1_SETTINGS_SCHEMA).filter(
            (key) => /fill|emergency/i.test(key) && !(key in V1_KEY_RENAMES),
        );
        expect(
            rest.every((key) =>
                /^(autoExposureFill|currencyReserveFills|missionUseFills|useScheduledFill|scheduledFill)/.test(key),
            ),
        ).toBe(true);
    });
});

describe('renameV1Keys', () => {
    test('renames the keys, leaves the values and every other key alone, and keeps the order', () => {
        const values = {
            exposure: 90,
            autoFill: true,
            emergencyFill: 300,
            autoFillSchedule: [{ count: 2, seconds: 60 }],
            scenario: 'Plan',
        };
        const renamed = renameV1Keys(values);
        expect(Object.keys(renamed)).toEqual([
            'exposure',
            'autoSubmit',
            'emergencySubmit',
            'autoSubmitSchedule',
            'scenario',
        ]);
        expect(renamed).toEqual({
            exposure: 90,
            autoSubmit: true,
            emergencySubmit: 300,
            autoSubmitSchedule: [{ count: 2, seconds: 60 }],
            scenario: 'Plan',
        });
        expect(values).toHaveProperty('autoFill', true);
    });

    test('the 1.x key wins over a leftover 2.x-named key, which 1.x never read', () => {
        expect(renameV1Keys({ autoSubmit: false, autoFill: true })).toEqual({ autoSubmit: true });
        expect(renameV1Keys({ autoFill: true, autoSubmit: false })).toEqual({ autoSubmit: true });
    });

    test('a key named like a prototype member stays an ordinary key', () => {
        const renamed = renameV1Keys(parseJsonObject('{"__proto__":{"x":1},"constructor":2,"autoFill":true}'));
        expect(Object.keys(renamed)).toEqual(['__proto__', 'constructor', 'autoSubmit']);
        expect(Object.getPrototypeOf(renamed)).toBe(Object.prototype);
        expect(({} as Record<string, unknown>).x).toBeUndefined();
    });
});

describe('renameV1Value', () => {
    test('renames a plain object and returns anything else as it is', () => {
        expect(renameV1Value({ autoFill: true })).toEqual({ autoSubmit: true });
        const list = [{ autoFill: true }];
        for (const other of [list, 'text', 4, null, undefined]) expect(renameV1Value(other)).toBe(other);
    });
});

describe('renameV1ScenarioDocument', () => {
    const doc = {
        name: 'Plan',
        version: 1,
        start: 'a',
        phases: {
            a: {
                settings: { autoFill: true, exposure: 80, boostFillNew: true },
                rules: [{ do: [{ type: 'fillExposure' }] }],
            },
            b: { rules: [] },
            c: { settings: 'junk' },
            d: 'junk',
        },
    };

    test('renames the setting keys of every phase and nothing else', () => {
        expect(renameV1ScenarioDocument(doc)).toEqual({
            ...doc,
            phases: {
                ...doc.phases,
                a: {
                    settings: { autoSubmit: true, exposure: 80, boostNewSubmit: true },
                    rules: [{ do: [{ type: 'fillExposure' }] }],
                },
            },
        });
    });

    test('does not change its input', () => {
        const before = JSON.stringify(doc);
        renameV1ScenarioDocument(doc);
        expect(JSON.stringify(doc)).toBe(before);
    });

    test.each([
        undefined,
        null,
        4,
        'text',
        true,
        [],
        [{ phases: {} }],
        {},
        { phases: null },
        { phases: [] },
        { phases: 'x' },
        { phases: {} },
    ])('is total: %j comes back as it is', (garbage) => {
        expect(() => renameV1ScenarioDocument(garbage)).not.toThrow();
        expect(renameV1ScenarioDocument(garbage)).toEqual(garbage);
    });

    test('survives hostile shapes without throwing', () => {
        const hostile = [
            JSON.parse('{"phases":{"__proto__":{"settings":{"autoFill":true}}}}'),
            { phases: { a: { settings: invalid<object>(Object.create(null)) } } },
            { phases: { a: { settings: [{ autoFill: true }] } } },
        ];
        for (const item of hostile) expect(() => renameV1ScenarioDocument(item)).not.toThrow();
        expect(Object.keys(Object.prototype)).toEqual([]);
    });
});
