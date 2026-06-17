/**
 * Component tests for TitleTagRulesEditor.jsx — the controlled list editor
 * for title→tags rules in the global settings modal. The translation manager
 * mock returns each key verbatim, so labels/placeholders are the i18n keys.
 */

import { fireEvent, render, screen } from '@/test/test-utils';
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
        expect(onChange).toHaveBeenCalledWith([{ title: '', mustIncludeTags: [], shouldIncludeTags: [] }]);
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
});
