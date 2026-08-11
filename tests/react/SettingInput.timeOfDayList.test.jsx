/**
 * Component tests for the scheduled-fill list editors in SettingInput:
 *   - `type: 'timeOfDayList'` (TimeOfDayListField): variable rows of native
 *     <input type="time">, each entry a daily 'HH:MM' string.
 *   - `type: 'timeList'` (TimeListField): variable rows of hours+minutes
 *     pairs, each entry stored as seconds.
 * Emission drops draft rows (''/0) and dedupes first-wins; the cap renders a
 * visible role="status" message; remove buttons carry indexed aria-labels.
 * The translation manager mock returns keys verbatim.
 */

import { fireEvent, render, screen } from './helpers/test-utils';
import { SettingInput, SCHEDULED_FILL_MAX_ENTRIES } from '@/components/app/SettingInput';

const timeInputs = () => Array.from(document.querySelectorAll('input[type="time"]'));
const numberInputs = () => Array.from(document.querySelectorAll('input[type="number"]'));
const addButton = (label) => screen.getByText(label);
const removeButtons = () => screen.queryAllByLabelText(/app\.scheduledFillRemoveEntry \d+/);

describe('SettingInput type=timeOfDayList', () => {
    const KEY = 'scheduledFillTime';
    const config = { type: 'timeOfDayList', default: [], label: 'app.scheduledFillTime' };

    const renderField = (value, { onChange = jest.fn(), onReset = jest.fn() } = {}) => {
        render(<SettingInput settingKey={KEY} config={config} value={value} onChange={onChange} onReset={onReset} />);
        return { onChange, onReset };
    };

    test('renders one time input per stored entry', () => {
        renderField(['09:00', '21:30']);
        expect(timeInputs().map((i) => i.value)).toEqual(['09:00', '21:30']);
    });

    test('empty list renders no rows and the off-hint', () => {
        renderField([]);
        expect(timeInputs()).toHaveLength(0);
        expect(screen.getByText('app.scheduledFillTimeOff')).toBeTruthy();
    });

    test('a non-empty list hides the off-hint', () => {
        renderField(['09:00']);
        expect(screen.queryByText('app.scheduledFillTimeOff')).toBeNull();
    });

    test('null normalizes to the empty list (controlled inputs)', () => {
        renderField(null);
        expect(timeInputs()).toHaveLength(0);
    });

    test('adding a row keeps it as a local draft (no emission of "")', () => {
        const { onChange } = renderField(['09:00']);
        fireEvent.click(addButton('app.scheduledFillAddTime'));
        expect(timeInputs()).toHaveLength(2);
        expect(onChange).toHaveBeenCalledWith(KEY, ['09:00']);
    });

    test('editing a row emits the full array', () => {
        const { onChange } = renderField(['09:00', '21:30']);
        fireEvent.change(timeInputs()[1], { target: { value: '22:15' } });
        expect(onChange).toHaveBeenCalledWith(KEY, ['09:00', '22:15']);
    });

    test('removing a row emits without it (indexed aria-label)', () => {
        const { onChange } = renderField(['09:00', '21:30']);
        const removes = removeButtons();
        expect(removes).toHaveLength(2);
        fireEvent.click(removes[0]);
        expect(onChange).toHaveBeenCalledWith(KEY, ['21:30']);
    });

    test('duplicate entries are flagged inline and deduped from the emission', () => {
        const { onChange } = renderField(['09:00', '21:30']);
        fireEvent.change(timeInputs()[1], { target: { value: '09:00' } });
        expect(screen.getByText('app.scheduledFillDuplicateEntry')).toBeTruthy();
        expect(onChange).toHaveBeenCalledWith(KEY, ['09:00']);
    });

    test('at the cap the add button is disabled AND a visible status message explains why', () => {
        const full = Array.from({ length: SCHEDULED_FILL_MAX_ENTRIES }, (_, i) => `0${i}:00`.slice(-5));
        renderField(full);
        expect(addButton('app.scheduledFillAddTime').disabled).toBe(true);
        const status = screen.getByText(new RegExp(`app\\.scheduledFillMaxEntries`));
        expect(status.closest('[role="status"]') ?? status.getAttribute('role')).toBeTruthy();
    });

    test('each row input is described by its own per-row hint id', () => {
        renderField(['09:00', '21:30']);
        const ids = timeInputs().map((i) => i.getAttribute('aria-describedby'));
        expect(ids).toEqual([`${KEY}-row-0-hint`, `${KEY}-row-1-hint`]);
    });

    test('the reset button calls onReset with the key', () => {
        const { onReset } = renderField(['09:00']);
        fireEvent.click(screen.getByTitle('app.resetToDefaultNotSaved'));
        expect(onReset).toHaveBeenCalledWith(KEY);
    });
});

