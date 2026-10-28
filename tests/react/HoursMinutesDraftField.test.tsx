/**
 * HoursMinutesDraftField — the hours + minutes pair editing a fractional-hours
 * value that may be blank (a rule's inherit, an unset setting). The two
 * guarantees under test:
 *
 *   - Clearing reaches the blank: the drafts are strings, both empty emits '',
 *     and an explicit 0 stays the off value — in either clearing order.
 *   - The inputs never show a value that is not stored: clamps and floors are
 *     written back to the draft (999 → 720, 1.5 → 1), and a value changed from
 *     outside re-syncs the drafts, every blank form treated alike.
 *
 * The translation mock echoes keys, so the inputs' aria-labels are
 * "<label> app.hours" / "<label> app.minutes".
 */

import { fireEvent, render, screen } from './helpers/test-utils';
import { HoursMinutesDraftField } from '@/components/app/HoursMinutesFields';
import { SAVE_ERROR_ID } from '@/components/ui/ModalActionRow';

import type { ComponentProps } from 'preact';

const LABEL = 'app.autoJoinWithinHoursOfEnd';
const hoursInput = () => screen.getByLabelText<HTMLInputElement>(`${LABEL} app.hours`);
const minutesInput = () => screen.getByLabelText<HTMLInputElement>(`${LABEL} app.minutes`);
const shown = (): [string, string] => [hoursInput().value, minutesInput().value];

type FieldProps = ComponentProps<typeof HoursMinutesDraftField>;

const fieldWith = (value: number | '' | null | undefined): ComponentProps<typeof HoursMinutesDraftField> => ({
    value,
    onChange: jest.fn(),
    label: LABEL,
    labelId: 'w-label',
});

const renderField = (value: number | '' | null | undefined, over: Partial<FieldProps> = {}) =>
    render(<HoursMinutesDraftField {...fieldWith(value)} {...over} />);

describe('HoursMinutesDraftField — stored values render as drafts', () => {
    // The blank forms must all read as the same empty pair, never as 0.
    test.each([undefined, null, ''] as Array<number | '' | null | undefined>)(
        'a blank (%p) renders two empty inputs',
        (value) => {
            renderField(value);
            expect(shown()).toEqual(['', '']);
        },
    );

    test('an explicit 0 renders 0h 0m, not the inherit blank', () => {
        renderField(0);
        expect(shown()).toEqual(['0', '0']);
    });

    test('1.5 h renders as 1 h 30 m', () => {
        renderField(1.5);
        expect(shown()).toEqual(['1', '30']);
    });

    test.each([
        [0.001, '0', '1'],
        [0.99999, '1', '0'],
        [720, '720', '0'],
    ])('%p h renders as %s h %s m', (value, h, m) => {
        renderField(value);
        expect(shown()).toEqual([h, m]);
    });

    test('a value a hand-corrupted file could hold that is not a number renders as 0h 0m', () => {
        renderField(Number.NaN);
        expect(shown()).toEqual(['0', '0']);
    });
});

describe('HoursMinutesDraftField — emission', () => {
    test('typing 1 h 30 m from blank emits 1.5', () => {
        const onChange = jest.fn();
        renderField('', { onChange });
        fireEvent.change(hoursInput(), { target: { value: '1' } });
        expect(onChange).toHaveBeenLastCalledWith(1);
        fireEvent.change(minutesInput(), { target: { value: '30' } });
        expect(onChange).toHaveBeenLastCalledWith(1.5);
    });

    test('1 h 20 m round-trips exactly (stored as 4/3 h)', () => {
        const onChange = jest.fn();
        const first = renderField('', { onChange });
        fireEvent.change(hoursInput(), { target: { value: '1' } });
        fireEvent.change(minutesInput(), { target: { value: '20' } });
        expect(onChange).toHaveBeenLastCalledWith(1.3333333333333333);
        first.unmount();
        renderField(1.3333333333333333);
        expect(shown()).toEqual(['1', '20']);
    });

    test('0 h 59 m round-trips exactly (stored as 59/60 h)', () => {
        const onChange = jest.fn();
        const first = renderField('', { onChange });
        fireEvent.change(hoursInput(), { target: { value: '0' } });
        fireEvent.change(minutesInput(), { target: { value: '59' } });
        expect(onChange).toHaveBeenLastCalledWith(0.9833333333333333);
        first.unmount();
        renderField(0.9833333333333333);
        expect(shown()).toEqual(['0', '59']);
    });

    test.each([
        ['hours first', 'hours', 'minutes'],
        ['minutes first', 'minutes', 'hours'],
    ])('clearing %s leaves the blank after both are cleared, in either order', (_name, first, second) => {
        const onChange = jest.fn();
        renderField(1.5, { onChange });
        fireEvent.change(first === 'hours' ? hoursInput() : minutesInput(), { target: { value: '' } });
        expect(onChange).toHaveBeenLastCalledWith(first === 'hours' ? 0.5 : 1);
        fireEvent.change(second === 'hours' ? hoursInput() : minutesInput(), { target: { value: '' } });
        expect(onChange).toHaveBeenLastCalledWith('');
    });

    test('minutes above 59 clamp to 59 and the clamp is written back', () => {
        const onChange = jest.fn();
        renderField('', { onChange });
        fireEvent.change(hoursInput(), { target: { value: '1' } });
        fireEvent.change(minutesInput(), { target: { value: '99' } });
        expect(minutesInput().value).toBe('59');
        expect(onChange).toHaveBeenLastCalledWith(1 + 59 / 60);
    });

    test('at the 720 h ceiling the minutes are forced to 0 and re-synced', () => {
        const onChange = jest.fn();
        renderField(720, { onChange });
        fireEvent.change(minutesInput(), { target: { value: '30' } });
        expect(shown()).toEqual(['720', '0']);
        expect(onChange).toHaveBeenLastCalledWith(720);
    });

    test.each([
        ['999', '720'],
        ['721', '720'],
    ])('typing %s in hours shows %s', (typed, stored) => {
        renderField('', { onChange: jest.fn() });
        fireEvent.change(hoursInput(), { target: { value: typed } });
        expect(shown()).toEqual([stored, '']);
    });

    test('typing 1.5 in hours floors to 1 and shows it', () => {
        renderField('');
        fireEvent.change(hoursInput(), { target: { value: '1.5' } });
        expect(hoursInput().value).toBe('1');
    });

    test('a negative draft reads as 0 — a NaN value never leaves the component', () => {
        const onChange = jest.fn();
        renderField('', { onChange });
        fireEvent.change(hoursInput(), { target: { value: '-5' } });
        expect(hoursInput().value).toBe('0');
        expect(onChange).toHaveBeenLastCalledWith(0);
    });
});

