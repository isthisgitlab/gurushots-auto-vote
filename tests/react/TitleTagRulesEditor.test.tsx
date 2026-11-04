/**
 * Component tests for TitleTagRulesEditor.tsx — the profiles-style dropdown +
 * single-form editor for challenge rules in the global settings modal. The
 * translation manager mock returns each key verbatim, so labels/placeholders
 * are the i18n keys. The form appears only for a rule picked in the dropdown,
 * so nearly every test selects one first (`renderEditor` does it by default).
 */

import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from './helpers/test-utils';
import { TitleTagRulesEditor } from '@/components/app/TitleTagRulesEditor';
import type { TitleRule } from '../../src/ts/core/types/settings';
import { invalid } from '../helpers/invalid';
import { fillTemplate, mockTranslator } from './helpers/setup';
import { app as englishApp } from '../../src/ts/core/translations/english';
import { app as latvianApp } from '../../src/ts/core/translations/latvian';

/** The dropdown the rule is picked in. */
const dropdown = () => screen.getByLabelText<HTMLSelectElement>('app.titleRuleSelectRule');
/** Pick the rule at `index` (0-based) in the dropdown. */
const selectRule = (index: number) => fireEvent.change(dropdown(), { target: { value: String(index) } });

/**
 * Render the editor, then pick a rule so the form shows (the component's whole
 * point). `select: null` skips the pick — for the empty state, where there is
 * no dropdown at all. The guard queries by role, not by label key, so it also
 * works under the real-strings translators below.
 */
const renderEditor = (ui: React.ReactElement, { select }: { select?: number | null } = { select: 0 }) => {
    const view = render(ui);
    const ruleDropdown = select !== null ? screen.queryByRole('combobox') : null;
    if (ruleDropdown) fireEvent.change(ruleDropdown, { target: { value: String(select) } });
    return view;
};

