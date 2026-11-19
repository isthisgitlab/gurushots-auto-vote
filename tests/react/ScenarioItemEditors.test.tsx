/**
 * The scenario builder's generic editors: every field kind, list add / move /
 * remove, the number↔yes/no switch of entry fields, and unknown types from
 * hand-edited JSON.
 */

import { useState } from 'react';
import type { ComponentType } from 'preact';
import { act, render, screen, fireEvent, within } from './helpers/test-utils';
import { ItemEditor, ConditionList, ActionList } from '@/components/app/scenarioBuilder/ItemEditors';
import type { BuilderScope } from '@/components/app/scenarioBuilder/ItemEditors';
import { invalid } from '../helpers/invalid';
import { isPlainObject } from '../../src/ts/core/plainObject';
import { isArrayOf, isUnknown, parseJson, parseJsonAs, parseJsonObject } from '../helpers/parseJson';

/** A form control the tests drive: a select, or an input for text / number / checkbox fields. */
type Control = HTMLInputElement | HTMLSelectElement;

/** What Probe hands every editor; `kind` only reaches ItemEditor (the lists ignore it). */
type EditorProps = {
    value: unknown;
    onChange: (next: unknown) => void;
    phases: string[];
    kind: 'condition' | 'action';
    scope?: BuilderScope;
};

// A <select>'s onChange is a native 'change' listener under preact/compat.
const changeSelect = (sel: Control, value: string) =>
    act(() => {
        sel.value = value;
        sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });

/** Keeps the edited value in state and shows it, like the builder does. */
function Probe({
    Editor,
    initial,
    ...props
}: {
    Editor: ComponentType<EditorProps>;
    initial: unknown;
    kind?: EditorProps['kind'];
    scope?: BuilderScope;
}) {
    const [value, setValue] = useState(initial);
    return (
        <div>
            <Editor
                value={value}
                onChange={setValue}
                phases={['main', 'later']}
                {...invalid<Pick<EditorProps, 'kind' | 'scope'>>(props)}
            />
            <output data-testid="value">{JSON.stringify(value ?? null)}</output>
        </div>
    );
}

/** The editor's current value, as the JSON the Probe shows. */
const value = () => parseJson(screen.getByTestId('value').textContent);
const valueObject = () => parseJsonObject(screen.getByTestId('value').textContent);
const valueList = () => parseJsonAs(screen.getByTestId('value').textContent, isArrayOf(isUnknown));
const valueObjects = () => parseJsonAs(screen.getByTestId('value').textContent, isArrayOf(isPlainObject));
/** The one edited item's entry tests, as the tests read them. */
const predicatesOf = () => (valueObject().where as Array<Record<string, unknown>>) ?? [];
// A field's label names both its group and its control; tests want the control.
const controlIn = (container: HTMLElement, name: string) =>
    within(container)
        .getAllByLabelText<Control>(name)
        .find((el) => el.tagName !== 'DIV')!;
const control = (name: string) => controlIn(document.body, name);
const group = (name: string) => screen.getAllByRole('group', { name })[0];

describe('ConditionList', () => {
    test('adds conditions of any type with their defaults', () => {
        render(<Probe Editor={ConditionList} initial={undefined} />);
        changeSelect(control('app.sbAddCondition'), 'beforeEnd');
        changeSelect(control('app.sbAddCondition'), 'dailyWindow');
        expect(value()).toEqual([
            { type: 'beforeEnd', max: '1d' },
            { type: 'dailyWindow', from: '06:00', to: '08:00' },
        ]);
    });

    test('an item without a readable type is named by its position alone', () => {
        render(<Probe Editor={ConditionList} initial={[null, { type: 7 }]} />);
        expect(
            screen.getAllByRole('button', { name: /^app\.sbRemove: / }).map((b) => b.getAttribute('aria-label')),
        ).toEqual(['app.sbRemove: 1', 'app.sbRemove: 2']);
    });

    test('moves and removes items', () => {
        render(
            <Probe
                Editor={ConditionList}
                initial={[
                    { type: 'entries', op: '>', value: 1 },
                    { type: 'freeSlots', op: '>', value: 0 },
                ]}
            />,
        );
        const up = screen.getAllByRole<HTMLButtonElement>('button', { name: /app\.sbMoveUp/ });
        // Each item's buttons are named by the item and its place, so a list of them is not identical rows.
        expect(up.map((button) => button.getAttribute('aria-label'))).toEqual([
            'app.sbMoveUp: app.sbCond_entries 1',
            'app.sbMoveUp: app.sbCond_freeSlots 2',
        ]);
        expect(up[0].disabled).toBe(true);
        fireEvent.click(up[1]);
        expect(valueObjects().map((c) => c.type)).toEqual(['freeSlots', 'entries']);
        fireEvent.click(screen.getAllByRole('button', { name: /app\.sbMoveDown/ })[0]);
        expect(valueObjects().map((c) => c.type)).toEqual(['entries', 'freeSlots']);
        fireEvent.click(screen.getByRole('button', { name: 'app.sbRemove: app.sbCond_entries 1' }));
        expect(value()).toEqual([{ type: 'freeSlots', op: '>', value: 0 }]);
    });

    test('a non-list value reads as empty', () => {
        render(<Probe Editor={ConditionList} initial="nonsense" />);
        changeSelect(control('app.sbAddCondition'), 'exposure');
        expect(value()).toEqual([{ type: 'exposure', op: '>=', value: 0 }]);
    });
});

