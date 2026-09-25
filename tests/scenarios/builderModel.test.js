/**
 * Pure draft edits for the scenario builder.
 */

const model = require('../../src/js/scenarios/builderModel');

describe('setIn / getIn', () => {
    test('replaces a nested value without mutating the original', () => {
        const doc = { a: { b: [1, 2] } };
        const next = model.setIn(doc, ['a', 'b', 1], 9);
        expect(next).toEqual({ a: { b: [1, 9] } });
        expect(doc).toEqual({ a: { b: [1, 2] } });
        expect(model.getIn(next, ['a', 'b', 1])).toBe(9);
        expect(model.getIn(next, ['x', 'y'])).toBeUndefined();
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
            later: { settings: { autoFill: false } },
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
        expect(renamed.phases.first.rules[0].do[0]).toEqual({ type: 'goto', phase: 'end' });
        expect(renamed.phases.end).toEqual({ settings: { autoFill: false } });
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
        const withRule = model.setIn(doc, ['phases', 'later', 'rules'], [{ id: 'main-2', do: [] }]);
        expect(model.newRule(withRule, 'main').id).toBe('main-3');
        expect(model.newRule(doc, 'later')).toEqual({
            id: 'later-2',
            do: [{ type: 'notify', message: 'Check the challenge' }],
        });
    });
});

test('isEditableDraft accepts the shapes the forms can render', () => {
    expect(model.isEditableDraft(model.newScenario('Plan'))).toBe(true);
    expect(model.isEditableDraft({ phases: { a: { settings: {}, rules: [{ do: [], if: [] }] } } })).toBe(true);
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
    ]) {
        expect(model.isEditableDraft(bad)).toBe(false);
    }
});
