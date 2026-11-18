/**
 * The visual scenario builder: header, phases (settings overlay, rules), the
 * JSON tab, simulation on a live challenge, and save (with rename).
 */

import { act, cleanup, render, screen, waitFor, fireEvent, within } from './helpers/test-utils';
import type { ComponentProps } from 'preact';
import { ScenarioBuilder } from '@/components/app/scenarioBuilder/ScenarioBuilder';
import type { ScenarioDraft, ScenarioDraftRule } from '../../src/ts/core/types/scenarioBuilder';
import { invalid } from '../helpers/invalid';

/** The saved document as these tests read it: each phase they inspect has rules, and every action a type. */
type SavedDraft = Omit<ScenarioDraft, 'phases'> & {
    phases: Record<
        string,
        { settings?: Record<string, unknown>; rules: (Omit<ScenarioDraftRule, 'do'> & { do: { type: string }[] })[] }
    >;
};

const changeSelect = (sel: HTMLSelectElement, value: string) =>
    act(() => {
        sel.value = value;
        sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

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

let saved: unknown;
let onSaved: jest.MockedFunction<ComponentProps<typeof ScenarioBuilder>['onSaved']>;
let onCancel: jest.MockedFunction<ComponentProps<typeof ScenarioBuilder>['onCancel']>;
let onDirtyChange: jest.MockedFunction<ComponentProps<typeof ScenarioBuilder>['onDirtyChange']>;

const renderBuilder = async (props: Partial<ComponentProps<typeof ScenarioBuilder>> = {}) => {
    onSaved = jest.fn();
    onCancel = jest.fn();
    onDirtyChange = jest.fn();
    render(
        <ScenarioBuilder
            initial={doc()}
            originalName="Plan"
            revision={5}
            onSaved={onSaved}
            onCancel={onCancel}
            onDirtyChange={onDirtyChange}
            {...props}
        />,
    );
    await waitFor(() => expect(window.api.getSettingsSchema).toHaveBeenCalled());
};

/** Saves and returns the document the builder sent. */
const saveDraft = async (): Promise<SavedDraft> => {
    click('app.sbSave');
    await waitFor(() => expect(window.api.saveScenario).toHaveBeenCalled());
    return invalid(jest.mocked(window.api.saveScenario).mock.calls.at(-1)![0]);
};

beforeEach(() => {
    saved = null;
    jest.mocked(window.api.getSettingsSchema).mockResolvedValue(
        invalid({
            schema: {
                exposure: { type: 'number', perChallenge: true, default: 100, label: 'app.exposure' },
                autoSubmit: { type: 'boolean', perChallenge: true, default: false, label: 'app.autoSubmit' },
                scenario: { type: 'scenario', perChallenge: true, default: '', label: 'app.scenario' },
                chosenPhotos: { type: 'photos', perChallenge: true, default: [], label: 'app.chosenPhotos' },
                timezone: { type: 'string', perChallenge: false, default: 'UTC', label: 'app.timezone' },
            },
            defaults: {},
        }),
    );
    jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ app: {} }));
    jest.mocked(window.api.getActiveChallenges).mockResolvedValue({ challenges: [invalid({ id: 7, title: 'Show' })] });
    window.api.saveScenario = invalid(
        jest.fn(async (draft: ScenarioDraft) => {
            saved = draft;
            return { success: true, name: draft.name };
        }),
    );
    window.api.renameScenario = invalid(jest.fn(async () => ({ success: true, name: 'New' })));
    window.api.checkScenario = invalid(jest.fn(async () => ({ success: true })));
    window.api.simulateScenario = jest.fn();
});

