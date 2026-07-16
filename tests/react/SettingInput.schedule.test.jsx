/**
 * Component tests for the `type: 'schedule'` branch of SettingInput — the
 * fixed auto-fill schedule editor (ScheduleField). GuruShots challenges allow
 * at most 4 images and entry 1 always exists, so the editor renders exactly
 * three fixed rows (Image 2, Image 3, Image 4), each a time-before-close.
 * 0h 0m = off. Edits emit ONLY the active rows (seconds > 0) sorted by count;
 * any stored row not keyed by counts 2/3/4 is dropped on the first edit. The
 * translation manager mock returns each key verbatim, so labels are the i18n
 * keys (row aria-labels read e.g. "app.autoFillScheduleImage 2 app.hours").
 */

import { fireEvent, render, screen } from '@/test/test-utils';
import { SettingInput } from '@/components/app/SettingInput';

const KEY = 'autoFillSchedule';
const MAX_SECONDS = 30 * 24 * 3600;
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

const hoursInput = (count) => screen.getByLabelText(`app.autoFillScheduleImage ${count} app.hours`);
const minutesInput = (count) => screen.getByLabelText(`app.autoFillScheduleImage ${count} app.minutes`);
const allHoursInputs = () => screen.queryAllByLabelText(/^app\.autoFillScheduleImage \d+ app\.hours$/);

describe('SettingInput type=schedule — fixed three-row rendering', () => {
    test('renders exactly the three fixed rows for an empty stored array', () => {
        renderSchedule([]);
        expect(allHoursInputs()).toHaveLength(3);
        [2, 3, 4].forEach((count) => {
            expect(hoursInput(count).value).toBe('0');
            expect(minutesInput(count).value).toBe('0');
        });
    });

    test('renders exactly three rows for a sparse stored array, missing images shown as off', () => {
        renderSchedule([{ count: 4, seconds: 900 }]);
        expect(allHoursInputs()).toHaveLength(3);
        expect(hoursInput(2).value).toBe('0');
        expect(minutesInput(2).value).toBe('0');
        expect(hoursInput(3).value).toBe('0');
        expect(minutesInput(3).value).toBe('0');
        expect(minutesInput(4).value).toBe('15');
        // Images 2 and 3 carry the off hint; image 4 does not.
        expect(screen.getAllByText('app.autoFillScheduleOff')).toHaveLength(2);
    });

    test('renders exactly three rows for a full stored array with per-row values', () => {
        renderSchedule(config.default);
        expect(allHoursInputs()).toHaveLength(3);
        expect(minutesInput(2).value).toBe('30');
        expect(minutesInput(3).value).toBe('20');
        expect(minutesInput(4).value).toBe('10');
        expect(screen.queryByText('app.autoFillScheduleOff')).toBeNull();
    });

    test('row labels and aria-labels carry the image identity', () => {
        renderSchedule(config.default);
        // Visible row label: "app.autoFillScheduleImage N ≤".
        [2, 3, 4].forEach((count) => {
            expect(screen.getByText(`app.autoFillScheduleImage ${count} ≤`)).toBeTruthy();
            expect(screen.getByLabelText(`app.autoFillScheduleImage ${count} app.hours`)).toBeTruthy();
            expect(screen.getByLabelText(`app.autoFillScheduleImage ${count} app.minutes`)).toBeTruthy();
        });
    });
});

describe('SettingInput type=schedule — edits emit active rows sorted by count', () => {
    test("editing a row's hours emits only seconds>0 rows sorted by count", () => {
        const onChange = renderSchedule([{ count: 4, seconds: 900 }]);
        fireEvent.change(hoursInput(2), { target: { value: '1' } });
        expect(onChange).toHaveBeenCalledWith(KEY, [
            { count: 2, seconds: 3600 },
            { count: 4, seconds: 900 },
        ]);
    });

    test('setting a row to 0h 0m drops it from the payload', () => {
        // Image 3 is 0h 20m; zeroing the minutes turns it off entirely.
        const onChange = renderSchedule(config.default);
        fireEvent.change(minutesInput(3), { target: { value: '0' } });
        expect(onChange).toHaveBeenCalledWith(KEY, [
            { count: 2, seconds: 1800 },
            { count: 4, seconds: 600 },
        ]);
    });

    test('zeroing every row emits [] (the no-schedule opt-out)', () => {
        const onChange = renderSchedule([{ count: 2, seconds: 1800 }]);
        fireEvent.change(minutesInput(2), { target: { value: '0' } });
        expect(onChange).toHaveBeenCalledWith(KEY, []);
    });

    test('a stored row with an unexpected count is dropped on the first edit of any row', () => {
        const onChange = renderSchedule([
            { count: 7, seconds: 999 },
            { count: 2, seconds: 1800 },
        ]);
        fireEvent.change(minutesInput(4), { target: { value: '10' } });
        expect(onChange).toHaveBeenCalledWith(KEY, [
            { count: 2, seconds: 1800 },
            { count: 4, seconds: 600 },
        ]);
    });

    test('emitted payload stays sorted by count when a later image is edited first', () => {
        const onChange = renderSchedule([]);
        fireEvent.change(minutesInput(4), { target: { value: '10' } });
        expect(onChange).toHaveBeenCalledWith(KEY, [{ count: 4, seconds: 600 }]);
    });
});

