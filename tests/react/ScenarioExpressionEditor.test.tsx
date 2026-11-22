/**
 * The live-value expression editor: every kind's form, the stage and expected-type
 * filtering of facts, nesting under the depth cap, and the operand cap of the
 * aggregates.
 */

import { useState } from 'react';
import { act, render, screen, fireEvent, within } from './helpers/test-utils';
import { ExpressionEditor } from '@/components/app/scenarioBuilder/ExpressionEditor';
import { invalid } from '../helpers/invalid';
import { isPlainObject } from '../../src/ts/core/plainObject';
import { parseJson, parseJsonObject } from '../helpers/parseJson';

type Control = HTMLInputElement | HTMLSelectElement;

const changeSelect = (sel: Control, value: string) =>
    act(() => {
        sel.value = value;
        sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });

/**
 * Types into an input. preact/compat serves an input's onChange from the native 'input' event, and
 * fireEvent.change only aliases that once its compat probe has flipped, so the native events go out
 * directly — deterministic from a file's very first interaction.
 */
const changeInput = (input: Control, value: string) =>
    act(() => {
        input.value = value;
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
    });

const STAGES = {
    active: ['active'] as ('active' | 'preJoin' | 'postClose' | 'account')[],
    account: ['account'] as ('active' | 'preJoin' | 'postClose' | 'account')[],
};

function Probe({
    initial,
    expected,
    stages = STAGES.active,
}: {
    initial: unknown;
    expected?: string;
    stages?: ('active' | 'preJoin' | 'postClose' | 'account')[];
}) {
    const [value, setValue] = useState(initial);
    return (
        <div>
            <ExpressionEditor
                value={value}
                onChange={setValue}
                context={{
                    stages,
                    settingKeys: ['exposure' as const, 'autoJoinMaxCoins' as const],
                }}
                {...invalid<Pick<Parameters<typeof ExpressionEditor>[0], 'expected'>>(expected ? { expected } : {})}
            />
            <output data-testid="value">{JSON.stringify(value ?? null)}</output>
        </div>
    );
}

const value = () => parseJson(screen.getByTestId('value').textContent);
const valueObject = () => parseJsonObject(screen.getByTestId('value').textContent);
const control = (name: string) => screen.getAllByLabelText<Control>(name).at(-1)!;
const selectOf = (name: string) => screen.getAllByLabelText<HTMLSelectElement>(name).at(-1)!;

describe('literal', () => {
    test('a number literal edits its value and quantity, and a duration picks a unit', () => {
        render(<Probe initial={{ kind: 'literal', value: 10, quantity: 'instant' }} />);
        changeInput(control('app.sbField_value'), '20');
        changeSelect(control('app.sbField_quantity'), 'duration');
        expect(value()).toEqual({ kind: 'literal', value: 20, quantity: 'duration', unit: 'hours' });
        // A unit is a duration's own.
        expect(screen.getByLabelText('app.sbField_unit')).toBeTruthy();
        changeSelect(control('app.sbField_quantity'), 'percent');
        expect(valueObject().unit).toBeUndefined();
        expect(screen.queryByLabelText('app.sbField_unit')).toBeNull();
    });

    test('a typed field offers only its own literal kind, an untyped one every kind', () => {
        const typed = render(
            <Probe
                initial={{ kind: 'literal', value: '1d', quantity: 'duration', unit: 'hours' }}
                expected="duration"
            />,
        );
        expect(screen.queryByLabelText('app.sbLiteralKind')).toBeNull();
        typed.unmount();
        render(<Probe initial={{ kind: 'literal', value: 0, quantity: 'count' }} />);
        changeSelect(control('app.sbLiteralKind'), 'boolean');
        expect(value()).toEqual({ kind: 'literal', value: false });
        fireEvent.click(control('app.sbField_value'));
        expect(valueObject().value).toBe(true);
        changeSelect(control('app.sbLiteralKind'), 'list');
        changeInput(control('app.sbField_value'), 'sunset, night');
        expect(value()).toEqual({ kind: 'literal', value: ['sunset', 'night'] });
        changeSelect(control('app.sbLiteralKind'), 'number');
        expect(value()).toEqual({ kind: 'literal', value: 0, quantity: 'count' });
        changeSelect(control('app.sbLiteralKind'), 'text');
        expect(value()).toEqual({ kind: 'literal', value: '' });
        changeInput(control('app.sbField_value'), 'sunset');
        expect(value()).toEqual({ kind: 'literal', value: 'sunset' });
    });
});

