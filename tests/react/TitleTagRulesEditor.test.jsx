/**
 * Component tests for TitleTagRulesEditor.jsx — the controlled list editor
 * for title→tags rules in the global settings modal. The translation manager
 * mock returns each key verbatim, so labels/placeholders are the i18n keys.
 */

import { fireEvent, render, screen } from './helpers/test-utils';
import { TitleTagRulesEditor } from '@/components/app/TitleTagRulesEditor';

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
        fireEvent.change(screen.getByLabelText('app.titleTagRuleTitle'), { target: { value: "Let's See Hats" } });
        expect(onChange).toHaveBeenCalledWith([
            { title: "Let's See Hats", mustIncludeTags: [], shouldIncludeTags: [] },
        ]);
    });

    test('removing a row emits the array without it', () => {
        const onChange = jest.fn();
        const value = [
            { title: 'A', mustIncludeTags: ['x'], shouldIncludeTags: [] },
            { title: 'B', mustIncludeTags: ['y'], shouldIncludeTags: [] },
        ];
        render(<TitleTagRulesEditor value={value} onChange={onChange} />);
        const removeButtons = screen.getAllByRole('button', { name: 'app.removeTitleTagRule' });
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

        const select = screen.getByLabelText('app.titleRuleProfile');
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
        const pick = (label, next) => {
            const select = screen.getByLabelText(label);
            select.value = next;
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
        };

        test('auto-join defaults to inherit when the rule does not set it', () => {
            render(<TitleTagRulesEditor value={rowWith()} onChange={jest.fn()} />);
            expect(screen.getByLabelText('app.titleRuleAutoJoin').value).toBe('');
        });

        test('an explicit false shows as Off, not as inherit', () => {
            render(<TitleTagRulesEditor value={rowWith({ autoJoin: false })} onChange={jest.fn()} />);
            expect(screen.getByLabelText('app.titleRuleAutoJoin').value).toBe('off');
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
            pick('app.titleRuleAutoFill', 'off');
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ autoFill: false })]);
        });

        test('returning to Inherit emits the empty sentinel the sanitizer drops', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={rowWith({ autoJoin: true })} onChange={onChange} />);
            pick('app.titleRuleAutoJoin', '');
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ autoJoin: '' })]);
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
            expect(screen.getByLabelText('app.titleRuleJoinWindow').value).toBe('0');
        });
    });

    describe('match mode and challenge tag', () => {
        const rowWith = (over = {}) => [{ title: 'abc', mustIncludeTags: [], shouldIncludeTags: [], ...over }];

        test('a rule with no match key shows as exact', () => {
            render(<TitleTagRulesEditor value={rowWith()} onChange={jest.fn()} />);
            expect(screen.getByLabelText('app.titleRuleMatch').value).toBe('exact');
        });

        test('choosing a mode emits it', () => {
            const onChange = jest.fn();
            render(<TitleTagRulesEditor value={rowWith()} onChange={onChange} />);
            const select = screen.getByLabelText('app.titleRuleMatch');
            select.value = 'contains';
            select.dispatchEvent(new window.Event('change', { bubbles: true }));
            expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ match: 'contains' })]);
        });

        test('a saved mode renders back', () => {
            render(<TitleTagRulesEditor value={rowWith({ match: 'starts' })} onChange={jest.fn()} />);
            expect(screen.getByLabelText('app.titleRuleMatch').value).toBe('starts');
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
            expect(screen.getByLabelText('app.titleRuleChallengeTag').value).toBe('Turbo');
            expect(screen.getAllByPlaceholderText('app.tagsPlaceholder')).toHaveLength(2);
        });

        test('a tag-only rule renders with an empty title', () => {
            render(
                <TitleTagRulesEditor
                    value={[{ challengeTag: 'Exhibition', mustIncludeTags: [], shouldIncludeTags: [] }]}
                    onChange={jest.fn()}
                />,
            );
            expect(screen.getByLabelText('app.titleTagRuleTitle').value).toBe('');
            expect(screen.getByLabelText('app.titleRuleChallengeTag').value).toBe('Exhibition');
        });
    });
});