describe('header', () => {
    test('name, start, description and limits edit the draft', async () => {
        await renderBuilder({ originalName: null });
        expect(screen.getByText('app.sbTitleNew')).toBeTruthy();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'Plan B' } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbStart'), 'later');
        fireEvent.change(screen.getByLabelText('app.sbDescription'), { target: { value: 'Mine' } });
        fireEvent.change(screen.getByLabelText('app.sbCurrency_swaps'), { target: { value: '3' } });
        fireEvent.change(screen.getByLabelText('app.sbCurrency_keys'), { target: { value: '1' } });
        fireEvent.change(screen.getByLabelText('app.sbCurrency_keys'), { target: { value: '' } });
        const draft = await saveDraft();
        expect(draft).toEqual(
            expect.objectContaining({ name: 'Plan B', start: 'later', description: 'Mine', limits: { swaps: 3 } }),
        );
        expect(window.api.saveScenario).toHaveBeenCalledWith(expect.any(Object), {
            overwrite: false,
            expectedDefinitionRevision: 5,
        });
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
        const names = screen.getAllByLabelText<HTMLInputElement>('app.sbPhaseName');
        expect(names).toHaveLength(3);
        fireEvent.change(names[1], { target: { value: 'end' } });
        fireEvent.focusOut(names[1]);
        fireEvent.change(names[0], { target: { value: 'end' } });
        fireEvent.focusOut(names[0]);
        expect(names[0].value).toBe('main');
        fireEvent.click(screen.getAllByRole('button', { name: /^app\.sbRemovePhase: / })[2]);
        const draft = await saveDraft();
        expect(Object.keys(draft.phases)).toEqual(['main', 'end']);
        expect(draft.phases.main.rules[0].do[0]).toEqual({ type: 'goto', phase: 'end' });
    });

    test('the only phase cannot be removed', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbRemovePhase: main' }).disabled).toBe(true);
        expect(screen.getByText('app.sbNoSettings')).toBeTruthy();
    });

    test('the settings overlay: add, change and remove per-challenge settings', async () => {
        await renderBuilder();
        await waitFor(() => expect(screen.getAllByText('app.exposure').length).toBeGreaterThan(0));
        const picker = screen.getAllByLabelText<HTMLSelectElement>('app.sbAddSetting')[0];
        expect(within(picker).queryByText('app.scenario')).toBeNull();
        expect(within(picker).queryByText('app.timezone')).toBeNull();
        changeSelect(picker, 'autoSubmit');
        fireEvent.change(document.querySelector('#sb-setting-exposure')!, { target: { value: '55' } });
        fireEvent.click(screen.getAllByTitle(/^app\.resetToDefaultNotSaved/)[0]);
        expect(document.querySelector<HTMLInputElement>('#sb-setting-exposure')!.value).toBe('100');
        fireEvent.change(document.querySelector('#sb-setting-exposure')!, { target: { value: '12' } });
        // unknownKey (not in the schema) shows its key and only a remove button.
        expect(screen.getByText('unknownKey')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'app.sbRemove: unknownKey' }));
        const draft = await saveDraft();
        expect(draft.phases.main.settings).toEqual({ exposure: 12, autoSubmit: false });
    });
});

describe('chosen photos in a phase', () => {
    test('the row wraps and says a scenario list only applies after joining', async () => {
        window.api.getSetting = jest.fn().mockResolvedValue('');
        await renderBuilder({
            initial: { ...doc(), phases: { main: { settings: { chosenPhotos: ['p1'] }, rules: [] } } },
        });
        const hint = await screen.findByText('app.chosenPhotosScenarioHint');
        expect(hint.closest('div')!.className).toContain('flex-wrap');
        expect(screen.getByRole('button', { name: 'app.choosePhotos' })).toBeTruthy();
    });

    test('other settings carry no such hint, and the key can be picked from the list', async () => {
        await renderBuilder();
        await waitFor(() => expect(screen.getAllByText('app.exposure').length).toBeGreaterThan(0));
        expect(screen.queryByText('app.chosenPhotosScenarioHint')).toBeNull();
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbAddSetting')[0], 'chosenPhotos');
        expect(await screen.findByText('app.chosenPhotosScenarioHint')).toBeTruthy();
        const draft = await saveDraft();
        expect(draft.phases.main.settings).toEqual({ exposure: 10, unknownKey: 1, chosenPhotos: [] });
    });
});

