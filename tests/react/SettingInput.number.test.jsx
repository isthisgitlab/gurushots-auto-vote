/**
 * The number branch of SettingInput.
 *
 * Two bugs shipped together here and both are user-visible:
 *
 *   - No schema entry ever defined min/max/unit even though the IPC projection forwarded them
 *     and this component bound them, so every number field rendered unbounded, unlabelled and
 *     with no way to see why a value was refused.
 *   - `parseInt(e.target.value, 10) || 0` turned an emptied field into 0, which zod rejects
 *     for a minimum-1 key like exposure — the user got a save failure for a value they never
 *     typed.
 *
 * The blank case matters most for the settings whose min is 0 (exposureTarget,
 * lastHourExposureTarget and the two entry-slot indexes): `Number('')` is 0, so a blank field
 * looked perfectly in range, no field was highlighted, and Save then showed the generic
 * "check the highlighted values" banner pointing at nothing.
 */

import { render, fireEvent } from './helpers/test-utils';
import { SettingInput } from '@/components/app/SettingInput';

const renderNumber = (over = {}) => {
    const props = {
        settingKey: 'exposure',
        config: { type: 'number', min: 1, max: 100, unit: 'app.unitPercent' },
        value: 50,
        onChange: jest.fn(),
        disabled: false,
        ...over,
    };
    const utils = render(<SettingInput {...props} />);
    return { props, input: utils.container.querySelector('input[type="number"]'), ...utils };
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
            config: { type: 'number', min: 0, max: 100, unit: 'app.unitPercent' },
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
            config: { type: 'number', min: 0, max: 4 },
            value: 9,
        });

        expect(input.getAttribute('max')).toBe('4');
        expect(input.className).toContain('input-error');
        expect(container.querySelector('.text-error')).not.toBeNull();
    });
});