describe('SettingInput type=schedule — inline diagnostics', () => {
    test('all rows off shows the role="status" empty warning', () => {
        renderSchedule([]);
        const status = screen.getByRole('status');
        expect(status.textContent).toBe('app.autoFillScheduleEmpty');
    });

    test('rows stored with seconds 0 also count as off for the empty warning', () => {
        renderSchedule([
            { count: 2, seconds: 0 },
            { count: 3, seconds: 0 },
        ]);
        expect(screen.getByRole('status').textContent).toBe('app.autoFillScheduleEmpty');
    });

    test('no empty warning while at least one row is active', () => {
        renderSchedule([{ count: 3, seconds: 600 }]);
        expect(screen.queryByRole('status')).toBeNull();
    });

    test('time inversion marks the earlier image dominated (2 @ 10m vs 3 @ 3h)', () => {
        // Image 3 reaches a higher count no later (3h ≥ 10m), so the
        // image-2-at-10m step never fires under the max-based trigger.
        renderSchedule([
            { count: 2, seconds: 600 },
            { count: 3, seconds: 10800 },
        ]);
        const badges = screen.getAllByText('app.autoFillScheduleDominated');
        expect(badges).toHaveLength(1);
        // The badge sits in image 2's hint span (aria-describedby wiring).
        expect(badges[0].closest(`[id="${KEY}-row-2-hint"]`)).not.toBeNull();
    });

    test('a well-ordered schedule shows no dominated badge', () => {
        renderSchedule(config.default);
        expect(screen.queryByText('app.autoFillScheduleDominated')).toBeNull();
    });

    test('off rows never get the dominated badge — only the off hint', () => {
        // Images 2 and 4 are off; an active row "covers" a 0-second row
        // trivially, but off rows are excluded from the check by design.
        renderSchedule([{ count: 3, seconds: 10800 }]);
        expect(screen.queryByText('app.autoFillScheduleDominated')).toBeNull();
        expect(screen.getAllByText('app.autoFillScheduleOff')).toHaveLength(2);
    });

    test('seconds above the 30-day cap flag the row out-of-range with the error class', () => {
        renderSchedule([{ count: 2, seconds: MAX_SECONDS + 60 }]);
        expect(screen.getByText('app.autoFillScheduleOutOfRange')).toBeTruthy();
        expect(hoursInput(2).className).toMatch(/input-error/);
        expect(minutesInput(2).className).toMatch(/input-error/);
        // In-range rows carry no error class.
        expect(hoursInput(3).className).not.toMatch(/input-error/);
    });

    test('a row exactly at the 30-day cap is not flagged out-of-range', () => {
        renderSchedule([{ count: 2, seconds: MAX_SECONDS }]);
        expect(screen.queryByText('app.autoFillScheduleOutOfRange')).toBeNull();
    });

    test('a corrupted negative seconds value is flagged out-of-range, never dominated', () => {
        // A hand-corrupted -5 renders as 0h 0m (secondsToHoursMinutes clamps)
        // but is NOT the off state; without the full bounds check it would
        // show a spurious dominated badge (any active row "covers" -5s).
        renderSchedule([
            { count: 2, seconds: -5 },
            { count: 3, seconds: 10800 },
        ]);
        expect(screen.getByText('app.autoFillScheduleOutOfRange')).toBeTruthy();
        expect(screen.queryByText('app.autoFillScheduleDominated')).toBeNull();
        expect(screen.queryByText('app.autoFillScheduleOff')).not.toBeNull(); // image 4 is off
    });

    test('a corrupted fractional seconds value is flagged out-of-range', () => {
        renderSchedule([{ count: 2, seconds: 600.5 }]);
        expect(screen.getByText('app.autoFillScheduleOutOfRange')).toBeTruthy();
    });
});