describe('rules', () => {
    test('add, rename, repeat, move and remove', async () => {
        await renderBuilder();
        // A rule's own controls come first in its card, before its condition and action lists.
        const ruleCards = () => [...document.querySelectorAll<HTMLElement>('section .bg-base-100')];
        const ruleButton = (index: number, name: string) =>
            // Named by the action and the rule's place: "Move up: Rule 2".
            within(ruleCards()[index]).getAllByRole<HTMLButtonElement>('button', {
                name: new RegExp(`^${name.replace('.', '\\.')}: Rule ${index + 1}$`),
            })[0];
        const labels = screen.getAllByLabelText('app.sbRuleLabel');
        fireEvent.change(labels[0], { target: { value: '' } });
        fireEvent.change(labels[1], { target: { value: 'Second' } });
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbRepeat')[0], 'oncePerDay');
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
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbAddCondition')[0], 'exposure');
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbAddAction')[0], 'fillExposure');
        const draft = await saveDraft();
        expect(draft.phases.main.rules[0].if).toEqual([{ type: 'exposure', op: '>=', value: 0 }]);
        expect(draft.phases.main.rules[0].do.map((a) => a.type)).toEqual(['goto', 'fillExposure']);
    });
});

describe('tabs', () => {
    const tabs = () => screen.getAllByRole('tab');

    test('follow the WAI-ARIA tabs pattern', async () => {
        await renderBuilder();
        const [builder, json] = tabs();
        expect(screen.getByRole('tablist').className).toContain('tabs-border');
        expect([builder.getAttribute('tabindex'), json.getAttribute('tabindex')]).toEqual(['0', '-1']);
        const panel = screen.getByRole('tabpanel');
        expect(panel.getAttribute('aria-labelledby')).toBe(builder.id);
        // only the selected tab controls a mounted panel
        expect(builder.getAttribute('aria-controls')).toBe(panel.id);
        expect(json.hasAttribute('aria-controls')).toBe(false);

        fireEvent.click(json);
        expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(json.id);
        expect(json.getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id);
        expect(builder.hasAttribute('aria-controls')).toBe(false);
        expect([builder.getAttribute('tabindex'), json.getAttribute('tabindex')]).toEqual(['-1', '0']);
    });

    test('the arrow keys wrap and Home / End jump, selecting and focusing the target', async () => {
        await renderBuilder();
        const [builder, json] = tabs();
        const press = (from: HTMLElement, key: string) => fireEvent.keyDown(from, { key });

        press(builder, 'ArrowRight');
        expect(json.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(json);
        press(json, 'ArrowRight');
        expect(builder.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(builder);
        press(builder, 'ArrowLeft');
        expect(json.getAttribute('aria-selected')).toBe('true');
        press(json, 'ArrowLeft');
        expect(builder.getAttribute('aria-selected')).toBe('true');
        press(builder, 'End');
        expect(json.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(json);
        press(json, 'Home');
        expect(builder.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(builder);
    });

    test('other keys leave the selection alone', async () => {
        await renderBuilder();
        const [builder] = tabs();
        expect(fireEvent.keyDown(builder, { key: 'a' })).toBe(true);
        expect(builder.getAttribute('aria-selected')).toBe('true');
    });
});

describe('JSON tab', () => {
    test('a valid edit replaces the draft; invalid or unrenderable JSON keeps it', async () => {
        await renderBuilder();
        fireEvent.click(screen.getByRole('tab', { name: 'app.sbTabJson' }));
        const box = screen.getByRole('textbox', { name: 'app.sbTabJson' });
        expect(box.getAttribute('autocapitalize')).toBe('off');
        fireEvent.change(box, { target: { value: '{nope' } });
        expect(screen.getByRole('status').textContent).toBe('app.sbJsonInvalid');
        fireEvent.change(box, { target: { value: '{"phases": 5}' } });
        expect(screen.getByRole('status')).toBeTruthy();
        const next = { name: 'From JSON', version: 1, start: 'x', phases: { x: {} } };
        fireEvent.change(box, { target: { value: JSON.stringify(next) } });
        expect(screen.queryByRole('status')).toBeNull();
        fireEvent.click(screen.getByRole('tab', { name: 'app.sbTabBuilder' }));
        expect(screen.getByLabelText<HTMLInputElement>('app.sbName').value).toBe('From JSON');
        expect(await saveDraft()).toEqual(next);
    });
});

describe('simulate', () => {
    const response = (patch: Record<string, unknown> = {}) =>
        invalid<Awaited<ReturnType<typeof window.api.simulateScenario>>>({
            success: true,
            events: [],
            stopReason: 'idle',
            halted: null,
            manualOnly: false,
            ...patch,
        });
    const SHOW = { id: 7, title: 'Show', close_time: 1_800_000_000 };

    test('runs the draft on the picked active challenge, to its close, assuming every step succeeds, and shows the timeline', async () => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(
            response({
                events: [
                    { type: 'rule', at: 1_800_000_000, subject: '7', phase: 'main', ruleId: 'r1', applied: true },
                    {
                        type: 'operation',
                        at: 1_800_000_010,
                        subject: '7',
                        operation: 'submitToChallenge',
                        outcome: 'success',
                        applied: true,
                    },
                    { type: 'phase', at: 1_800_000_020, subject: '7', from: 'main', to: 'later', applied: true },
                    {
                        type: 'published',
                        at: 1_800_000_030,
                        subject: '7',
                        phase: 'later',
                        validUntil: null,
                        applied: true,
                    },
                    { type: 'notice', at: 1_800_000_040, subject: '7', message: 'Halted by hand', applied: true },
                    { type: 'preview', at: 1_800_009_000, subject: '7', reason: 'next-wake', applied: false },
                ],
                stopReason: 'halted',
                halted: 'Phase gone',
            }),
        );
        jest.mocked(window.api.getActiveChallenges).mockResolvedValue({ challenges: [invalid(SHOW)] });
        await renderBuilder();
        const picker = await screen.findByLabelText<HTMLSelectElement>('app.sbSimulateOn');
        await waitFor(() => expect(within(picker).getByText('Show')).toBeTruthy());
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSimulate' }).disabled).toBe(true);
        changeSelect(picker, '7');
        click('app.sbSimulate');
        await screen.findByText('app.sbSimulateAssume');
        expect(window.api.simulateScenario).toHaveBeenCalledWith({
            scenario: { draft: expect.objectContaining({ name: 'Plan' }) },
            subject: { kind: 'active', challengeId: '7' },
            until: 1_800_000_000,
            assumptions: {
                outcomes: {
                    submit: 'success',
                    join: 'success',
                    claim: 'success',
                    boost: 'success',
                    turbo: 'success',
                    swap: 'success',
                    fill: 'success',
                    keyUnlock: 'success',
                },
            },
        });
        expect(screen.getByText(/\[main\] r1/)).toBeTruthy();
        expect(screen.getByText(/submitToChallenge \(success\)/)).toBeTruthy();
        expect(screen.getByText(/app\.sbToPhase/)).toBeTruthy();
        expect(screen.getByText(/\[later\]/)).toBeTruthy();
        expect(screen.getByText(/Halted by hand/)).toBeTruthy();
        // The preview is prospective: it is not listed with what the run did.
        expect(screen.getAllByRole('listitem')).toHaveLength(5);
        expect(screen.getByText('app.sbStop_halted')).toBeTruthy();
        expect(screen.getByText('Phase gone')).toBeTruthy();
    });

    test('a challenge with no close time is simulated to now, never to a made-up close', async () => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(response());
        jest.mocked(window.api.getActiveChallenges).mockResolvedValue({
            challenges: [invalid({ id: 7, title: 'Show' })],
        });
        jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_500);
        await renderBuilder();
        const picker = await screen.findByLabelText<HTMLSelectElement>('app.sbSimulateOn');
        await waitFor(() => expect(within(picker).getByText('Show')).toBeTruthy());
        changeSelect(picker, '7');
        click('app.sbSimulate');
        await screen.findByText('app.sbSimulateNothing');
        expect(window.api.simulateScenario).toHaveBeenCalledWith(expect.objectContaining({ until: 1_700_000_000 }));
    });

    test.each([
        ['horizon', 'app.sbStop_closed'],
        ['needsEvidence', 'app.sbStop_halted'],
        ['limit', 'app.sbStop_limit'],
    ])('the stop reason %s reads as %s', async (stopReason, key) => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(response({ stopReason }));
        jest.mocked(window.api.getActiveChallenges).mockResolvedValue({ challenges: [invalid(SHOW)] });
        await renderBuilder();
        const picker = await screen.findByLabelText<HTMLSelectElement>('app.sbSimulateOn');
        await waitFor(() => expect(within(picker).getByText('Show')).toBeTruthy());
        changeSelect(picker, '7');
        click('app.sbSimulate');
        expect(await screen.findByText(key)).toBeTruthy();
    });

    test('a Manual Only challenge keeps the timeline and says it is paused; a plain one does not', async () => {
        jest.mocked(window.api.simulateScenario)
            .mockResolvedValueOnce(
                invalid({ success: true, events: [], stopReason: 'idle', halted: null, manualOnly: true }),
            )
            .mockResolvedValueOnce(
                invalid({ success: true, events: [], stopReason: 'idle', halted: null, manualOnly: false }),
            );
        jest.mocked(window.api.getActiveChallenges).mockResolvedValue({
            challenges: [invalid({ id: 7, title: 'Show' })],
        });
        await renderBuilder();
        const picker = await screen.findByLabelText<HTMLSelectElement>('app.sbSimulateOn');
        await waitFor(() => expect(within(picker).getByText('Show')).toBeTruthy());
        changeSelect(picker, '7');
        click('app.sbSimulate');
        await screen.findByText('app.sbSimulatePausedManual');
        expect(screen.getByText('app.sbSimulateNothing')).toBeTruthy();
        click('app.sbSimulate');
        await waitFor(() => expect(screen.queryByText('app.sbSimulatePausedManual')).toBeNull());
        expect(screen.getByText('app.sbSimulateNothing')).toBeTruthy();
    });

    test('an empty timeline, and a failed run with its problems', async () => {
        jest.mocked(window.api.simulateScenario)
            .mockResolvedValueOnce(invalid({ success: true, events: [], stopReason: 'idle', halted: null }))
            .mockResolvedValueOnce(invalid({ success: false, issues: [{ path: 'start', message: 'No phase' }] }));
        jest.mocked(window.api.getActiveChallenges).mockResolvedValue({
            challenges: [invalid({ id: 7, title: 'Show' })],
        });
        await renderBuilder();
        const picker = await screen.findByLabelText<HTMLSelectElement>('app.sbSimulateOn');
        await waitFor(() => expect(within(picker).getByText('Show')).toBeTruthy());
        changeSelect(picker, '7');
        click('app.sbSimulate');
        await screen.findByText('app.sbSimulateNothing');
        expect(screen.getByText('app.sbStop_idle')).toBeTruthy();
        click('app.sbSimulate');
        expect((await screen.findByRole('alert')).textContent).toContain('app.sbSimulateFailed');
        expect(screen.queryByText('app.sbSimulateNothing')).toBeNull();
    });

    test('a challenge whose data cannot be read refuses with its own next step, not the scenario one', async () => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(
            invalid({ success: false, error: 'challenge-data-incomplete' }),
        );
        await renderBuilder();
        const picker = await screen.findByLabelText<HTMLSelectElement>('app.sbSimulateOn');
        await waitFor(() => expect(within(picker).getByText('Show')).toBeTruthy());
        changeSelect(picker, '7');
        click('app.sbSimulate');
        // Both keys render in one span, so the assertions read the span's text; the lookahead tells the
        // default next step apart from the refusal one ("…NextRefresh").
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('app.sbSimulateDataIncomplete');
        expect(alert.textContent).toContain('app.scenarioErrorNextRefresh');
        expect(alert.textContent).not.toMatch(/app\.scenarioErrorNext(?!Refresh)/);
        expect(alert.textContent).not.toContain('app.sbSimulateFailed');
    });
});