describe('field kinds', () => {
    test('op, number, time and a type change', () => {
        render(<Probe Editor={ItemEditor} kind="condition" initial={{ type: 'exposure', op: '>=', value: 0 }} />);
        changeSelect(control('app.sbField_op'), '<');
        fireEvent.change(control('app.sbField_value'), { target: { value: '40' } });
        expect(value()).toEqual({ type: 'exposure', op: '<', value: 40 });
        changeSelect(control('app.sbPickType'), 'dailyWindow');
        fireEvent.change(control('app.sbField_from'), { target: { value: '07:30' } });
        expect(value()).toEqual({ type: 'dailyWindow', from: '07:30', to: '08:00' });
    });

    test('optional durations and percents are left out when cleared', () => {
        const { unmount } = render(
            <Probe Editor={ItemEditor} kind="condition" initial={{ type: 'beforeEnd', max: '1d' }} />,
        );
        fireEvent.change(control('app.sbField_min'), { target: { value: '2h' } });
        fireEvent.change(control('app.sbField_max'), { target: { value: '' } });
        expect(value()).toEqual({ type: 'beforeEnd', min: '2h' });
        unmount();
        render(<Probe Editor={ItemEditor} kind="condition" initial={{ type: 'elapsedPercent', min: 50 }} />);
        fireEvent.change(control('app.sbField_max'), { target: { value: '90' } });
        fireEvent.change(control('app.sbField_min'), { target: { value: '' } });
        expect(value()).toEqual({ type: 'elapsedPercent', max: 90 });
    });

    test('states, currency and memory slot', () => {
        const { unmount } = render(
            <Probe Editor={ItemEditor} kind="condition" initial={{ type: 'boostState', in: 'AVAILABLE' }} />,
        );
        fireEvent.click(control('app.sbState_boost_AVAILABLE_KEY'));
        fireEvent.click(control('app.sbState_boost_LOCKED'));
        fireEvent.click(control('app.sbState_boost_LOCKED'));
        expect(value()).toEqual({ type: 'boostState', in: ['AVAILABLE_KEY'] });
        unmount();
        const second = render(
            <Probe
                Editor={ItemEditor}
                kind="condition"
                initial={{ type: 'balance', currency: 'swaps', op: '>', value: 0 }}
            />,
        );
        changeSelect(control('app.sbField_currency'), 'keys');
        expect(valueObject().currency).toBe('keys');
        second.unmount();
        render(<Probe Editor={ItemEditor} kind="condition" initial={{ type: 'memorySet', slot: 'held' }} />);
        fireEvent.change(control('app.sbField_slot'), { target: { value: 'top' } });
        expect(value()).toEqual({ type: 'memorySet', slot: 'top' });
    });

    test('entry conditions: selector, the number↔yes/no switch, and the speed window', () => {
        render(
            <Probe
                Editor={ItemEditor}
                kind="condition"
                initial={{ type: 'entry', select: { by: 'bestRank' }, field: 'votes', op: '>=', value: 0 }}
            />,
        );
        fireEvent.change(control('app.sbField_value'), { target: { value: '30' } });
        fireEvent.change(control('app.sbField_window'), { target: { value: '6h' } });
        changeSelect(control('app.sbField_field'), 'speedRatio');
        expect(value()).toEqual({
            type: 'entry',
            select: { by: 'bestRank' },
            field: 'speedRatio',
            op: '>=',
            value: 30,
            window: '6h',
        });
        changeSelect(control('app.sbField_field'), 'boosted');
        expect(value()).toEqual({ type: 'entry', select: { by: 'bestRank' }, field: 'boosted', op: '=', value: true });
        changeSelect(control('app.sbField_value'), 'false');
        expect(valueObject().value).toBe(false);
        changeSelect(control('app.sbField_field'), 'turbo');
        expect(value()).toEqual(expect.objectContaining({ field: 'turbo', value: false }));
        changeSelect(control('app.sbField_field'), 'rank');
        expect(value()).toEqual(expect.objectContaining({ field: 'rank', op: '>=', value: 0 }));

        const selector = group('app.sbField_select');
        changeSelect(controlIn(selector, 'app.sbPickType'), 'slot');
        changeSelect(controlIn(selector, 'app.sbField_index'), '0');
        expect(valueObject().select).toEqual({ by: 'slot', index: 0 });
        changeSelect(controlIn(selector, 'app.sbPickType'), 'fastest');
        fireEvent.click(controlIn(selector, 'app.sbField_skipProtected'));
        expect(valueObject().select).toEqual({ by: 'fastest', skipProtected: true });
        fireEvent.click(controlIn(selector, 'app.sbField_skipProtected'));
        expect(valueObject().select).toEqual({ by: 'fastest' });
    });

    test('nested all / any / not', () => {
        render(
            <Probe
                Editor={ItemEditor}
                kind="condition"
                initial={{ type: 'not', condition: { type: 'entries', op: '>', value: 1 } }}
            />,
        );
        const inner = group('app.sbField_condition');
        changeSelect(controlIn(inner, 'app.sbPickType'), 'any');
        changeSelect(control('app.sbAddCondition'), 'freeSlots');
        expect(valueObject().condition).toEqual({
            type: 'any',
            of: [
                { type: 'exposure', op: '<', value: 50 },
                { type: 'freeSlots', op: '>=', value: 0 },
            ],
        });
    });

    test('an unknown type (hand-edited JSON) shows no fields; a non-object shows an empty editor', () => {
        const { unmount } = render(<Probe Editor={ItemEditor} kind="condition" initial={{ type: 'mystery' }} />);
        expect(screen.queryAllByRole('group')).toHaveLength(0);
        unmount();
        render(<Probe Editor={ItemEditor} kind="action" initial={null} />);
        changeSelect(control('app.sbPickType'), 'fillExposure');
        expect(value()).toEqual({ type: 'fillExposure' });
    });
});

