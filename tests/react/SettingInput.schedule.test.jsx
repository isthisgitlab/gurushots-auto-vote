/**
 * Component tests for the `type: 'schedule'` branch of SettingInput — the
 * auto-fill schedule editor (ScheduleField). One row per { count, seconds }
 * step, displayed sorted by count; add/remove emit onChange payloads mapped
 * back through each row's original array index. Duplicate counts and
 * dominated rows are flagged inline. The translation manager mock returns
 * each key verbatim, so labels are the i18n keys.
 */

import { fireEvent, render, screen } from '@/test/test-utils';
import { SettingInput } from '@/components/app/SettingInput';

const KEY = 'autoFillSchedule';
const config = {
    type: 'schedule',
    default: [
        { count: 2, seconds: 1800 },
        { count: 3, seconds: 1200 },
        { count: 4, seconds: 600 },
    ],
};

const renderSchedule = (value, onChange = jest.fn()) => {
    render(<SettingInput settingKey={KEY} config={config} value={value} onChange={onChange} onReset={jest.fn()} />);
    return onChange;
};

const countInputs = () => screen.queryAllByLabelText('app.autoFillScheduleImageCount');
const removeButtons = () => screen.queryAllByLabelText('app.autoFillScheduleRemoveStep');
const addButton = () =>
    Array.from(document.querySelectorAll('button')).find((b) => b.textContent.includes('app.autoFillScheduleAddStep'));

describe('SettingInput type=schedule — row rendering', () => {
    test('renders one row per entry, sorted by count regardless of array order', () => {
        renderSchedule([
            { count: 4, seconds: 600 },
            { count: 2, seconds: 1800 },
        ]);
        const counts = countInputs();
        expect(counts).toHaveLength(2);
        expect(counts.map((i) => i.value)).toEqual(['2', '4']);
        // Hours/minutes fields carry the per-row seconds (1800s → 0h 30m first).
        const minutes = screen.getAllByLabelText('app.minutes');
        expect(minutes.map((i) => i.value)).toEqual(['30', '10']);
    });

    test('renders hour + minute inputs per row with translated aria-labels', () => {
        renderSchedule([{ count: 2, seconds: 3600 + 12 * 60 }]);
        expect(screen.getAllByLabelText('app.hours')[0].value).toBe('1');
        expect(screen.getAllByLabelText('app.minutes')[0].value).toBe('12');
    });
});

describe('SettingInput type=schedule — add / remove', () => {
    test('add button appends the lowest unused count ≥ 2 with 3600 seconds', () => {
        const onChange = renderSchedule([
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
        ]);
        fireEvent.click(addButton());
        expect(onChange).toHaveBeenCalledWith(KEY, [
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
            { count: 4, seconds: 3600 },
        ]);
    });

    test('add button fills a gap in the used counts (2 and 4 used → adds 3)', () => {
        const onChange = renderSchedule([
            { count: 4, seconds: 600 },
            { count: 2, seconds: 1800 },
        ]);
        fireEvent.click(addButton());
        expect(onChange).toHaveBeenCalledWith(KEY, [
            { count: 4, seconds: 600 },
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 3600 },
        ]);
    });

    test('add button stays enabled while an unused count remains (counts 2..19 used → adds 20)', () => {
        const rows = Array.from({ length: 18 }, (_, i) => ({ count: i + 2, seconds: 60 * (i + 1) }));
        const onChange = renderSchedule(rows);
        expect(addButton().disabled).toBe(false);
        fireEvent.click(addButton());
        expect(onChange).toHaveBeenCalledWith(KEY, [...rows, { count: 20, seconds: 3600 }]);
    });

    test('add button is disabled once every count 2..20 is in use', () => {
        const rows = Array.from({ length: 19 }, (_, i) => ({ count: i + 2, seconds: 60 * (i + 1) }));
        renderSchedule(rows);
        expect(addButton().disabled).toBe(true);
    });

    test('add button is disabled at the 20-row cap even with a count still unused', () => {
        // 19 rows with counts 2..19 plus a duplicate 19 → 20 rows, count 20 unused.
        const rows = Array.from({ length: 18 }, (_, i) => ({ count: i + 2, seconds: 60 * (i + 1) }));
        rows.push({ count: 19, seconds: 30 }, { count: 19, seconds: 60 });
        renderSchedule(rows);
        expect(addButton().disabled).toBe(true);
    });

    test('remove button removes the right underlying row (display is sorted)', () => {
        // Displayed order is [2, 4] but the array order is [4, 2]; removing the
        // FIRST displayed row must drop {count:2}, not the array's first element.
        const onChange = renderSchedule([
            { count: 4, seconds: 600 },
            { count: 2, seconds: 1800 },
        ]);
        fireEvent.click(removeButtons()[0]);
        expect(onChange).toHaveBeenCalledWith(KEY, [{ count: 4, seconds: 600 }]);
    });
});

describe('SettingInput type=schedule — inline diagnostics', () => {
    test('duplicate counts flag both rows with the hint and the input-error class', () => {
        renderSchedule([
            { count: 2, seconds: 600 },
            { count: 2, seconds: 1800 },
        ]);
        expect(screen.getAllByText('app.autoFillScheduleDuplicate')).toHaveLength(2);
        countInputs().forEach((input) => expect(input.className).toMatch(/input-error/));
    });

    test('unique counts show neither the duplicate hint nor the error class', () => {
        renderSchedule([
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
        ]);
        expect(screen.queryByText('app.autoFillScheduleDuplicate')).toBeNull();
        countInputs().forEach((input) => expect(input.className).not.toMatch(/input-error/));
    });

    test('a dominated row (another row with count ≥ and seconds ≥, one strict) shows the badge', () => {
        // {2, 600} is dead: {3, 1800} reaches a higher count no later.
        renderSchedule([
            { count: 3, seconds: 1800 },
            { count: 2, seconds: 600 },
        ]);
        expect(screen.getAllByText('app.autoFillScheduleDominated')).toHaveLength(1);
    });

    test('no dominated badge when each row contributes (higher count, tighter deadline)', () => {
        renderSchedule([
            { count: 2, seconds: 1800 },
            { count: 3, seconds: 1200 },
            { count: 4, seconds: 600 },
        ]);
        expect(screen.queryByText('app.autoFillScheduleDominated')).toBeNull();
    });

    test('empty schedule renders the role="status" empty warning', () => {
        renderSchedule([]);
        const status = screen.getByRole('status');
        expect(status.textContent).toBe('app.autoFillScheduleEmpty');
        expect(countInputs()).toHaveLength(0);
    });
});