describe('fact', () => {
    test('picks a fact of the expected type that runs in the stages of the rule', () => {
        render(<Probe initial={null} expected="instant" />);
        changeSelect(control('app.sbExprKind'), 'fact');
        const picked = valueObject();
        expect(picked).toEqual(expect.objectContaining({ kind: 'fact' }));
        const options = [...selectOf('app.sbField_name').options].map((option) => option.value);
        expect(options).toContain('challenge.end');
        expect(options).not.toContain('challenge.title');
        expect(options).toContain('clock.now');
    });

    test('an installation rule is not offered challenge facts', () => {
        render(<Probe initial={{ kind: 'fact', name: 'clock.now' }} stages={STAGES.account} />);
        const options = [...selectOf('app.sbField_name').options].map((option) => option.value);
        expect(options).toContain('clock.now');
        expect(options).not.toContain('challenge.end');
        expect(options).not.toContain('boost.state');
    });

    test('an entry fact offers its selector and a speed fact its window', () => {
        render(<Probe initial={{ kind: 'fact', name: 'entry.votes' }} />);
        const selector = screen.getAllByRole('group', { name: 'app.sbField_select' }).at(-1)!;
        changeSelect(within(selector).getAllByLabelText<HTMLSelectElement>('app.sbPickType').at(-1)!, 'slot');
        expect(valueObject()).toEqual({ kind: 'fact', name: 'entry.votes', select: { by: 'slot', index: 1 } });
    });
});

describe('setting', () => {
    test('references one of the eligible keys in a chosen view', () => {
        render(<Probe initial={null} />);
        changeSelect(control('app.sbExprKind'), 'setting');
        expect(value()).toEqual({ kind: 'setting', key: 'exposure', view: 'base' });
        changeSelect(control('app.sbField_key'), 'autoJoinMaxCoins');
        changeSelect(control('app.sbField_view'), 'effective');
        expect(value()).toEqual({ kind: 'setting', key: 'autoJoinMaxCoins', view: 'effective' });
    });
});