describe('HoursMinutesDraftField — outside resync', () => {
    test('a changed value re-syncs the drafts', () => {
        const { rerender } = renderField(1.5);
        rerender(<HoursMinutesDraftField {...fieldWith(2)} />);
        expect(shown()).toEqual(['2', '0']);
    });

    test('undefined counts as the blank', () => {
        const { rerender } = renderField(1.5);
        rerender(<HoursMinutesDraftField {...fieldWith(undefined)} />);
        expect(shown()).toEqual(['', '']);
    });

    test('the echoed round-trip of an edit does not re-sync, an outside replace does', () => {
        const { rerender } = renderField(1.5);
        fireEvent.change(hoursInput(), { target: { value: '2' } });
        // The parent echoes 2.5 (2 h 30 m, what the drafts produce): the typed
        // draft survives the round-trip.
        rerender(<HoursMinutesDraftField {...fieldWith(2.5)} />);
        expect(shown()).toEqual(['2', '30']);
        // A genuinely outside change (reset, another rule) lands.
        rerender(<HoursMinutesDraftField {...fieldWith(0)} />);
        expect(shown()).toEqual(['0', '0']);
    });
});

describe('HoursMinutesDraftField — markup and accessibility', () => {
    test('the group is labelled by the caption id and unit text follows each input', () => {
        renderField(0);
        const group = screen.getByRole('group');
        expect(group.getAttribute('aria-labelledby')).toBe('w-label');
        expect(group.textContent).toContain('app.hours');
        expect(group.textContent).toContain('app.minutes');
    });

    test('an id makes the group the focusable target a refused Save lands on', () => {
        const { container } = renderField(0, { id: 'the-field' });
        const group = container.querySelector<HTMLElement>('#the-field')!;
        expect(group.getAttribute('role')).toBe('group');
        expect(group.getAttribute('tabindex')).toBe('-1');
        group.focus();
        expect(document.activeElement).toBe(group);
    });

    test('without an id the group carries no tabindex', () => {
        const { container } = renderField(0);
        expect(container.querySelector('[role="group"]')!.hasAttribute('tabindex')).toBe(false);
    });

    test('a refused value marks both inputs and names the save-failed alert on the group', () => {
        renderField(0, { rejected: true });
        expect(hoursInput().getAttribute('aria-invalid')).toBe('true');
        expect(minutesInput().getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByRole('group').getAttribute('aria-describedby')).toBe(SAVE_ERROR_ID);
    });

    test('a clean value carries neither mark', () => {
        renderField(0);
        expect(hoursInput().hasAttribute('aria-invalid')).toBe(false);
        expect(minutesInput().hasAttribute('aria-invalid')).toBe(false);
        expect(screen.getByRole('group').hasAttribute('aria-describedby')).toBe(false);
    });

    test('an invalid value points both inputs at the described region', () => {
        renderField(0, { invalid: true, describedBy: 'the-error' });
        expect(hoursInput().getAttribute('aria-describedby')).toBe('the-error');
        expect(minutesInput().getAttribute('aria-describedby')).toBe('the-error');
        expect(hoursInput().className).toContain('input-error');
    });

    test('the placeholder shows on both blank inputs, disabled applies to both', () => {
        renderField('', { placeholder: 'inherit', disabled: true });
        expect(hoursInput().getAttribute('placeholder')).toBe('inherit');
        expect(minutesInput().getAttribute('placeholder')).toBe('inherit');
        expect(hoursInput().disabled).toBe(true);
        expect(minutesInput().disabled).toBe(true);
    });

    test('with one draft empty and the other set, neither input shows the placeholder', () => {
        const onChange = jest.fn();
        renderField('', { onChange, placeholder: 'inherit' });
        fireEvent.change(hoursInput(), { target: { value: '1' } });
        // Half a real value is on screen: "inherit" would name the wrong state.
        expect(hoursInput().value).toBe('1');
        // The DOM property reads '' whether the attribute went or sits empty.
        expect(hoursInput().placeholder).toBe('');
        expect(minutesInput().placeholder).toBe('');
    });
});
