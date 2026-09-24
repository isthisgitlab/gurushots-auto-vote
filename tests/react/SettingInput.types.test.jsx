/**
 * SettingInput type dispatch and the smaller field editors the per-type suites
 * (number / schedule / timeOfDayList) do not reach: tags, time, boolean, text,
 * the missing-config guard, the per-type empty defaults, the reset buttons, and
 * tolerance of hand-corrupted stored values. The translation mock echoes keys.
 */

import { fireEvent, render, screen } from './helpers/test-utils';
import { SettingInput, SettingLabel, TagsField } from '@/components/app/SettingInput';

const renderInput = (config, value, over = {}) => {
    const props = { settingKey: 'k', config, value, onChange: jest.fn(), onReset: jest.fn(), ...over };
    const utils = render(<SettingInput {...props} />);
    return { ...props, ...utils };
};

const resetButton = () => document.querySelector('button[title="app.resetToDefaultNotSaved"]');

describe('SettingInput — dispatch guards and empty defaults', () => {
    test('renders nothing without a config', () => {
        const { container } = renderInput(undefined, 1);
        expect(container.innerHTML).toBe('');
    });

    test.each([
        ['number', 'input[type="number"]', '0'],
        ['time', 'input[type="number"]', '0'],
        ['text', 'input[type="text"]', ''],
    ])('a %s setting with no value and no default renders its empty value', (type, selector, expected) => {
        renderInput({ type }, undefined);
        expect(document.querySelector(selector).value).toBe(expected);
    });

    test('a boolean with no value and no default renders unchecked', () => {
        renderInput({ type: 'boolean' }, undefined);
        expect(document.querySelector('input[type="checkbox"]').checked).toBe(false);
    });

    test.each([
        ['tags', () => document.querySelector('input[type="text"]').value === ''],
        ['schedule', () => screen.queryByText('app.autoFillScheduleEmpty') !== null],
        ['timeOfDayList', () => screen.queryByText('app.scheduledFillTimeOff') !== null],
        ['timeList', () => screen.queryByText('app.scheduledFillBeforeEndOff') !== null],
    ])('a %s setting with no value and no default renders as an empty list', (type, isEmpty) => {
        renderInput({ type, label: 'app.x' }, undefined);
        expect(isEmpty()).toBe(true);
    });

    test('an unknown type falls back to a text input', () => {
        const { onChange } = renderInput({ type: 'mystery', default: 'abc' }, undefined);
        const input = document.querySelector('input[type="text"]');
        expect(input.value).toBe('abc');
        fireEvent.change(input, { target: { value: 'xyz' } });
        expect(onChange).toHaveBeenCalledWith('k', 'xyz');
    });
});

describe('SettingInput — tags', () => {
    test('shows the stored tags and emits the parsed array on edit', () => {
        const { onChange } = renderInput({ type: 'tags' }, ['a', 'b']);
        const input = screen.getByPlaceholderText('app.tagsPlaceholder');
        expect(input.value).toBe('a, b');
        fireEvent.change(input, { target: { value: 'x, , y ' } });
        expect(onChange).toHaveBeenCalledWith('k', ['x', 'y']);
    });

    test('the reset button reports the setting key', () => {
        const { onReset } = renderInput({ type: 'tags' }, []);
        fireEvent.click(resetButton());
        expect(onReset).toHaveBeenCalledWith('k');
    });

    test('TagsField treats a missing value as no tags and has no reset without onReset', () => {
        render(<TagsField settingKey="k" value={undefined} onChange={jest.fn()} placeholder="p" />);
        expect(screen.getByPlaceholderText('p').value).toBe('');
        expect(resetButton()).toBeNull();
    });

    test('TagsField re-syncs its draft when the array is replaced from outside', () => {
        const { rerender } = render(<TagsField settingKey="k" value={['a']} onChange={jest.fn()} placeholder="p" />);
        rerender(<TagsField settingKey="k" value={['b', 'c']} onChange={jest.fn()} placeholder="p" />);
        expect(screen.getByPlaceholderText('p').value).toBe('b, c');
    });

    test('TagsField keeps a trailing comma while typing when the parsed tags already match', () => {
        const onChange = jest.fn();
        const { rerender } = render(<TagsField settingKey="k" value={['a']} onChange={onChange} placeholder="p" />);
        fireEvent.change(screen.getByPlaceholderText('p'), { target: { value: 'a, b,' } });
        // Parent echoes the parsed array back: the draft must keep the comma.
        rerender(<TagsField settingKey="k" value={['a', 'b']} onChange={onChange} placeholder="p" />);
        expect(screen.getByPlaceholderText('p').value).toBe('a, b,');
    });
});