describe('ActionList', () => {
    test('photo sources, goto phase, notify text, vote percent and swap slots', () => {
        render(<Probe Editor={ActionList} initial={[]} />);
        changeSelect(control('app.sbAddAction'), 'swap');
        changeSelect(control('app.sbField_with'), 'memory');
        fireEvent.change(control('app.sbField_slot'), { target: { value: 'held' } });
        fireEvent.change(control('app.sbField_rememberAdded'), { target: { value: 'filler' } });
        expect(valueList()[0]).toEqual({
            type: 'swap',
            entry: { by: 'bestRank' },
            with: { memory: 'held' },
            rememberAdded: 'filler',
        });
        changeSelect(control('app.sbField_with'), 'best');
        expect(valueObjects()[0].with).toBe('best');

        changeSelect(control('app.sbAddAction'), 'goto');
        changeSelect(control('app.sbField_phase'), 'later');
        changeSelect(control('app.sbAddAction'), 'notify');
        fireEvent.change(control('app.sbField_message'), { target: { value: 'Boost now' } });
        changeSelect(control('app.sbAddAction'), 'vote');
        fireEvent.change(control('app.sbField_toExposure'), { target: { value: '80' } });
        expect(valueList().slice(1)).toEqual([
            { type: 'goto', phase: 'later' },
            { type: 'notify', message: 'Boost now' },
            { type: 'vote', toExposure: 80 },
        ]);
    });
});

