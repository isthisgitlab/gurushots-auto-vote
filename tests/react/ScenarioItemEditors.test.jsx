/**
 * The scenario builder's generic editors: every field kind, list add / move /
 * remove, the number↔yes/no switch of entry fields, and unknown types from
 * hand-edited JSON.
 */

import { useState } from 'react';
import { act, render, screen, fireEvent, within } from './helpers/test-utils';
import { ItemEditor, ConditionList, ActionList } from '@/components/app/scenarioBuilder/ItemEditors';

// A <select>'s onChange is a native 'change' listener under preact/compat.
const changeSelect = (sel, value) =>
    act(() => {
        sel.value = value;
        sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });

/** Keeps the edited value in state and shows it, like the builder does. */
function Probe({ Editor, initial, ...props }) {
    const [value, setValue] = useState(initial);
    return (
        <div>
            <Editor value={value} onChange={setValue} phases={['main', 'later']} {...props} />
            <output data-testid="value">{JSON.stringify(value ?? null)}</output>
        </div>
    );
}

const value = () => JSON.parse(screen.getByTestId('value').textContent);
// A field's label names both its group and its control; tests want the control.
const controlIn = (container, name) =>
    within(container)
        .getAllByLabelText(name)
        .find((el) => el.tagName !== 'DIV');
const control = (name) => controlIn(document.body, name);
const group = (name) => screen.getAllByRole('group', { name })[0];

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
        const up = screen.getAllByRole('button', { name: /app\.sbMoveUp/ });
        expect(up[0].disabled).toBe(true);
        fireEvent.click(up[1]);
        expect(value().map((c) => c.type)).toEqual(['freeSlots', 'entries']);
        fireEvent.click(screen.getAllByRole('button', { name: /app\.sbMoveDown/ })[0]);
        expect(value().map((c) => c.type)).toEqual(['entries', 'freeSlots']);
        fireEvent.click(screen.getAllByRole('button', { name: 'app.sbRemove' })[0]);
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
        fireEvent.click(control('AVAILABLE_KEY'));
        fireEvent.click(control('LOCKED'));
        fireEvent.click(control('LOCKED'));
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
        expect(value().currency).toBe('keys');
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
        expect(value().value).toBe(false);
        changeSelect(control('app.sbField_field'), 'turbo');
        expect(value()).toEqual(expect.objectContaining({ field: 'turbo', value: false }));
        changeSelect(control('app.sbField_field'), 'rank');
        expect(value()).toEqual(expect.objectContaining({ field: 'rank', op: '>=', value: 0 }));

        const selector = group('app.sbField_select');
        changeSelect(controlIn(selector, 'app.sbPickType'), 'slot');
        changeSelect(controlIn(selector, 'app.sbField_index'), '0');
        expect(value().select).toEqual({ by: 'slot', index: 0 });
        changeSelect(controlIn(selector, 'app.sbPickType'), 'fastest');
        fireEvent.click(controlIn(selector, 'app.sbField_skipProtected'));
        expect(value().select).toEqual({ by: 'fastest', skipProtected: true });
        fireEvent.click(controlIn(selector, 'app.sbField_skipProtected'));
        expect(value().select).toEqual({ by: 'fastest' });
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
        expect(value().condition).toEqual({
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
        expect(value()[0]).toEqual({
            type: 'swap',
            entry: { by: 'bestRank' },
            with: { memory: 'held' },
            rememberAdded: 'filler',
        });
        changeSelect(control('app.sbField_with'), 'best');
        expect(value()[0].with).toBe('best');

        changeSelect(control('app.sbAddAction'), 'goto');
        changeSelect(control('app.sbField_phase'), 'later');
        changeSelect(control('app.sbAddAction'), 'notify');
        fireEvent.change(control('app.sbField_message'), { target: { value: 'Boost now' } });
        changeSelect(control('app.sbAddAction'), 'vote');
        fireEvent.change(control('app.sbField_toExposure'), { target: { value: '80' } });
        expect(value().slice(1)).toEqual([
            { type: 'goto', phase: 'later' },
            { type: 'notify', message: 'Boost now' },
            { type: 'vote', toExposure: 80 },
        ]);
    });
});
