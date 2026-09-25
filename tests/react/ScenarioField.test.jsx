/**
 * The `scenario` setting's field: a pick of the stored scenarios, with a
 * stale assignment kept visible as missing.
 */

import { render, screen, waitFor } from './helpers/test-utils';
import { SettingInput } from '@/components/app/SettingInput';

const config = { type: 'scenario', default: '' };

// A <select>'s onChange stays a native 'change' listener under preact/compat
// (see ChallengeProfilesBar.test.jsx), so dispatch the real event.
const changeSelect = (sel, value) => {
    sel.value = value;
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
};

beforeEach(() => {
    window.api.getScenarios.mockResolvedValue({
        success: true,
        scenarios: { 'Show plan': {}, Other: {} },
        templates: [],
    });
});

const renderField = (value, onChange = jest.fn()) =>
    render(
        <SettingInput settingKey="scenario" config={config} value={value} onChange={onChange} onReset={jest.fn()} />,
    );

test('lists the stored scenarios after "none" and reports a pick', async () => {
    const onChange = jest.fn();
    renderField('', onChange);
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(3));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['app.scenarioNone', 'Show plan', 'Other']);
    changeSelect(screen.getByRole('combobox'), 'Other');
    expect(onChange).toHaveBeenCalledWith('scenario', 'Other');
});

test('selects the stored casing of an assignment', async () => {
    renderField('show PLAN');
    await waitFor(() => expect(screen.getByRole('combobox').value).toBe('Show plan'));
});

test('keeps a stale assignment visible as missing', async () => {
    renderField('Deleted');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    expect(screen.getByRole('combobox').value).toBe('Deleted');
    expect(screen.getAllByRole('option')[3].textContent).toBe('app.scenarioMissingOption');
});