// The scope a rule of a challenge scenario in its active stage carries: two writable keys with their descriptors,
// the keys a live value may read, a scenario to hand over to and a profile to use.
const SCOPE: BuilderScope = {
    scope: 'challenge',
    stages: ['active'],
    writableKeys: ['exposure', 'autoSubmit', 'timezone', 'language', 'customTimezones'],
    readableKeys: ['exposure'],
    descriptors: {
        exposure: { kind: 'number', quantity: 'percent' },
        autoSubmit: { kind: 'boolean' },
        timezone: { kind: 'string' },
        language: { kind: 'enum', values: ['en', 'lv'] },
        customTimezones: { kind: 'list' },
    },
    scenarios: ['Other'],
    profiles: ['Evening'],
};

describe('the new kinds', () => {
    test('a setSetting step picks its key and its literal follows what the key takes', () => {
        render(
            <Probe
                Editor={ItemEditor}
                kind="action"
                initial={{ type: 'setSetting', key: 'exposure', value: 10 }}
                scope={SCOPE}
            />,
        );
        // Switching the key resets the value to a literal the new key takes.
        changeSelect(control('app.sbField_key'), 'autoSubmit');
        expect(valueObject().value).toBe(false);
        fireEvent.click(control('app.sbField_value'));
        expect(valueObject().value).toBe(true);
        changeSelect(control('app.sbValueKind'), 'live');
        expect(valueObject().value).toEqual(expect.objectContaining({ kind: 'literal' }));
        changeSelect(control('app.sbValueKind'), 'literal');
        expect(valueObject().value).toBe(false);
    });

    test.each([
        ['autoSubmit', { kind: 'literal', value: false }],
        ['exposure', { kind: 'literal', value: 0, quantity: 'percent' }],
        ['timezone', { kind: 'literal', value: '' }],
        ['language', { kind: 'literal', value: '' }],
        ['customTimezones', { kind: 'literal', value: [] }],
    ])(
        'a live value for %s starts as the type the setting takes, and only kinds that can give it are offered',
        (key, start) => {
            render(
                <Probe
                    Editor={ItemEditor}
                    kind="action"
                    initial={{ type: 'setSetting', key, value: 0 }}
                    scope={SCOPE}
                />,
            );
            changeSelect(control('app.sbValueKind'), 'live');
            expect(valueObject().value).toEqual(start);
            const kinds = [...screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[0].options].map(
                (option) => option.value,
            );
            // A yes/no, a text, a list or a percentage is never an offset or a difference.
            for (const bad of ['offset', 'difference', 'earlier', 'later']) expect(kinds).not.toContain(bad);
            if (key === 'autoSubmit' || key === 'timezone' || key === 'customTimezones') {
                for (const bad of ['add', 'subtract', 'min', 'max']) expect(kinds).not.toContain(bad);
            }
        },
    );

    test('a live value for a setting with no expression form is untyped, and the validator judges it', () => {
        render(
            <Probe
                Editor={ItemEditor}
                kind="action"
                initial={{ type: 'setSetting', key: 'mystery', value: 0 }}
                scope={{
                    ...SCOPE,
                    writableKeys: [...SCOPE.writableKeys, 'mystery'],
                    descriptors: { ...SCOPE.descriptors, mystery: { kind: 'other' } },
                }}
            />,
        );
        changeSelect(control('app.sbValueKind'), 'live');
        expect(valueObject().value).toEqual({ kind: 'literal', value: 0, quantity: 'count' });
        const kinds = [...screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[0].options].map(
            (option) => option.value,
        );
        expect(kinds).toContain('offset');
    });

    test('a literal follows every value kind its key may take', () => {
        render(
            <Probe
                Editor={ItemEditor}
                kind="action"
                initial={{ type: 'setSetting', key: 'exposure', value: 10 }}
                scope={SCOPE}
            />,
        );
        changeSelect(control('app.sbField_key'), 'language');
        changeSelect(control('app.sbField_value'), 'lv');
        expect(valueObject().value).toBe('lv');
        changeSelect(control('app.sbField_key'), 'timezone');
        fireEvent.change(control('app.sbField_value'), { target: { value: 'Europe/Riga' } });
        expect(valueObject().value).toBe('Europe/Riga');
        changeSelect(control('app.sbField_key'), 'customTimezones');
        fireEvent.change(control('app.sbField_value'), { target: { value: 'Riga, Oslo' } });
        expect(valueObject().value).toEqual(['Riga', 'Oslo']);
        // A number key resets to 0, and a key the scope has no descriptor for to the same.
        changeSelect(control('app.sbField_key'), 'exposure');
        expect(valueObject().value).toBe(0);
        // A list literal that is not a list (hand-edited) reads as empty until typed into.
        changeSelect(control('app.sbField_key'), 'customTimezones');
        fireEvent.change(control('app.sbField_value'), { target: { value: '' } });
        expect(valueObject().value).toEqual([]);
    });

    test('a handoff names a stored scenario or none, a profile the same', () => {
        const { unmount } = render(
            <Probe Editor={ItemEditor} kind="action" initial={{ type: 'handoffScenario', to: null }} scope={SCOPE} />,
        );
        changeSelect(control('app.sbField_to'), 'Other');
        expect(valueObject().to).toBe('Other');
        changeSelect(control('app.sbField_to'), '');
        expect(valueObject().to).toBeNull();
        unmount();
        render(<Probe Editor={ItemEditor} kind="action" initial={{ type: 'useProfile', name: null }} scope={SCOPE} />);
        changeSelect(control('app.sbField_name'), 'Evening');
        expect(valueObject().name).toBe('Evening');
    });

    test('a pin picks its power, and a join may narrow its price', () => {
        const { unmount } = render(
            <Probe
                Editor={ItemEditor}
                kind="action"
                initial={{ type: 'setPin', power: 'boost', entry: { by: 'bestRank' } }}
                scope={SCOPE}
            />,
        );
        changeSelect(control('app.sbField_power'), 'turbo');
        expect(valueObject().power).toBe('turbo');
        unmount();
        render(<Probe Editor={ItemEditor} kind="action" initial={{ type: 'join' }} scope={SCOPE} />);
        expect(valueObject().maxCoins).toBeUndefined();
    });

    test('entry tests are added, switched between number and yes/no fields, and removed', () => {
        render(
            <Probe
                Editor={ItemEditor}
                kind="condition"
                initial={{
                    type: 'entryCount',
                    where: [
                        { field: 'votes', op: '>=', value: 0 },
                        invalid<Record<string, unknown>>({}),
                        invalid<unknown>(null),
                    ],
                    op: '>=',
                    value: 0,
                }}
                scope={SCOPE}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: 'app.sbAddPredicate' }));
        expect(valueObject().where).toHaveLength(4);
        const rows = screen.getAllByRole('group', { name: /app\.sbRemove: / });
        changeSelect(within(rows[1]).getAllByLabelText<HTMLSelectElement>('app.sbField_field')[0], 'boosted');
        expect(predicatesOf()[1]).toEqual({ field: 'boosted', op: '=', value: true });
        changeSelect(within(rows[1]).getAllByLabelText<HTMLSelectElement>('app.sbField_value')[0], 'false');
        expect(predicatesOf()[1].value).toBe(false);
        changeSelect(within(rows[1]).getAllByLabelText<HTMLSelectElement>('app.sbField_field')[0], 'rank');
        expect(predicatesOf()[1]).toEqual({ field: 'rank', op: '>=', value: 0 });
        fireEvent.change(within(rows[0]).getAllByLabelText('app.sbField_value').at(-1) as HTMLInputElement, {
            target: { value: '9' },
        });
        expect(predicatesOf()[0].value).toBe(9);
        changeSelect(within(rows[2]).getAllByLabelText<HTMLSelectElement>('app.sbField_op')[0], '<=');
        expect(predicatesOf()[2]).toEqual({ op: '<=' });
        fireEvent.click(within(rows[3]).getByRole('button', { name: /app\.sbRemove: 4/ }));
        fireEvent.click(within(rows[2]).getByRole('button', { name: /app\.sbRemove: 3/ }));
        fireEvent.click(within(rows[1]).getByRole('button', { name: /app\.sbRemove: 2/ }));
        expect(valueObject().where).toHaveLength(1);
    });

    test('live-value fields hold the expression editor', () => {
        render(
            <Probe
                Editor={ItemEditor}
                kind="condition"
                initial={{
                    type: 'compare',
                    left: { kind: 'literal', value: 0, quantity: 'count' },
                    op: '=',
                    right: { kind: 'literal', value: 0, quantity: 'count' },
                }}
                scope={SCOPE}
            />,
        );
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[0], 'setting');
        expect(valueObject().left).toEqual({ kind: 'setting', key: 'exposure', view: 'base' });
    });
});

