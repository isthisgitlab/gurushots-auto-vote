/**
 * The number branch of SettingInput.
 *
 * Two user-visible guarantees:
 *
 *   - The schema's min/max/unit reach the field through the IPC projection, so every number
 *     field renders bounded and labelled, with a visible reason when a value is refused.
 *   - An emptied field is not coerced to 0 (as `parseInt(e.target.value, 10) || 0` would do),
 *     which zod rejects for a minimum-1 key like exposure — a save failure for a value the user
 *     never typed.
 *
 * The blank case matters most for the settings whose min is 0 (exposureTarget,
 * finalWindowExposureTarget and the two entry-slot indexes): `Number('')` is 0, so a blank field
 * would look perfectly in range, no field would be highlighted, and Save would show the generic
 * "check the highlighted values" banner pointing at nothing.
 */

import { useState } from 'react';
import { render, fireEvent, screen } from './helpers/test-utils';
import type { ComponentProps } from 'preact';
import { SettingInput, SettingLabel, numberRangeMessage, parseNumberInput } from '@/components/app/SettingInput';
import { SAVE_ERROR_ID } from '@/components/ui/ModalActionRow';
import type { SerializableSchemaEntry } from '../../src/ts/ipc/settings.handlers';
import { invalid } from '../helpers/invalid';
import { fillTemplate } from './helpers/setup';

const renderNumber = (over: Partial<ComponentProps<typeof SettingInput>> = {}) => {
    const props = {
        settingKey: 'exposure',
        config: invalid<SerializableSchemaEntry>({ type: 'number', min: 1, max: 100, unit: 'app.unitPercent' }),
        value: 50,
        onChange: jest.fn(),
        disabled: false,
        ...over,
    };
    const utils = render(<SettingInput {...props} />);
    return { props, input: utils.container.querySelector<HTMLInputElement>('input[type="number"]')!, ...utils };
};

