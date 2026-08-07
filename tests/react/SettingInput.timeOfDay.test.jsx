/**
 * Component tests for the `type: 'timeOfDay'` branch of SettingInput — the
 * scheduled-fill daily time editor. The value is a wall-clock 'HH:MM' string
 * ('' = off, shown with an off-hint); the native <input type="time"> emits
 * strings directly, so onChange forwards them unmodified. The translation
 * manager mock returns keys verbatim.
 */

import { fireEvent, render, screen } from '@/test/test-utils';
import { SettingInput } from '@/components/app/SettingInput';

const KEY = 'scheduledFillTime';
const config = { type: 'timeOfDay', default: '' };

const renderTimeOfDay = (value, { onChange = jest.fn(), onReset = jest.fn() } = {}) => {
    const { container } = render(
        <SettingInput settingKey={KEY} config={config} value={value} onChange={onChange} onReset={onReset} />,
    );
    return { onChange, onReset, input: container.querySelector('input[type="time"]') };
};

describe('SettingInput type=timeOfDay', () => {
    test('renders a time input carrying the stored value', () => {
        const { input } = renderTimeOfDay('21:30');
        expect(input).not.toBeNull();
        expect(input.value).toBe('21:30');
    });

    test('empty value renders the off-hint', () => {
        const { input } = renderTimeOfDay('');
        expect(input.value).toBe('');
        expect(screen.getByText('app.scheduledFillTimeOff')).toBeTruthy();
    });

    test('a set value hides the off-hint', () => {
        renderTimeOfDay('09:05');
        expect(screen.queryByText('app.scheduledFillTimeOff')).toBeNull();
    });

    test('editing emits the raw HH:MM string', () => {
        const { onChange, input } = renderTimeOfDay('21:30');
        fireEvent.change(input, { target: { value: '07:45' } });
        expect(onChange).toHaveBeenCalledWith(KEY, '07:45');
    });

    test('clearing emits the empty string (off sentinel)', () => {
        const { onChange, input } = renderTimeOfDay('21:30');
        fireEvent.change(input, { target: { value: '' } });
        expect(onChange).toHaveBeenCalledWith(KEY, '');
    });

    test('the reset button calls onReset with the key', () => {
        const { onReset } = renderTimeOfDay('21:30');
        fireEvent.click(screen.getByTitle('app.resetToDefaultNotSaved'));
        expect(onReset).toHaveBeenCalledWith(KEY);
    });

    test('a null stored value normalizes to the empty-string default (controlled input)', () => {
        const { input } = renderTimeOfDay(null);
        expect(input.value).toBe('');
    });
});