describe('what the stages offer', () => {
    test('an installation rule is offered only what runs outside a challenge', () => {
        const account: BuilderScope = { ...SCOPE, scope: 'installation', stages: ['account'] };
        render(
            <Probe
                Editor={ItemEditor}
                kind="condition"
                initial={{ type: 'memorySet', slot: 'held' }}
                scope={account}
            />,
        );
        const options = [...screen.getAllByLabelText<HTMLSelectElement>('app.sbPickType')[0].options].map(
            (option) => option.value,
        );
        expect(options).not.toContain('boostState');
        expect(options).not.toContain('entry');
        expect(options).toContain('compare');
    });

    test('a rule of several stages is offered only what every stage allows', () => {
        const both: BuilderScope = { ...SCOPE, stages: ['preJoin', 'active'] };
        render(<Probe Editor={ItemEditor} kind="action" initial={{ type: 'notify', message: 'Hi' }} scope={both} />);
        const options = [...screen.getAllByLabelText<HTMLSelectElement>('app.sbPickType')[0].options].map(
            (option) => option.value,
        );
        // No operation is allowed in both stages, so an automation step is not offered at all.
        expect(options).not.toContain('runAutomation');
        expect(options).toContain('setSetting');
        // join runs only before joining, boost only while active: neither runs in both stages.
        expect(options).not.toContain('join');
        expect(options).not.toContain('claimChallengeReward');
        expect(options).not.toContain('boost');
        const preJoin: BuilderScope = { ...SCOPE, stages: ['preJoin'] };
        const second = render(
            <Probe Editor={ItemEditor} kind="action" initial={{ type: 'notify', message: 'Hi' }} scope={preJoin} />,
        );
        expect(
            [
                ...within(second.container as HTMLElement).getAllByLabelText<HTMLSelectElement>('app.sbPickType')[0]
                    .options,
            ].map((option) => option.value),
        ).toContain('join');
        second.unmount();
    });
});