describe('SettingInput — number', () => {
    test('binds the declared bounds and renders the unit', () => {
        const { container, input } = renderNumber();

        expect(input.getAttribute('min')).toBe('1');
        expect(input.getAttribute('max')).toBe('100');
        // The test harness's translator echoes the key rather than resolving it, so assert
        // the unit is rendered at all — the real string ('%') is covered by locale parity.
        expect(container.textContent).toContain('app.unitPercent');
    });

    test('an in-range value is not flagged', () => {
        const { container, input } = renderNumber({ value: 50 });

        expect(input.className).not.toContain('input-error');
        expect(container.querySelector('.text-error')).toBeNull();
    });

    test('flags a value above the maximum and explains the range', () => {
        const { container, input } = renderNumber({ value: 150 });

        expect(input.className).toContain('input-error');
        expect(container.querySelector('.text-error')).not.toBeNull();
    });

    test('a flagged value is marked invalid and points at its message', () => {
        const { container, input } = renderNumber({ value: 150 });

        expect(input.getAttribute('aria-invalid')).toBe('true');
        const message = container.querySelector('.text-error')!.parentElement!;
        expect(message.id).toBe('setting-exposure-error');
        expect(input.getAttribute('aria-describedby')).toBe(message.id);
    });

    test('an in-range value carries neither mark', () => {
        const { input } = renderNumber({ value: 50 });

        expect(input.hasAttribute('aria-invalid')).toBe(false);
        expect(input.hasAttribute('aria-describedby')).toBe(false);
    });

    test('a refused in-range value is marked invalid without a message', () => {
        const { container, input } = renderNumber({ value: 50, rejected: true });

        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(input.hasAttribute('aria-describedby')).toBe(false);
        expect(container.querySelector('.text-error')).toBeNull();
    });

    test('exports the parse and the range message the application settings reuse', () => {
        expect(parseNumberInput('')).toBe('');
        expect(parseNumberInput('x')).toBe('');
        expect(parseNumberInput('12')).toBe(12);
        expect(numberRangeMessage({ min: 1, max: 5 }, (key, vars) => fillTemplate(`${key} {min}-{max}`, vars))).toBe(
            'app.validationOutOfRange 1-5',
        );
        expect(numberRangeMessage({ min: 3 }, (key, vars) => fillTemplate(`${key} {min}`, vars))).toBe(
            'app.validationAtLeast 3',
        );
        expect(numberRangeMessage({}, (key) => key)).toBe('app.validationInvalidValue');
    });

    test('flags a value below the minimum', () => {
        const { input } = renderNumber({ value: 0 });

        expect(input.className).toContain('input-error');
    });

    test('clearing the field reports empty, not 0', () => {
        const { props, input } = renderNumber();

        fireEvent.change(input, { target: { value: '' } });

        expect(props.onChange).toHaveBeenCalledWith('exposure', '');
    });

    test('a blank field is flagged even when the minimum is 0', () => {
        // Number('') === 0, so without an explicit blank check this field looked in range
        // and Save wrote '' straight through to zod with nothing highlighted in the UI.
        const { container, input } = renderNumber({
            settingKey: 'exposureTarget',
            config: invalid({ type: 'number', min: 0, max: 100, unit: 'app.unitPercent' }),
            value: '',
        });

        expect(input.className).toContain('input-error');
        expect(container.querySelector('.text-error')).not.toBeNull();
    });

    test('a typed number is reported as a number', () => {
        const { props, input } = renderNumber();

        fireEvent.change(input, { target: { value: '75' } });

        expect(props.onChange).toHaveBeenCalledWith('exposure', 75);
    });

    test('a unitless bounded setting still renders and validates', () => {
        // The entry-slot indexes are deliberately unitless but bounded 0-4.
        const { container, input } = renderNumber({
            settingKey: 'boostImageIndex',
            config: invalid({ type: 'number', min: 0, max: 4 }),
            value: 9,
        });

        expect(input.getAttribute('max')).toBe('4');
        expect(input.className).toContain('input-error');
        expect(container.querySelector('.text-error')).not.toBeNull();
    });

    test('a min-only setting explains the lower bound', () => {
        renderNumber({ config: invalid({ type: 'number', min: 1 }), value: 0 });

        expect(screen.getByText('app.validationAtLeast')).toBeTruthy();
    });

    test('an unbounded setting left blank gets the generic invalid-value message', () => {
        renderNumber({ config: invalid({ type: 'number' }), value: '' });

        expect(screen.getByText('app.validationInvalidValue')).toBeTruthy();
    });
});

/**
 * The `minutes` display flag (autoJoinWithinHoursOfEnd): the number renders as
 * an hours + minutes pair inside the same ControlRow. The modals pair the
 * input with a SettingLabel, as below — that pairing is what names the group.
 */
