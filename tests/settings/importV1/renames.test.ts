/**
 * The 1.x to 2.x setting-key renames: the table, and renaming the keys of a values map and of a scenario document.
 */

import {
    V1_KEY_RENAMES,
    V1_REFUSED_KEY_PREFIX,
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

describe.each(['drop-targets', 'keep-lone-targets'] as const)('renameV1Keys (%s)', (mode) => {
    test('renames the keys, leaves the values and every other key alone, and keeps the order', () => {
        const values = {
            exposure: 90,
            autoFill: true,
            emergencyFill: 300,
            autoFillSchedule: [{ count: 2, seconds: 60 }],
            scenario: 'Plan',
        };
        const renamed = renameV1Keys(values, mode);
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

    test('the 1.x key wins over a 2.x-named key beside it, which 1.x never read', () => {
        expect(renameV1Keys({ autoSubmit: false, autoFill: true }, mode)).toEqual({ autoSubmit: true });
        expect(renameV1Keys({ autoFill: true, autoSubmit: false }, mode)).toEqual({ autoSubmit: true });
    });

    test('a key named like a prototype member stays an ordinary key', () => {
        const renamed = renameV1Keys(parseJsonObject('{"__proto__":{"x":1},"constructor":2,"autoFill":true}'), mode);
        expect(Object.keys(renamed)).toEqual(['__proto__', 'constructor', 'autoSubmit']);
        expect(Object.getPrototypeOf(renamed)).toBe(Object.prototype);
        expect(({} as Record<string, unknown>).x).toBeUndefined();
    });
});

describe('a 2.x-named key with no 1.x counterpart', () => {
    const lone = { exposure: 90, autoSubmit: false, boostNewSubmit: true };

    test('is dropped from a 1.x settings map, where 1.x never read it', () => {
        expect(renameV1Keys(lone, 'drop-targets')).toEqual({ exposure: 90 });
    });

    test('stays in a map from outside, which a 2.x install may have written already renamed', () => {
        expect(renameV1Keys(lone, 'keep-lone-targets')).toEqual(lone);
    });

    test('every rename target is treated alike', () => {
        const targets = Object.fromEntries(Object.values(V1_KEY_RENAMES).map((key) => [key, 1]));
        expect(renameV1Keys(targets, 'drop-targets')).toEqual({});
        expect(renameV1Keys(targets, 'keep-lone-targets')).toEqual(targets);
    });
});

describe('renameV1Value', () => {
    test('renames a plain object and returns anything else as it is', () => {
        expect(renameV1Value({ autoFill: true }, 'drop-targets')).toEqual({ autoSubmit: true });
        expect(renameV1Value({ autoSubmit: true }, 'drop-targets')).toEqual({});
        expect(renameV1Value({ autoSubmit: true }, 'keep-lone-targets')).toEqual({ autoSubmit: true });
        const list = [{ autoFill: true }];
        for (const other of [list, 'text', 4, null, undefined]) {
            expect(renameV1Value(other, 'drop-targets')).toBe(other);
        }
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

    test('a lone 2.x name survives in a file from outside (the default), as a file exported by 2.x is renamed already', () => {
        const exported = { name: 'Plan', phases: { a: { settings: { autoSubmit: true, autoFill: false } } } };
        expect(renameV1ScenarioDocument(exported)).toEqual({
            name: 'Plan',
            phases: { a: { settings: { autoSubmit: false } } },
        });
        const renamed = { name: 'Plan', phases: { a: { settings: { autoSubmit: true, exposure: 80 } } } };
        expect(renameV1ScenarioDocument(renamed)).toEqual(renamed);
        expect(renameV1ScenarioDocument(renamed, 'keep-lone-targets')).toEqual(renamed);
    });

    test('in a 1.x settings file a 2.x name is kept refused: under a name no setting answers to, never dropped', () => {
        const stray = {
            name: 'Plan',
            phases: { a: { settings: { autoSubmit: true, autoFill: false, exposure: 80 } } },
        };
        expect(renameV1ScenarioDocument(stray, 'drop-targets')).toEqual({
            name: 'Plan',
            phases: {
                a: { settings: { exposure: 80, autoSubmit: false, [`${V1_REFUSED_KEY_PREFIX}autoSubmit`]: true } },
            },
        });
        const lone = { phases: { a: { settings: { boostNewSubmit: 1 } } } };
        expect(renameV1ScenarioDocument(lone, 'drop-targets')).toEqual({
            phases: { a: { settings: { [`${V1_REFUSED_KEY_PREFIX}boostNewSubmit`]: 1 } } },
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
