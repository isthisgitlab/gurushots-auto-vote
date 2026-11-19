/**
 * Pure draft edits for the scenario builder.
 */

import { invalid } from '../helpers/invalid';
import model = require('../../src/ts/core/scenarios/builderModel');

describe('setIn', () => {
    test('replaces a nested value without mutating the original', () => {
        const doc = { a: { b: [1, 2] } };
        const next = model.setIn(doc, ['a', 'b', 1], 9);
        expect(next).toEqual({ a: { b: [1, 9] } });
        expect(doc).toEqual({ a: { b: [1, 2] } });
    });

    test('creates missing containers, and undefined removes a key or an item', () => {
        expect(model.setIn({}, ['a', 0, 'b'], 1)).toEqual({ a: [{ b: 1 }] });
        expect(model.setIn({}, ['a', 'b'], 1)).toEqual({ a: { b: 1 } });
        expect(model.setIn({ a: 1, b: 2 }, ['a'], undefined)).toEqual({ b: 2 });
        expect(model.setIn({ list: [1, 2, 3] }, ['list', 1], undefined)).toEqual({ list: [1, 3] });
        expect(model.setIn({ a: 1 }, [], { b: 2 })).toEqual({ b: 2 });
    });
});

test('moveItem swaps neighbours and ignores out-of-range moves', () => {
    expect(model.moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    const list = [1, 2];
    expect(model.moveItem(list, 0, -1)).toBe(list);
    expect(model.moveItem(list, 1, 1)).toBe(list);
});

describe('phases', () => {
    const doc = {
        ...model.newScenario('Plan'),
        phases: {
            main: {
                rules: [
                    {
                        id: 'r',
                        do: [
                            { type: 'goto', phase: 'later' },
                            { type: 'notify', message: 'x' },
                        ],
                    },
                ],
            },
            later: { settings: { autoSubmit: false } },
        },
    };

    test('newScenario and addPhase', () => {
        expect(model.newScenario('Plan')).toEqual({
            name: 'Plan',
            version: 1,
            start: 'main',
            phases: { main: { rules: [] } },
        });
        expect(Object.keys(model.addPhase(model.addPhase(doc)).phases)).toEqual(['main', 'later', 'phase2', 'phase3']);
    });

    test('renamePhase follows start and gotos, keeping order', () => {
        const renamed = model.renamePhase(model.renamePhase(doc, 'later', 'end'), 'main', 'first');
        expect(Object.keys(renamed.phases)).toEqual(['first', 'end']);
        expect(renamed.start).toBe('first');
        expect(renamed.phases.first.rules![0].do[0]).toEqual({ type: 'goto', phase: 'end' });
        expect(renamed.phases.end).toEqual({ settings: { autoSubmit: false } });
    });

    test('renamePhase refuses a no-op, an empty name and a taken name', () => {
        expect(model.renamePhase(doc, 'main', 'main')).toBe(doc);
        expect(model.renamePhase(doc, 'main', '')).toBe(doc);
        expect(model.renamePhase(doc, 'main', 'later')).toBe(doc);
    });

    test('removePhase keeps at least one and moves start', () => {
        expect(Object.keys(model.removePhase(doc, 'later').phases)).toEqual(['main']);
        expect(model.removePhase(doc, 'main').start).toBe('later');
        const single = model.newScenario('One');
        expect(model.removePhase(single, 'main')).toBe(single);
    });

    test('newRule ids are unique across the scenario', () => {
        const withRule = model.setIn(doc, ['phases', 'later', 'rules'], [{ id: 'main-1', do: [] }]);
        expect(model.newRule(withRule, 'main').id).toBe('main-2');
        expect(model.newRule(doc, 'later')).toEqual({
            id: 'later-1',
            repeat: 'once',
            do: [{ type: 'notify', message: 'Check the challenge' }],
        });
    });
});

test('isEditableDraft accepts the shapes the forms can render', () => {
    expect(model.isEditableDraft(model.newScenario('Plan'))).toBe(true);
    expect(model.isEditableDraft({ phases: { a: { settings: {}, rules: [{ do: [], if: [] }] } } })).toBe(true);
    expect(
        model.isEditableDraft({
            phases: {
                a: {
                    bindings: { exposure: 1 },
                    schedules: { submit: {} },
                    profile: 'P',
                    pins: { boost: 'p1' },
                    photoPool: { name: 'K' },
                    rules: [{ do: [], stages: ['active'] }],
                },
            },
        }),
    ).toBe(true);
    for (const bad of [
        null,
        [],
        5,
        { phases: [] },
        { phases: { a: null } },
        { phases: { a: { settings: [] } } },
        { phases: { a: { rules: {} } } },
        { phases: { a: { rules: [null] } } },
        { phases: { a: { rules: [{ do: {} }] } } },
        { phases: { a: { rules: [{ do: [], if: {} }] } } },
        { phases: { a: { rules: [{ do: [], stages: 'always' }] } } },
        { phases: { a: { bindings: [] } } },
        { phases: { a: { schedules: 'soon' } } },
        { phases: { a: { pins: 1 } } },
        { phases: { a: { photoPool: false } } },
        { phases: { a: { profile: 7 } } },
    ]) {
        expect(model.isEditableDraft(bad)).toBe(false);
    }
});

describe('bindPhotoPool', () => {
    const draft = (phases: Record<string, unknown>) =>
        invalid<Parameters<typeof model.bindPhotoPool>[0]>({
            name: 'Plan',
            start: 'main',
            phases,
            description: 'Mine',
        });

    test('binds the pool to the phase and changes nothing else on the draft as it is now', () => {
        const before = draft({ main: { settings: { exposure: 10 } }, later: {} });
        const after = model.bindPhotoPool(before, 'main', 'Beach');
        expect(after.phases.main).toEqual({ settings: { exposure: 10 }, photoPool: { name: 'Beach' } });
        expect(after.phases.later).toEqual({});
        expect(after.description).toBe('Mine');
        // The draft that came in is not changed.
        expect(before.phases.main).toEqual({ settings: { exposure: 10 } });
    });

    test('replaces the pool the phase had, flags and all', () => {
        const after = model.bindPhotoPool(draft({ main: { photoPool: { name: 'Old', only: true } } }), 'main', 'New');
        expect(after.phases.main.photoPool).toEqual({ name: 'New' });
    });

    test('a phase that is gone leaves the draft as it is', () => {
        const before = draft({ main: {} });
        expect(model.bindPhotoPool(before, 'gone', 'Beach')).toBe(before);
        // A name that only the prototype has is no phase.
        expect(model.bindPhotoPool(before, 'constructor', 'Beach')).toBe(before);
    });

    test.each([
        ['a setting', { settings: { chosenPhotosOnly: true } }],
        ['a live value', { bindings: { chosenPhotos: { kind: 'literal', value: [] } } }],
    ])('a phase that holds Chosen Photos as %s is not bound over them', (_label, phase) => {
        const before = draft({ main: phase });
        expect(model.bindPhotoPool(before, 'main', 'Beach')).toBe(before);
    });
});
