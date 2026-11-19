/**
 * The dynamic schedule editor: submit rows with their counts and instants, vote
 * and pause windows, the replaced-setting conflict, and the row caps.
 */

import { useState } from 'react';
import { act, render, screen, fireEvent } from './helpers/test-utils';
import { ScheduleEditor } from '@/components/app/scenarioBuilder/ScheduleEditor';
import { invalid } from '../helpers/invalid';
import { parseJson, parseJsonObject } from '../helpers/parseJson';

type Control = HTMLInputElement | HTMLSelectElement;

const changeSelect = (sel: Control, value: string) =>
    act(() => {
        sel.value = value;
        sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });

function Probe({ initial, held = [] as string[] }: { initial: unknown; held?: string[] }) {
    const [value, setValue] = useState<unknown>(initial);
    return (
        <div>
            <ScheduleEditor
                schedules={value}
                onChange={setValue}
                context={{ stages: ['active'], settingKeys: [] }}
                heldKeys={held}
            />
            <output data-testid="value">{JSON.stringify(value ?? null)}</output>
        </div>
    );
}

const value = () => parseJson(screen.getByTestId('value').textContent);
/** The schedules object as the tests read it. */
const schedulesOf = () =>
    parseJsonObject(screen.getByTestId('value').textContent) as Record<string, { alignment?: string; rows: unknown[] }>;
const select = (name: string) => screen.getAllByLabelText<HTMLSelectElement>(name).at(-1)!;