describe('SettingInput — time', () => {
    const config = { type: 'time', default: 0 };

    test('splits stored seconds into hours and minutes', () => {
        renderInput(config, 3 * 3600 + 25 * 60);
        const [hours, minutes] = document.querySelectorAll('input[type="number"]');
        expect(hours.value).toBe('3');
        expect(minutes.value).toBe('25');
    });

    test('editing hours or minutes emits the combined seconds', () => {
        const { onChange } = renderInput(config, 3600 + 30 * 60);
        const [hours, minutes] = document.querySelectorAll('input[type="number"]');
        fireEvent.change(hours, { target: { value: '2' } });
        expect(onChange).toHaveBeenLastCalledWith('k', 2 * 3600 + 30 * 60);
        fireEvent.change(minutes, { target: { value: '5' } });
        expect(onChange).toHaveBeenLastCalledWith('k', 3600 + 5 * 60);
    });

    test('the reset button reports the key, and is absent without onReset', () => {
        const { onReset, unmount } = renderInput(config, 60);
        fireEvent.click(resetButton());
        expect(onReset).toHaveBeenCalledWith('k');
        unmount();
        renderInput(config, 60, { onReset: undefined });
        expect(resetButton()).toBeNull();
    });
});

describe('SettingInput — boolean', () => {
    test('toggling emits the checked state', () => {
        const { onChange } = renderInput({ type: 'boolean', default: false }, false);
        fireEvent.click(document.querySelector('input[type="checkbox"]'));
        expect(onChange).toHaveBeenCalledWith('k', true);
    });

    test('the reset button reports the key', () => {
        const { onReset } = renderInput({ type: 'boolean', default: false }, true);
        fireEvent.click(resetButton());
        expect(onReset).toHaveBeenCalledWith('k');
    });
});

describe('SettingInput — number extras', () => {
    test('a min-only setting explains the lower bound', () => {
        renderInput({ type: 'number', min: 5 }, 1);
        expect(screen.getByText('app.validationAtLeast')).toBeTruthy();
    });

    test('a valid number string parseInt cannot read is reported as blank', () => {
        const { onChange } = renderInput({ type: 'number', min: 0 }, 1);
        fireEvent.change(document.querySelector('input[type="number"]'), { target: { value: '.5' } });
        expect(onChange).toHaveBeenCalledWith('k', '');
    });

    test('the reset button reports the key', () => {
        const { onReset } = renderInput({ type: 'number', min: 0 }, 1);
        fireEvent.click(resetButton());
        expect(onReset).toHaveBeenCalledWith('k');
    });
});

describe('SettingInput — text', () => {
    test('the reset button reports the key, and is absent without onReset', () => {
        const { onReset, unmount } = renderInput({ type: 'text', default: '' }, 'hello');
        fireEvent.click(resetButton());
        expect(onReset).toHaveBeenCalledWith('k');
        unmount();
        renderInput({ type: 'text', default: '' }, 'hello', { onReset: undefined });
        expect(resetButton()).toBeNull();
    });
});