describe('TitleTagRulesEditor', () => {
    test('renders the empty-state hint when there are no rules', () => {
        renderEditor(<TitleTagRulesEditor value={[]} onChange={jest.fn()} />, { select: null });
        expect(screen.getByText('app.noTitleTagRules')).toBeTruthy();
        expect(screen.queryByLabelText('app.titleRuleSelectRule')).toBeNull();
    });

    test('with rules but nothing picked, only the dropdown shows', () => {
        renderEditor(
            <TitleTagRulesEditor
                value={[{ title: 'A', mustIncludeTags: [], shouldIncludeTags: [] }]}
                onChange={jest.fn()}
            />,
            { select: null },
        );
        expect(dropdown().value).toBe('');
        expect(screen.queryByLabelText('app.titleTagRuleTitle 1')).toBeNull();
        expect(screen.queryByRole('button', { name: /^app\.removeTitleTagRule/ })).toBeNull();
    });

    test('"Add rule" appends an empty rule and selects it', () => {
        const Harness = () => {
            const [rules, setRules] = useState<TitleRule[]>([]);
            return <TitleTagRulesEditor value={rules} onChange={setRules} />;
        };
        renderEditor(<Harness />, { select: null });
        fireEvent.click(screen.getByRole('button', { name: 'app.addTitleTagRule' }));
        // The new rule is the one the form shows (n = m = 1); the seed carries
        // no name key (absence is the unset spelling).
        expect(dropdown().value).toBe('0');
        expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleName').value).toBe('');
        expect(mockTranslator.t).toHaveBeenCalledWith('app.titleRulePositionOf', { n: 1, m: 1 }, 'en');
    });

    test('the dropdown labels each rule by its position and display name', () => {
        const value = [
            { name: 'Night owl', title: '', mustIncludeTags: [], shouldIncludeTags: [] },
            { title: 'Hats', mustIncludeTags: [], shouldIncludeTags: [] },
            { challengeTag: 'Exhibition', mustIncludeTags: [], shouldIncludeTags: [] },
            { type: 'flash', mustIncludeTags: [], shouldIncludeTags: [] },
            { closesAt: '17:10', closesAtTimes: ['17:10', '18:10'], mustIncludeTags: [], shouldIncludeTags: [] },
            { mustIncludeTags: [], shouldIncludeTags: [] },
        ];
        renderEditor(<TitleTagRulesEditor value={value} onChange={jest.fn()} />, { select: null });
        const labels = [...dropdown().options].map((option) => option.textContent);
        expect(labels).toEqual([
            '—',
            '1. Night owl',
            '2. Hats',
            '3. Exhibition',
            '4. flash',
            '5. 17:10, 18:10',
            '6. app.titleRuleUntitled',
        ]);
    });

    test('a name with embedded whitespace renders collapsed in the dropdown', () => {
        renderEditor(
            <TitleTagRulesEditor
                value={[{ name: 'Night\n  owl   run', title: '', mustIncludeTags: [], shouldIncludeTags: [] }]}
                onChange={jest.fn()}
            />,
            { select: null },
        );
        expect(screen.getByRole('option', { name: '1. Night owl run' })).toBeTruthy();
    });

    test('a long close-times list is summarized: the first three, then an ellipsis', () => {
        const times = Array.from({ length: 4 }, (_, i) => `${String(i + 17).padStart(2, '0')}:10`);
        renderEditor(
            <TitleTagRulesEditor
                value={[{ closesAtTimes: times, mustIncludeTags: [], shouldIncludeTags: [] }]}
                onChange={jest.fn()}
            />,
            { select: null },
        );
        expect(screen.getByRole('option', { name: '1. 17:10, 18:10, 19:10, …' })).toBeTruthy();
    });

    test('editing the title emits the updated rule', () => {
        const onChange = jest.fn();
        const value = [{ title: '', mustIncludeTags: [], shouldIncludeTags: [] }];
        renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />);
        fireEvent.change(screen.getByLabelText('app.titleTagRuleTitle 1'), { target: { value: "Let's See Hats" } });
        expect(onChange).toHaveBeenCalledWith([
            { title: "Let's See Hats", titles: ["Let's See Hats"], mustIncludeTags: [], shouldIncludeTags: [] },
        ]);
    });

    test('the Name input patches the rule and caps at the sanitizer bound', () => {
        const onChange = jest.fn();
        const value = [{ title: 'A', mustIncludeTags: [], shouldIncludeTags: [] }];
        renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />);
        const name = screen.getByLabelText('app.titleRuleName');
        expect(name.getAttribute('maxlength')).toBe('200');
        fireEvent.change(name, { target: { value: 'Night owl' } });
        expect(onChange).toHaveBeenCalledWith([
            { name: 'Night owl', title: 'A', mustIncludeTags: [], shouldIncludeTags: [] },
        ]);
    });

    test('the Name hint names it display-only, and the field keeps a typed name on re-render', () => {
        const value = [{ name: 'Night owl', title: 'A', mustIncludeTags: [], shouldIncludeTags: [] }];
        renderEditor(<TitleTagRulesEditor value={value} onChange={jest.fn()} />);
        expect(screen.getByText('app.titleRuleNameHint')).toBeTruthy();
        expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleName').value).toBe('Night owl');
    });

    test('a rule with content but nothing set warns at edit time, named or not', () => {
        const onChange = jest.fn();
        const { rerender } = renderEditor(
            <TitleTagRulesEditor
                value={[{ name: 'Night owl', mustIncludeTags: [], shouldIncludeTags: [] }]}
                onChange={onChange}
            />,
        );
        expect(screen.getByText('app.titleRuleDropWarning')).toBeTruthy();
        // Still dropped (and still warned) unnamed: a title without any behaviour.
        rerender(
            <TitleTagRulesEditor
                value={[{ title: 'Hats', mustIncludeTags: [], shouldIncludeTags: [] }]}
                onChange={onChange}
            />,
        );
        expect(screen.getByText('app.titleRuleDropWarning')).toBeTruthy();
        // A condition plus behaviour (tags) clears it.
        rerender(
            <TitleTagRulesEditor
                value={[{ title: 'Hats', mustIncludeTags: ['x'], shouldIncludeTags: [] }]}
                onChange={onChange}
            />,
        );
        expect(screen.queryByText('app.titleRuleDropWarning')).toBeNull();
        // The pristine empty new row stays quiet.
        rerender(
            <TitleTagRulesEditor
                value={[{ title: '', mustIncludeTags: [], shouldIncludeTags: [] }]}
                onChange={onChange}
            />,
        );
        expect(screen.queryByText('app.titleRuleDropWarning')).toBeNull();
    });

    test('a rule can assign a scenario inline, and a missing one stays visible', async () => {
        jest.mocked(window.api.getScenarios).mockResolvedValue(
            invalid({ success: true, scenarios: { Plan: {} }, templates: [] }),
        );
        const onChange = jest.fn();
        const value = [{ title: 'A', mustIncludeTags: [], shouldIncludeTags: [] }];
        const { rerender } = renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />);
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
        renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />);
        fireEvent.click(screen.getByText(/app\.addTitleRuleTitle/));
        expect(onChange).toHaveBeenLastCalledWith([
            { title: 'A', titles: ['A', ''], mustIncludeTags: [], shouldIncludeTags: [] },
        ]);
    });

    test('stored titles render one input each and can be removed', () => {
        const onChange = jest.fn();
        const value = [{ title: 'A', titles: ['A', 'B'], mustIncludeTags: [], shouldIncludeTags: [] }];
        renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />);
        expect(screen.getByLabelText<HTMLInputElement>('app.titleTagRuleTitle 1').value).toBe('A');
        expect(screen.getByLabelText<HTMLInputElement>('app.titleTagRuleTitle 2').value).toBe('B');
        fireEvent.click(screen.getByLabelText('app.removeTitleRuleTitle 1'));
        expect(onChange).toHaveBeenLastCalledWith([
            { title: 'B', titles: ['B'], mustIncludeTags: [], shouldIncludeTags: [] },
        ]);
    });

    test('a single title has no remove-title button', () => {
        renderEditor(
            <TitleTagRulesEditor
                value={[{ title: 'A', mustIncludeTags: [], shouldIncludeTags: [] }]}
                onChange={jest.fn()}
            />,
        );
        expect(screen.queryByLabelText('app.removeTitleRuleTitle 1')).toBeNull();
    });

    test('the selected rule is deleted in two steps, and delete clears the selection', () => {
        const onChange = jest.fn();
        const value = [
            { title: 'A', mustIncludeTags: ['x'], shouldIncludeTags: [] },
            { title: 'B', mustIncludeTags: ['y'], shouldIncludeTags: [] },
        ];
        renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />);
        const remove = () => screen.getByRole('button', { name: 'app.removeTitleTagRule 1' });
        const armed = () => screen.getByRole('button', { name: 'app.confirmDelete' });
        expect(remove().className).not.toContain('btn-error');
        fireEvent.click(remove());
        // Armed: the accessible name tracks the visible confirm prompt (the
        // prompt is announced, and stays in the name per WCAG 2.5.3).
        expect(armed().className).toContain('btn-error');
        expect(armed().textContent).toBe('app.confirmDelete');
        fireEvent.click(armed());
        expect(onChange).toHaveBeenCalledWith([{ title: 'B', mustIncludeTags: ['y'], shouldIncludeTags: [] }]);
        // No ghost rule: the form goes back to "—".
        expect(dropdown().value).toBe('');
        expect(screen.queryByLabelText('app.titleTagRuleTitle 1')).toBeNull();
        // "—" is selectable again.
        fireEvent.change(dropdown(), { target: { value: '' } });
        expect(dropdown().value).toBe('');
    });

    test('an armed delete is disarmed by switching the picked rule and deletes nothing', () => {
        const onChange = jest.fn();
        const value = [
            { title: 'A', mustIncludeTags: [], shouldIncludeTags: [] },
            { title: 'B', mustIncludeTags: [], shouldIncludeTags: [] },
        ];
        renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.removeTitleTagRule 1' }));
        selectRule(1);
        expect(screen.getByRole('button', { name: 'app.removeTitleTagRule 2' }).className).not.toContain('btn-error');
        fireEvent.click(screen.getByRole('button', { name: 'app.removeTitleTagRule 2' }));
        // First press after the switch: armed again, nothing removed yet.
        expect(onChange).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'app.confirmDelete' }).className).toContain('btn-error');
    });

    test('an armed delete is disarmed by a reorder: the move fires, the delete does not', () => {
        const onChange = jest.fn();
        const value = [
            { title: 'A', mustIncludeTags: [], shouldIncludeTags: [] },
            { title: 'B', mustIncludeTags: [], shouldIncludeTags: [] },
        ];
        renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.removeTitleTagRule 1' }));
        // Armed on rule 1, its own ↓ clicked — no selection change in between,
        // so moveRule's own disarm is what protects this path.
        fireEvent.click(screen.getByLabelText('app.titleRuleMoveDown 1'));
        expect(onChange).toHaveBeenLastCalledWith([value[1], value[0]]);
        // The selection followed the moved rule to position 2; the armed state did not.
        fireEvent.click(screen.getByRole('button', { name: 'app.removeTitleTagRule 2' }));
        // If the delete HAD stayed armed, the second press would have removed
        // the rule now at position 2.
        expect(onChange).not.toHaveBeenCalledWith([value[0]]);
        expect(screen.getByRole('button', { name: 'app.confirmDelete' }).className).toContain('btn-error');
    });

    test('an armed delete is disarmed by a list-length change alone (no handler disarm)', () => {
        const value3 = [
            { title: 'A', mustIncludeTags: [], shouldIncludeTags: [] },
            { title: 'B', mustIncludeTags: [], shouldIncludeTags: [] },
            { title: 'C', mustIncludeTags: [], shouldIncludeTags: [] },
        ];
        const { rerender } = renderEditor(<TitleTagRulesEditor value={value3} onChange={jest.fn()} />, { select: 1 });
        fireEvent.click(screen.getByRole('button', { name: 'app.removeTitleTagRule 2' }));
        expect(screen.getByRole('button', { name: 'app.confirmDelete' }).className).toContain('btn-error');
        // A background refresh shrinks the list while the selected index stays
        // valid: only the length-change effect disarms here.
        rerender(<TitleTagRulesEditor value={value3.slice(0, 2)} onChange={jest.fn()} />);
        expect(dropdown().value).toBe('1');
        fireEvent.click(screen.getByRole('button', { name: 'app.removeTitleTagRule 2' }));
        // First press after the shrink: armed again, nothing deleted.
        expect(screen.getByRole('button', { name: 'app.confirmDelete' }).className).toContain('btn-error');
    });

    test('an armed delete is disarmed by Add rule; the next press re-arms', () => {
        const onChange = jest.fn();
        const first = { title: 'A', mustIncludeTags: [], shouldIncludeTags: [] };
        const Harness = () => {
            const [rules, setRules] = useState<TitleRule[]>([first]);
            return (
                <TitleTagRulesEditor
                    value={rules}
                    onChange={(next) => {
                        onChange(next);
                        setRules(next);
                    }}
                />
            );
        };
        renderEditor(<Harness />);
        fireEvent.click(screen.getByRole('button', { name: 'app.removeTitleTagRule 1' }));
        fireEvent.click(screen.getByRole('button', { name: 'app.addTitleTagRule' }));
        // The appended rule carries no name key: absence is the unset spelling.
        expect(onChange).toHaveBeenLastCalledWith([
            first,
            { title: '', profile: '', mustIncludeTags: [], shouldIncludeTags: [] },
        ]);
        expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleName')).toBeTruthy();
        // The appended rule is selected; the first press on its delete arms it.
        fireEvent.click(screen.getByRole('button', { name: 'app.removeTitleTagRule 2' }));
        expect(screen.getByRole('button', { name: 'app.confirmDelete' }).className).toContain('btn-error');
    });

    test('an armed delete is disarmed by Sort default; picking a rule re-arms from scratch', () => {
        const onChange = jest.fn();
        const pics = { title: '', pics: 4, mustIncludeTags: [], shouldIncludeTags: [] };
        const titled = { title: 'A', mustIncludeTags: [], shouldIncludeTags: [] };
        renderEditor(<TitleTagRulesEditor value={[titled, pics]} onChange={onChange} />);
        fireEvent.click(screen.getByRole('button', { name: 'app.removeTitleTagRule 1' }));
        fireEvent.click(screen.getByText('app.titleRuleSortDefault'));
        expect(onChange).toHaveBeenLastCalledWith([titled, pics]);
        // Sort deselected: no form, no delete button at all.
        expect(screen.queryByRole('button', { name: /app\.removeTitleTagRule/ })).toBeNull();
        selectRule(1);
        fireEvent.click(screen.getByRole('button', { name: 'app.removeTitleTagRule 2' }));
        expect(onChange).not.toHaveBeenCalledWith([pics]);
        expect(screen.getByRole('button', { name: 'app.confirmDelete' }).className).toContain('btn-error');
    });

    test('an armed delete disarms itself after the confirm window', () => {
        jest.useFakeTimers();
        try {
            const onChange = jest.fn();
            renderEditor(
                <TitleTagRulesEditor
                    value={[{ title: 'A', mustIncludeTags: [], shouldIncludeTags: [] }]}
                    onChange={onChange}
                />,
            );
            const remove = () => screen.getByRole('button', { name: 'app.removeTitleTagRule 1' });
            const armed = () => screen.getByRole('button', { name: 'app.confirmDelete' });
            fireEvent.click(remove());
            expect(armed().className).toContain('btn-error');
            // Past the window the arm expires: the button is idle again.
            jest.advanceTimersByTime(4000);
            expect(screen.queryByRole('button', { name: 'app.confirmDelete' })).toBeNull();
            expect(remove().className).not.toContain('btn-error');
            fireEvent.click(remove());
            // Idle again: the press armed, it did not delete.
            expect(onChange).not.toHaveBeenCalled();
            expect(armed().className).toContain('btn-error');
        } finally {
            jest.useRealTimers();
        }
    });

    test('a background refresh that shrinks the list normalizes the selection, and regrowing leaves no ghost', () => {
        const value = Array.from({ length: 6 }, (_, i) => ({
            title: `R${i}`,
            mustIncludeTags: [],
            shouldIncludeTags: [],
        }));
        const { rerender } = renderEditor(<TitleTagRulesEditor value={value} onChange={jest.fn()} />, { select: 5 });
        expect(dropdown().value).toBe('5');
        rerender(<TitleTagRulesEditor value={value.slice(0, 3)} onChange={jest.fn()} />);
        // Out of range: the stored selection is reset, not merely clamped.
        expect(dropdown().value).toBe('');
        // Regrowing must not resurrect the stale index.
        rerender(
            <TitleTagRulesEditor
                value={[...value, { title: 'R6', mustIncludeTags: [], shouldIncludeTags: [] }]}
                onChange={jest.fn()}
            />,
        );
        expect(dropdown().value).toBe('');
        expect(screen.queryByLabelText('app.titleTagRuleTitle 1')).toBeNull();
    });

    test('the selection follows the rule through reorders, and the header keeps focus', () => {
        const value = [
            { title: 'A', mustIncludeTags: [], shouldIncludeTags: [] },
            { title: 'B', mustIncludeTags: [], shouldIncludeTags: [] },
            { title: 'C', mustIncludeTags: [], shouldIncludeTags: [] },
        ];
        const Harness = () => {
            const [rules, setRules] = useState<TitleRule[]>(value);
            return <TitleTagRulesEditor value={rules} onChange={setRules} />;
        };
        renderEditor(<Harness />);
        fireEvent.change(screen.getByLabelText('app.titleTagRuleTitle 1'), { target: { value: 'A2' } });
        const moveDown = screen.getByLabelText('app.titleRuleMoveDown 1');
        // happy-dom's synthetic click does not focus, so give the button focus
        // the way a real click would have.
        moveDown.focus();
        fireEvent.click(moveDown);
        // The emitted array is swapped; the form still edits rule "A2" — now at
        // position 2.
        expect(screen.getByLabelText<HTMLInputElement>('app.titleTagRuleTitle 1').value).toBe('A2');
        expect(mockTranslator.t).toHaveBeenCalledWith('app.titleRulePositionOf', { n: 2, m: 3 }, 'en');
        // Up and down again: both moveRule directions fire, and the last click
        // deliberately lands the rule mid-list so the clicked button — now
        // relabelled "Move rule down 2" — stays ENABLED. A focus assertion on
        // a button the move itself disabled would prove nothing beyond
        // happy-dom's quirks.
        fireEvent.click(screen.getByLabelText('app.titleRuleMoveUp 2'));
        fireEvent.click(screen.getByLabelText('app.titleRuleMoveDown 1'));
        expect(screen.getByLabelText<HTMLInputElement>('app.titleTagRuleTitle 1').value).toBe('A2');
        expect(mockTranslator.t).toHaveBeenCalledWith('app.titleRulePositionOf', { n: 2, m: 3 }, 'en');
        // The button was not remounted, so keyboard focus survived the moves.
        expect(document.activeElement).toBe(screen.getByLabelText('app.titleRuleMoveDown 2'));
    });

    test('the reorder arrows at the ends are disabled', () => {
        const value = [
            { title: 'A', mustIncludeTags: [], shouldIncludeTags: [] },
            { title: 'B', mustIncludeTags: [], shouldIncludeTags: [] },
        ];
        renderEditor(<TitleTagRulesEditor value={value} onChange={jest.fn()} />);
        expect(screen.getByLabelText<HTMLButtonElement>('app.titleRuleMoveUp 1').disabled).toBe(true);
        expect(screen.getByLabelText<HTMLButtonElement>('app.titleRuleMoveDown 1').disabled).toBe(false);
        selectRule(1);
        expect(screen.getByLabelText<HTMLButtonElement>('app.titleRuleMoveUp 2').disabled).toBe(false);
        expect(screen.getByLabelText<HTMLButtonElement>('app.titleRuleMoveDown 2').disabled).toBe(true);
    });

    test('the position text is a polite live region; the armed prompt lives on the button alone', () => {
        renderEditor(
            <TitleTagRulesEditor
                value={[{ title: 'A', mustIncludeTags: [], shouldIncludeTags: [] }]}
                onChange={jest.fn()}
            />,
        );
        const live = screen.getByText('app.titleRulePositionOf');
        expect(live.getAttribute('aria-live')).toBe('polite');
        fireEvent.click(screen.getByRole('button', { name: 'app.removeTitleTagRule 1' }));
        // The button carries the prompt — in its accessible name as much as in
        // its text — while the live region keeps the position.
        expect(screen.getByRole('button', { name: 'app.confirmDelete' }).textContent).toBe('app.confirmDelete');
        expect(live.textContent).toBe('app.titleRulePositionOf');
    });

    test('a confirmed delete moves focus to the dropdown', () => {
        const value = [
            { title: 'A', mustIncludeTags: [], shouldIncludeTags: [] },
            { title: 'B', mustIncludeTags: [], shouldIncludeTags: [] },
        ];
        renderEditor(<TitleTagRulesEditor value={value} onChange={jest.fn()} />);
        const remove = () => screen.getByRole('button', { name: 'app.removeTitleTagRule 1' });
        remove().focus();
        fireEvent.click(remove()); // arm
        fireEvent.click(screen.getByRole('button', { name: 'app.confirmDelete' })); // confirm
        // The confirm button unmounts with the form; the dropdown is the anchor.
        expect(document.activeElement).toBe(dropdown());
    });

    test('a confirmed delete of the last rule moves focus to Add rule', () => {
        const Harness = () => {
            const [rules, setRules] = useState<TitleRule[]>([
                { title: 'A', mustIncludeTags: [], shouldIncludeTags: [] },
            ]);
            return <TitleTagRulesEditor value={rules} onChange={setRules} />;
        };
        renderEditor(<Harness />);
        const remove = () => screen.getByRole('button', { name: 'app.removeTitleTagRule 1' });
        remove().focus();
        fireEvent.click(remove()); // arm
        fireEvent.click(screen.getByRole('button', { name: 'app.confirmDelete' })); // confirm
        // The dropdown unmounts with the last rule; Add rule is the surviving
        // anchor, so focus never falls to <body>.
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'app.addTitleTagRule' }));
        expect(screen.queryByLabelText('app.titleRuleSelectRule')).toBeNull();
    });

    test('editing the Must tags emits the parsed tag array (first TagsField in the form)', () => {
        const onChange = jest.fn();
        const value = [{ title: 'A', mustIncludeTags: [], shouldIncludeTags: [] }];
        renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />);
        // Both TagsFields share the tags placeholder; Must is rendered first.
        const tagInputs = screen.getAllByPlaceholderText('app.tagsPlaceholder');
        fireEvent.change(tagInputs[0], { target: { value: 'hat, cap' } });
        expect(onChange).toHaveBeenCalledWith([{ title: 'A', mustIncludeTags: ['hat', 'cap'], shouldIncludeTags: [] }]);
    });

    test('switching the picked rule re-reads the stateful fields: pending text does not leak', () => {
        const value = [
            { title: 'A', mustIncludeTags: ['keep-a'], shouldIncludeTags: [] },
            { title: 'B', mustIncludeTags: ['keep-b'], shouldIncludeTags: [] },
        ];
        const Harness = () => {
            const [rules, setRules] = useState<TitleRule[]>(value);
            return <TitleTagRulesEditor value={rules} onChange={setRules} />;
        };
        renderEditor(<Harness />);
        // Type into rule A's Must tags (the keystroke commits it to rule A).
        fireEvent.change(screen.getAllByPlaceholderText('app.tagsPlaceholder')[0], {
            target: { value: 'keep-a, typed' },
        });
        expect(screen.getAllByPlaceholderText<HTMLInputElement>('app.tagsPlaceholder')[0].value).toBe('keep-a, typed');
        // Switch to rule B: its own tags show, not rule A's pending text.
        selectRule(1);
        expect(screen.getAllByPlaceholderText<HTMLInputElement>('app.tagsPlaceholder')[0].value).toBe('keep-b');
        // And back to rule A: its committed text is intact.
        selectRule(0);
        expect(screen.getAllByPlaceholderText<HTMLInputElement>('app.tagsPlaceholder')[0].value).toBe('keep-a, typed');
    });

    test('selecting a saved profile assigns it to the title rule', () => {
        const onChange = jest.fn();
        const value = [{ title: 'Portraits', mustIncludeTags: [], shouldIncludeTags: [] }];
        renderEditor(
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
            renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={jest.fn()} />);
            expect(screen.getByLabelText<HTMLSelectElement>('app.titleRuleAutoJoin').value).toBe('');
        });

        test('an explicit false shows as Off, not as inherit', () => {
            renderEditor(<TitleTagRulesEditor value={rowWith({ autoJoin: false })} onChange={jest.fn()} />);
            expect(screen.getByLabelText<HTMLSelectElement>('app.titleRuleAutoJoin').value).toBe('off');
        });

        test('choosing On emits a real boolean', () => {
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            pick('app.titleRuleAutoJoin', 'on');
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ autoJoin: true })]);
        });

        test('choosing Off emits false, not inherit', () => {
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            pick('app.titleRuleAutoSubmit', 'off');
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ autoSubmit: false })]);
        });

        test('returning to Inherit emits the empty sentinel the sanitizer drops', () => {
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={rowWith({ autoJoin: true })} onChange={onChange} />);
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
                renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={jest.fn()} />);
                const group = screen.getByRole('group', { name: 'app.chosenPhotos' });
                expect(group.textContent).toContain('app.titleRuleInherit');
                expect(screen.queryByRole('button', { name: 'app.titleRuleInherit' })).toBeNull();
            });

            test("'' (a cleared draft) also reads as inherit", () => {
                renderEditor(<TitleTagRulesEditor value={rowWith({ chosenPhotos: '' })} onChange={jest.fn()} />);
                expect(screen.getByRole('group', { name: 'app.chosenPhotos' }).textContent).toContain(
                    'app.titleRuleInherit',
                );
            });

            test('choosing photos stores the list on the rule', async () => {
                const onChange = jest.fn();
                renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
                fireEvent.click(screen.getByRole('button', { name: 'app.choosePhotos' }));
                fireEvent.click(await screen.findByRole('button', { name: 'app.pickLoadPhotos' }));
                fireEvent.click(await screen.findByRole('button', { name: 'app.photoChooserTileLabel' }));
                fireEvent.click(screen.getByRole('button', { name: 'app.photoChooserUse' }));
                await waitFor(() =>
                    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ chosenPhotos: [ID] })]),
                );
                // A rule has no challenge to read eligibility through.
                expect(window.api.getLibraryPhotos).toHaveBeenCalledWith(null, undefined, 'cached', 'submit', 0, 100);
            });

            test('an explicit empty list means none, and Inherit writes the empty sentinel', () => {
                const onChange = jest.fn();
                renderEditor(<TitleTagRulesEditor value={rowWith({ chosenPhotos: [] })} onChange={onChange} />);
                expect(screen.getByRole('group', { name: 'app.chosenPhotos' }).textContent).toContain('app.none');
                fireEvent.click(screen.getByRole('button', { name: 'app.titleRuleInherit' }));
                expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ chosenPhotos: '' })]);
            });

            test('Submit Only is a three-way select like the other inline overrides', () => {
                const onChange = jest.fn();
                renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
                expect(screen.getByLabelText<HTMLSelectElement>('app.chosenPhotosOnly').value).toBe('');
                pick('app.chosenPhotosOnly', 'on');
                expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ chosenPhotosOnly: true })]);
            });

            test('the pick-order flag is a three-way select too, with no reach warning', () => {
                const onChange = jest.fn();
                renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
                expect(screen.getByLabelText<HTMLSelectElement>('app.chosenPhotosInOrder').value).toBe('');
                pick('app.chosenPhotosInOrder', 'on');
                expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ chosenPhotosInOrder: true })]);
            });

            test('Manual Only offers inherit and on only: a rule never holds off', () => {
                const onChange = jest.fn();
                renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
                const select = screen.getByLabelText<HTMLSelectElement>('app.manualPhotosOnly');
                expect([...select.options].map((option) => option.value)).toEqual(['', 'on']);
                expect(select.value).toBe('');
                pick('app.manualPhotosOnly', 'on');
                expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ manualPhotosOnly: true })]);
                pick('app.manualPhotosOnly', '');
                expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ manualPhotosOnly: '' })]);
            });

            test('a stored false reads as inherit, not as an option the select lacks', () => {
                renderEditor(<TitleTagRulesEditor value={rowWith({ manualPhotosOnly: false })} onChange={jest.fn()} />);
                expect(screen.getByLabelText<HTMLSelectElement>('app.manualPhotosOnly').value).toBe('');
            });

            test('Manual Only on a rule says what it does to the rule, directly under its own select', () => {
                const { rerender } = renderEditor(
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
                const { rerender } = renderEditor(
                    <TitleTagRulesEditor value={rowWith({ chosenPhotosOnly: true })} onChange={jest.fn()} />,
                );
                expect(screen.getByText('app.chosenPhotosOnlyReachHint')).toBeTruthy();
                rerender(<TitleTagRulesEditor value={rowWith({ chosenPhotosOnly: false })} onChange={jest.fn()} />);
                expect(screen.queryByText('app.chosenPhotosOnlyReachHint')).toBeNull();
            });
        });

        test('the join window emits the hours typed', () => {
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            fireEvent.change(screen.getByLabelText('app.titleRuleJoinWindow app.hours'), { target: { value: '24' } });
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ autoJoinWithinHoursOfEnd: 24 })]);
        });

        test('the join window takes minutes and stores fractional hours', () => {
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            fireEvent.change(screen.getByLabelText('app.titleRuleJoinWindow app.minutes'), { target: { value: '30' } });
            expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ autoJoinWithinHoursOfEnd: 0.5 })]);
        });

        test('clearing the join window emits inherit, NOT 0', () => {
            // 0 means "join on sight" — an empty field must not silently become it.
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={rowWith({ autoJoinWithinHoursOfEnd: 24 })} onChange={onChange} />);
            fireEvent.change(screen.getByLabelText('app.titleRuleJoinWindow app.hours'), { target: { value: '' } });
            expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ autoJoinWithinHoursOfEnd: 0 })]);
            fireEvent.change(screen.getByLabelText('app.titleRuleJoinWindow app.minutes'), { target: { value: '' } });
            expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ autoJoinWithinHoursOfEnd: '' })]);
        });

        test('an explicit 0 window renders as 0h 0m, not as an empty (inherit) pair', () => {
            renderEditor(<TitleTagRulesEditor value={rowWith({ autoJoinWithinHoursOfEnd: 0 })} onChange={jest.fn()} />);
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleJoinWindow app.hours').value).toBe('0');
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleJoinWindow app.minutes').value).toBe('0');
        });

        test('the after-start field edits as hours + minutes and stores fractional hours', () => {
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            fireEvent.change(screen.getByLabelText('app.titleRuleJoinAfterStart app.hours'), {
                target: { value: '2' },
            });
            expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ autoJoinAfterHoursFromStart: 2 })]);
            fireEvent.change(screen.getByLabelText('app.titleRuleJoinAfterStart app.minutes'), {
                target: { value: '30' },
            });
            expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ autoJoinAfterHoursFromStart: 2.5 })]);
        });

        test('clearing the after-start field emits inherit, NOT 0', () => {
            const onChange = jest.fn();
            renderEditor(
                <TitleTagRulesEditor value={rowWith({ autoJoinAfterHoursFromStart: 2.5 })} onChange={onChange} />,
            );
            fireEvent.change(screen.getByLabelText('app.titleRuleJoinAfterStart app.hours'), { target: { value: '' } });
            expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ autoJoinAfterHoursFromStart: 0.5 })]);
            fireEvent.change(screen.getByLabelText('app.titleRuleJoinAfterStart app.minutes'), {
                target: { value: '' },
            });
            expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ autoJoinAfterHoursFromStart: '' })]);
        });

        test('an explicit 0 after-start renders as 0h 0m, not as an empty (inherit) pair', () => {
            renderEditor(
                <TitleTagRulesEditor value={rowWith({ autoJoinAfterHoursFromStart: 0 })} onChange={jest.fn()} />,
            );
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleJoinAfterStart app.hours').value).toBe('0');
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleJoinAfterStart app.minutes').value).toBe('0');
        });

        test('the after-start hours entry caps at 720 hours', () => {
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            fireEvent.change(screen.getByLabelText('app.titleRuleJoinAfterStart app.hours'), {
                target: { value: '721' },
            });
            expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ autoJoinAfterHoursFromStart: 720 })]);
        });

        test('the timing fields render in precedence order: after-start, percent, before-end', () => {
            renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={jest.fn()} />);
            const afterStart = screen.getByLabelText('app.titleRuleJoinAfterStart app.hours');
            const percent = screen.getByLabelText('app.titleRulePercentElapsed');
            const beforeEnd = screen.getByLabelText('app.titleRuleJoinWindow app.hours');
            expect(afterStart.getAttribute('max')).toBe('720');
            expect(percent.getAttribute('max')).toBe('99');
            expect(afterStart.compareDocumentPosition(percent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
            expect(percent.compareDocumentPosition(beforeEnd) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });

        /**
         * The rule-sets-the-timing hint: ANY filled timing field (a number, 0
         * included) means the rule replaces the global timings, so the hint shows
         * from one filled field on. Above 0 it names the applying SETTING (the
         * field labels read as connectives), asserted under the key-verbatim mock
         * through the t call; with all zeros it shows the zero hint. The
         * real-dictionary block below asserts the composed text itself.
         */
        describe('join timing hint', () => {
            // The context's t passes the current language as a third argument.
            const hintNames = (settingKey: string) =>
                expect(mockTranslator.t).toHaveBeenCalledWith('app.titleRuleJoinTimingHint', { '0': settingKey }, 'en');

            test('a single filled field above 0 names its setting', () => {
                renderEditor(
                    <TitleTagRulesEditor value={rowWith({ autoJoinAfterPercentElapsed: 75 })} onChange={jest.fn()} />,
                );
                expect(screen.getByText('app.titleRuleJoinTimingHint')).toBeTruthy();
                hintNames('app.autoJoinAfterPercentElapsed');
            });

            test('two filled fields name the first above 0 in precedence order', () => {
                renderEditor(
                    <TitleTagRulesEditor
                        value={rowWith({ autoJoinAfterPercentElapsed: 75, autoJoinWithinHoursOfEnd: 24 })}
                        onChange={jest.fn()}
                    />,
                );
                expect(screen.getByText('app.titleRuleJoinTimingHint')).toBeTruthy();
                hintNames('app.autoJoinAfterPercentElapsed');
            });

            test('after-start wins over percent', () => {
                renderEditor(
                    <TitleTagRulesEditor
                        value={rowWith({ autoJoinAfterHoursFromStart: 5, autoJoinAfterPercentElapsed: 75 })}
                        onChange={jest.fn()}
                    />,
                );
                hintNames('app.autoJoinAfterHoursFromStart');
            });

            test('a zero-filled field is skipped even when it sits first', () => {
                renderEditor(
                    <TitleTagRulesEditor
                        value={rowWith({ autoJoinAfterHoursFromStart: 0, autoJoinAfterPercentElapsed: 75 })}
                        onChange={jest.fn()}
                    />,
                );
                hintNames('app.autoJoinAfterPercentElapsed');
            });

            test('a single filled 0 shows the zero hint, not a named field', () => {
                renderEditor(
                    <TitleTagRulesEditor value={rowWith({ autoJoinAfterPercentElapsed: 0 })} onChange={jest.fn()} />,
                );
                expect(screen.getByText('app.titleRuleJoinTimingZeroHint')).toBeTruthy();
                expect(screen.queryByText('app.titleRuleJoinTimingHint')).toBeNull();
            });

            test('all filled fields at 0 show the zero hint, not a named field', () => {
                renderEditor(
                    <TitleTagRulesEditor
                        value={rowWith({ autoJoinAfterHoursFromStart: 0, autoJoinWithinHoursOfEnd: 0 })}
                        onChange={jest.fn()}
                    />,
                );
                expect(screen.getByText('app.titleRuleJoinTimingZeroHint')).toBeTruthy();
                expect(screen.queryByText('app.titleRuleJoinTimingHint')).toBeNull();
            });

            test('no filled timing field shows no hint', () => {
                renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={jest.fn()} />);
                expect(screen.queryByText('app.titleRuleJoinTimingHint')).toBeNull();
                expect(screen.queryByText('app.titleRuleJoinTimingZeroHint')).toBeNull();
            });

            describe.each([
                ['English', englishApp],
                ['Latvian', latvianApp],
            ])('with real %s strings', (_language, strings: typeof englishApp | typeof latvianApp) => {
                const byKey = new Map(Object.entries(strings));
                let previousTranslator: ReturnType<typeof mockTranslator.t.getMockImplementation>;
                beforeEach(() => {
                    previousTranslator = mockTranslator.t.getMockImplementation();
                    mockTranslator.t.mockImplementation((key, vars) =>
                        fillTemplate(byKey.get(key.replace(/^app\./, '')) ?? key, vars),
                    );
                });
                afterEach(() => {
                    mockTranslator.t.mockImplementation(previousTranslator);
                });

                test('percent over before-end names the percent setting translated', () => {
                    renderEditor(
                        <TitleTagRulesEditor
                            value={rowWith({ autoJoinAfterPercentElapsed: 75, autoJoinWithinHoursOfEnd: 24 })}
                            onChange={jest.fn()}
                        />,
                    );
                    expect(
                        screen.getByText(
                            fillTemplate(strings.titleRuleJoinTimingHint, { '0': strings.autoJoinAfterPercentElapsed }),
                        ),
                    ).toBeTruthy();
                });

                test('after-start over percent names the after-start setting translated', () => {
                    renderEditor(
                        <TitleTagRulesEditor
                            value={rowWith({ autoJoinAfterHoursFromStart: 5, autoJoinAfterPercentElapsed: 75 })}
                            onChange={jest.fn()}
                        />,
                    );
                    expect(
                        screen.getByText(
                            fillTemplate(strings.titleRuleJoinTimingHint, { '0': strings.autoJoinAfterHoursFromStart }),
                        ),
                    ).toBeTruthy();
                });

                test('a single filled 0 shows the zero hint translated', () => {
                    renderEditor(
                        <TitleTagRulesEditor
                            value={rowWith({ autoJoinAfterPercentElapsed: 0 })}
                            onChange={jest.fn()}
                        />,
                    );
                    expect(screen.getByText(strings.titleRuleJoinTimingZeroHint)).toBeTruthy();
                });

                test('all filled fields at 0 show the zero hint translated', () => {
                    renderEditor(
                        <TitleTagRulesEditor
                            value={rowWith({ autoJoinAfterHoursFromStart: 0, autoJoinWithinHoursOfEnd: 0 })}
                            onChange={jest.fn()}
                        />,
                    );
                    expect(screen.getByText(strings.titleRuleJoinTimingZeroHint)).toBeTruthy();
                });
            });
        });
    });

    describe('closes at', () => {
        const rowWith = (over = {}) => [{ title: 'abc', mustIncludeTags: [], shouldIncludeTags: [], ...over }];
        const input = (n = 1) =>
            screen.getByLabelText<HTMLInputElement>(new RegExp(`^app\\.titleRuleClosesAtRow ${n} app\\.of \\d+$`));
        const addButton = () => screen.getByRole('button', { name: /app\.addCloseTime/ });

        test('the time input patches closesAt, an empty value sends an empty string, and one row keeps no list', () => {
            const onChange = jest.fn();
            const { rerender } = renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
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
            renderEditor(<TitleTagRulesEditor value={rowWith({ closesAt: '17:10' })} onChange={onChange} />);
            fireEvent.click(addButton());
            expect(onChange).toHaveBeenLastCalledWith([
                expect.objectContaining({ closesAt: '17:10', closesAtTimes: ['17:10', ''] }),
            ]);
        });

        test('a stored list shows one row per time, editing one patches the list, and its first row mirrors into closesAt', () => {
            const onChange = jest.fn();
            renderEditor(
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
            const { rerender } = renderEditor(
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
            renderEditor(
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
            renderEditor(<Harness start={rowWith()} />);
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
            renderEditor(<Harness />);
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
            renderEditor(<Harness />);
            fireEvent.click(screen.getByRole('button', { name: 'app.removeCloseTime 1' }));
            expect(document.activeElement).toBe(input(1));
        });

        test('Add time is held at 24 rows', () => {
            const times = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
            const { rerender } = renderEditor(
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
            renderEditor(
                <TitleTagRulesEditor
                    value={rowWith({ closesAt: '17:10', closesAtTimes: ['17:10', ''] })}
                    onChange={jest.fn()}
                />,
            );
            expect(input(2).classList.contains('input-error')).toBe(false);
            expect(screen.queryByText('app.titleRuleClosesAtInvalid')).toBeNull();
        });

        test('a stored value that is not a strict HH:MM is marked invalid; a valid or empty one is not', () => {
            const { rerender } = renderEditor(
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
            renderEditor(
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
            const { rerender } = renderEditor(
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
            renderEditor(<TitleTagRulesEditor value={rowWith(over)} onChange={jest.fn()} />);
            expect(values.map((_, i) => input(i + 1).value)).toEqual(values);
            expect(values.map((_, i) => input(i + 1).classList.contains('input-error'))).toEqual(invalids);
        });

        test('only the first row of a malformed list is marked, and a null list is no list', () => {
            const { rerender } = renderEditor(
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
            renderEditor(
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
            renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={jest.fn()} />);
            expect(screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 1').value).toBe('exact');
        });

        test('choosing a mode emits it', () => {
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            const select = screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 1');
            select.value = 'contains';
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ match: 'contains' })]);
        });

        test('the mode is offered only once the rule names a title; until then it shows exact', () => {
            const { rerender } = renderEditor(
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
            renderEditor(<TitleTagRulesEditor value={rowWith({ match: 'starts' })} onChange={jest.fn()} />);
            expect(screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 1').value).toBe('starts');
        });

        test('each title has its own mode and removing a title keeps modes aligned', () => {
            const onChange = jest.fn();
            const value = rowWith({ titles: ['Hats', 'Photo'], titleMatchModes: ['exact', 'starts'] });
            renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />);
            expect(screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 1').value).toBe('exact');
            expect(screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 2').value).toBe('starts');
            fireEvent.click(screen.getByLabelText('app.removeTitleRuleTitle 1'));
            expect(onChange).toHaveBeenLastCalledWith([
                expect.objectContaining({ title: 'Photo', titles: ['Photo'], titleMatchModes: ['starts'] }),
            ]);
        });

        test('changing the second title mode leaves the first title mode unchanged', () => {
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={rowWith({ titles: ['Hats', 'Photo'] })} onChange={onChange} />);
            const select = screen.getByLabelText<HTMLSelectElement>('app.titleRuleMatch 2');
            select.value = 'starts';
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
            expect(onChange).toHaveBeenLastCalledWith([
                expect.objectContaining({ titleMatchModes: ['exact', 'starts'] }),
            ]);
        });

        test('editing the challenge tag emits it', () => {
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            fireEvent.change(screen.getByLabelText('app.titleRuleChallengeTag'), {
                target: { value: 'Exhibition' },
            });
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ challengeTag: 'Exhibition' })]);
        });

        test('the challenge-tag field is distinct from the photo tag fields', () => {
            // Three tag-ish inputs in a row: challenge tag (its own labelled
            // field) plus Must/Should photo tags (the shared placeholder).
            renderEditor(<TitleTagRulesEditor value={rowWith({ challengeTag: 'Turbo' })} onChange={jest.fn()} />);
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleChallengeTag').value).toBe('Turbo');
            expect(screen.getAllByPlaceholderText('app.tagsPlaceholder')).toHaveLength(2);
        });

        test('a tag-only rule renders with an empty title', () => {
            renderEditor(
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
            renderEditor(<TitleTagRulesEditor value={null} onChange={jest.fn()} />, { select: null });
            expect(screen.getByText('app.noTitleTagRules')).toBeTruthy();
        });

        test('editing the second of several titles leaves the first untouched', () => {
            const onChange = jest.fn();
            const value = [{ title: 'A', titles: ['A', 'B'], mustIncludeTags: [], shouldIncludeTags: [] }];
            renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />);
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
            renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />);
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
            renderEditor(<TitleTagRulesEditor value={value} onChange={onChange} />, { select: 1 });
            // One rule in the form: [B.must, B.should].
            const tagInputs = screen.getAllByPlaceholderText('app.tagsPlaceholder');
            fireEvent.change(tagInputs[1], { target: { value: 'sky' } });
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
            const { container } = renderEditor(
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
            renderEditor(<TitleTagRulesEditor value={[row({ pics: 2 })]} onChange={onChange} />);
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRulePics').value).toBe('2');
            pick('app.titleRulePics', '4');
            expect(onChange).toHaveBeenLastCalledWith([row({ pics: 4 })]);
            pick('app.titleRulePics', '');
            expect(onChange).toHaveBeenLastCalledWith([row({ pics: '' })]);
        });

        test('the runtime range emits numbers and an empty field emits "any"', () => {
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={[row({ maxHours: 24 })]} onChange={onChange} />);
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleMinHours').value).toBe('');
            expect(screen.getByLabelText<HTMLInputElement>('app.titleRuleMaxHours').value).toBe('24');
            fireEvent.change(screen.getByLabelText('app.titleRuleMinHours'), { target: { value: '168' } });
            expect(onChange).toHaveBeenLastCalledWith([row({ maxHours: 24, minHours: 168 })]);
            fireEvent.change(screen.getByLabelText('app.titleRuleMaxHours'), { target: { value: '' } });
            expect(onChange).toHaveBeenLastCalledWith([row({ maxHours: '' })]);
        });

        test('the percent join anchor emits a number and caps at 99', () => {
            const onChange = jest.fn();
            renderEditor(<TitleTagRulesEditor value={[row()]} onChange={onChange} />);
            const input = screen.getByLabelText('app.titleRulePercentElapsed');
            expect(input.getAttribute('max')).toBe('99');
            fireEvent.change(input, { target: { value: '75' } });
            expect(onChange).toHaveBeenLastCalledWith([row({ autoJoinAfterPercentElapsed: 75 })]);
        });

        test('the order hint and sort button appear only with several rules', () => {
            const { rerender } = renderEditor(<TitleTagRulesEditor value={[row({ pics: 4 })]} onChange={jest.fn()} />);
            expect(screen.queryByText('app.titleRuleSortDefault')).toBeNull();
            expect(screen.queryByText('app.titleRuleOrderHint')).toBeNull();
            rerender(<TitleTagRulesEditor value={[row({ pics: 4 }), row({ title: 'A' })]} onChange={jest.fn()} />);
            expect(screen.getByText('app.titleRuleOrderHint')).toBeTruthy();
        });

        test('sorting puts title rules first, then photos + runtime, photos, runtime, and deselects', () => {
            const onChange = jest.fn();
            const runtime = row({ minHours: 168 });
            const pics = row({ pics: 4 });
            const both = row({ pics: 4, minHours: 168 });
            const titled = row({ title: 'Hats' });
            renderEditor(<TitleTagRulesEditor value={[runtime, pics, both, titled]} onChange={onChange} />);
            fireEvent.click(screen.getByText('app.titleRuleSortDefault'));
            expect(onChange).toHaveBeenCalledWith([titled, both, pics, runtime]);
            // Sorting scrambles indices: the selection is reset, not re-pointed.
            expect(dropdown().value).toBe('');
            expect(screen.queryByLabelText('app.titleTagRuleTitle 1')).toBeNull();
        });

        test('a title-less rule that turns auto-join or auto-submit on shows the broad warning', () => {
            const { rerender } = renderEditor(
                <TitleTagRulesEditor value={[row({ pics: 4, autoJoin: true })]} onChange={jest.fn()} />,
            );
            expect(screen.getByText('app.titleRuleBroadWarning')).toBeTruthy();
            rerender(<TitleTagRulesEditor value={[row({ pics: 4, autoSubmit: true })]} onChange={jest.fn()} />);
            expect(screen.getByText('app.titleRuleBroadWarning')).toBeTruthy();
        });

        test('no broad warning for a titled rule, an Off value, or a rule with no condition yet', () => {
            const { rerender } = renderEditor(
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
