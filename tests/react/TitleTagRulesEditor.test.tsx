/**
 * Component tests for TitleTagRulesEditor.tsx — the controlled list editor
 * for challenge rules in the global settings modal. The translation manager
 * mock returns each key verbatim, so labels/placeholders are the i18n keys.
 */

import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { TitleTagRulesEditor } from '@/components/app/TitleTagRulesEditor';
import type { TitleRule } from '../../src/ts/types/settings';
import { invalid } from '../helpers/invalid';

describe('TitleTagRulesEditor', () => {
    test('renders the empty-state hint when there are no rules', () => {
        render(<TitleTagRulesEditor value={[]} onChange={jest.fn()} />);
        expect(screen.getByText('app.noTitleTagRules')).toBeTruthy();
    });

    test('"Add rule" appends an empty rule', () => {
        const onChange = jest.fn();
        render(<TitleTagRulesEditor value={[]} onChange={onChange} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.addTitleTagRule' }));
        expect(onChange).toHaveBeenCalledWith([{ title: '', profile: '', mustIncludeTags: [], shouldIncludeTags: [] }]);
    });

    test('editing the title emits the updated rule', () => {
        const onChange = jest.fn();
        const value = [{ title: '', mustIncludeTags: [], shouldIncludeTags: [] }];
        render(<TitleTagRulesEditor value={value} onChange={onChange} />);
        fireEvent.change(screen.getByLabelText('app.titleTagRuleTitle 1'), { target: { value: "Let's See Hats" } });
        expect(onChange).toHaveBeenCalledWith([
            { title: "Let's See Hats", titles: ["Let's See Hats"], mustIncludeTags: [], shouldIncludeTags: [] },
        ]);
    });

    test('a rule can assign a scenario inline, and a missing one stays visible', async () => {
        jest.mocked(window.api.getScenarios).mockResolvedValue(
            invalid({ success: true, scenarios: { Plan: {} }, templates: [] }),
        );
        const onChange = jest.fn();
        const value = [{ title: 'A', mustIncludeTags: [], shouldIncludeTags: [] }];
        const { rerender } = render(<TitleTagRulesEditor value={value} onChange={onChange} />);
        await waitFor(() => expect(screen.getByRole('option', { name: 'Plan' })).toBeTruthy());
        const pick = (name: string) => {
            const select = screen.getByLabelText<HTMLSelectElement>('app.scenario');
            select.value = name;
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
        };
        pick('Plan');
        expect(onChange).toHaveBeenLastCalledWith([{ ...value[0], scenario: 'Plan' }]);

        rerender(<TitleTagRulesEditor value={[{ ...value[0], scenario: 'Plan' }]} onChange={onChange} />);
        pick('');
        expect(onChange).toHaveBeenLastCalledWith([{ ...value[0], scenario: '' }]);

        rerender(<TitleTagRulesEditor value={[{ ...value[0], scenario: 'Gone' }]} onChange={onChange} />);
        expect(screen.getByLabelText<HTMLSelectElement>('app.scenario').value).toBe('Gone');
        expect(screen.getByRole('option', { name: 'app.scenarioMissingOption' })).toBeTruthy();
    });

    test('a rule can list several titles', () => {
        const onChange = jest.fn();
        const value = [{ title: 'A', mustIncludeTags: [], shouldIncludeTags: [] }];
        render(<TitleTagRulesEditor value={value} onChange={onChange} />);
        fireEvent.click(screen.getByText(/app\.addTitleRuleTitle/));
        expect(onChange).toHaveBeenLastCalledWith([
            { title: 'A', titles: ['A', ''], mustIncludeTags: [], shouldIncludeTags: [] },
        ]);
    });

    test('stored titles render one input each and can be removed', () => {
        const onChange = jest.fn();
        const value = [{ title: 'A', titles: ['A', 'B'], mustIncludeTags: [], shouldIncludeTags: [] }];
        render(<TitleTagRulesEditor value={value} onChange={onChange} />);
        expect(screen.getByLabelText<HTMLInputElement>('app.titleTagRuleTitle 1').value).toBe('A');
        expect(screen.getByLabelText<HTMLInputElement>('app.titleTagRuleTitle 2').value).toBe('B');
        fireEvent.click(screen.getByLabelText('app.removeTitleRuleTitle 1'));
        expect(onChange).toHaveBeenLastCalledWith([
            { title: 'B', titles: ['B'], mustIncludeTags: [], shouldIncludeTags: [] },
        ]);
    });

    test('a single title has no remove-title button', () => {
        render(
            <TitleTagRulesEditor
                value={[{ title: 'A', mustIncludeTags: [], shouldIncludeTags: [] }]}
                onChange={jest.fn()}
            />,
        );
        expect(screen.queryByLabelText('app.removeTitleRuleTitle 1')).toBeNull();
    });

    test('removing a row emits the array without it', () => {
        const onChange = jest.fn();
        const value = [
            { title: 'A', mustIncludeTags: ['x'], shouldIncludeTags: [] },
            { title: 'B', mustIncludeTags: ['y'], shouldIncludeTags: [] },
        ];
        render(<TitleTagRulesEditor value={value} onChange={onChange} />);
        const removeButtons = screen.getAllByRole('button', { name: /^app\.removeTitleTagRule \d+$/ });
        expect(removeButtons[0].className).toContain('btn-error');
        expect(removeButtons[0].className).not.toContain('btn-outline');
        // Set apart from the reorder buttons, and named by its rule so the two are not the same control to a reader.
        expect(removeButtons[0].className).toContain('ml-auto');
        expect(removeButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
            'app.removeTitleTagRule 1',
            'app.removeTitleTagRule 2',
        ]);
        fireEvent.click(removeButtons[0]);
        expect(onChange).toHaveBeenCalledWith([{ title: 'B', mustIncludeTags: ['y'], shouldIncludeTags: [] }]);
    });

    test('editing the Must tags emits the parsed tag array (first TagsField in the row)', () => {
        const onChange = jest.fn();
        const value = [{ title: 'A', mustIncludeTags: [], shouldIncludeTags: [] }];
        render(<TitleTagRulesEditor value={value} onChange={onChange} />);
        // Both TagsFields share the tags placeholder; Must is rendered first.
        const tagInputs = screen.getAllByPlaceholderText('app.tagsPlaceholder');
        fireEvent.change(tagInputs[0], { target: { value: 'hat, cap' } });
        expect(onChange).toHaveBeenCalledWith([{ title: 'A', mustIncludeTags: ['hat', 'cap'], shouldIncludeTags: [] }]);
    });

    test('selecting a saved profile assigns it to the title rule', () => {
        const onChange = jest.fn();
        const value = [{ title: 'Portraits', mustIncludeTags: [], shouldIncludeTags: [] }];
        render(
            <TitleTagRulesEditor
                value={value}
                onChange={onChange}
                profiles={{ 'Portrait Tactic': { exposure: 80 }, Other: {} }}
            />,
        );

        const select = screen.getByLabelText<HTMLSelectElement>('app.titleRuleProfile');
        select.value = 'Portrait Tactic';
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
        expect(onChange).toHaveBeenCalledWith([
            { title: 'Portraits', profile: 'Portrait Tactic', mustIncludeTags: [], shouldIncludeTags: [] },
        ]);
    });

    /**
     * Inline per-title overrides. The three-way selects and the window field all
     * spell "inherit" as '', which the settings sanitizer drops — so the editor
     * must emit '' rather than a defaulted false/0, which would be a DIFFERENT,
     * explicit instruction.
     */
    describe('inline overrides', () => {
        const rowWith = (over = {}) => [{ title: 'abc', mustIncludeTags: [], shouldIncludeTags: [], ...over }];
        const pick = (label: string, next: string) => {
            const select = screen.getByLabelText<HTMLSelectElement>(label);
            select.value = next;
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
        };

        test('auto-join defaults to inherit when the rule does not set it', () => {
            render(<TitleTagRulesEditor value={rowWith()} onChange={jest.fn()} />);
            expect(screen.getByLabelText<HTMLSelectElement>('app.titleRuleAutoJoin').value).toBe('');
        });

        test('an explicit false shows as Off, not as inherit', () => {
            render(<TitleTagRulesEditor value={rowWith({ autoJoin: false })} onChange={jest.fn()} />);
            expect(screen.getByLabelText<HTMLSelectElement>('app.titleRuleAutoJoin').value).toBe('off');
        });

        test('choosing On emits a real boolean', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            pick('app.titleRuleAutoJoin', 'on');
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ autoJoin: true })]);
        });

        test('choosing Off emits false, not inherit', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            pick('app.titleRuleAutoSubmit', 'off');
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ autoSubmit: false })]);
        });

        test('returning to Inherit emits the empty sentinel the sanitizer drops', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={rowWith({ autoJoin: true })} onChange={onChange} />);
            pick('app.titleRuleAutoJoin', '');
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ autoJoin: '' })]);
        });

        describe('chosen photos', () => {
            const ID = `00000001${'a'.repeat(24)}`;
            beforeEach(() => {
                window.api.getSetting = jest.fn().mockResolvedValue('');
                window.api.getLibraryPhotos = jest.fn().mockResolvedValue({
                    success: true,
                    photos: [{ id: ID, labels: [], allowed: true, message: null, uploadDate: null }],
                    memberId: null,
                    truncated: false,
                    wonIds: [],
                    wonCount: 0,
                    preview: false,
                    readAtMs: 1_700_000_000_000,
                    allowedKnown: false,
                });
            });

            test('a rule that sets nothing inherits, with no Clear', () => {
                render(<TitleTagRulesEditor value={rowWith()} onChange={jest.fn()} />);
                const group = screen.getByRole('group', { name: 'app.chosenPhotos' });
                expect(group.textContent).toContain('app.titleRuleInherit');
                expect(screen.queryByRole('button', { name: 'app.titleRuleInherit' })).toBeNull();
            });

            test("'' (a cleared draft) also reads as inherit", () => {
                render(<TitleTagRulesEditor value={rowWith({ chosenPhotos: '' })} onChange={jest.fn()} />);
                expect(screen.getByRole('group', { name: 'app.chosenPhotos' }).textContent).toContain(
                    'app.titleRuleInherit',
                );
            });

            test('choosing photos stores the list on the rule', async () => {
                const onChange = jest.fn();
                render(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
                fireEvent.click(screen.getByRole('button', { name: 'app.choosePhotos' }));
                fireEvent.click(await screen.findByRole('button', { name: 'app.pickLoadAll' }));
                fireEvent.click(await screen.findByRole('button', { name: 'app.photoChooserTileLabel' }));
                fireEvent.click(screen.getByRole('button', { name: 'app.photoChooserUse' }));
                await waitFor(() =>
                    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ chosenPhotos: [ID] })]),
                );
                // A rule has no challenge to read eligibility through.
                expect(window.api.getLibraryPhotos).toHaveBeenCalledWith(null, undefined, 'cached', 'submit');
            });

            test('an explicit empty list means none, and Inherit writes the empty sentinel', () => {
                const onChange = jest.fn();
                render(<TitleTagRulesEditor value={rowWith({ chosenPhotos: [] })} onChange={onChange} />);
                expect(screen.getByRole('group', { name: 'app.chosenPhotos' }).textContent).toContain('app.none');
                fireEvent.click(screen.getByRole('button', { name: 'app.titleRuleInherit' }));
                expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ chosenPhotos: '' })]);
            });

            test('Submit Only is a three-way select like the other inline overrides', () => {
                const onChange = jest.fn();
                render(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
                expect(screen.getByLabelText<HTMLSelectElement>('app.chosenPhotosOnly').value).toBe('');
                pick('app.chosenPhotosOnly', 'on');
                expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ chosenPhotosOnly: true })]);
            });

            test('the pick-order flag is a three-way select too, with no reach warning', () => {
                const onChange = jest.fn();
                render(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
                expect(screen.getByLabelText<HTMLSelectElement>('app.chosenPhotosInOrder').value).toBe('');
                pick('app.chosenPhotosInOrder', 'on');
                expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ chosenPhotosInOrder: true })]);
            });

            test('Manual Only offers inherit and on only: a rule never holds off', () => {
                const onChange = jest.fn();
                render(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
                const select = screen.getByLabelText<HTMLSelectElement>('app.manualPhotosOnly');
                expect([...select.options].map((option) => option.value)).toEqual(['', 'on']);
                expect(select.value).toBe('');
                pick('app.manualPhotosOnly', 'on');
                expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ manualPhotosOnly: true })]);
                pick('app.manualPhotosOnly', '');
                expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ manualPhotosOnly: '' })]);
            });

            test('a stored false reads as inherit, not as an option the select lacks', () => {
                render(<TitleTagRulesEditor value={rowWith({ manualPhotosOnly: false })} onChange={jest.fn()} />);
                expect(screen.getByLabelText<HTMLSelectElement>('app.manualPhotosOnly').value).toBe('');
            });

            test('Manual Only on a rule says what it does to the rule, directly under its own select', () => {
                const { rerender } = render(
                    <TitleTagRulesEditor value={rowWith({ manualPhotosOnly: true })} onChange={jest.fn()} />,
                );
                const hint = screen.getByText('app.manualPhotosOnlyRuleHint');
                const select = screen.getByLabelText('app.manualPhotosOnly');
                // The hint (in its live region) shares the select's own cell, after it: not under Chosen Photos at the foot of the editor.
                expect(hint.closest('[role="status"]')!.parentElement).toBe(select.parentElement);
                expect(select.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
                expect(screen.getByRole('group', { name: 'app.chosenPhotos' }).contains(hint)).toBe(false);
                // A rule has no single challenge: the challenge settings modal's alert is not used.
                expect(screen.queryByText('app.manualOnlyAlert')).toBeNull();
                rerender(<TitleTagRulesEditor value={rowWith()} onChange={jest.fn()} />);
                expect(screen.queryByText('app.manualPhotosOnlyRuleHint')).toBeNull();
            });

            test('Submit Only on a rule warns that it reaches every matching challenge', () => {
                const { rerender } = render(
                    <TitleTagRulesEditor value={rowWith({ chosenPhotosOnly: true })} onChange={jest.fn()} />,
                );
                expect(screen.getByText('app.chosenPhotosOnlyReachHint')).toBeTruthy();
                rerender(<TitleTagRulesEditor value={rowWith({ chosenPhotosOnly: false })} onChange={jest.fn()} />);
                expect(screen.queryByText('app.chosenPhotosOnlyReachHint')).toBeNull();
            });
        });

        test('the join window emits a number', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            fireEvent.change(screen.getByLabelText('app.titleRuleJoinWindow'), { target: { value: '24' } });
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ autoJoinWithinHoursOfEnd: 24 })]);
        });

        test('clearing the join window emits inherit, NOT 0', () => {
            // 0 means "join on sight" — an empty field must not silently become it.
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={rowWith({ autoJoinWithinHoursOfEnd: 24 })} onChange={onChange} />);
            fireEvent.change(screen.getByLabelText('app.titleRuleJoinWindow'), { target: { value: '' } });
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ autoJoinWithinHoursOfEnd: '' })]);
        });

        test('an explicit 0 window renders as 0, not as an empty (inherit) field', () => {
            render(<TitleTagRulesEditor value={rowWith({ autoJoinWithinHoursOfEnd: 0 })} onChange={jest.fn()} />);
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleJoinWindow').value).toBe('0');
        });
    });

    describe('closes at', () => {
        const rowWith = (over = {}) => [{ title: 'abc', mustIncludeTags: [], shouldIncludeTags: [], ...over }];
        const input = (n = 1) =>
            screen.getByLabelText<HTMLInputElement>(new RegExp(`^app\\.titleRuleClosesAtRow ${n} app\\.of \\d+$`));
        const addButton = () => screen.getByRole('button', { name: /app\.addCloseTime/ });

        test('the time input patches closesAt, an empty value sends an empty string, and one row keeps no list', () => {
            const onChange = jest.fn();
            const { rerender } = render(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            expect(input().value).toBe('');
            fireEvent.change(input(), { target: { value: '17:10' } });
            expect(onChange).toHaveBeenLastCalledWith([
                expect.objectContaining({ closesAt: '17:10', closesAtTimes: undefined }),
            ]);
            rerender(<TitleTagRulesEditor value={rowWith({ closesAt: '17:10' })} onChange={onChange} />);
            expect(input().value).toBe('17:10');
            fireEvent.change(input(), { target: { value: '' } });
            expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ closesAt: '' })]);
        });

        test('Add time appends a blank row and starts the list; the first row stays in closesAt', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={rowWith({ closesAt: '17:10' })} onChange={onChange} />);
            fireEvent.click(addButton());
            expect(onChange).toHaveBeenLastCalledWith([
                expect.objectContaining({ closesAt: '17:10', closesAtTimes: ['17:10', ''] }),
            ]);
        });

        test('a stored list shows one row per time, editing one patches the list, and its first row mirrors into closesAt', () => {
            const onChange = jest.fn();
            render(
                <TitleTagRulesEditor
                    value={rowWith({ closesAt: '17:10', closesAtTimes: ['17:10', '18:10'] })}
                    onChange={onChange}
                />,
            );
            expect([input(1).value, input(2).value]).toEqual(['17:10', '18:10']);
            fireEvent.change(input(2), { target: { value: '19:30' } });
            expect(onChange).toHaveBeenLastCalledWith([
                expect.objectContaining({ closesAt: '17:10', closesAtTimes: ['17:10', '19:30'] }),
            ]);
            fireEvent.change(input(1), { target: { value: '16:00' } });
            expect(onChange).toHaveBeenLastCalledWith([
                expect.objectContaining({ closesAt: '16:00', closesAtTimes: ['16:00', '18:10'] }),
            ]);
        });

        test('Remove time drops that row, and cutting back to one leaves no stale list behind', () => {
            const onChange = jest.fn();
            const { rerender } = render(
                <TitleTagRulesEditor
                    value={rowWith({ closesAt: '17:10', closesAtTimes: ['17:10', '18:10', '19:10'] })}
                    onChange={onChange}
                />,
            );
            fireEvent.click(screen.getByRole('button', { name: 'app.removeCloseTime 1' }));
            expect(onChange).toHaveBeenLastCalledWith([
                expect.objectContaining({ closesAt: '18:10', closesAtTimes: ['18:10', '19:10'] }),
            ]);
            rerender(
                <TitleTagRulesEditor
                    value={rowWith({ closesAt: '18:10', closesAtTimes: ['18:10', '19:10'] })}
                    onChange={onChange}
                />,
            );
            fireEvent.click(screen.getByRole('button', { name: 'app.removeCloseTime 2' }));
            expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ closesAt: '18:10' })]);
            expect(onChange).toHaveBeenLastCalledWith([
                expect.not.objectContaining({ closesAtTimes: expect.anything() }),
            ]);
            rerender(<TitleTagRulesEditor value={rowWith({ closesAt: '18:10' })} onChange={onChange} />);
            expect(screen.queryByRole('button', { name: /app\.removeCloseTime/ })).toBeNull();
        });

        test('each row is named by its place in the list: "Close time 1 of 2"', () => {
            render(
                <TitleTagRulesEditor
                    value={rowWith({ closesAt: '17:10', closesAtTimes: ['17:10', '18:10'] })}
                    onChange={jest.fn()}
                />,
            );
            expect(screen.getByLabelText('app.titleRuleClosesAtRow 1 app.of 2')).toBeTruthy();
            expect(screen.getByLabelText('app.titleRuleClosesAtRow 2 app.of 2')).toBeTruthy();
        });

        test('Add time on a blank row keeps both blank rows on screen, and clearing the first of two blank-first rows keeps the list', () => {
            const Harness = ({ start }: { start: TitleRule[] }) => {
                const [rules, setRules] = useState<TitleRule[]>(start);
                return <TitleTagRulesEditor value={rules} onChange={setRules} />;
            };
            render(<Harness start={rowWith()} />);
            fireEvent.click(addButton());
            expect([input(1).value, input(2).value]).toEqual(['', '']);
            fireEvent.change(input(2), { target: { value: '10:00' } });
            fireEvent.change(input(1), { target: { value: '09:00' } });
            fireEvent.change(input(1), { target: { value: '' } });
            expect([input(1).value, input(2).value]).toEqual(['', '10:00']);
            fireEvent.change(input(2), { target: { value: '' } });
            expect([input(1).value, input(2).value]).toEqual(['', '']);
        });

        test('removing a row moves focus to the row that took its place, else to Add time', () => {
            const Harness = () => {
                const [rules, setRules] = useState<TitleRule[]>(
                    rowWith({ closesAt: '09:00', closesAtTimes: ['09:00', '10:00', '11:00'] }),
                );
                return <TitleTagRulesEditor value={rules} onChange={setRules} />;
            };
            render(<Harness />);
            fireEvent.click(screen.getByRole('button', { name: 'app.removeCloseTime 2' }));
            expect(document.activeElement).toBe(input(2));
            expect(input(2).value).toBe('11:00');
            fireEvent.click(screen.getByRole('button', { name: 'app.removeCloseTime 2' }));
            // One row left: no Remove to land on, so focus goes to Add time.
            expect(document.activeElement).toBe(addButton());
        });

        test('removing a lone invalid row (the row stays, blank) lands focus on its input', () => {
            const Harness = () => {
                const [rules, setRules] = useState<TitleRule[]>(rowWith({ closesAt: '7:10' }));
                return <TitleTagRulesEditor value={rules} onChange={setRules} />;
            };
            render(<Harness />);
            fireEvent.click(screen.getByRole('button', { name: 'app.removeCloseTime 1' }));
            expect(document.activeElement).toBe(input(1));
        });

        test('Add time is held at 24 rows', () => {
            const times = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
            const { rerender } = render(
                <TitleTagRulesEditor
                    value={rowWith({ closesAt: times[0], closesAtTimes: times.slice(0, 23) })}
                    onChange={jest.fn()}
                />,
            );
            expect(addButton().hasAttribute('disabled')).toBe(false);
            rerender(
                <TitleTagRulesEditor
                    value={rowWith({ closesAt: times[0], closesAtTimes: times })}
                    onChange={jest.fn()}
                />,
            );
            expect(addButton().hasAttribute('disabled')).toBe(true);
        });

        test('a new blank row shows no error', () => {
            render(
                <TitleTagRulesEditor
                    value={rowWith({ closesAt: '17:10', closesAtTimes: ['17:10', ''] })}
                    onChange={jest.fn()}
                />,
            );
            expect(input(2).classList.contains('input-error')).toBe(false);
            expect(screen.queryByText('app.titleRuleClosesAtInvalid')).toBeNull();
        });

        test('a stored value that is not a strict HH:MM is marked invalid; a valid or empty one is not', () => {
            const { rerender } = render(
                <TitleTagRulesEditor value={rowWith({ closesAt: '7:10' })} onChange={jest.fn()} />,
            );
            expect(input().classList.contains('input-error')).toBe(true);
            expect(input().getAttribute('aria-invalid')).toBe('true');
            const message = screen.getByText('app.titleRuleClosesAtInvalid');
            expect(message.id).not.toBe('');
            expect(input().getAttribute('aria-describedby')).toBe(message.id);
            for (const closesAt of ['17:10', '', undefined]) {
                rerender(<TitleTagRulesEditor value={rowWith({ closesAt })} onChange={jest.fn()} />);
                expect(input().classList.contains('input-error')).toBe(false);
                expect(input().hasAttribute('aria-invalid')).toBe(false);
                expect(input().hasAttribute('aria-describedby')).toBe(false);
                expect(screen.queryByText('app.titleRuleClosesAtInvalid')).toBeNull();
            }
        });

        test('only the invalid rows of a list say so: a bad time, a non-text entry, and a padded valid one is fine', () => {
            render(
                <TitleTagRulesEditor
                    value={rowWith({
                        closesAt: '17:10',
                        closesAtTimes: ['17:10', 'x', invalid<string>(17), ' 18:10 '],
                    })}
                    onChange={jest.fn()}
                />,
            );
            expect([1, 2, 3, 4].map((n) => input(n).classList.contains('input-error'))).toEqual([
                false,
                true,
                true,
                false,
            ]);
            expect(screen.getAllByText('app.titleRuleClosesAtInvalid')).toHaveLength(2);
        });

        test('a lone invalid row can be removed, which clears both fields; a lone valid or blank row has no Remove', () => {
            const onChange = jest.fn();
            const { rerender } = render(
                <TitleTagRulesEditor value={rowWith({ closesAt: '7:10' })} onChange={onChange} />,
            );
            fireEvent.click(screen.getByRole('button', { name: 'app.removeCloseTime 1' }));
            expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ closesAt: undefined })]);
            expect(onChange).toHaveBeenLastCalledWith([
                expect.not.objectContaining({ closesAtTimes: expect.anything() }),
            ]);
            for (const closesAt of ['17:10', '']) {
                rerender(<TitleTagRulesEditor value={rowWith({ closesAt })} onChange={onChange} />);
                expect(screen.queryByRole('button', { name: /app\.removeCloseTime/ })).toBeNull();
            }
        });

        test.each([
            [
                'a list of blanks falls back to closesAt, as the matcher does',
                { closesAt: '17:10', closesAtTimes: ['', ''] },
                ['17:10'],
                [false],
            ],
            ['an empty list falls back to closesAt', { closesAt: '17:10', closesAtTimes: [] }, ['17:10'], [false]],
            ['blank rows with no closesAt at all stay as rows', { closesAtTimes: ['', ' '] }, ['', ''], [false, false]],
            [
                'an invalid closesAt behind a list of blanks is invalid',
                { closesAt: 'x', closesAtTimes: [''] },
                [''],
                [true],
            ],
            ['a listed time is shown trimmed and is valid', { closesAtTimes: [' 18:10 '] }, ['18:10'], [false]],
            [
                'a list that is not a list marks the first row invalid, whatever closesAt says',
                { closesAt: '17:10', closesAtTimes: '18:10' },
                ['17:10'],
                [true],
            ],
            [
                'an object in place of the list marks the first row invalid',
                { closesAtTimes: { 0: '18:10' } },
                [''],
                [true],
            ],
        ])('%s', (_name, over, values, invalids) => {
            render(<TitleTagRulesEditor value={rowWith(over)} onChange={jest.fn()} />);
            expect(values.map((_, i) => input(i + 1).value)).toEqual(values);
            expect(values.map((_, i) => input(i + 1).classList.contains('input-error'))).toEqual(invalids);
        });

        test('only the first row of a malformed list is marked, and a null list is no list', () => {
            const { rerender } = render(
                <TitleTagRulesEditor value={rowWith({ closesAt: '17:10', closesAtTimes: 7 })} onChange={jest.fn()} />,
            );
            expect(screen.getAllByText('app.titleRuleClosesAtInvalid')).toHaveLength(1);
            rerender(
                <TitleTagRulesEditor
                    value={rowWith({ closesAt: '17:10', closesAtTimes: null })}
                    onChange={jest.fn()}
                />,
            );
            expect(screen.queryByText('app.titleRuleClosesAtInvalid')).toBeNull();
            expect(input().value).toBe('17:10');
        });

        test('a rule that lists only several times (no closesAt) is a broad-spending rule when it auto-joins', () => {
            render(
                <TitleTagRulesEditor
                    value={[
                        {
                            title: '',
                            closesAtTimes: ['17:10', '18:10'],
                            autoJoin: true,
                            mustIncludeTags: [],
                            shouldIncludeTags: [],
                        },
                    ]}
                    onChange={jest.fn()}
                />,
            );
            expect(screen.getByText('app.titleRuleBroadWarning')).toBeTruthy();
        });
    });

    describe('match mode and challenge tag', () => {
        const rowWith = (over = {}) => [{ title: 'abc', mustIncludeTags: [], shouldIncludeTags: [], ...over }];

        test('a rule with no match key shows as exact', () => {
            render(<TitleTagRulesEditor value={rowWith()} onChange={jest.fn()} />);
            expect(screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 1').value).toBe('exact');
        });

        test('choosing a mode emits it', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            const select = screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 1');
            select.value = 'contains';
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ match: 'contains' })]);
        });

        test('the mode is offered only once the rule names a title; until then it shows exact', () => {
            const { rerender } = render(
                <TitleTagRulesEditor
                    value={rowWith({ title: '', titles: ['  '], match: 'contains', pics: 4 })}
                    onChange={jest.fn()}
                />,
            );
            const select = () => screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 1');
            expect(select().disabled).toBe(true);
            expect(select().value).toBe('exact');
            rerender(<TitleTagRulesEditor value={rowWith({ match: 'contains' })} onChange={jest.fn()} />);
            expect(select().disabled).toBe(false);
            expect(select().value).toBe('contains');
        });

        test('a saved mode renders back', () => {
            render(<TitleTagRulesEditor value={rowWith({ match: 'starts' })} onChange={jest.fn()} />);
            expect(screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 1').value).toBe('starts');
        });

        test('each title has its own mode and removing a title keeps modes aligned', () => {
            const onChange = jest.fn();
            const value = rowWith({ titles: ['Hats', 'Photo'], titleMatchModes: ['exact', 'starts'] });
            render(<TitleTagRulesEditor value={value} onChange={onChange} />);
            expect(screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 1').value).toBe('exact');
            expect(screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 2').value).toBe('starts');
            fireEvent.click(screen.getByLabelText('app.removeTitleRuleTitle 1'));
            expect(onChange).toHaveBeenLastCalledWith([
                expect.objectContaining({ title: 'Photo', titles: ['Photo'], titleMatchModes: ['starts'] }),
            ]);
        });

        test('changing the second title mode leaves the first title mode unchanged', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={rowWith({ titles: ['Hats', 'Photo'] })} onChange={onChange} />);
            const select = screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 2');
            select.value = 'starts';
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
            expect(onChange).toHaveBeenLastCalledWith([
                expect.objectContaining({ titleMatchModes: ['exact', 'starts'] }),
            ]);
        });

        test('editing the challenge tag emits it', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            fireEvent.change(screen.getByLabelText('app.titleRuleChallengeTag'), {
                target: { value: 'Exhibition' },
            });
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ challengeTag: 'Exhibition' })]);
        });

        test('the challenge-tag field is distinct from the photo tag fields', () => {
            // Three tag-ish inputs in a row: challenge tag (its own labelled
            // field) plus Must/Should photo tags (the shared placeholder).
            render(<TitleTagRulesEditor value={rowWith({ challengeTag: 'Turbo' })} onChange={jest.fn()} />);
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleChallengeTag').value).toBe('Turbo');
            expect(screen.getAllByPlaceholderText('app.tagsPlaceholder')).toHaveLength(2);
        });

        test('a tag-only rule renders with an empty title', () => {
            render(
                <TitleTagRulesEditor
                    value={[{ challengeTag: 'Exhibition', mustIncludeTags: [], shouldIncludeTags: [] }]}
                    onChange={jest.fn()}
                />,
            );
            expect(screen.getByLabelText<HTMLInputElement>('app.titleTagRuleTitle 1').value).toBe('');
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleChallengeTag').value).toBe('Exhibition');
        });
    });

    describe('edge rows', () => {
        test('a non-array value renders the empty state instead of crashing', () => {
            render(<TitleTagRulesEditor value={null} onChange={jest.fn()} />);
            expect(screen.getByText('app.noTitleTagRules')).toBeTruthy();
        });

        test('editing the second of several titles leaves the first untouched', () => {
            const onChange = jest.fn();
            const value = [{ title: 'A', titles: ['A', 'B'], mustIncludeTags: [], shouldIncludeTags: [] }];
            render(<TitleTagRulesEditor value={value} onChange={onChange} />);
            fireEvent.change(screen.getByLabelText('app.titleTagRuleTitle 2'), { target: { value: 'C' } });
            expect(onChange).toHaveBeenLastCalledWith([
                { title: 'A', titles: ['A', 'C'], mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
        });

        test('a hand-edited null first title falls back to an empty primary title', () => {
            const onChange = jest.fn();
            const value = invalid<TitleRule[]>([
                { title: 'x', titles: [null, 'B'], mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
            render(<TitleTagRulesEditor value={value} onChange={onChange} />);
            fireEvent.click(screen.getByLabelText('app.removeTitleRuleTitle 2'));
            expect(onChange).toHaveBeenLastCalledWith([
                { title: '', titles: [null], mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
        });

        test('editing the Should tags of the second rule only patches that rule', () => {
            const onChange = jest.fn();
            const value = [
                { title: 'A', mustIncludeTags: [], shouldIncludeTags: [] },
                { title: 'B', mustIncludeTags: [], shouldIncludeTags: [] },
            ];
            render(<TitleTagRulesEditor value={value} onChange={onChange} />);
            // Two TagsFields per row: [A.must, A.should, B.must, B.should].
            const tagInputs = screen.getAllByPlaceholderText('app.tagsPlaceholder');
            fireEvent.change(tagInputs[3], { target: { value: 'sky' } });
            expect(onChange).toHaveBeenCalledWith([
                { title: 'A', mustIncludeTags: [], shouldIncludeTags: [] },
                { title: 'B', mustIncludeTags: [], shouldIncludeTags: ['sky'] },
            ]);
        });
    });

    /**
     * Class conditions (type, photo count, runtime range), the ordering
     * controls, and the broad-rule warning.
     */
    describe('class conditions and ordering', () => {
        const row = (over = {}) => ({ title: '', mustIncludeTags: [], shouldIncludeTags: [], ...over });
        const pick = (label: string, next: string) => {
            const select = screen.getByLabelText<HTMLSelectElement>(label);
            select.value = next;
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
        };

        test('editing the challenge type emits it and the suggestions render', () => {
            const onChange = jest.fn();
            const { container } = render(
                <TitleTagRulesEditor value={[row()]} onChange={onChange} types={['default', 'flash']} />,
            );
            fireEvent.change(screen.getByLabelText('app.titleRuleType'), { target: { value: 'flash' } });
            expect(onChange).toHaveBeenCalledWith([row({ type: 'flash' })]);
            const options = Array.from(container.querySelectorAll<HTMLOptionElement>('#gs-rule-types option')).map(
                (o) => o.value,
            );
            expect(options).toEqual(['default', 'flash']);
        });

        test('the photo count emits a number, and Any emits the empty sentinel', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={[row({ pics: 2 })]} onChange={onChange} />);
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRulePics').value).toBe('2');
            pick('app.titleRulePics', '4');
            expect(onChange).toHaveBeenLastCalledWith([row({ pics: 4 })]);
            pick('app.titleRulePics', '');
            expect(onChange).toHaveBeenLastCalledWith([row({ pics: '' })]);
        });

        test('the runtime range emits numbers and an empty field emits "any"', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={[row({ maxHours: 24 })]} onChange={onChange} />);
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleMinHours').value).toBe('');
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleMaxHours').value).toBe('24');
            fireEvent.change(screen.getByLabelText('app.titleRuleMinHours'), { target: { value: '168' } });
            expect(onChange).toHaveBeenLastCalledWith([row({ maxHours: 24, minHours: 168 })]);
            fireEvent.change(screen.getByLabelText('app.titleRuleMaxHours'), { target: { value: '' } });
            expect(onChange).toHaveBeenLastCalledWith([row({ maxHours: '' })]);
        });

        test('the percent join anchor emits a number and caps at 99', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={[row()]} onChange={onChange} />);
            const input = screen.getByLabelText('app.titleRulePercentElapsed');
            expect(input.getAttribute('max')).toBe('99');
            fireEvent.change(input, { target: { value: '75' } });
            expect(onChange).toHaveBeenLastCalledWith([row({ autoJoinAfterPercentElapsed: 75 })]);
        });

        test('rules move up and down; the arrows at the ends are disabled', () => {
            const onChange = jest.fn();
            const value = [row({ pics: 4 }), row({ title: 'A' })];
            render(<TitleTagRulesEditor value={value} onChange={onChange} />);
            expect(screen.getByLabelText<HTMLButtonElement>('app.titleRuleMoveUp 1').disabled).toBe(true);
            expect(screen.getByLabelText<HTMLButtonElement>('app.titleRuleMoveDown 2').disabled).toBe(true);
            fireEvent.click(screen.getByLabelText('app.titleRuleMoveDown 1'));
            expect(onChange).toHaveBeenLastCalledWith([value[1], value[0]]);
            fireEvent.click(screen.getByLabelText('app.titleRuleMoveUp 2'));
            expect(onChange).toHaveBeenLastCalledWith([value[1], value[0]]);
        });

        test('the order hint and sort button appear only with several rules', () => {
            const { rerender } = render(<TitleTagRulesEditor value={[row({ pics: 4 })]} onChange={jest.fn()} />);
            expect(screen.queryByText('app.titleRuleSortDefault')).toBeNull();
            expect(screen.queryByText('app.titleRuleOrderHint')).toBeNull();
            rerender(<TitleTagRulesEditor value={[row({ pics: 4 }), row({ title: 'A' })]} onChange={jest.fn()} />);
            expect(screen.getByText('app.titleRuleOrderHint')).toBeTruthy();
        });

        test('sorting puts title rules first, then photos + runtime, photos, runtime', () => {
            const onChange = jest.fn();
            const runtime = row({ minHours: 168 });
            const pics = row({ pics: 4 });
            const both = row({ pics: 4, minHours: 168 });
            const titled = row({ title: 'Hats' });
            render(<TitleTagRulesEditor value={[runtime, pics, both, titled]} onChange={onChange} />);
            fireEvent.click(screen.getByText('app.titleRuleSortDefault'));
            expect(onChange).toHaveBeenCalledWith([titled, both, pics, runtime]);
        });

        test('a title-less rule that turns auto-join or auto-submit on shows the broad warning', () => {
            const { rerender } = render(
                <TitleTagRulesEditor value={[row({ pics: 4, autoJoin: true })]} onChange={jest.fn()} />,
            );
            expect(screen.getByText('app.titleRuleBroadWarning')).toBeTruthy();
            rerender(<TitleTagRulesEditor value={[row({ pics: 4, autoSubmit: true })]} onChange={jest.fn()} />);
            expect(screen.getByText('app.titleRuleBroadWarning')).toBeTruthy();
        });

        test('no broad warning for a titled rule, an Off value, or a rule with no condition yet', () => {
            const { rerender } = render(
                <TitleTagRulesEditor value={[row({ title: 'A', autoJoin: true })]} onChange={jest.fn()} />,
            );
            expect(screen.queryByText('app.titleRuleBroadWarning')).toBeNull();
            rerender(<TitleTagRulesEditor value={[row({ pics: 4, autoJoin: false })]} onChange={jest.fn()} />);
            expect(screen.queryByText('app.titleRuleBroadWarning')).toBeNull();
            rerender(<TitleTagRulesEditor value={[row({ autoJoin: true })]} onChange={jest.fn()} />);
            expect(screen.queryByText('app.titleRuleBroadWarning')).toBeNull();
        });
    });
});