describe('SettingInput — list editors tolerate corrupted stored values', () => {
    test('a non-array schedule renders every image as off', () => {
        renderInput({ type: 'schedule', default: [] }, 'garbage');
        expect(screen.getAllByText('app.autoFillScheduleOff')).toHaveLength(3);
    });

    test('the schedule reset button reports the key', () => {
        const { onReset } = renderInput({ type: 'schedule', default: [] }, []);
        fireEvent.click(resetButton());
        expect(onReset).toHaveBeenCalledWith('k');
    });

    test('a non-array timeOfDayList renders no rows', () => {
        renderInput({ type: 'timeOfDayList', default: [], label: 'app.t' }, 42);
        expect(document.querySelectorAll('input[type="time"]')).toHaveLength(0);
        expect(screen.getByText('app.scheduledFillTimeOff')).toBeTruthy();
    });

    test('a non-array timeList renders no rows', () => {
        renderInput({ type: 'timeList', default: [], label: 'app.t' }, 'x');
        expect(document.querySelectorAll('input[type="number"]')).toHaveLength(0);
        expect(screen.getByText('app.scheduledFillBeforeEndOff')).toBeTruthy();
    });

    test('a non-numeric timeList row shows as a 0h 0m draft and is not emitted', () => {
        const { onChange } = renderInput({ type: 'timeList', default: [], label: 'app.t' }, ['abc', 3600]);
        const inputs = document.querySelectorAll('input[type="number"]');
        expect([inputs[0].value, inputs[1].value]).toEqual(['0', '0']);
        expect(screen.getByText('app.scheduledFillEntryDraft')).toBeTruthy();
        // Editing the valid row's minutes emits only real offsets.
        fireEvent.change(inputs[3], { target: { value: '15' } });
        expect(onChange).toHaveBeenLastCalledWith('k', [3600 + 15 * 60]);
    });

    test('the timeList reset button reports the key', () => {
        const { onReset } = renderInput({ type: 'timeList', default: [], label: 'app.t' }, [60]);
        fireEvent.click(resetButton());
        expect(onReset).toHaveBeenCalledWith('k');
    });

    test('a timeOfDayList re-syncs its rows when the stored list is replaced from outside', () => {
        const config = { type: 'timeOfDayList', default: [], label: 'app.t' };
        const onChange = jest.fn();
        const { rerender } = render(
            <SettingInput settingKey="k" config={config} value={['09:00']} onChange={onChange} />,
        );
        rerender(<SettingInput settingKey="k" config={config} value={['10:00', '11:00']} onChange={onChange} />);
        expect(Array.from(document.querySelectorAll('input[type="time"]')).map((i) => i.value)).toEqual([
            '10:00',
            '11:00',
        ]);
    });
});

describe('SettingLabel + SettingInput — accessible names', () => {
    const renderLabelled = (config, value, id) =>
        render(
            <>
                <SettingLabel inputId={id ?? 'setting-k'} type={config.type}>
                    <span>Caption</span>
                </SettingLabel>
                <SettingInput settingKey="k" config={config} value={value} onChange={jest.fn()} id={id} />
            </>,
        );

    test.each([
        ['number', 3, 'spinbutton'],
        ['boolean', true, 'checkbox'],
        ['text', 'x', 'textbox'],
        ['tags', ['a'], 'textbox'],
    ])('a %s setting is the control its <label> names', (type, value, role) => {
        renderLabelled({ type }, value);
        expect(screen.getByRole(role, { name: 'Caption' })).toBe(screen.getByLabelText('Caption'));
    });

    test('a caller-supplied id is used instead of the default', () => {
        renderLabelled({ type: 'number' }, 3, 'challenge-setting-k');
        expect(screen.getByLabelText('Caption').id).toBe('challenge-setting-k');
    });

    test.each([
        ['time', 3600],
        ['schedule', []],
        ['timeOfDayList', []],
        ['timeList', []],
    ])('a multi-control %s setting is a group named by the caption', (type, value) => {
        renderLabelled({ type, label: 'lbl' }, value);
        expect(screen.getByRole('group', { name: 'Caption' })).toBeTruthy();
        expect(document.querySelector('label')).toBeNull();
    });

    test('the time setting names its hours and minutes inputs', () => {
        renderLabelled({ type: 'time', label: 'lbl' }, 3660);
        expect(screen.getByRole('spinbutton', { name: 'lbl app.hours' }).value).toBe('1');
        expect(screen.getByRole('spinbutton', { name: 'lbl app.minutes' }).value).toBe('1');
    });
});
