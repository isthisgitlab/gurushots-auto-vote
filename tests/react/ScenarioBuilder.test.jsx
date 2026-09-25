/**
 * The visual scenario builder: header, phases (settings overlay, rules), the
 * JSON tab, simulation on a live challenge, and save (with rename).
 */

import { act, render, screen, waitFor, fireEvent, within } from './helpers/test-utils';
import { ScenarioBuilder } from '@/components/app/scenarioBuilder/ScenarioBuilder';

const changeSelect = (sel, value) =>
    act(() => {
        sel.value = value;
        sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
const click = (name) => fireEvent.click(screen.getByRole('button', { name }));

const doc = () => ({
    name: 'Plan',
    version: 1,
    start: 'main',
    phases: {
        main: {
            settings: { exposure: 10, unknownKey: 1 },
            rules: [
                { id: 'r1', label: 'First', do: [{ type: 'goto', phase: 'later' }] },
                {
                    id: 'r2',
                    repeat: 'once',
                    if: [{ type: 'entries', op: '>', value: 1 }],
                    do: [{ type: 'fillExposure' }],
                },
            ],
        },
        later: {},
    },
});

let saved;
let onSaved;
let onCancel;

const renderBuilder = async (props = {}) => {
    onSaved = jest.fn();
    onCancel = jest.fn();
    render(<ScenarioBuilder initial={doc()} originalName="Plan" onSaved={onSaved} onCancel={onCancel} {...props} />);
    await waitFor(() => expect(window.api.getSettingsSchema).toHaveBeenCalled());
};

/** Saves and returns the document the builder sent. */
const saveDraft = async () => {
    click('app.sbSave');
    await waitFor(() => expect(window.api.saveScenario).toHaveBeenCalled());
    return window.api.saveScenario.mock.calls.at(-1)[0];
};

beforeEach(() => {
    saved = null;
    window.api.getSettingsSchema.mockResolvedValue({
        schema: {
            exposure: { type: 'number', perChallenge: true, default: 100, label: 'app.exposure' },
            autoFill: { type: 'boolean', perChallenge: true, default: false, label: 'app.autoFill' },
            scenario: { type: 'scenario', perChallenge: true, default: '', label: 'app.scenario' },
            timezone: { type: 'string', perChallenge: false, default: 'UTC', label: 'app.timezone' },
        },
        defaults: {},
    });
    window.api.getSettings.mockResolvedValue({ token: 'tok' });
    window.api.getActiveChallenges.mockResolvedValue({ challenges: [{ id: 7, title: 'Show' }] });
    window.api.saveScenario = jest.fn(async (draft) => {
        saved = draft;
        return { success: true, name: draft.name };
    });
    window.api.renameScenario = jest.fn(async () => ({ success: true, name: 'New' }));
    window.api.checkScenario = jest.fn(async () => ({ success: true }));
    window.api.simulateScenario = jest.fn();
});

describe('header', () => {
    test('name, start, description and limits edit the draft', async () => {
        await renderBuilder({ originalName: null });
        expect(screen.getByText('app.sbTitleNew')).toBeTruthy();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'Plan B' } });
        changeSelect(screen.getByLabelText('app.sbStart'), 'later');
        fireEvent.change(screen.getByLabelText('app.sbDescription'), { target: { value: 'Mine' } });
        fireEvent.change(screen.getByLabelText('app.sbCurrency_swaps'), { target: { value: '3' } });
        fireEvent.change(screen.getByLabelText('app.sbCurrency_keys'), { target: { value: '1' } });
        fireEvent.change(screen.getByLabelText('app.sbCurrency_keys'), { target: { value: '' } });
        const draft = await saveDraft();
        expect(draft).toEqual(
            expect.objectContaining({ name: 'Plan B', start: 'later', description: 'Mine', limits: { swaps: 3 } }),
        );
        expect(window.api.saveScenario).toHaveBeenCalledWith(expect.any(Object), { overwrite: false });
        expect(window.api.renameScenario).not.toHaveBeenCalled();
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
    });

    test('clearing the description leaves it out', async () => {
        await renderBuilder({ initial: { ...doc(), description: 'Old' } });
        fireEvent.change(screen.getByLabelText('app.sbDescription'), { target: { value: '' } });
        expect((await saveDraft()).description).toBeUndefined();
    });
});

