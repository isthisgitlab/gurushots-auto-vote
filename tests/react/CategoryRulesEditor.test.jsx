/**
 * CategoryRulesEditor — controlled editor for category-keyed join-timing rules.
 * The translation mock echoes keys, so labels are the i18n keys. "Inherit" is
 * spelled '' throughout (the settings sanitizer drops it), and an explicit 0 is
 * a different, real value — the tests pin both.
 */

import { fireEvent, render, screen } from './helpers/test-utils';
import { CategoryRulesEditor } from '@/components/app/CategoryRulesEditor';

const pick = (element, next) => {
    element.value = next;
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
};

describe('CategoryRulesEditor', () => {
    test('a non-array value shows the empty state and no type suggestions', () => {
        const { container } = render(<CategoryRulesEditor value={undefined} onChange={jest.fn()} />);
        expect(screen.getByText('app.noCategoryRules')).toBeTruthy();
        expect(container.querySelectorAll('datalist option')).toHaveLength(0);
    });

    test('type suggestions render as labelled datalist options', () => {
        const { container } = render(
            <CategoryRulesEditor value={[]} onChange={jest.fn()} types={['default', 'flash']} />,
        );
        const options = Array.from(container.querySelectorAll('#gs-category-rule-types option'));
        expect(options.map((o) => [o.value, o.textContent])).toEqual([
            ['default', 'default'],
            ['flash', 'flash'],
        ]);
    });

    test('"Add" appends an empty any-type / any-count rule', () => {
        const onChange = jest.fn();
        render(<CategoryRulesEditor value={[{ type: 'flash' }]} onChange={onChange} />);
        fireEvent.click(screen.getByRole('button', { name: /app\.addCategoryRule/ }));
        expect(onChange).toHaveBeenCalledWith([{ type: 'flash' }, { type: '', pics: '' }]);
    });

    test('a rule with no keys renders every field as inherit/empty', () => {
        render(<CategoryRulesEditor value={[{}]} onChange={jest.fn()} />);
        expect(screen.getByLabelText('app.categoryRuleType').value).toBe('');
        expect(screen.getByLabelText('app.categoryRulePics').value).toBe('');
        expect(screen.getByLabelText('app.categoryRulePercentElapsed').value).toBe('');
        expect(screen.getByLabelText('app.categoryRuleJoinWindow').value).toBe('');
        expect(screen.queryByText('app.noCategoryRules')).toBeNull();
    });

    test('stored values render back, including an explicit 0 override', () => {
        render(
            <CategoryRulesEditor
                value={[{ type: 'exhibition', pics: 4, autoJoinAfterPercentElapsed: 0, autoJoinWithinHoursOfEnd: 12 }]}
                onChange={jest.fn()}
            />,
        );
        expect(screen.getByLabelText('app.categoryRuleType').value).toBe('exhibition');
        // The pics select is not asserted here: happy-dom's select.value setter
        // compares strictly, so a numeric `value` prop never selects under test
        // (browsers coerce). The pics round-trip is pinned by the pick test below.
        expect(screen.getByLabelText('app.categoryRulePercentElapsed').value).toBe('0');
        expect(screen.getByLabelText('app.categoryRuleJoinWindow').value).toBe('12');
    });

    test('editing the type patches only the edited rule', () => {
        const onChange = jest.fn();
        const value = [{ type: 'a' }, { type: 'b' }];
        render(<CategoryRulesEditor value={value} onChange={onChange} />);
        fireEvent.change(screen.getAllByLabelText('app.categoryRuleType')[1], { target: { value: 'speed' } });
        expect(onChange).toHaveBeenCalledWith([{ type: 'a' }, { type: 'speed' }]);
    });

    test('picking a photo count emits a number, and "any" emits the inherit sentinel', () => {
        const onChange = jest.fn();
        render(<CategoryRulesEditor value={[{ pics: 2 }]} onChange={onChange} />);
        const select = screen.getByLabelText('app.categoryRulePics');
        pick(select, '3');
        expect(onChange).toHaveBeenLastCalledWith([{ pics: 3 }]);
        pick(select, '');
        expect(onChange).toHaveBeenLastCalledWith([{ pics: '' }]);
    });

    test('number overrides emit numbers, and clearing emits inherit rather than 0', () => {
        const onChange = jest.fn();
        render(<CategoryRulesEditor value={[{ type: 'flash' }]} onChange={onChange} />);
        fireEvent.change(screen.getByLabelText('app.categoryRulePercentElapsed'), { target: { value: '50' } });
        expect(onChange).toHaveBeenLastCalledWith([{ type: 'flash', autoJoinAfterPercentElapsed: 50 }]);
        fireEvent.change(screen.getByLabelText('app.categoryRuleJoinWindow'), { target: { value: '' } });
        expect(onChange).toHaveBeenLastCalledWith([{ type: 'flash', autoJoinWithinHoursOfEnd: '' }]);
    });

    test('the window inputs carry their bounds', () => {
        render(<CategoryRulesEditor value={[{}]} onChange={jest.fn()} />);
        expect(screen.getByLabelText('app.categoryRulePercentElapsed').getAttribute('max')).toBe('99');
        expect(screen.getByLabelText('app.categoryRuleJoinWindow').getAttribute('max')).toBe('720');
    });

    test('removing a rule emits the list without it', () => {
        const onChange = jest.fn();
        render(<CategoryRulesEditor value={[{ type: 'a' }, { type: 'b' }]} onChange={onChange} />);
        fireEvent.click(screen.getAllByRole('button', { name: 'app.removeCategoryRule' })[0]);
        expect(onChange).toHaveBeenCalledWith([{ type: 'b' }]);
    });
});