describe('composite kinds', () => {
    test('offset, difference, add and subtract nest their operands', () => {
        const first = render(<Probe initial={null} />);
        changeSelect(control('app.sbExprKind'), 'offset');
        expect(valueObject()).toEqual(
            expect.objectContaining({
                kind: 'offset',
                by: { kind: 'literal', value: 0, quantity: 'duration', unit: 'hours' },
                direction: 'before',
            }),
        );
        changeSelect(control('app.sbField_direction'), 'after');
        expect(valueObject().direction).toBe('after');
        first.unmount();
        const second = render(<Probe initial={null} />);
        changeSelect(control('app.sbExprKind'), 'difference');
        expect(valueObject().kind).toBe('difference');
        second.unmount();
        render(<Probe initial={null} />);
        changeSelect(control('app.sbExprKind'), 'add');
        expect(value()).toEqual(
            expect.objectContaining({
                kind: 'add',
                left: { kind: 'literal', value: 0, quantity: 'duration', unit: 'hours' },
                right: { kind: 'literal', value: 0, quantity: 'duration', unit: 'hours' },
            }),
        );
    });

    test('earlier holds 2 to 8 operands; a full one stops offering more', () => {
        render(<Probe initial={null} />);
        changeSelect(control('app.sbExprKind'), 'earlier');
        expect(valueObject().of).toHaveLength(2);
        const add = () => fireEvent.click(screen.getAllByRole('button', { name: 'app.sbAddOperand' }).at(-1)!);
        for (let n = 0; n < 6; n++) add();
        expect(valueObject().of).toHaveLength(8);
        expect(screen.getAllByRole<HTMLButtonElement>('button', { name: 'app.sbAddOperand' }).at(-1)!.disabled).toBe(
            true,
        );
        fireEvent.click(screen.getAllByRole('button', { name: /^app\.sbRemove: / }).at(-1)!);
        expect(valueObject().of).toHaveLength(7);
    });

    describe('focus after adding and removing an operand', () => {
        /** A failed toBe on a DOM node makes Jest print the whole page: compare as a boolean. */
        const isFocused = (element: Element | undefined) => document.activeElement === element;
        const removeOperand = (position: number) =>
            screen.getByRole<HTMLButtonElement>('button', { name: `app.sbRemove: ${position}` });
        const addOperands = (count: number) => {
            for (let n = 0; n < count; n++)
                fireEvent.click(screen.getAllByRole('button', { name: 'app.sbAddOperand' }).at(-1)!);
        };

        test('adding an operand lands on the first control of the new operand', () => {
            render(<Probe initial={null} />);
            changeSelect(control('app.sbExprKind'), 'earlier');
            addOperands(1);
            expect(valueObject().of).toHaveLength(3);
            const kinds = screen.getAllByLabelText('app.sbExprKind');
            expect(isFocused(kinds.at(-1))).toBe(true);
        });

        test('adding the last operand a full list takes still lands on the new operand', () => {
            render(<Probe initial={null} />);
            changeSelect(control('app.sbExprKind'), 'earlier');
            addOperands(6);
            expect(valueObject().of).toHaveLength(8);
            expect(isFocused(screen.getAllByLabelText('app.sbExprKind').at(-1))).toBe(true);
        });

        test('removing an operand lands on the remove button now in its place, else the previous one', () => {
            render(<Probe initial={null} />);
            changeSelect(control('app.sbExprKind'), 'earlier');
            addOperands(2);
            fireEvent.click(removeOperand(2));
            expect(isFocused(removeOperand(2))).toBe(true);
            fireEvent.click(removeOperand(3));
            expect(valueObject().of).toHaveLength(2);
            // Two operands are the least: both remove buttons are off, so the add button takes it.
            expect(isFocused(screen.getByRole('button', { name: 'app.sbAddOperand' }))).toBe(true);
        });

        test('removing the last of three lands on the previous remove button', () => {
            render(<Probe initial={null} />);
            changeSelect(control('app.sbExprKind'), 'earlier');
            addOperands(2);
            fireEvent.click(removeOperand(4));
            expect(isFocused(removeOperand(3))).toBe(true);
        });
    });

    test('at the depth cap only whole values are offered', () => {
        render(<ExpressionEditorDepthTest />);
        const kinds = [...screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind').at(-1)!.options]
            .map((o) => o.value)
            .filter((value) => value !== '');
        expect(kinds).toEqual(['literal', 'fact', 'setting']);
    });
});

/** A nested editor at the deepest allowed level, through a chain of offsets. */
function ExpressionEditorDepthTest() {
    const [value, setValue] = useState<unknown>(null);
    return (
        <ExpressionEditor
            value={value}
            onChange={setValue}
            context={{ stages: STAGES.active, settingKeys: ['exposure'], depth: 7 }}
        />
    );
}

describe('hand-edited values', () => {
    test('a value that is no expression reads as the default of its picked kind', () => {
        render(<Probe initial="nonsense" />);
        changeSelect(control('app.sbExprKind'), 'fact');
        expect(isPlainObject(valueObject())).toBe(true);
        expect(valueObject().kind).toBe('fact');
    });
});

describe('edges of the literal and fact forms', () => {
    test('a literal with no readable value offers the kinds from a placeholder', () => {
        render(<Probe initial={{ kind: 'literal', value: null }} />);
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbLiteralKind').value).toBe('');
        changeSelect(control('app.sbLiteralKind'), 'text');
        expect(value()).toEqual({ kind: 'literal', value: '' });
        changeInput(control('app.sbField_value'), 'sunset');
        expect(value()).toEqual({ kind: 'literal', value: 'sunset' });
    });

    test('a duration literal without a unit reads in hours until another is picked', () => {
        render(<Probe initial={{ kind: 'literal', value: 5, quantity: 'duration' }} />);
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbField_unit').value).toBe('hours');
        changeSelect(control('app.sbField_unit'), 'days');
        expect(valueObject().unit).toBe('days');
    });

    test('a list literal shows its items comma-separated', () => {
        render(<Probe initial={{ kind: 'literal', value: ['a', 'b'] }} />);
        expect((control('app.sbField_value') as HTMLInputElement).value).toBe('a, b');
    });

    test('a speed fact carries its measuring window, and clearing it leaves it out', () => {
        render(<Probe initial={{ kind: 'fact', name: 'entry.votesPerHour', window: '6h' }} />);
        expect((control('app.sbField_window') as HTMLInputElement).value).toBe('6h');
        changeInput(control('app.sbField_window'), '');
        expect(valueObject().window).toBeUndefined();
        changeInput(control('app.sbField_window'), '2h');
        expect(valueObject().window).toBe('2h');
    });
});

describe('typed and hand-edited literals and facts', () => {
    test('a yes-no field holds a yes-no literal, and a duration field a typed sum', () => {
        const first = render(<Probe initial={null} expected="boolean" />);
        changeSelect(control('app.sbExprKind'), 'literal');
        expect(value()).toEqual({ kind: 'literal', value: false });
        first.unmount();
        const second = render(<Probe initial={null} expected="duration" />);
        changeSelect(control('app.sbExprKind'), 'add');
        expect(valueObject()).toEqual(
            expect.objectContaining({
                kind: 'add',
                left: { kind: 'literal', value: 0, quantity: 'duration', unit: 'hours' },
                right: { kind: 'literal', value: 0, quantity: 'duration', unit: 'hours' },
            }),
        );
        second.unmount();
        const third = render(<Probe initial={null} />);
        // The first kind select is the value's own; the operands carry the rest.
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[0], 'min');
        expect(valueObject().of).toHaveLength(2);
        fireEvent.click(screen.getAllByRole('button', { name: 'app.sbAddOperand' })[0]);
        expect(valueObject().of).toHaveLength(3);
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[0], 'max');
        expect(valueObject().kind).toBe('max');
        third.unmount();
        const fourth = render(<Probe initial={null} expected="votes" />);
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[0], 'min');
        expect((valueObject().of as unknown[])[0]).toEqual({ kind: 'literal', value: 0, quantity: 'votes' });
        fourth.unmount();
    });

    test('a string field holds a text literal, a list field a list one', () => {
        const first = render(<Probe initial={null} expected="string" />);
        changeSelect(control('app.sbExprKind'), 'literal');
        expect(screen.getByLabelText('app.sbField_value')).toBeTruthy();
        first.unmount();
        render(<Probe initial={null} expected="list" />);
        changeSelect(control('app.sbExprKind'), 'literal');
        expect(screen.getByPlaceholderText('sunset, night')).toBeTruthy();
    });

    test('the placeholder option of the literal kinds stays a no-op', () => {
        render(<Probe initial={{ kind: 'literal', value: null }} />);
        changeSelect(control('app.sbLiteralKind'), '');
        expect(value()).toEqual({ kind: 'literal', value: null });
    });

    test('a fact name no vocabulary knows reads as none picked', () => {
        render(<Probe initial={{ kind: 'fact', name: 'nonsense' }} />);
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbField_name').value).toBe('');
        changeSelect(control('app.sbField_name'), 'clock.now');
        expect(valueObject().name).toBe('clock.now');
    });

    test('hand-edited composites with no fields of their own read as their defaults', () => {
        const first = render(<Probe initial={{ kind: 'setting' }} />);
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbField_key').value).toBe('');
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbField_view').value).toBe('base');
        first.unmount();
        const second = render(<Probe initial={{ kind: 'offset' }} />);
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbField_direction').value).toBe('before');
        second.unmount();
        render(<Probe initial={{ kind: 'difference' }} />);
        expect(screen.getAllByLabelText('app.sbExprKind').length).toBeGreaterThan(1);
    });

    test('an aggregate whose operands are not a list reads as none', () => {
        render(<Probe initial={invalid<Record<string, unknown>>({ kind: 'earlier', of: 'junk' })} />);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbAddOperand' }).disabled).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'app.sbAddOperand' }));
        expect(valueObject().of).toHaveLength(1);
    });

    test('a setting key with a translated name shows the name', () => {
        const { mockTranslator } = jest.requireActual('./helpers/setup') as typeof import('./helpers/setup');
        const original = mockTranslator.t.getMockImplementation();
        mockTranslator.t.mockImplementation((key: string) => (key === 'app.exposure' ? 'Exposure' : key));
        render(<Probe initial={null} />);
        changeSelect(control('app.sbExprKind'), 'setting');
        expect(within(control('app.sbField_key')).getByText('Exposure')).toBeTruthy();
        mockTranslator.t.mockImplementation(original);
    });
});