describe('phases', () => {
    test('add, rename (following gotos and start) and remove', async () => {
        await renderBuilder();
        click('app.sbAddPhase');
        const names = screen.getAllByLabelText('app.sbPhaseName');
        expect(names).toHaveLength(3);
        fireEvent.change(names[1], { target: { value: 'end' } });
        fireEvent.focusOut(names[1]);
        fireEvent.change(names[0], { target: { value: 'end' } });
        fireEvent.focusOut(names[0]);
        expect(names[0].value).toBe('main');
        fireEvent.click(screen.getAllByRole('button', { name: 'app.sbRemovePhase' })[2]);
        const draft = await saveDraft();
        expect(Object.keys(draft.phases)).toEqual(['main', 'end']);
        expect(draft.phases.main.rules[0].do[0]).toEqual({ type: 'goto', phase: 'end' });
    });

    test('the only phase cannot be removed', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        expect(screen.getByRole('button', { name: 'app.sbRemovePhase' }).disabled).toBe(true);
        expect(screen.getByText('app.sbNoSettings')).toBeTruthy();
    });

    test('the settings overlay: add, change and remove per-challenge settings', async () => {
        await renderBuilder();
        await waitFor(() => expect(screen.getAllByText('app.exposure').length).toBeGreaterThan(0));
        const picker = screen.getAllByLabelText('app.sbAddSetting')[0];
        expect(within(picker).queryByText('app.scenario')).toBeNull();
        expect(within(picker).queryByText('app.timezone')).toBeNull();
        changeSelect(picker, 'autoFill');
        fireEvent.change(document.querySelector('#sb-setting-exposure'), { target: { value: '55' } });
        fireEvent.click(screen.getAllByTitle('app.resetToDefaultNotSaved')[0]);
        expect(document.querySelector('#sb-setting-exposure').value).toBe('100');
        fireEvent.change(document.querySelector('#sb-setting-exposure'), { target: { value: '12' } });
        // unknownKey (not in the schema) shows its key and only a remove button.
        expect(screen.getByText('unknownKey')).toBeTruthy();
        fireEvent.click(screen.getAllByRole('button', { name: 'app.sbRemove' })[1]);
        const draft = await saveDraft();
        expect(draft.phases.main.settings).toEqual({ exposure: 12, autoFill: false });
    });
});

describe('rules', () => {
    test('add, rename, repeat, move and remove', async () => {
        await renderBuilder();
        // A rule's own controls come first in its card, before its condition and action lists.
        const ruleCards = () => [...document.querySelectorAll('section .bg-base-100')];
        const ruleButton = (index, name) => within(ruleCards()[index]).getAllByRole('button', { name })[0];
        const labels = screen.getAllByLabelText('app.sbRuleLabel');
        fireEvent.change(labels[0], { target: { value: '' } });
        fireEvent.change(labels[1], { target: { value: 'Second' } });
        changeSelect(screen.getAllByLabelText('app.sbRepeat')[0], 'oncePerDay');
        fireEvent.click(screen.getAllByRole('button', { name: 'app.sbAddRule' })[0]);
        expect(ruleCards()).toHaveLength(3);
        expect(ruleButton(0, 'app.sbMoveUp').disabled).toBe(true);
        expect(ruleButton(2, 'app.sbMoveDown').disabled).toBe(true);
        fireEvent.click(ruleButton(0, 'app.sbMoveDown'));
        fireEvent.click(ruleButton(1, 'app.sbMoveUp'));
        fireEvent.click(ruleButton(0, 'app.sbMoveDown'));
        fireEvent.click(ruleButton(2, 'app.sbRemove'));
        const draft = await saveDraft();
        expect(draft.phases.main.rules.map((r) => r.id)).toEqual(['r2', 'r1']);
        expect(draft.phases.main.rules[0].label).toBe('Second');
        expect(draft.phases.main.rules[1]).toEqual(expect.objectContaining({ repeat: 'oncePerDay' }));
        expect(draft.phases.main.rules[1].label).toBeUndefined();
    });

    test("rules without conditions say so, and editing a rule's lists updates it", async () => {
        await renderBuilder();
        expect(screen.getAllByText('app.sbConditionsEmpty')).toHaveLength(1);
        changeSelect(screen.getAllByLabelText('app.sbAddCondition')[0], 'exposure');
        changeSelect(screen.getAllByLabelText('app.sbAddAction')[0], 'fillExposure');
        const draft = await saveDraft();
        expect(draft.phases.main.rules[0].if).toEqual([{ type: 'exposure', op: '>=', value: 0 }]);
        expect(draft.phases.main.rules[0].do.map((a) => a.type)).toEqual(['goto', 'fillExposure']);
    });
});

describe('JSON tab', () => {
    test('a valid edit replaces the draft; invalid or unrenderable JSON keeps it', async () => {
        await renderBuilder();
        fireEvent.click(screen.getByRole('tab', { name: 'app.sbTabJson' }));
        const box = screen.getByLabelText('app.sbTabJson');
        fireEvent.change(box, { target: { value: '{nope' } });
        expect(screen.getByRole('status').textContent).toBe('app.sbJsonInvalid');
        fireEvent.change(box, { target: { value: '{"phases": 5}' } });
        expect(screen.getByRole('status')).toBeTruthy();
        const next = { name: 'From JSON', version: 1, start: 'x', phases: { x: {} } };
        fireEvent.change(box, { target: { value: JSON.stringify(next) } });
        expect(screen.queryByRole('status')).toBeNull();
        fireEvent.click(screen.getByRole('tab', { name: 'app.sbTabBuilder' }));
        expect(screen.getByLabelText('app.sbName').value).toBe('From JSON');
        expect(await saveDraft()).toEqual(next);
    });
});