describe('SettingInput type=timeList', () => {
    const KEY = 'scheduledFillBeforeEnd';
    const config = { type: 'timeList', default: [], label: 'app.scheduledFillBeforeEnd' };

    const renderField = (value, { onChange = jest.fn(), onReset = jest.fn() } = {}) => {
        render(<SettingInput settingKey={KEY} config={config} value={value} onChange={onChange} onReset={onReset} />);
        return { onChange, onReset };
    };

    test('renders an hours+minutes pair per stored entry', () => {
        renderField([4 * 3600, 10 * 3600 + 30 * 60]);
        // Two rows → four number inputs: [4h, 0m, 10h, 30m].
        expect(numberInputs().map((i) => i.value)).toEqual(['4', '0', '10', '30']);
    });

    test('empty list renders the off-hint', () => {
        renderField([]);
        expect(numberInputs()).toHaveLength(0);
        expect(screen.getByText('app.scheduledFillBeforeEndOff')).toBeTruthy();
    });

    test('a fresh row stays a 0h 0m draft with a draft hint, not emitted', () => {
        const { onChange } = renderField([3600]);
        fireEvent.click(addButton('app.scheduledFillAddBeforeEnd'));
        expect(screen.getByText('app.scheduledFillEntryDraft')).toBeTruthy();
        expect(onChange).toHaveBeenCalledWith(KEY, [3600]);
    });

    test('editing hours emits seconds for the full array', () => {
        const { onChange } = renderField([3600]);
        fireEvent.change(numberInputs()[0], { target: { value: '4' } });
        expect(onChange).toHaveBeenCalledWith(KEY, [4 * 3600]);
    });

    test('the issue case: two offsets (4h and 10h) round-trip', () => {
        const { onChange } = renderField([4 * 3600]);
        fireEvent.click(addButton('app.scheduledFillAddBeforeEnd'));
        fireEvent.change(numberInputs()[2], { target: { value: '10' } });
        expect(onChange).toHaveBeenLastCalledWith(KEY, [4 * 3600, 10 * 3600]);
    });

    test('duplicate offsets are flagged and deduped from the emission', () => {
        const { onChange } = renderField([3600, 7200]);
        // Set row 2 to 1h as well → duplicate of row 1.
        fireEvent.change(numberInputs()[2], { target: { value: '1' } });
        expect(screen.getByText('app.scheduledFillDuplicateEntry')).toBeTruthy();
        expect(onChange).toHaveBeenCalledWith(KEY, [3600]);
    });

    test('removing a row emits without it', () => {
        const { onChange } = renderField([3600, 7200]);
        fireEvent.click(removeButtons()[1]);
        expect(onChange).toHaveBeenCalledWith(KEY, [3600]);
    });

    test('at the cap the add button is disabled with a visible status message', () => {
        renderField(Array.from({ length: SCHEDULED_FILL_MAX_ENTRIES }, (_, i) => (i + 1) * 3600));
        expect(addButton('app.scheduledFillAddBeforeEnd').disabled).toBe(true);
        expect(screen.getByText(/app\.scheduledFillMaxEntries/)).toBeTruthy();
    });

    test('an entry above the 30-day cap flags out-of-range with the error class and hint', () => {
        renderField([31 * 24 * 3600]);
        expect(screen.getByText('app.autoFillScheduleOutOfRange')).toBeTruthy();
        expect(numberInputs().every((i) => i.className.includes('input-error'))).toBe(true);
    });

    test('a hand-edited negative or fractional entry flags out-of-range instead of posing as a draft', () => {
        renderField([-5]);
        expect(screen.getByText('app.autoFillScheduleOutOfRange')).toBeTruthy();
        expect(screen.queryByText('app.scheduledFillEntryDraft')).toBeNull();
    });

    test('an in-range entry carries no error class', () => {
        renderField([4 * 3600]);
        expect(screen.queryByText('app.autoFillScheduleOutOfRange')).toBeNull();
        expect(numberInputs().every((i) => !i.className.includes('input-error'))).toBe(true);
    });
});