describe('a value worked out before the phase applies (a binding, a schedule)', () => {
    const { FACTS } = jest.requireActual(
        '../../src/ts/core/scenarios/facts',
    ) as typeof import('../../src/ts/core/scenarios/facts');
    const { FACT_NAMES } = jest.requireActual(
        '../../src/ts/core/scenarios/vocabulary',
    ) as typeof import('../../src/ts/core/scenarios/vocabulary');
    const policyFact = FACT_NAMES.find(
        (name) => FACTS[name].classification === 'policy' && FACTS[name].stages.includes('active'),
    );
    const rawFact = FACT_NAMES.find(
        (name) => FACTS[name].classification === 'raw' && FACTS[name].stages.includes('active'),
    );

    function BaseOnlyProbe({ baseOnly }: { baseOnly: boolean }) {
        const [value, setValue] = useState<unknown>({ kind: 'fact', name: rawFact });
        return (
            <div>
                <ExpressionEditor
                    value={value}
                    onChange={setValue}
                    context={{
                        stages: STAGES.active,
                        settingKeys: ['exposure', 'scheduledFillWindowMinutes', 'autoJoinMaxCoins'],
                        descriptors: {
                            exposure: { kind: 'number', quantity: 'percent' },
                            scheduledFillWindowMinutes: { kind: 'number', quantity: 'duration', unit: 'minutes' },
                            autoJoinMaxCoins: { kind: 'number', quantity: 'coins' },
                        },
                        baseOnly,
                    }}
                    expected="any"
                />
                <output data-testid="value">{JSON.stringify(value)}</output>
            </div>
        );
    }

    test('the fixture facts exist', () => {
        expect(policyFact).toBeDefined();
        expect(rawFact).toBeDefined();
    });

    test('a policy fact is offered to a rule but not to a binding', () => {
        const rule = render(<BaseOnlyProbe baseOnly={false} />);
        expect(within(control('app.sbField_name')).queryByRole('option', { name: policyFact })).toBeTruthy();
        rule.unmount();
        render(<BaseOnlyProbe baseOnly={true} />);
        expect(within(control('app.sbField_name')).queryByRole('option', { name: policyFact })).toBeNull();
        expect(within(control('app.sbField_name')).queryByRole('option', { name: rawFact })).toBeTruthy();
    });

    test('the effective view is offered to a rule but not to a binding, and a new setting starts on the base view', () => {
        const rule = render(<BaseOnlyProbe baseOnly={false} />);
        changeSelect(control('app.sbExprKind'), 'setting');
        expect(within(control('app.sbField_view')).getAllByRole('option').length).toBeGreaterThan(1);
        rule.unmount();
        render(<BaseOnlyProbe baseOnly={true} />);
        changeSelect(control('app.sbExprKind'), 'setting');
        expect(within(control('app.sbField_view')).getAllByRole('option')).toHaveLength(1);
        expect(valueObject().view).toBe('base');
    });

    test('a new fact in a binding starts on a raw fact', () => {
        render(<BaseOnlyProbe baseOnly={true} />);
        changeSelect(control('app.sbExprKind'), 'literal');
        changeSelect(control('app.sbExprKind'), 'fact');
        const name = String(valueObject().name);
        expect(FACTS[name as keyof typeof FACTS].classification).toBe('raw');
    });

    test('the setting list holds only the keys that give what the field expects', () => {
        render(<ExpressionHost expected="duration" />);
        changeSelect(control('app.sbExprKind'), 'setting');
        const keys = within(control('app.sbField_key'))
            .getAllByRole('option')
            .map((option) => option.textContent);
        expect(keys).toEqual(['app.sbPickType', 'scheduledFillWindowMinutes']);
        expect(valueObject().key).toBe('scheduledFillWindowMinutes');
    });

    function ExpressionHost({ expected }: { expected: string }) {
        const [value, setValue] = useState<unknown>(null);
        return (
            <div>
                <ExpressionEditor
                    value={value}
                    onChange={setValue}
                    expected={invalid<'duration'>(expected)}
                    context={{
                        stages: STAGES.active,
                        settingKeys: ['exposure', 'scheduledFillWindowMinutes'],
                        descriptors: {
                            exposure: { kind: 'number', quantity: 'percent' },
                            scheduledFillWindowMinutes: { kind: 'number', quantity: 'duration', unit: 'minutes' },
                        },
                    }}
                />
                <output data-testid="value">{JSON.stringify(value)}</output>
            </div>
        );
    }
});