describe('submit', () => {
    test('adding a submit schedule starts one row whose count and instant are editable', () => {
        render(<Probe initial={undefined} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAdd_submit' }));
        expect(value()).toEqual({
            submit: { alignment: 'end', rows: [{ count: 1, at: expect.anything() }] },
        });
        changeSelect(select('app.sbScheduleCount'), '2');
        changeSelect(select('app.sbExprKind'), 'fact');
        expect(schedulesOf().submit.rows[0]).toEqual({ count: 2, at: { kind: 'fact', name: 'clock.now' } });
    });

    test('rows add up to four and remove back to none, taking the schedule with them', () => {
        render(<Probe initial={undefined} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAdd_submit' }));
        for (let n = 0; n < 3; n++)
            fireEvent.click(screen.getAllByRole('button', { name: 'app.sbScheduleAddRow_submit' }).at(-1)!);
        expect(schedulesOf().submit.rows).toHaveLength(4);
        expect(
            screen.getAllByRole<HTMLButtonElement>('button', { name: 'app.sbScheduleAddRow_submit' }).at(-1)!.disabled,
        ).toBe(true);
        // Counts stay unique: a taken count is not offered again.
        const counts = [...select('app.sbScheduleCount').options].map((option) => option.value);
        expect(counts).not.toContain((schedulesOf().submit.rows[0] as { count: number }).count);
        for (let n = 0; n < 4; n++)
            fireEvent.click(screen.getAllByRole('button', { name: /^app\.sbScheduleRemoveRow_submit: / }).at(-1)!);
        expect(value()).toBeNull();
    });

    test('a hand-edited schedule whose rows are not a list reads as none', () => {
        render(
            <Probe
                initial={invalid<Record<string, unknown>>({
                    submit: invalid<Record<string, unknown>>({ rows: 'junk' }),
                })}
            />,
        );
        expect(screen.queryByLabelText('app.sbScheduleCount')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAddRow_submit' }));
        expect(schedulesOf().submit.rows).toHaveLength(1);
    });

    test('a submit schedule without an alignment reads as the end-aligned one', () => {
        render(<Probe initial={{ submit: { rows: [{ count: 1, at: { kind: 'fact', name: 'clock.now' } }] } }} />);
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbField_alignment').value).toBe('end');
    });

    test('the alignment switches, and the whole kind is removed with its rows', () => {
        render(
            <Probe
                initial={{
                    submit: { alignment: 'end', rows: [{ count: 1, at: { kind: 'fact', name: 'clock.now' } }] },
                }}
            />,
        );
        changeSelect(select('app.sbField_alignment'), 'absolute');
        expect(schedulesOf().submit.alignment).toBe('absolute');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbRemove: app.sbSchedule_submit' }));
        expect(value()).toBeNull();
    });

    test('a held literal the schedule replaces keeps it from being added', () => {
        render(<Probe initial={undefined} held={['autoSubmitSchedule']} />);
        const add = screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbScheduleAdd_submit' });
        expect(add.disabled).toBe(true);
        expect(screen.getByText('app.sbScheduleReplaces: app.autoSubmitSchedule')).toBeTruthy();
    });
});

describe('windows', () => {
    test('vote and pause windows hold an instant and a duration each', () => {
        render(<Probe initial={undefined} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAdd_vote' }));
        changeSelect(select('app.sbExprKind'), 'fact');
        expect(schedulesOf().vote.rows[0]).toEqual(
            expect.objectContaining({ at: { kind: 'fact', name: 'clock.now' } }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAdd_pause' }));
        expect(schedulesOf().pause.rows[0]).toEqual(expect.objectContaining({ duration: expect.anything() }));
    });

    test('a held pause setting keeps the pause schedule off', () => {
        render(<Probe initial={undefined} held={['votingPauseTime']} />);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbScheduleAdd_pause' }).disabled).toBe(true);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbScheduleAdd_vote' }).disabled).toBe(false);
    });

    test('a row removes to none, and the window kind goes with it', () => {
        render(
            <Probe
                initial={{
                    vote: {
                        rows: [
                            {
                                at: { kind: 'fact', name: 'clock.now' },
                                duration: { kind: 'literal', value: 1, quantity: 'duration', unit: 'hours' },
                            },
                        ],
                    },
                }}
            />,
        );
        fireEvent.click(screen.getByRole('button', { name: /^app\.sbScheduleRemoveRow_vote: / }));
        expect(value()).toBeNull();
    });
});

describe('hand-edited values', () => {
    test('a schedule that is not an object reads as none', () => {
        render(<Probe initial="nonsense" />);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbScheduleAdd_submit' }).disabled).toBe(
            false,
        );
        expect(screen.queryByLabelText('app.sbScheduleCount')).toBeNull();
    });

    test('a malformed row still renders its controls for the rows that are whole', () => {
        render(
            <Probe
                initial={{
                    submit: {
                        alignment: 'absolute',
                        rows: [{ count: 2, at: { kind: 'fact', name: 'clock.now' } }, null],
                    },
                }}
            />,
        );
        expect(screen.getAllByLabelText('app.sbScheduleCount').filter((el) => el.tagName === 'SELECT')).toHaveLength(2);
        expect(schedulesOf().submit.rows[0]).toEqual({ count: 2, at: { kind: 'fact', name: 'clock.now' } });
    });
});

test('a window schedule stops at its row cap', () => {
    render(<Probe initial={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAdd_vote' }));
    for (let n = 0; n < 5; n++) fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAddRow_vote' }));
    expect(schedulesOf().vote.rows).toHaveLength(6);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbScheduleAddRow_vote' }).disabled).toBe(true);
});

describe('focus after adding and removing', () => {
    const at = { kind: 'fact', name: 'clock.now' };
    const threeRows = {
        submit: {
            alignment: 'end',
            rows: [
                { count: 1, at },
                { count: 2, at },
                { count: 3, at },
            ],
        },
    };
    /** A failed toBe on a DOM node makes Jest print the whole page: compare as a boolean. */
    const isFocused = (element: Element | undefined) => document.activeElement === element;
    const removeRow = (name: 'submit' | 'vote', position: number) =>
        screen.getByRole<HTMLButtonElement>('button', {
            name: `app.sbScheduleRemoveRow_${name}: ${position}`,
        });

    test('adding a schedule lands on the first control of its new row', () => {
        render(<Probe initial={undefined} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAdd_submit' }));
        expect(isFocused(screen.getByRole('combobox', { name: 'app.sbScheduleCount' }))).toBe(true);
    });

    test('adding a row lands on the first control of that row, also when the add button turns off', () => {
        render(<Probe initial={{ submit: { alignment: 'end', rows: threeRows.submit.rows.slice(0, 3) } }} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAddRow_submit' }));
        expect(schedulesOf().submit.rows).toHaveLength(4);
        const counts = screen.getAllByRole('combobox', { name: 'app.sbScheduleCount' });
        expect(isFocused(counts[3])).toBe(true);
    });

    test('a window row added lands on its first control', () => {
        render(<Probe initial={undefined} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAdd_vote' }));
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAddRow_vote' }));
        const rows = document.querySelectorAll('[data-list-row]');
        expect(rows).toHaveLength(2);
        expect(rows[1]!.contains(document.activeElement)).toBe(true);
        expect(document.activeElement === document.body).toBe(false);
    });

    test('removing a middle row lands on the remove button now in its place', () => {
        render(<Probe initial={threeRows} />);
        fireEvent.click(removeRow('submit', 2));
        expect(schedulesOf().submit.rows).toHaveLength(2);
        expect(isFocused(removeRow('submit', 2))).toBe(true);
    });

    test('removing the last row lands on the previous row remove button', () => {
        render(<Probe initial={threeRows} />);
        fireEvent.click(removeRow('submit', 3));
        expect(isFocused(removeRow('submit', 2))).toBe(true);
    });

    test('removing the first row lands on the remove button now first', () => {
        render(<Probe initial={threeRows} />);
        fireEvent.click(removeRow('submit', 1));
        expect(isFocused(removeRow('submit', 1))).toBe(true);
    });

    test('removing the only row of a schedule lands on its add button', () => {
        render(<Probe initial={{ vote: { rows: [{ at, duration: { kind: 'literal', value: 1 } }] } }} />);
        fireEvent.click(removeRow('vote', 1));
        expect(value()).toBeNull();
        expect(isFocused(screen.getByRole('button', { name: 'app.sbScheduleAdd_vote' }))).toBe(true);
    });

    test('removing a whole schedule lands on its add button', () => {
        render(<Probe initial={threeRows} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.sbRemove: app.sbSchedule_submit' }));
        expect(isFocused(screen.getByRole('button', { name: 'app.sbScheduleAdd_submit' }))).toBe(true);
    });

    test('an add the editor did not take leaves the focus alone', () => {
        const props = { onChange: jest.fn(), context: { stages: ['active' as const], settingKeys: [] }, heldKeys: [] };
        const schedule = { vote: { rows: [{ at, duration: { kind: 'literal', value: 1 } }] } };
        const view = render(<ScheduleEditor schedules={schedule} {...props} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAddRow_vote' }));
        expect(props.onChange).toHaveBeenCalledTimes(1);
        // The same rows again: there is no new row to land on, so nothing takes the focus.
        view.rerender(<ScheduleEditor schedules={schedule} {...props} />);
        expect(document.activeElement === document.body).toBe(true);
    });

    test('two editors on the page keep their focus to themselves', () => {
        render(
            <div>
                <Probe initial={threeRows} />
                <Probe initial={threeRows} />
            </div>,
        );
        fireEvent.click(screen.getAllByRole('button', { name: 'app.sbScheduleRemoveRow_submit: 3' })[1]!);
        expect(isFocused(screen.getAllByRole('button', { name: 'app.sbScheduleRemoveRow_submit: 2' })[1])).toBe(true);
    });
});