describe('save', () => {
    test('editing under a new name renames first, then overwrites', async () => {
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        await saveDraft();
        expect(window.api.renameScenario).toHaveBeenCalledWith('Plan', 'New', { expectedDefinitionRevision: 5 });
        // The rename moved the collection by one change, which the overwrite expects.
        expect(window.api.saveScenario).toHaveBeenCalledWith(expect.objectContaining({ name: 'New' }), {
            overwrite: true,
            expectedDefinitionRevision: 6,
        });
    });

    test('a builder opened before the revision was readable states none', async () => {
        await renderBuilder({ revision: null });
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        await saveDraft();
        expect(window.api.renameScenario).toHaveBeenCalledWith('Plan', 'New', {
            expectedDefinitionRevision: undefined,
        });
        expect(window.api.saveScenario).toHaveBeenCalledWith(expect.objectContaining({ name: 'New' }), {
            overwrite: true,
            expectedDefinitionRevision: undefined,
        });
    });

    test('a casing-only change does not rename; a refused save shows its problems', async () => {
        window.api.saveScenario = invalid(
            jest.fn(async () => ({
                success: false,
                issues: [{ path: 'start', message: 'No phase' }],
            })),
        );
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'PLAN' } });
        click('app.sbSave');
        expect((await screen.findByRole('alert')).textContent).toContain('app.sbSaveFailed');
        expect(window.api.renameScenario).not.toHaveBeenCalled();
        expect(onSaved).not.toHaveBeenCalled();
    });

    test('a draft that does not validate changes nothing — no rename, no save', async () => {
        window.api.checkScenario = invalid(
            jest.fn(async () => ({
                success: false,
                issues: [{ path: 'start', message: 'No phase' }],
            })),
        );
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        click('app.sbSave');
        // The validator's English message is worded in the UI language; its path stays.
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('start');
        expect(alert.textContent).not.toContain('No phase');
        expect(alert.textContent).toContain('app.scenarioIssueGeneric');
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
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('app.scenarioIssueGeneric');
        expect(alert.textContent).not.toContain('disk full');
        await waitFor(() =>
            expect(window.api.logDebug).toHaveBeenCalledWith('Scenario issue without wording at "": disk full'),
        );
        click('app.sbSave');
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(window.api.renameScenario).toHaveBeenCalledTimes(1);
        // Both saves expect the revision the rename left, and the retry does not fall back to the one before it.
        expect(window.api.saveScenario).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'New' }), {
            overwrite: true,
            expectedDefinitionRevision: 6,
        });
    });

    test('a refused rename stops before saving', async () => {
        window.api.renameScenario = invalid(
            jest.fn(async () => ({
                success: false,
                issues: [{ path: 'name', message: 'taken' }],
            })),
        );
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'Other' } });
        click('app.sbSave');
        expect((await screen.findByRole('alert')).textContent).toContain('app.scenarioIssueGeneric');
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

describe('dirty reporting', () => {
    const lastReport = () => onDirtyChange.mock.calls.at(-1)?.[0];

    test('false when opened, true after an edit, false again when the edit is undone', async () => {
        await renderBuilder();
        expect(lastReport()).toBe(false);
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'Plan B' } });
        expect(lastReport()).toBe(true);
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'Plan' } });
        expect(lastReport()).toBe(false);
    });

    test('closing the builder reports false', async () => {
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'Plan B' } });
        expect(lastReport()).toBe(true);
        cleanup();
        await waitFor(() => expect(lastReport()).toBe(false));
    });

    test('JSON text that never became the draft is dirty; leaving the tab clears it', async () => {
        await renderBuilder();
        fireEvent.click(screen.getByRole('tab', { name: 'app.sbTabJson' }));
        expect(lastReport()).toBe(false);
        fireEvent.change(screen.getByRole('textbox', { name: 'app.sbTabJson' }), { target: { value: '{nope' } });
        expect(lastReport()).toBe(true);
        fireEvent.click(screen.getByRole('tab', { name: 'app.sbTabBuilder' }));
        expect(lastReport()).toBe(false);
    });
});