describe('what a value can be, by what it must give', () => {
    // The outermost editor's kind select (a composite value has nested ones after it); the empty pick is no kind.
    const outer = () => screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[0];
    const kindsOf = () => [...outer().options].map((option) => option.value).filter((kind) => kind !== '');

    test.each([
        ['boolean', ['literal', 'fact', 'setting']],
        ['string', ['literal', 'fact', 'setting']],
        ['list', ['literal', 'fact', 'setting']],
    ])('a %s is a literal, a fact or a setting, and nothing computed', (expected, wanted) => {
        // Settings for each plain kind exist in the context so that a setting is offered.
        render(
            <Host
                expected={expected}
                descriptors={{ flag: { kind: 'boolean' }, text: { kind: 'string' }, tags: { kind: 'list' } }}
                keys={['flag', 'text', 'tags']}
            />,
        );
        expect(kindsOf().filter((kind) => wanted.includes(kind))).toEqual(wanted);
        for (const bad of ['offset', 'difference', 'add', 'subtract', 'earlier', 'later', 'min', 'max']) {
            expect(kindsOf()).not.toContain(bad);
        }
    });

    test('an instant is moved by an offset or picked as the earlier or later of several; a duration is a difference or a sum', () => {
        const first = render(<Host expected="instant" />);
        expect(kindsOf()).toEqual(expect.arrayContaining(['offset', 'earlier', 'later']));
        expect(kindsOf()).not.toContain('difference');
        expect(kindsOf()).not.toContain('add');
        first.unmount();
        render(<Host expected="duration" />);
        expect(kindsOf()).toEqual(expect.arrayContaining(['difference', 'add', 'subtract', 'min', 'max']));
        expect(kindsOf()).not.toContain('offset');
        expect(kindsOf()).not.toContain('earlier');
    });

    test('any other quantity combines only as itself: sums, differences of its own, smallest and largest', () => {
        render(<Host expected="percent" />);
        expect(kindsOf()).toEqual(expect.arrayContaining(['add', 'subtract', 'min', 'max']));
        for (const bad of ['offset', 'difference', 'earlier', 'later']) expect(kindsOf()).not.toContain(bad);
    });

    test('an untyped field offers every kind', () => {
        render(<Host expected="any" />);
        expect(kindsOf()).toEqual(expect.arrayContaining(['offset', 'difference', 'earlier', 'min']));
    });

    test('a fact or a setting is not offered when nothing can give what is expected', () => {
        // No fact gives a list in the account stage, and the context holds no setting.
        render(<Host expected="list" stages={STAGES.account} />);
        expect(kindsOf()).toEqual(['literal']);
    });

    test('the kind a value already has stays in the list, so the select shows what it is', () => {
        render(<Host expected="boolean" initial={{ kind: 'offset' }} />);
        expect(kindsOf()).toContain('offset');
        expect(outer().value).toBe('offset');
    });

    test('a fact that takes a window keeps it across a change to another fact that takes one, and loses it for one that does not', () => {
        render(
            <Host
                expected="any"
                initial={{ kind: 'fact', name: 'entry.votesPerHour', select: { by: 'slot', index: 1 }, window: '2h' }}
            />,
        );
        changeSelect(selectOf('app.sbField_name'), 'entry.speedRatio');
        expect(valueObject()).toEqual({
            kind: 'fact',
            name: 'entry.speedRatio',
            select: { by: 'slot', index: 1 },
            window: '2h',
        });
        changeSelect(selectOf('app.sbField_name'), 'entry.votes');
        // `entry.votes` takes a select but no window: the window goes with the fact that took it.
        expect(valueObject()).toEqual({ kind: 'fact', name: 'entry.votes', select: { by: 'slot', index: 1 } });
        changeSelect(selectOf('app.sbField_name'), 'clock.now');
        // `clock.now` takes neither: nothing hidden is carried along.
        expect(valueObject()).toEqual({ kind: 'fact', name: 'clock.now' });
    });

    test('a fact over entries gets a select of its own when it had none', () => {
        render(<Host expected="any" initial={{ kind: 'fact', name: 'clock.now' }} />);
        changeSelect(selectOf('app.sbField_name'), 'entry.votes');
        expect(valueObject()).toMatchObject({
            kind: 'fact',
            name: 'entry.votes',
            select: expect.objectContaining({ by: 'slot' }),
        });
    });

    test('the empty pick keeps a fact with no name and carries nothing', () => {
        render(
            <Host expected="any" initial={{ kind: 'fact', name: 'entry.votes', select: { by: 'slot', index: 1 } }} />,
        );
        changeSelect(selectOf('app.sbField_name'), '');
        expect(valueObject()).toEqual({ kind: 'fact', name: '' });
    });

    function Host({
        expected,
        stages = STAGES.active,
        initial = null,
        descriptors,
        keys = [],
    }: {
        expected: string;
        stages?: ('active' | 'preJoin' | 'postClose' | 'account')[];
        initial?: unknown;
        descriptors?: Record<string, { kind: 'boolean' | 'string' | 'list' }>;
        keys?: string[];
    }) {
        const [value, setValue] = useState<unknown>(initial);
        return (
            <div>
                <ExpressionEditor
                    value={value}
                    onChange={setValue}
                    expected={invalid<'duration'>(expected)}
                    context={{ stages, settingKeys: keys, descriptors }}
                />
                <output data-testid="value">{JSON.stringify(value)}</output>
            </div>
        );
    }
});