describe('simulate', () => {
    test('runs the draft on the picked challenge and shows the timeline', async () => {
        window.api.simulateScenario.mockResolvedValueOnce({
            success: true,
            events: [
                { at: 1_800_000_000, phase: 'main', ruleId: 'r1', label: 'First', actions: ['goto'], toPhase: 'later' },
                { at: 1_800_000_060, phase: 'later', ruleId: 'r3', label: 'Next', actions: ['notify'], toPhase: null },
            ],
            stoppedBecause: 'halted',
            halted: 'Phase gone',
        });
        await renderBuilder();
        const picker = await screen.findByLabelText('app.sbSimulateOn');
        await waitFor(() => expect(within(picker).getByText('Show')).toBeTruthy());
        expect(screen.getByRole('button', { name: 'app.sbSimulate' }).disabled).toBe(true);
        changeSelect(picker, '7');
        click('app.sbSimulate');
        await screen.findByText('app.sbSimulateAssume');
        expect(window.api.simulateScenario).toHaveBeenCalledWith('7', expect.objectContaining({ name: 'Plan' }));
        expect(screen.getByText(/\[main\] First: goto/).textContent).toContain('app.sbToPhase');
        expect(screen.getByText('app.sbStop_halted')).toBeTruthy();
        expect(screen.getByText('Phase gone')).toBeTruthy();
    });

    test('an empty timeline, and a failed run with its problems', async () => {
        window.api.simulateScenario
            .mockResolvedValueOnce({ success: true, events: [], stoppedBecause: 'idle', halted: null })
            .mockResolvedValueOnce({ success: false, issues: [{ path: 'start', message: 'No phase' }] });
        window.api.getActiveChallenges.mockResolvedValue({ challenges: [{ id: 7, title: 'Show' }] });
        await renderBuilder();
        const picker = await screen.findByLabelText('app.sbSimulateOn');
        await waitFor(() => expect(within(picker).getByText('Show')).toBeTruthy());
        changeSelect(picker, '7');
        click('app.sbSimulate');
        await screen.findByText('app.sbSimulateNothing');
        expect(screen.getByText('app.sbStop_idle')).toBeTruthy();
        click('app.sbSimulate');
        expect((await screen.findByRole('alert')).textContent).toContain('app.sbSimulateFailed');
        expect(screen.queryByText('app.sbSimulateNothing')).toBeNull();
    });
});

describe('save', () => {
    test('editing under a new name renames first, then overwrites', async () => {
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        await saveDraft();
        expect(window.api.renameScenario).toHaveBeenCalledWith('Plan', 'New');
        expect(window.api.saveScenario).toHaveBeenCalledWith(expect.objectContaining({ name: 'New' }), {
            overwrite: true,
        });
    });

    test('a casing-only change does not rename; a refused save shows its problems', async () => {
        window.api.saveScenario = jest.fn(async () => ({
            success: false,
            issues: [{ path: 'start', message: 'No phase' }],
        }));
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'PLAN' } });
        click('app.sbSave');
        expect((await screen.findByRole('alert')).textContent).toContain('app.sbSaveFailed');
        expect(window.api.renameScenario).not.toHaveBeenCalled();
        expect(onSaved).not.toHaveBeenCalled();
    });

    test('a draft that does not validate changes nothing — no rename, no save', async () => {
        window.api.checkScenario = jest.fn(async () => ({
            success: false,
            issues: [{ path: 'start', message: 'No phase' }],
        }));
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        click('app.sbSave');
        expect((await screen.findByRole('alert')).textContent).toContain('No phase');
        expect(window.api.renameScenario).not.toHaveBeenCalled();
        expect(window.api.saveScenario).not.toHaveBeenCalled();
    });

    test('after a rename went through but the save was refused, a retry saves without renaming again', async () => {
        window.api.saveScenario = jest
            .fn()
            .mockResolvedValueOnce({ success: false, issues: [{ path: '', message: 'disk full' }] })
            .mockResolvedValueOnce({ success: true, name: 'New' });
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        click('app.sbSave');
        expect((await screen.findByRole('alert')).textContent).toContain('disk full');
        click('app.sbSave');
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(window.api.renameScenario).toHaveBeenCalledTimes(1);
        expect(window.api.saveScenario).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'New' }), {
            overwrite: true,
        });
    });

    test('a refused rename stops before saving', async () => {
        window.api.renameScenario = jest.fn(async () => ({
            success: false,
            issues: [{ path: 'name', message: 'taken' }],
        }));
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'Other' } });
        click('app.sbSave');
        expect((await screen.findByRole('alert')).textContent).toContain('taken');
        expect(window.api.saveScenario).not.toHaveBeenCalled();
        expect(saved).toBeNull();
    });

    test('cancel', async () => {
        await renderBuilder();
        expect(screen.getByText('app.sbTitleEdit')).toBeTruthy();
        click('app.cancel');
        expect(onCancel).toHaveBeenCalled();
    });
});