test('a key the scope has no descriptor for still resets to a number', () => {
    const loose: BuilderScope = { ...SCOPE, writableKeys: [...SCOPE.writableKeys, 'mystery'] };
    render(
        <Probe
            Editor={ItemEditor}
            kind="action"
            initial={{ type: 'setSetting', key: 'exposure', value: 5 }}
            scope={loose}
        />,
    );
    changeSelect(control('app.sbField_key'), 'mystery');
    expect(valueObject().value).toBe(0);
});

test('a hand-edited list of tests that is not a list reads as empty', () => {
    render(
        <Probe
            Editor={ItemEditor}
            kind="condition"
            initial={invalid<{ type: string; where?: unknown; op?: string; value?: number }>({
                type: 'entryCount',
                where: 5,
                op: '>=',
                value: 0,
            })}
            scope={SCOPE}
        />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'app.sbAddPredicate' }));
    expect(predicatesOf()).toEqual([{ field: 'votes', op: '>=', value: 0 }]);
});

test('a setSetting value a hand edit left the wrong kind reads as a number', () => {
    render(
        <Probe
            Editor={ItemEditor}
            kind="action"
            initial={invalid<Record<string, unknown>>({ type: 'setSetting', key: 'customTimezones', value: 'junk' })}
            scope={SCOPE}
        />,
    );
    expect((control('app.sbField_value') as HTMLInputElement).value).toBe('');
});

test('a profile is cleared back to none', () => {
    render(<Probe Editor={ItemEditor} kind="action" initial={{ type: 'useProfile', name: 'Evening' }} scope={SCOPE} />);
    changeSelect(control('app.sbField_name'), '');
    expect(valueObject().name).toBeNull();
});

test('a setting key with a translated name shows the name', () => {
    const { mockTranslator } = jest.requireActual('./helpers/setup') as typeof import('./helpers/setup');
    const original = mockTranslator.t.getMockImplementation();
    mockTranslator.t.mockImplementation((key: string) =>
        key === 'app.language' ? 'Language' : key === 'app.en' ? 'English' : key,
    );
    try {
        render(
            <Probe
                Editor={ItemEditor}
                kind="action"
                initial={{ type: 'setSetting', key: 'language', value: 'en' }}
                scope={SCOPE}
            />,
        );
        expect(within(control('app.sbField_key')).getByText('Language')).toBeTruthy();
        expect(within(control('app.sbField_value')).getByText('English')).toBeTruthy();
    } finally {
        mockTranslator.t.mockImplementation(original);
    }
});