describe('SettingInput — number with minutes (hours + minutes pair)', () => {
    const MINUTES_CONFIG = {
        type: 'number',
        min: 0,
        max: 720,
        unit: 'app.unitHours',
        label: 'app.autoJoinWithinHoursOfEnd',
        description: 'd',
        minutes: true,
    };
    const KEY = 'autoJoinWithinHoursOfEnd';
    const ERROR_ID = `setting-${KEY}-error`;

    const renderMinutes = (value: unknown, over: Partial<ComponentProps<typeof SettingInput>> = {}) => {
        const onChange = jest.fn();
        const utils = render(
            <>
                <SettingLabel inputId={`setting-${KEY}`} type="number" config={invalid(MINUTES_CONFIG)}>
                    <span className="font-medium">app.autoJoinWithinHoursOfEnd</span>
                </SettingLabel>
                <SettingInput
                    settingKey={KEY}
                    config={invalid(MINUTES_CONFIG)}
                    value={value}
                    onChange={onChange}
                    {...over}
                />
            </>,
        );
        return { onChange, ...utils };
    };

    /** The modal pairing with the value echoed back, so clearing reaches the blank. */
    function EchoingMinutesField({ onReset }: { onReset?: ComponentProps<typeof SettingInput>['onReset'] }) {
        // The minutes pair emits a number or ''; the handler's key is ignored.
        const [value, setValue] = useState<unknown>(1.5);
        return (
            <>
                <SettingLabel inputId={`setting-${KEY}`} type="number" config={invalid(MINUTES_CONFIG)}>
                    <span className="font-medium">app.autoJoinWithinHoursOfEnd</span>
                </SettingLabel>
                <SettingInput
                    settingKey={KEY}
                    config={invalid(MINUTES_CONFIG)}
                    value={value}
                    onChange={(_key, next) => setValue(next)}
                    onReset={onReset}
                />
            </>
        );
    }

    test('the labelled group resolves and carries no unit suffix — the pair has its own', () => {
        renderMinutes(1.5);

        const group = screen.getByRole('group', { name: 'app.autoJoinWithinHoursOfEnd' });
        expect(
            group.querySelector('input[type="number"][aria-label="app.autoJoinWithinHoursOfEnd app.hours"]'),
        ).toBeTruthy();
        expect(
            group.querySelector('input[type="number"][aria-label="app.autoJoinWithinHoursOfEnd app.minutes"]'),
        ).toBeTruthy();
        expect(screen.queryByText('app.unitHours')).toBeNull();
    });

    test('the pair emits fractional hours through the schema change handler', () => {
        const { onChange } = renderMinutes(0);
        fireEvent.change(screen.getByLabelText('app.autoJoinWithinHoursOfEnd app.hours'), { target: { value: '1' } });
        fireEvent.change(screen.getByLabelText('app.autoJoinWithinHoursOfEnd app.minutes'), {
            target: { value: '30' },
        });
        expect(onChange).toHaveBeenLastCalledWith(KEY, 1.5);
    });

    test('a refused Save can focus the group, which names the save-failed alert', () => {
        renderMinutes(1.5, { rejected: true });

        const group = screen.getByRole('group', { name: 'app.autoJoinWithinHoursOfEnd' });
        expect(group.getAttribute('tabindex')).toBe('-1');
        group.focus();
        expect(document.activeElement).toBe(group);
        expect(group.getAttribute('aria-describedby')).toBe(SAVE_ERROR_ID);
        // NumberField passed `rejected` through: both inputs of the pair are marked.
        expect(screen.getByLabelText('app.autoJoinWithinHoursOfEnd app.hours').getAttribute('aria-invalid')).toBe(
            'true',
        );
        expect(screen.getByLabelText('app.autoJoinWithinHoursOfEnd app.minutes').getAttribute('aria-invalid')).toBe(
            'true',
        );
    });

    test('an unrefused value marks nothing', () => {
        renderMinutes(1.5);

        expect(
            screen.getByRole('group', { name: 'app.autoJoinWithinHoursOfEnd' }).hasAttribute('aria-describedby'),
        ).toBe(false);
        expect(screen.getByLabelText('app.autoJoinWithinHoursOfEnd app.hours').hasAttribute('aria-invalid')).toBe(
            false,
        );
    });

    test('clearing both inputs shows the range message on the inputs, and reset still works', () => {
        const onReset = jest.fn();
        render(<EchoingMinutesField onReset={onReset} />);

        fireEvent.change(screen.getByLabelText('app.autoJoinWithinHoursOfEnd app.hours'), { target: { value: '' } });
        fireEvent.change(screen.getByLabelText('app.autoJoinWithinHoursOfEnd app.minutes'), { target: { value: '' } });

        // Both blank = '', out of range like any other blank: the message is
        // tied to the inputs, not just the banner.
        expect(screen.getByText('app.validationOutOfRange')).toBeTruthy();
        expect(screen.getByLabelText('app.autoJoinWithinHoursOfEnd app.hours').getAttribute('aria-describedby')).toBe(
            ERROR_ID,
        );
        expect(screen.getByLabelText('app.autoJoinWithinHoursOfEnd app.minutes').getAttribute('aria-describedby')).toBe(
            ERROR_ID,
        );
        fireEvent.click(document.querySelector('button[title^="app.resetToDefaultNotSaved"]')!);
        expect(onReset).toHaveBeenCalledWith(KEY);
    });
});
