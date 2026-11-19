/**
 * The visual scenario builder: header, phases (settings overlay, rules), the
 * JSON tab, simulation on a live challenge, and save (with rename).
 */

import { act, cleanup, render, screen, waitFor, fireEvent, within } from './helpers/test-utils';
import type { ComponentProps } from 'preact';
import { ScenarioBuilder } from '@/components/app/scenarioBuilder/ScenarioBuilder';
import type { ScenarioDraft, ScenarioDraftPhase, ScenarioDraftRule } from '../../src/ts/core/types/scenarioBuilder';
import { invalid } from '../helpers/invalid';

/** The saved document as these tests read it: each phase they inspect has rules, and every action a type. */
type SavedPhase = Omit<ScenarioDraftPhase, 'rules'> & {
    rules: (Omit<ScenarioDraftRule, 'do'> & { do: { type: string }[] })[];
};
type SavedDraft = Omit<ScenarioDraft, 'phases'> & { phases: Record<string, SavedPhase> };

const changeSelect = (sel: HTMLSelectElement, value: string) =>
    act(() => {
        sel.value = value;
        sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
/** Types into an input (preact/compat serves onChange from the native 'input' event; see the editor tests). */
const changeInput = (input: HTMLInputElement, value: string) =>
    act(() => {
        input.value = value;
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
        input.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

/** A local date-time (as a datetime-local input holds it) `days` from now: a horizon that stays ahead whenever this runs. */
const futureLocal = (days: number): string => {
    const date = new Date(Date.now() + days * 86_400_000);
    const two = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
};
const UNTIL = futureLocal(30);

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
let onRenamed: jest.MockedFunction<NonNullable<ComponentProps<typeof ScenarioBuilder>['onRenamed']>>;
let onCancel: jest.MockedFunction<ComponentProps<typeof ScenarioBuilder>['onCancel']>;
let onDirtyChange: jest.MockedFunction<ComponentProps<typeof ScenarioBuilder>['onDirtyChange']>;

const renderBuilder = async (props: Partial<ComponentProps<typeof ScenarioBuilder>> = {}) => {
    onSaved = jest.fn();
    onRenamed = jest.fn();
    onCancel = jest.fn();
    onDirtyChange = jest.fn();
    const view = render(
        <ScenarioBuilder
            initial={doc()}
            originalName="Plan"
            revision={5}
            onSaved={onSaved}
            onRenamed={onRenamed}
            onCancel={onCancel}
            onDirtyChange={onDirtyChange}
            {...props}
        />,
    );
    await waitFor(() => expect(window.api.getSettingsSchema).toHaveBeenCalled());
    return view;
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
                manualPhotosOnly: {
                    type: 'boolean',
                    perChallenge: true,
                    default: false,
                    label: 'app.manualPhotosOnly',
                },
            },
            defaults: {},
        }),
    );
    jest.mocked(window.api.getSettings).mockResolvedValue(invalid({ app: {} }));
    jest.mocked(window.api.getActiveChallenges).mockResolvedValue({ challenges: [invalid({ id: 7, title: 'Show' })] });
    // The capability catalogue the pickers and the live-value editor read: two challenge-writable keys, one
    // user-only one, one installation-only one, and a key no expression can read.
    jest.mocked(window.api.getScenarioCapabilities).mockResolvedValue(
        invalid({
            success: true,
            capabilities: {
                settings: [
                    invalid({
                        key: 'exposure',
                        disposition: 'challengePolicy',
                        read: 'value',
                        phaseWrite: ['challenge'],
                        owner: 'challenge',
                        value: { kind: 'number', quantity: 'percent' },
                    }),
                    invalid({
                        key: 'autoSubmit',
                        disposition: 'challengePolicy',
                        read: 'value',
                        phaseWrite: ['challenge'],
                        owner: 'challenge',
                        value: { kind: 'boolean' },
                    }),
                    invalid({
                        key: 'scheduledFillWindowMinutes',
                        disposition: 'challengePolicy',
                        read: 'value',
                        phaseWrite: ['challenge'],
                        owner: 'challenge',
                        value: { kind: 'number', quantity: 'duration', unit: 'minutes' },
                    }),
                    invalid({
                        key: 'autoSubmitSchedule',
                        disposition: 'challengePolicy',
                        read: 'value',
                        phaseWrite: ['challenge'],
                        owner: 'challenge',
                        value: { kind: 'other' },
                    }),
                    invalid({
                        key: 'chosenPhotos',
                        disposition: 'challengePolicy',
                        read: 'value',
                        phaseWrite: ['challenge'],
                        owner: 'challenge',
                        value: { kind: 'other' },
                    }),
                    invalid({
                        key: 'windowBounds',
                        disposition: 'internalState',
                        read: 'projection',
                        phaseWrite: [],
                        owner: 'window',
                        value: { kind: 'other' },
                    }),
                    invalid({
                        key: 'manualPhotosOnly',
                        disposition: 'lifecycleControl',
                        read: 'value',
                        phaseWrite: [],
                        owner: 'challenge',
                        restriction: 'A phase cannot change Manual Only',
                        value: { kind: 'boolean' },
                    }),
                    invalid({
                        key: 'notifyOnBoost',
                        disposition: 'appPreference',
                        read: 'value',
                        phaseWrite: ['installation'],
                        owner: 'installation',
                        value: { kind: 'boolean' },
                    }),
                    invalid({
                        key: 'snapYesWithoutModel',
                        disposition: 'accountPolicy',
                        read: 'value',
                        phaseWrite: ['installation'],
                        owner: 'installation',
                        value: { kind: 'boolean' },
                    }),
                    invalid({
                        key: 'theme',
                        disposition: 'devicePreference',
                        read: 'value',
                        phaseWrite: ['installation'],
                        owner: 'device',
                        value: { kind: 'string' },
                    }),
                    invalid({
                        key: 'checkFrequencyMin',
                        disposition: 'appPreference',
                        read: 'value',
                        phaseWrite: ['installation'],
                        owner: 'installation',
                        value: { kind: 'number', quantity: 'count' },
                    }),
                    invalid({
                        key: 'timezone',
                        disposition: 'appPreference',
                        read: 'value',
                        phaseWrite: ['installation'],
                        owner: 'installation',
                        value: { kind: 'string' },
                    }),
                    invalid({
                        key: 'customTimezones',
                        disposition: 'devicePreference',
                        read: 'value',
                        phaseWrite: ['installation'],
                        owner: 'device',
                        value: { kind: 'list' },
                    }),
                    invalid({
                        key: 'language',
                        disposition: 'devicePreference',
                        read: 'value',
                        phaseWrite: ['installation'],
                        owner: 'device',
                        value: { kind: 'enum', values: ['en', 'lv'] },
                    }),
                ],
                remoteEnabled: invalid({
                    disposition: 'lifecycleControl',
                    read: 'projection',
                    phaseWrite: [],
                    owner: 'authentication',
                    value: { kind: 'boolean' },
                }),
            },
        }),
    );
    jest.mocked(window.api.listSimulationSubjects).mockResolvedValue(
        invalid({ success: true, readable: true, subjects: [invalid({ id: '7', label: 'Show' })] }),
    );
    jest.mocked(window.api.getPhotoPools).mockResolvedValue(invalid({ success: true, pools: { Beach: ['p1'] } }));
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
        // The input is named by its own label, whatever its id is.
        const exposure = () => screen.getAllByLabelText<HTMLInputElement>('app.exposure')[0];
        fireEvent.change(exposure(), { target: { value: '55' } });
        fireEvent.click(screen.getAllByTitle(/^app\.resetToDefaultNotSaved/)[0]);
        expect(exposure().value).toBe('100');
        fireEvent.change(exposure(), { target: { value: '12' } });
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

describe('focus after adding and removing', () => {
    /** A failed toBe on a DOM node makes Jest print the whole page: compare as a boolean. */
    const isFocused = (element: Element | undefined) => document.activeElement === element;
    const removePhase = (name: string) =>
        screen.getByRole<HTMLButtonElement>('button', { name: `app.sbRemovePhase: ${name}` });

    test('a phase added lands on the first control of the new phase', async () => {
        await renderBuilder();
        click('app.sbAddPhase');
        const names = screen.getAllByLabelText<HTMLInputElement>('app.sbPhaseName');
        expect(names).toHaveLength(3);
        expect(isFocused(names[2])).toBe(true);
    });

    test('a phase removed lands on the remove button in its place, else the previous, else the add button', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {}, mid: {}, end: {} } } });
        fireEvent.click(removePhase('mid'));
        // 'end' now sits where 'mid' was.
        expect(isFocused(removePhase('end'))).toBe(true);
        fireEvent.click(removePhase('end'));
        // 'main' is the previous one, but the only phase left cannot be removed: the add button takes it.
        expect(isFocused(screen.getByRole('button', { name: 'app.sbAddPhase' }))).toBe(true);
    });

    test('the last phase removed lands on the previous remove button', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {}, mid: {}, end: {} } } });
        fireEvent.click(removePhase('end'));
        expect(isFocused(removePhase('mid'))).toBe(true);
    });

    test('a rule added lands on the first control of the new rule', async () => {
        await renderBuilder();
        fireEvent.click(screen.getAllByRole('button', { name: 'app.sbAddRule' })[0]);
        const labels = screen.getAllByLabelText<HTMLInputElement>('app.sbRuleLabel');
        expect(labels).toHaveLength(3);
        expect(isFocused(labels[2])).toBe(true);
    });

    test('a rule removed lands on the remove button in its place, else the previous, else the add button', async () => {
        await renderBuilder();
        const named = (position: number) =>
            screen.getByRole<HTMLButtonElement>('button', { name: `app.sbRemove: Rule ${position}` });
        fireEvent.click(named(1));
        // The second rule is now the first, and the remove button there is its.
        expect(isFocused(named(1))).toBe(true);
        fireEvent.click(named(1));
        expect(isFocused(screen.getAllByRole('button', { name: 'app.sbAddRule' })[0])).toBe(true);
    });

    test('the last rule removed lands on the previous remove button', async () => {
        await renderBuilder();
        fireEvent.click(screen.getByRole('button', { name: 'app.sbRemove: Rule 2' }));
        expect(isFocused(screen.getByRole('button', { name: 'app.sbRemove: Rule 1' }))).toBe(true);
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
        const press = (from: HTMLElement, key: string) => fireEvent.keyDown(from, { key });

        const [builder, json, keys] = tabs();
        press(builder, 'ArrowRight');
        expect(json.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(json);
        press(json, 'ArrowRight');
        expect(keys.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(keys);
        press(keys, 'ArrowRight');
        expect(builder.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(builder);
        press(builder, 'ArrowLeft');
        expect(keys.getAttribute('aria-selected')).toBe('true');
        press(keys, 'ArrowLeft');
        expect(json.getAttribute('aria-selected')).toBe('true');
        press(builder, 'End');
        expect(keys.getAttribute('aria-selected')).toBe('true');
        expect(document.activeElement).toBe(keys);
        press(keys, 'Home');
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

describe('scope and stages', () => {
    test('the scope select writes the scope and clears it for a challenge scenario', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbScope').value).toBe('challenge');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbScope'), 'installation');
        let draft = await saveDraft();
        expect(draft.scope).toBe('installation');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbScope'), 'challenge');
        draft = await saveDraft();
        expect(draft.scope).toBeUndefined();
    });

    test('an installation scenario offers no schedules, pins or pool, and no stage checkboxes', async () => {
        await renderBuilder({ initial: { ...doc(), scope: 'installation', phases: { main: {} } } });
        expect(screen.queryByText('app.sbScheduleAdd_submit')).toBeNull();
        expect(screen.queryByLabelText('app.sbPin_boost')).toBeNull();
        expect(screen.queryByLabelText('app.sbPhotoPool')).toBeNull();
        expect(screen.queryByText('app.sbStages')).toBeNull();
        expect(screen.getByText('app.sbInstallationNote')).toBeTruthy();
    });

    test('rule stage checkboxes write the stages, and the default set writes none', async () => {
        await renderBuilder({
            initial: {
                ...doc(),
                phases: {
                    main: { rules: [invalid({ id: 'r1', do: [{ type: 'notify', message: 'Check the challenge' }] })] },
                },
            },
        });
        // Only During challenge checked is the default: the document holds no stages.
        fireEvent.click(screen.getByLabelText('app.sbStage_preJoin'));
        let draft = await saveDraft();
        expect(draft.phases.main.rules?.[0].stages).toEqual(['preJoin', 'active']);
        fireEvent.click(screen.getByLabelText('app.sbStage_active'));
        fireEvent.click(screen.getByLabelText('app.sbStage_postClose'));
        draft = await saveDraft();
        expect(draft.phases.main.rules?.[0].stages).toEqual(['preJoin', 'postClose']);
        fireEvent.click(screen.getByLabelText('app.sbStage_active'));
        draft = await saveDraft();
        expect(draft.phases.main.rules?.[0].stages).toEqual(['preJoin', 'active', 'postClose']);
    });
});

describe('live values beside literals', () => {
    test('a binding edits the same key as a live value, named by its setting', async () => {
        const { mockTranslator } = jest.requireActual('./helpers/setup') as typeof import('./helpers/setup');
        const original = mockTranslator.t.getMockImplementation();
        mockTranslator.t.mockImplementation((key: string) =>
            key === 'app.exposure' ? 'Exposure' : key === 'app.theme' ? 'Theme' : key,
        );
        try {
            // A key the schema does not hold is named by its own translation.
            const first = await renderBuilder({
                initial: { ...doc(), scope: 'installation', phases: { main: {} } },
            });
            changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbAddBinding')[0], 'theme');
            expect(screen.getByText('Theme')).toBeTruthy();
            first.unmount();
            // A key the schema holds is named by its setting's own label.
            await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
            const picker = screen.getAllByLabelText<HTMLSelectElement>('app.sbAddBinding')[0];
            expect(within(picker).getByText('Exposure')).toBeTruthy();
            changeSelect(picker, 'exposure');
            expect(screen.getByText('Exposure')).toBeTruthy();
            changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[0], 'setting');
            const draft = await saveDraft();
            expect(draft.phases.main.bindings).toEqual({
                exposure: { kind: 'setting', key: 'exposure', view: 'base' },
            });
            expect(draft.phases.main.settings).toBeUndefined();
        } finally {
            mockTranslator.t.mockImplementation(original);
        }
    });

    test('a setSetting step holds a literal or a live value', async () => {
        await renderBuilder({
            initial: { ...doc(), phases: { main: { rules: [{ id: 'r1', do: [{ type: 'notify', message: 'Hi' }] }] } } },
        });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPickType'), 'setSetting');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbValueKind'), 'live');
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[0], 'setting');
        const draft = await saveDraft();
        expect(draft.phases.main.rules?.[0].do[0]).toEqual({
            type: 'setSetting',
            key: 'exposure',
            value: { kind: 'setting', key: 'exposure', view: 'base' },
        });
    });
});

describe('the dynamic submit schedule (issue 94)', () => {
    /** The nth kind select inside one schedule row (0 = the row's own value). */
    const rowEditor = (row: HTMLElement, n: number) =>
        within(row).getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[n];
    /** The select a field's group wrapper and its control both answer to. */
    const selectIn = (scope: HTMLElement, name: string) =>
        within(scope)
            .getAllByLabelText<HTMLSelectElement>(name)
            .filter((el) => el.tagName === 'SELECT')[0];
    const inputIn = (scope: HTMLElement, name: string) =>
        within(scope)
            .getAllByLabelText<HTMLInputElement>(name)
            .filter((el) => el.tagName === 'INPUT')
            .at(-1)!;

    test('the complete plan example is built without JSON', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAdd_submit' }));
        // Row one: the earlier of two offsets.
        const row = (n: number) =>
            screen
                .getAllByRole('button', { name: `app.sbScheduleRemoveRow_submit: ${n}` })
                .at(0)!
                .closest('div')!;
        changeSelect(rowEditor(row(1), 0), 'earlier');
        // Operand one: challenge.end minus 10 hours. After it becomes an offset its own editors take the
        // row's kind-select indexes 1 to 3, so the second operand's kind select is the last one in the row.
        changeSelect(rowEditor(row(1), 1), 'offset');
        changeSelect(selectIn(row(1), 'app.sbField_name'), 'challenge.end');
        changeInput(inputIn(row(1), 'app.sbField_value'), '10');
        // Operand two: the free Boost expiry minus 1 hour.
        changeSelect(within(row(1)).getAllByLabelText<HTMLSelectElement>('app.sbExprKind').at(-1)!, 'offset');
        changeSelect(
            within(row(1)).getAllByLabelText<HTMLSelectElement>('app.sbField_name').at(-1)!,
            'boost.freeExpiry',
        );
        changeInput(inputIn(row(1), 'app.sbField_value'), '1');
        changeSelect(selectIn(row(1), 'app.sbScheduleCount'), '2');
        // Rows two and three: challenge.end minus 9 and 8 hours.
        for (const [hours, count] of [
            [9, 3],
            [8, 4],
        ] as const) {
            fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAddRow_submit' }));
            const at = row(count - 1);
            changeSelect(rowEditor(at, 0), 'offset');
            changeSelect(selectIn(at, 'app.sbField_name'), 'challenge.end');
            changeInput(inputIn(at, 'app.sbField_value'), String(hours));
            changeSelect(selectIn(at, 'app.sbScheduleCount'), String(count));
        }
        const draft = await saveDraft();
        const hours = (n: number) => ({ kind: 'literal', value: n, quantity: 'duration', unit: 'hours' });
        const before = (name: string, n: number) => ({
            kind: 'offset',
            from: { kind: 'fact', name },
            by: hours(n),
            direction: 'before',
        });
        expect(draft.phases.main.schedules).toEqual({
            submit: {
                alignment: 'end',
                rows: [
                    {
                        count: 2,
                        at: { kind: 'earlier', of: [before('challenge.end', 10), before('boost.freeExpiry', 1)] },
                    },
                    { count: 3, at: before('challenge.end', 9) },
                    { count: 4, at: before('challenge.end', 8) },
                ],
            },
        });
    });

    test('a schedule takes its setting out of the pickers', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAdd_submit' }));
        const picker = screen.getAllByLabelText<HTMLSelectElement>('app.sbAddSetting')[0];
        expect(within(picker).queryByText('app.autoSubmitSchedule')).toBeNull();
    });
});

describe('photo pool', () => {
    test('binds an existing pool, and creates a new one before binding it', async () => {
        window.api.createPhotoPool = jest.fn().mockResolvedValue({ success: true });
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), 'Beach');
        fireEvent.click(screen.getByLabelText('app.sbPoolOnly'));
        let draft = await saveDraft();
        expect(draft.phases.main.photoPool).toEqual({ name: 'Beach', only: true });
        draft.phases.main.photoPool = undefined;
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), '__new');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolName'), 'Sunsets');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolPhotos'), 'p9, p10');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await waitFor(() => expect(window.api.createPhotoPool).toHaveBeenCalledWith('Sunsets', ['p9', 'p10']));
        // The pool is bound once it is known to exist (the list is read again first): the create form is gone by then.
        await waitFor(() => expect(screen.queryByLabelText('app.sbPoolName')).toBeNull());
        jest.mocked(window.api.saveScenario).mockClear();
        draft = await saveDraft();
        expect(draft.phases.main.photoPool).toEqual({ name: 'Sunsets' });
    });

    test('a pool the phase already draws from reads back', async () => {
        await renderBuilder({
            initial: { ...doc(), phases: { main: { photoPool: { name: 'Beach', inOrder: true } } } },
        });
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool').value).toBe('Beach');
        expect(screen.getByLabelText<HTMLInputElement>('app.sbPoolInOrder').checked).toBe(true);
    });
});

describe('capability catalogue', () => {
    test('every class is listed, and a user-only key says its restriction instead of an add button', async () => {
        const { mockTranslator } = jest.requireActual('./helpers/setup') as typeof import('./helpers/setup');
        const original = mockTranslator.t.getMockImplementation();
        mockTranslator.t.mockImplementation((key: string) => (key === 'app.manualPhotosOnly' ? 'Manual only' : key));
        try {
            await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
            fireEvent.click(screen.getByRole('tab', { name: 'app.sbTabKeys' }));
            expect(await screen.findByText('app.sbClass_challengePolicy')).toBeTruthy();
            expect(screen.getByText('app.sbClass_appPreference')).toBeTruthy();
            expect(screen.getByText('app.sbClass_lifecycleControl')).toBeTruthy();
            // The reason is the app's own wording, never the backend's English text.
            expect(screen.getByText(/app\.sbRestriction_manualPhotosOnly/)).toBeTruthy();
            expect(screen.queryByText(/A phase cannot change Manual Only/)).toBeNull();
            expect(screen.getAllByText(/app\.sbRead_projection/).length).toBeGreaterThan(0);
            expect(screen.getAllByText(/app\.sbUserOnly/).length).toBeGreaterThan(0);
            expect(screen.getByText(/^Manual only/)).toBeTruthy();
        } finally {
            mockTranslator.t.mockImplementation(original);
        }
    });

    test('the phase pickers never offer a key a phase cannot write', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        const picker = screen.getAllByLabelText<HTMLSelectElement>('app.sbAddSetting')[0];
        expect(within(picker).queryByText('app.manualPhotosOnly')).toBeNull();
        expect(within(picker).queryByText('app.notifyOnBoost')).toBeNull();
    });
});

describe('simulate', () => {
    const response = (patch: Record<string, unknown> = {}) =>
        invalid<Awaited<ReturnType<typeof window.api.simulateScenario>>>({
            success: true,
            events: [],
            assumptions: {},
            diagnostics: [],
            deadlines: [],
            finalState: null,
            needs: null,
            passes: [],
            stoppedAt: 1,
            stopReason: 'idle',
            halted: null,
            manualOnly: false,
            ...patch,
        });
    const untilSeconds = () => Math.floor(new Date(UNTIL).getTime() / 1000);

    const run = async () => {
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbSimulateUntil'), UNTIL);
        click('app.sbSimulate');
    };

    test.each(['candidate', 'active', 'completed'] as const)(
        'a challenge scenario lists and picks a %s subject and runs to the given horizon',
        async (kind) => {
            jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(response());
            await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
            changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateKind'), kind);
            await waitFor(() => expect(window.api.listSimulationSubjects).toHaveBeenCalledWith(kind));
            const picker = await screen.findByLabelText<HTMLSelectElement>('app.sbSimulateOn');
            await waitFor(() => expect(within(picker).getByText('Show')).toBeTruthy());
            expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSimulate' }).disabled).toBe(true);
            changeSelect(picker, '7');
            await run();
            await waitFor(() => expect(window.api.simulateScenario).toHaveBeenCalled());
            expect(window.api.simulateScenario).toHaveBeenCalledWith(
                expect.objectContaining({
                    scenario: { draft: expect.objectContaining({ name: 'Plan' }) },
                    subject: { kind, challengeId: '7' },
                    until: untilSeconds(),
                }),
            );
        },
    );

    test('an installation scenario runs on this installation with no challenge picker', async () => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(response());
        await renderBuilder({ initial: { ...doc(), scope: 'installation', phases: { main: {} } } });
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateKind').value).toBe('installation');
        expect(screen.queryByLabelText('app.sbSimulateOn')).toBeNull();
        await run();
        await waitFor(() =>
            expect(window.api.simulateScenario).toHaveBeenCalledWith(
                expect.objectContaining({ subject: { kind: 'installation' }, until: untilSeconds() }),
            ),
        );
    });

    test('a time already behind us is no horizon: the run stays off and the reason says what to do', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbSimulateUntil'), futureLocal(-2));
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSimulate' }).disabled).toBe(true);
        expect(screen.getByText('app.scenarioRefusal_untilInPast')).toBeTruthy();
    });

    test('an empty horizon says nothing yet, and a good one clears the reason', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        expect(screen.queryByText('app.scenarioRefusal_untilInPast')).toBeNull();
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbSimulateUntil'), futureLocal(-2));
        expect(screen.getByText('app.scenarioRefusal_untilInPast')).toBeTruthy();
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbSimulateUntil'), UNTIL);
        expect(screen.queryByText('app.scenarioRefusal_untilInPast')).toBeNull();
    });

    test('the run checks its inputs again: a horizon that went by since the button was on sends nothing', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbSimulateUntil'), UNTIL);
        const button = screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSimulate' });
        expect(button.disabled).toBe(false);
        const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 86_400_000);
        try {
            fireEvent.click(button);
            await Promise.resolve();
        } finally {
            now.mockRestore();
        }
        expect(window.api.simulateScenario).not.toHaveBeenCalled();
    });

    test('a slow list for a kind the user has left never replaces the list of the kind they are on', async () => {
        let releaseOld!: () => void;
        const oldHeld = new Promise<void>((resolve) => {
            releaseOld = resolve;
        });
        jest.mocked(window.api.listSimulationSubjects).mockImplementation(async (kind) => {
            if (kind === 'candidate') {
                await oldHeld;
                return invalid({ success: true, readable: true, subjects: [{ id: '7', label: 'Old candidate' }] });
            }
            return invalid({ success: true, readable: true, subjects: [{ id: '9', label: 'Active one' }] });
        });
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateKind'), 'active');
        const picker = await screen.findByLabelText<HTMLSelectElement>('app.sbSimulateOn');
        await waitFor(() => expect(within(picker).getByText('Active one')).toBeTruthy());
        releaseOld();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(
            within(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn')).queryByText('Old candidate'),
        ).toBeNull();
        expect(
            within(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn')).getByText('Active one'),
        ).toBeTruthy();
    });

    test.each([
        ['until-in-past', 'app.scenarioRefusal_untilInPast'],
        ['simulation-busy', 'app.scenarioRefusal_busy'],
        ['invalid-assumptions', 'app.scenarioRefusal_invalidAssumptions'],
    ])('a run refused with %s says its reason, though it carries no issues', async (code, wording) => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(invalid({ success: false, error: code }));
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        await run();
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('app.sbSimulateFailed');
        expect(alert.textContent).toContain(wording);
    });

    test.each([
        ['horizon', 'app.sbStop_horizon'],
        ['idle', 'app.sbStop_idle'],
        ['needsEvidence', 'app.sbStop_needsEvidence'],
        ['halted', 'app.sbStop_halted'],
        ['limit', 'app.sbStop_limit'],
    ])('a run that stopped on %s says its own reason', async (stopReason, key) => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(response({ stopReason }));
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        await run();
        expect(await screen.findByText(key)).toBeTruthy();
    });

    test.each([
        ['timezone-unavailable', 'app.sbHalted_timezone'],
        ['simulation-isolation-breached', 'app.sbHalted_isolation'],
        ['phase main: exposure: something odd', 'app.sbHalted_other'],
    ])('a halt for %s is worded, and its own text is never shown', async (halted, key) => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(response({ stopReason: 'halted', halted }));
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        await run();
        expect(await screen.findByText(key)).toBeTruthy();
        expect(screen.queryByText(halted)).toBeNull();
    });

    test('every value a run used reads in plain words: its name, its value and where it came from', async () => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(
            response({
                diagnostics: [
                    { key: 'scenario', value: 'Plan', provenance: 'draft' },
                    { key: 'subject', value: 'installation', provenance: 'installation' },
                    { key: 'timezone', value: 'Europe/Riga', provenance: 'installation setting' },
                    { key: 'start', value: 1_800_000_000, provenance: 'clock when the request was made' },
                    { key: 'until', value: 1_800_100_000, provenance: 'request' },
                    { key: 'bankroll', value: 'read', provenance: 'account read before the run' },
                    { key: 'bankroll', value: 'unknown', provenance: 'read failed; not assumed' },
                    {
                        key: 'progress',
                        value: 'main',
                        provenance: 'assumed: the challenge ran under this scenario from its start phase',
                    },
                    { key: 'subject', value: '7', provenance: 'active-list' },
                    { key: 'subject', value: '8', provenance: 'open-list' },
                    { key: 'subject', value: '9', provenance: 'completed-list' },
                    { key: 'scenario', value: 'Plan', provenance: 'saved scenario' },
                    { key: 'mystery', value: 4, provenance: 'somewhere else' },
                ],
            }),
        );
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        await run();
        await screen.findByText('app.sbDiagnostics');
        const text = screen.getByText('app.sbDiagnostics').parentElement!.textContent!;
        for (const part of [
            'app.sbDiagKey_scenario: Plan (app.sbDiagFrom_draft)',
            'app.sbDiagKey_subject: app.sbStage_account (app.sbDiagFrom_installation)',
            'app.sbDiagKey_timezone: Europe/Riga (app.sbDiagFrom_setting)',
            `app.sbDiagKey_start: ${new Date(1_800_000_000 * 1000).toLocaleString()} (app.sbDiagFrom_clock)`,
            `app.sbDiagKey_until: ${new Date(1_800_100_000 * 1000).toLocaleString()} (app.sbDiagFrom_request)`,
            'app.sbDiagKey_bankroll: app.sbDiagValue_read (app.sbDiagFrom_account)',
            'app.sbDiagKey_bankroll: app.sbDiagValue_unknown (app.sbDiagFrom_readFailed)',
            'app.sbDiagKey_progress: main (app.sbDiagFrom_assumedStart)',
            'app.sbDiagKey_subject: 7 (app.sbDiagFrom_active)',
            'app.sbDiagKey_subject: 8 (app.sbDiagFrom_open)',
            'app.sbDiagKey_subject: 9 (app.sbDiagFrom_completed)',
            'app.sbDiagKey_scenario: Plan (app.sbDiagFrom_saved)',
            'app.sbDiagKey_other: 4 (app.sbDiagFrom_other)',
        ]) {
            expect(text).toContain(part);
        }
        expect(text).not.toContain('somewhere else');
    });

    test('an operation the app names reads by its name, with how it went', async () => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(
            response({
                events: [
                    invalid({
                        type: 'operation',
                        at: 1,
                        subject: '7',
                        operation: 'submit',
                        outcome: 'refused',
                        applied: true,
                    }),
                ],
            }),
        );
        const { mockTranslator, fillTemplate } = jest.requireActual(
            './helpers/setup',
        ) as typeof import('./helpers/setup');
        const original = mockTranslator.t.getMockImplementation();
        const words: Record<string, string> = {
            'app.sbEventOperation': '{operation} went {outcome}',
            'app.sbAssumed_submit': 'Submitting a photo',
            'app.sbOutcome_refused': 'wrong',
        };
        mockTranslator.t.mockImplementation((key: string, vars?: Record<string, string | number | null | undefined>) =>
            fillTemplate(words[key] ?? key, vars),
        );
        try {
            await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
            changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
            await run();
            expect(await screen.findByText(/Submitting a photo went wrong/)).toBeTruthy();
        } finally {
            mockTranslator.t.mockImplementation(original);
        }
    });

    test('every notice shows as it was written, a halt-looking one included; the halt is the result’s own signal', async () => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(
            response({
                events: [
                    invalid({ type: 'notice', at: 1, subject: '7', message: 'Halted: Check the light', applied: true }),
                    invalid({ type: 'notice', at: 2, subject: '7', message: 'Check the boost', applied: true }),
                ],
                stopReason: 'idle',
                halted: null,
            }),
        );
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        await run();
        expect(await screen.findByText(/Halted: Check the light/)).toBeTruthy();
        expect(screen.getByText(/Check the boost/)).toBeTruthy();
        // No halt was signalled, so none is shown.
        expect(screen.queryByText('app.sbHalted_other')).toBeNull();
        expect(screen.getByText('app.sbStop_idle')).toBeTruthy();
    });

    test('no run until the subject, horizon and any assumption are valid', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSimulate' }).disabled).toBe(true);
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbSimulateUntil'), UNTIL);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSimulate' }).disabled).toBe(true);
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSimulate' }).disabled).toBe(false);
    });

    test('a failed subject list says so and retries; an empty list says there is nothing to show', async () => {
        jest.mocked(window.api.listSimulationSubjects)
            .mockResolvedValueOnce(invalid({ success: true, readable: false, subjects: [] }))
            .mockResolvedValueOnce(
                invalid({ success: true, readable: true, subjects: [invalid({ id: '7', label: 'Show' })] }),
            )
            .mockResolvedValue(invalid({ success: true, readable: true, subjects: [] }));
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        expect(await screen.findByText('app.sbSubjectsFailed')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'app.sbSubjectsRetry' }));
        const picker = await screen.findByLabelText<HTMLSelectElement>('app.sbSimulateOn');
        await waitFor(() => expect(within(picker).getByText('Show')).toBeTruthy());
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateKind'), 'completed');
        await waitFor(() => expect(screen.getByText('app.sbNoSubjects')).toBeTruthy());
        expect(screen.queryByLabelText('app.sbSimulateOn')).toBeNull();
    });

    test('explicit assumptions travel with the request and come back in the result', async () => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(
            response({ assumptions: { outcomes: { submit: 'refused' } }, stopReason: 'needsEvidence' }),
        );
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbAssume_submit'), 'refused');
        await run();
        await screen.findByText('app.sbSimulateNothing');
        expect(window.api.simulateScenario).toHaveBeenCalledWith(
            expect.objectContaining({ assumptions: { outcomes: { submit: 'refused' } } }),
        );
        expect(screen.getByText(/app\.sbStop_needsEvidence/)).toBeTruthy();
        // A result that carries no assumed answers at all shows no echo of any.
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(
            invalid({
                success: true,
                events: [],
                diagnostics: [],
                deadlines: [],
                finalState: null,
                needs: null,
                passes: [],
                stoppedAt: 1,
                stopReason: 'idle',
                halted: null,
            }),
        );
        await run();
        await waitFor(() => expect(screen.queryByText('app.sbAssumedList')).toBeNull());
    });

    test('the result shows events, deadlines, diagnostics, the needed outcome and the assumptions', async () => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(
            response({
                events: [{ type: 'rule', at: 1_800_000_000, subject: '7', phase: 'main', ruleId: 'r1', applied: true }],
                deadlines: [
                    { kind: 'submit', count: 2, at: 1_799_964_000 },
                    { kind: 'vote', start: null, end: 1_799_900_000 },
                ],
                diagnostics: [invalid({ key: 'exposure', value: 10, provenance: 'phase main' })],
                needs: invalid({ operation: 'submit', subject: '7', at: 5 }),
                assumptions: { outcomes: { submit: 'success' } },
                stopReason: 'needsEvidence',
            }),
        );
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbAssume_submit'), 'success');
        await run();
        await screen.findByText(/\[main\] r1/);
        expect(screen.getByText(/app\.sbDeadline_submit/)).toBeTruthy();
        expect(screen.getByText(/app\.sbNeeds/)).toBeTruthy();
        expect(screen.getByText(/app\.sbDiagKey_other: 10 \(app\.sbDiagFrom_other\)/)).toBeTruthy();
        expect(screen.getByText(/app\.sbAssumed_submit/)).toBeTruthy();
    });

    test('a Manual Only challenge keeps the timeline and says it is paused; a plain one does not', async () => {
        jest.mocked(window.api.simulateScenario)
            .mockResolvedValueOnce(response({ manualOnly: true }))
            .mockResolvedValueOnce(response({ manualOnly: false }));
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        await run();
        await screen.findByText('app.sbSimulatePausedManual');
        expect(screen.getByText('app.sbSimulateNothing')).toBeTruthy();
        await run();
        await waitFor(() => expect(screen.queryByText('app.sbSimulatePausedManual')).toBeNull());
    });

    test('a failed run shows its problems; a challenge whose data cannot be read words its own next step', async () => {
        jest.mocked(window.api.simulateScenario)
            .mockResolvedValueOnce(invalid({ success: false, issues: [{ path: 'start', message: 'No phase' }] }))
            .mockResolvedValueOnce(invalid({ success: false, error: 'challenge-data-incomplete' }));
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        await run();
        expect((await screen.findByRole('alert')).textContent).toContain('app.sbSimulateFailed');
        await run();
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('app.sbSimulateDataIncomplete');
        expect(alert.textContent).toContain('app.scenarioErrorNextRefresh');
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

    test('a refused save with a reason code words the reason', async () => {
        window.api.saveScenario = invalid(jest.fn(async () => ({ success: false, error: 'unresolved-work' })));
        await renderBuilder();
        click('app.sbSave');
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('app.scenarioRefusal_unresolvedWork');
    });

    test('a rename that landed before a refused save says both facts, and the list learns the new name', async () => {
        window.api.saveScenario = jest
            .fn()
            .mockResolvedValueOnce({ success: false, issues: [{ path: '', message: 'disk full' }] })
            .mockResolvedValueOnce({ success: true, name: 'New' });
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        click('app.sbSave');
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('status').textContent).toBe('app.sbRenamedNotSaved');
        expect(onRenamed).toHaveBeenCalledWith('New');
        expect(onSaved).not.toHaveBeenCalled();
        // A retry saves without renaming again, and the partial warning goes when the save lands.
        click('app.sbSave');
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(window.api.renameScenario).toHaveBeenCalledTimes(1);
        expect(window.api.saveScenario).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'New' }), {
            overwrite: true,
            expectedDefinitionRevision: 6,
        });
        expect(screen.queryByRole('status')).toBeNull();
    });

    const lost = (requestId: string) => invalid({ success: false, error: 'lost', unclear: true, requestId });
    const recorded = (status: string, error: string | null = null) =>
        invalid<Awaited<ReturnType<typeof window.api.getScenarioRequestStatus>>>({
            success: true,
            state: 'request',
            record: { requestId: 'req-1', operation: 'o', target: 'definitions', status, error, revision: 1, at: 1 },
        });

    test('a lost reply to the rename is checked, never sent again; found applied, the save goes on under the new name and revision', async () => {
        window.api.renameScenario = invalid(jest.fn(async () => lost('req-1')));
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        click('app.sbSave');
        await screen.findByText('app.effectUnclear');
        // Nothing more is sent while the rename has no answer: not the save, not the rename again.
        expect(window.api.saveScenario).not.toHaveBeenCalled();
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSave' }).disabled).toBe(true);
        click('app.sbSave');
        expect(window.api.renameScenario).toHaveBeenCalledTimes(1);
        window.api.getScenarioRequestStatus = jest.fn().mockResolvedValueOnce(recorded('applied'));
        click('app.effectCheckStatus');
        await waitFor(() => expect(screen.queryByText('app.effectUnclear')).toBeNull());
        // The rename landed: the list learns the new name, and both facts are said.
        expect(onRenamed).toHaveBeenCalledWith('New');
        expect(screen.getByRole('status').textContent).toBe('app.sbRenamedNotSaved');
        click('app.sbSave');
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(window.api.renameScenario).toHaveBeenCalledTimes(1);
        expect(window.api.saveScenario).toHaveBeenCalledWith(expect.objectContaining({ name: 'New' }), {
            overwrite: true,
            expectedDefinitionRevision: 6,
        });
    });

    test('a rename whose check says it failed shows why, and the next save asks for the rename afresh', async () => {
        window.api.renameScenario = invalid(jest.fn(async () => lost('req-1')));
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        click('app.sbSave');
        await screen.findByText('app.effectUnclear');
        window.api.getScenarioRequestStatus = jest.fn().mockResolvedValueOnce(recorded('failed', 'conflict'));
        click('app.effectCheckStatus');
        expect((await screen.findByRole('alert')).textContent).toContain('app.scenarioRefusal_conflict');
        expect(onRenamed).not.toHaveBeenCalled();
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSave' }).disabled).toBe(false);
        click('app.sbSave');
        await waitFor(() => expect(window.api.renameScenario).toHaveBeenCalledTimes(2));
    });

    test('giving up on an unconfirmed rename frees Save', async () => {
        window.api.renameScenario = invalid(jest.fn(async () => lost('req-1')));
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        click('app.sbSave');
        await screen.findByText('app.effectUnclear');
        click('errors.dismiss');
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSave' }).disabled).toBe(false);
        expect(onRenamed).not.toHaveBeenCalled();
    });

    test('a lost reply to the save is checked; found applied, the builder closes as saved', async () => {
        window.api.saveScenario = invalid(jest.fn(async () => lost('req-1')));
        await renderBuilder();
        click('app.sbSave');
        await screen.findByText('app.effectUnclear');
        expect(onSaved).not.toHaveBeenCalled();
        click('app.sbSave');
        expect(window.api.saveScenario).toHaveBeenCalledTimes(1);
        window.api.getScenarioRequestStatus = jest.fn().mockResolvedValueOnce(recorded('applied'));
        click('app.effectCheckStatus');
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
    });

    test('a save held by the Android service waits for its check too', async () => {
        window.api.saveScenario = invalid(
            jest.fn(async () => ({
                success: true,
                pending: true,
                requestId: 'app-1',
                target: 'definitions',
                revision: 2,
            })),
        );
        await renderBuilder();
        click('app.sbSave');
        await screen.findByText('app.effectQueued');
        expect(onSaved).not.toHaveBeenCalled();
    });

    test('a lost reply to the save after a rename keeps both facts on screen', async () => {
        window.api.saveScenario = invalid(jest.fn(async () => lost('req-2')));
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        click('app.sbSave');
        await screen.findByText('app.effectUnclear');
        expect(screen.getAllByRole('status').map((node) => node.textContent)).toContain('app.sbRenamedNotSaved');
        expect(onRenamed).toHaveBeenCalledWith('New');
    });

    test.each([
        ['conflict', 'app.scenarioRefusal_conflict'],
        ['revision-unreadable', 'app.scenarioRefusal_revisionUnreadable'],
    ])('a save refused with %s says its own next step', async (code, wording) => {
        window.api.saveScenario = invalid(jest.fn(async () => ({ success: false, error: code })));
        await renderBuilder();
        click('app.sbSave');
        expect((await screen.findByRole('alert')).textContent).toContain(wording);
    });

    test('a rename refused with a revision code says its own next step', async () => {
        window.api.renameScenario = invalid(jest.fn(async () => ({ success: false, error: 'conflict' })));
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        click('app.sbSave');
        expect((await screen.findByRole('alert')).textContent).toContain('app.scenarioRefusal_conflict');
        expect(window.api.saveScenario).not.toHaveBeenCalled();
    });

    test('a save whose answer never came shows the plain failure', async () => {
        window.api.saveScenario = jest.fn(() => Promise.reject(new Error('gone')));
        await renderBuilder();
        click('app.sbSave');
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('app.sbSaveFailed');
        expect(alert.textContent).not.toContain('app.scenarioIssueGeneric');
    });

    test('a refused rename shows no partial warning', async () => {
        window.api.renameScenario = invalid(
            jest.fn(async () => ({ success: false, issues: [{ path: 'name', message: 'taken' }] })),
        );
        await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'Other' } });
        click('app.sbSave');
        expect((await screen.findByRole('alert')).textContent).toContain('app.scenarioIssueGeneric');
        expect(screen.queryByRole('status')).toBeNull();
        expect(onRenamed).not.toHaveBeenCalled();
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

describe('phase holdings and catalogue edges', () => {
    test('a pin keeps the saved one, drops it, or names a photo', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPin_boost'), 'photo');
        changeInput(screen.getAllByLabelText<HTMLInputElement>('app.sbPinPhoto')[0], 'p7');
        let draft = await saveDraft();
        expect(draft.phases.main.pins).toEqual({ boost: 'p7' });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPin_turbo'), 'none');
        draft = await saveDraft();
        expect(draft.phases.main.pins).toEqual({ boost: 'p7', turbo: null });
    });

    test('a pool that is gone says so, and a refused create keeps the form open with its reason', async () => {
        window.api.createPhotoPool = jest.fn().mockResolvedValue(invalid({ success: false, error: 'invalid' }));
        await renderBuilder({ initial: { ...doc(), phases: { main: { photoPool: { name: 'Gone' } } } } });
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool').value).toBe('__gone');
        expect(screen.getByText('app.sbPoolGone')).toBeTruthy();
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), '__new');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolName'), 'Sunsets');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolPhotos'), 'p1');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        expect(await screen.findByText(/app\.scenarioRefusal_invalid/)).toBeTruthy();
        // The form stays open: nothing was bound.
        await waitFor(() =>
            expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSave' }).disabled).toBe(false),
        );
        const draft = await saveDraft();
        expect(draft.phases.main.photoPool).toEqual({ name: 'Gone' });
    });

    test('a catalogue that cannot be read says so', async () => {
        jest.mocked(window.api.getScenarioCapabilities).mockResolvedValue(
            invalid({
                success: true,
                capabilities: {
                    settings: [],
                    remoteEnabled: invalid({
                        disposition: 'lifecycleControl',
                        read: 'projection',
                        phaseWrite: [],
                        owner: 'authentication',
                        value: { kind: 'boolean' },
                    }),
                },
            }),
        );
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fireEvent.click(screen.getByRole('tab', { name: 'app.sbTabKeys' }));
        expect(await screen.findByText('app.sbCatalogueFailed')).toBeTruthy();
    });

    test('an installation scenario picks a key with no schema entry and edits its literal', async () => {
        await renderBuilder({ initial: { ...doc(), scope: 'installation', phases: { main: {} } } });
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbAddSetting')[0], 'language');
        const draft = await saveDraft();
        expect(draft.phases.main.settings).toEqual({ language: 'en' });
    });

    test('the stop mapping covers the horizon and the halt note', async () => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(
            invalid({
                success: true,
                events: [
                    invalid({
                        type: 'operation',
                        at: 1,
                        subject: '7',
                        operation: 'submitToChallenge',
                        outcome: 'success',
                        applied: true,
                    }),
                    invalid({ type: 'phase', at: 2, subject: '7', from: 'main', to: 'later', applied: true }),
                    invalid({
                        type: 'published',
                        at: 3,
                        subject: '7',
                        phase: 'later',
                        validUntil: null,
                        applied: true,
                    }),
                    invalid({ type: 'notice', at: 4, subject: '7', message: 'Hold on', applied: true }),
                    invalid({ type: 'preview', at: 5, subject: '7', reason: 'next-wake', applied: false }),
                ],
                assumptions: {},
                diagnostics: [],
                deadlines: [invalid({ kind: 'publication', validUntil: 1_800_000_000 })],
                finalState: null,
                needs: null,
                passes: [],
                stoppedAt: 1,
                stopReason: 'horizon',
                halted: 'Phase gone',
            }),
        );
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbSimulateUntil'), UNTIL);
        click('app.sbSimulate');
        expect(await screen.findByText('app.sbStop_horizon')).toBeTruthy();
        expect(screen.getByText('app.sbDeadline_publication')).toBeTruthy();
        // The halt reason is worded, never printed as written; an operation the app has no name for is a request.
        expect(screen.getByText('app.sbHalted_other')).toBeTruthy();
        expect(screen.queryByText('Phase gone')).toBeNull();
        expect(screen.queryByText(/submitToChallenge/)).toBeNull();
        expect(screen.getByText(/app\.sbEventOperation/)).toBeTruthy();
        // An event that was previewed, not run, is shown and says so.
        expect(screen.getByText(/app\.sbEventPreview/).textContent).toContain('app.sbEventNotRun');
        expect(screen.getByText(/app\.sbToPhase/)).toBeTruthy();
        expect(screen.getByText(/\[later\]/)).toBeTruthy();
        expect(screen.getByText(/Hold on/)).toBeTruthy();
    });

    test('an unreadable list of subjects keeps the horizon valid and the run off', async () => {
        jest.mocked(window.api.listSimulationSubjects).mockResolvedValue(
            invalid({ success: true, readable: false, subjects: [] }),
        );
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        await screen.findByText('app.sbSubjectsFailed');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbSimulateUntil'), UNTIL);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSimulate' }).disabled).toBe(true);
    });
});

describe('literal kinds of the overlay and bindings', () => {
    test('every descriptor kind picks a binding and a literal of its own', async () => {
        await renderBuilder({ initial: { ...doc(), scope: 'installation', phases: { main: {} } } });
        const addSetting = () => screen.getAllByLabelText<HTMLSelectElement>('app.sbAddSetting')[0];
        const addBinding = () => screen.getAllByLabelText<HTMLSelectElement>('app.sbAddBinding')[0];
        changeSelect(addSetting(), 'language');
        changeSelect(addSetting(), 'theme');
        changeSelect(addSetting(), 'customTimezones');
        // A bound key leaves the literal pickers and a literal key the binding picker.
        changeSelect(addSetting(), 'checkFrequencyMin');
        changeSelect(addSetting(), 'snapYesWithoutModel');
        changeSelect(addBinding(), 'notifyOnBoost');
        // The literal of a key with no schema entry is edited by its descriptor's own control.
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('language').at(-1) as HTMLSelectElement, 'lv');
        const draft = await saveDraft();
        expect(draft.phases.main.settings).toEqual({
            language: 'lv',
            theme: '',
            customTimezones: [],
            checkFrequencyMin: 0,
            snapYesWithoutModel: false,
        });
        expect(Object.keys(draft.phases.main.bindings ?? {})).toEqual(['notifyOnBoost']);
    });

    test('a binding row is removed, and stage checkboxes return to the default', async () => {
        await renderBuilder({
            initial: {
                ...doc(),
                phases: {
                    main: {
                        bindings: { exposure: { kind: 'setting', key: 'exposure', view: 'base' } },
                        rules: [{ id: 'r1', do: [{ type: 'notify', message: 'Hi' }] }],
                    },
                },
            },
        });
        fireEvent.click(screen.getByRole('button', { name: 'app.sbRemove: app.exposure' }));
        fireEvent.click(screen.getByLabelText('app.sbStage_preJoin'));
        fireEvent.click(screen.getByLabelText('app.sbStage_postClose'));
        // The last checked stage stays on, and unchecking back to only During challenge writes no stages.
        fireEvent.click(screen.getByLabelText('app.sbStage_preJoin'));
        const stillTwo = screen.getByLabelText<HTMLInputElement>('app.sbStage_postClose');
        fireEvent.click(stillTwo);
        const draft = await saveDraft();
        expect(draft.phases.main.bindings).toEqual({});
        expect((draft.phases.main.rules ?? [])[0].stages).toBeUndefined();
    });

    test('a pool is cleared from the phase, and the gone option comes back from the new-pool form', async () => {
        window.api.createPhotoPool = jest.fn().mockResolvedValue({ success: true });
        await renderBuilder({ initial: { ...doc(), phases: { main: { photoPool: { name: 'Gone' } } } } });
        let draft = await saveDraft();
        expect(draft.phases.main.photoPool).toEqual({ name: 'Gone' });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), '');
        draft = await saveDraft();
        expect(draft.phases.main.photoPool).toBeUndefined();
    });
});

test('a phase with an empty schedules object offers every schedule, and a kind is removed whole', async () => {
    await renderBuilder({ initial: { ...doc(), phases: { main: { schedules: {} } } } });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbScheduleAdd_submit' }).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAdd_vote' }));
    expect(screen.getByText('app.sbSchedule_vote')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'app.sbRemove: app.sbSchedule_vote' }));
    const draft = await saveDraft();
    expect(draft.phases.main.schedules).toBeUndefined();
});

describe('photo pool reads', () => {
    test('a failed pool read leaves nothing to bind but a new pool', async () => {
        jest.mocked(window.api.getPhotoPools).mockResolvedValueOnce(invalid({ success: false, error: 'x' }));
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        const picker = await screen.findByLabelText<HTMLSelectElement>('app.sbPhotoPool');
        expect(within(picker).queryByText(/Beach/)).toBeNull();
        expect(within(picker).getByText('app.sbPoolNew')).toBeTruthy();
    });

    test('an unchecking of the in-order flag takes the flag out', async () => {
        await renderBuilder({
            initial: { ...doc(), phases: { main: { photoPool: { name: 'Beach', inOrder: true } } } },
        });
        fireEvent.click(screen.getByLabelText('app.sbPoolInOrder'));
        const draft = await saveDraft();
        expect(draft.phases.main.photoPool).toEqual({ name: 'Beach' });
    });
});

test('bound keys of every value kind read as live values', async () => {
    await renderBuilder({
        initial: {
            ...doc(),
            scope: 'installation',
            phases: {
                main: {
                    bindings: {
                        theme: { kind: 'literal', value: 'nord' },
                        customTimezones: { kind: 'literal', value: [] },
                    },
                },
            },
        },
    });
    expect(screen.getAllByLabelText('app.sbExprKind').length).toBeGreaterThan(0);
    const draft = await saveDraft();
    expect(draft.phases.main.bindings).toEqual({
        theme: { kind: 'literal', value: 'nord' },
        customTimezones: { kind: 'literal', value: [] },
    });
});

describe('the small edges of the holdings and the run', () => {
    test('a pin goes back to the saved one, and the only-flag comes off', async () => {
        await renderBuilder({
            initial: {
                ...doc(),
                phases: { main: { pins: { boost: 'p1' }, photoPool: { name: 'Beach', only: true } } },
            },
        });
        changeSelect(
            screen.getAllByLabelText<HTMLSelectElement>('app.sbPin_boost').filter((el) => el.tagName === 'SELECT')[0],
            'keep',
        );
        fireEvent.click(screen.getByLabelText('app.sbPoolOnly'));
        const draft = await saveDraft();
        expect(draft.phases.main.pins).toBeUndefined();
        expect(draft.phases.main.photoPool).toEqual({ name: 'Beach' });
    });

    test('creating a pool another one already holds (even in another case) refuses and keeps the form open', async () => {
        window.api.createPhotoPool = jest.fn().mockResolvedValue(invalid({ success: false, error: 'exists' }));
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), '__new');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolName'), 'beach');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolPhotos'), 'p1');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        expect(await screen.findByText(/app\.scenarioRefusal_poolExists/)).toBeTruthy();
        expect(window.api.createPhotoPool).toHaveBeenCalledWith('beach', ['p1']);
        // The create is final (refused), so it no longer holds Save.
        await waitFor(() =>
            expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSave' }).disabled).toBe(false),
        );
        const draft = await saveDraft();
        expect(draft.phases.main.photoPool).toBeUndefined();
    });

    test('a lost reply to creating a pool blocks a second create; found applied, the pool is bound', async () => {
        window.api.createPhotoPool = jest
            .fn()
            .mockResolvedValue(invalid({ success: false, error: 'lost', unclear: true, requestId: 'req-p' }));
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), '__new');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolName'), 'Sunsets');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolPhotos'), 'p1, p2');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await screen.findByText('app.effectUnclear');
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbPoolCreate' }).disabled).toBe(true);
        expect(window.api.createPhotoPool).toHaveBeenCalledTimes(1);
        window.api.getScenarioRequestStatus = jest.fn().mockResolvedValueOnce(
            invalid({
                success: true,
                state: 'request',
                record: {
                    requestId: 'req-p',
                    operation: 'o',
                    target: 'pools',
                    status: 'applied',
                    error: null,
                    revision: 1,
                    at: 1,
                },
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'app.effectCheckStatus' }));
        await waitFor(() => expect(screen.queryByText('app.effectUnclear')).toBeNull());
        await waitFor(() => expect(screen.queryByLabelText('app.sbPoolName')).toBeNull());
        const draft = await saveDraft();
        expect(draft.phases.main.photoPool).toEqual({ name: 'Sunsets' });
    });

    test('a pool found saved after the user left the create form binds nothing', async () => {
        window.api.createPhotoPool = jest
            .fn()
            .mockResolvedValue(invalid({ success: false, error: 'lost', unclear: true, requestId: 'req-p' }));
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), '__new');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolName'), 'Sunsets');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolPhotos'), 'p1');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await screen.findByText('app.effectUnclear');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), '');
        window.api.getScenarioRequestStatus = jest.fn().mockResolvedValueOnce(
            invalid({
                success: true,
                state: 'request',
                record: {
                    requestId: 'req-p',
                    operation: 'o',
                    target: 'pools',
                    status: 'applied',
                    error: null,
                    revision: 1,
                    at: 1,
                },
            }),
        );
        fireEvent.click(screen.getByRole('button', { name: 'app.effectCheckStatus' }));
        await waitFor(() => expect(screen.queryByText('app.effectUnclear')).toBeNull());
        const draft = await saveDraft();
        expect(draft.phases.main.photoPool).toBeUndefined();
    });

    test('a pool save that throws says the change failed, in plain words', async () => {
        window.api.createPhotoPool = jest.fn(() => Promise.reject(new Error('gone')));
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), '__new');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolName'), 'Sunsets');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolPhotos'), 'p1');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        expect(await screen.findByText('errors.actionFailed')).toBeTruthy();
    });

    test('the run reads the cap and a publication with no end, and an assumption can be taken back', async () => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(
            invalid({
                success: true,
                events: [],
                diagnostics: [],
                deadlines: [invalid({ kind: 'publication', validUntil: null })],
                finalState: null,
                needs: null,
                passes: [],
                stoppedAt: 1,
                stopReason: 'limit',
                halted: null,
            }),
        );
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateOn'), '7');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbAssume_submit'), 'success');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbAssume_submit'), '');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbSimulateUntil'), UNTIL);
        click('app.sbSimulate');
        expect(await screen.findByText('app.sbStop_limit')).toBeTruthy();
        expect(screen.getByText(/app\.sbDeadline_publication/)).toBeTruthy();
        const request = invalid<Record<string, unknown>>(jest.mocked(window.api.simulateScenario).mock.calls[0]![0]);
        expect('assumptions' in request).toBe(false);
    });

    test('switching the scope moves the run to the installation', async () => {
        jest.mocked(window.api.simulateScenario).mockResolvedValueOnce(
            invalid({
                success: true,
                events: [],
                assumptions: {},
                diagnostics: [],
                deadlines: [],
                finalState: null,
                needs: null,
                passes: [],
                stoppedAt: 1,
                stopReason: 'idle',
                halted: null,
            }),
        );
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateKind'), 'completed');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbScope'), 'installation');
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbSimulateKind').value).toBe('installation');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbSimulateUntil'), UNTIL);
        click('app.sbSimulate');
        await waitFor(() =>
            expect(window.api.simulateScenario).toHaveBeenCalledWith(
                expect.objectContaining({ subject: { kind: 'installation' } }),
            ),
        );
    });
});

describe('what the pickers offer: only what the backend accepts', () => {
    const { FACTS } = jest.requireActual(
        '../../src/ts/core/scenarios/facts',
    ) as typeof import('../../src/ts/core/scenarios/facts');
    const stored = (scenarios: Record<string, unknown>) =>
        jest
            .mocked(window.api.getScenarios)
            .mockResolvedValue(invalid({ success: true, scenarios, revision: 1, templates: [] }));
    /** The select of a field (its group wrapper answers to the same name). */
    const field = (name: string) =>
        screen.getAllByLabelText<HTMLSelectElement>(name).filter((el) => el.tagName === 'SELECT')[0];
    const ruleDoc = (rule: Record<string, unknown>) =>
        invalid<ComponentProps<typeof ScenarioBuilder>['initial']>({ ...doc(), phases: { main: { rules: [rule] } } });

    test('a binding gives what its setting takes: a percentage setting offers percentage facts, raw ones, base reads', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbAddBinding')[0], 'exposure');
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[0], 'fact');
        const offered = within(screen.getAllByLabelText<HTMLSelectElement>('app.sbField_name')[0])
            .getAllByRole('option')
            .map((option) => option.textContent)
            .filter((name) => name !== 'app.sbPickType');
        expect(offered.length).toBeGreaterThan(0);
        for (const name of offered) {
            const fact = FACTS[name as keyof typeof FACTS];
            expect(fact.classification).toBe('raw');
            expect(fact.kind === 'number' && fact.quantity).toBe('percent');
        }
        // A setting read there is a base read, and only a percentage setting is listed.
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[0], 'setting');
        expect(
            within(screen.getAllByLabelText<HTMLSelectElement>('app.sbField_view')[0]).getAllByRole('option'),
        ).toHaveLength(1);
        expect(
            within(screen.getAllByLabelText<HTMLSelectElement>('app.sbField_key')[0])
                .getAllByRole('option')
                .map((option) => option.textContent),
        ).toEqual(['app.sbPickType', 'exposure']);
    });

    test('a vote window’s length can be a setting read: a schedule reads base settings that give a duration', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fireEvent.click(screen.getByRole('button', { name: 'app.sbScheduleAdd_vote' }));
        const kinds = screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind');
        // The row's own two values: when it starts, and how long it lasts.
        changeSelect(kinds.at(-1)!, 'setting');
        const keys = within(screen.getAllByLabelText<HTMLSelectElement>('app.sbField_key').at(-1)!)
            .getAllByRole('option')
            .map((option) => option.textContent);
        expect(keys).toEqual(['app.sbPickType', 'scheduledFillWindowMinutes']);
        expect(
            within(screen.getAllByLabelText<HTMLSelectElement>('app.sbField_view').at(-1)!).getAllByRole('option'),
        ).toHaveLength(1);
    });

    test('a step that runs an automation offers only the operations its stages allow', async () => {
        await renderBuilder({ initial: ruleDoc({ id: 'r1', do: [{ type: 'runAutomation', operation: 'submit' }] }) });
        const operations = () =>
            within(field('app.sbField_operation'))
                .getAllByRole('option')
                .map((option) => option.textContent);
        // While active: every operation but joining.
        expect(operations()).not.toContain('app.sbOpt_automation_join');
        expect(operations()).toContain('app.sbOpt_automation_submit');
        // Before joining only: joining and nothing else.
        fireEvent.click(screen.getByLabelText('app.sbStage_preJoin'));
        fireEvent.click(screen.getByLabelText('app.sbStage_active'));
        expect(operations()).toEqual(['app.sbOpt_automation_join']);
    });

    test('a handoff stays the last step: nothing is added after it or moved past it, and there is one', async () => {
        stored({});
        await renderBuilder({
            initial: ruleDoc({
                id: 'r1',
                do: [
                    { type: 'notify', message: 'Hi' },
                    { type: 'handoffScenario', to: null },
                ],
            }),
        });
        const adder = () => screen.getByLabelText<HTMLSelectElement>('app.sbAddAction');
        expect(within(adder()).queryByText('app.sbAct_handoffScenario')).toBeNull();
        // The first step cannot move down past the handoff; the handoff cannot move up.
        const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
        expect(button('app.sbMoveDown: app.sbAct_notify 1').disabled).toBe(true);
        expect(button('app.sbMoveUp: app.sbAct_handoffScenario 2').disabled).toBe(true);
        // A new step goes in before the handoff.
        changeSelect(adder(), 'earnTurbo');
        const draft = await saveDraft();
        expect(draft.phases.main.rules?.[0].do.map((step) => step.type)).toEqual([
            'notify',
            'earnTurbo',
            'handoffScenario',
        ]);
    });

    test('steps before a handoff still move among themselves', async () => {
        stored({});
        await renderBuilder({
            initial: ruleDoc({
                id: 'r1',
                do: [{ type: 'notify', message: 'Hi' }, { type: 'earnTurbo' }, { type: 'handoffScenario', to: null }],
            }),
        });
        const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name });
        expect(button('app.sbMoveDown: app.sbAct_notify 1').disabled).toBe(false);
        expect(button('app.sbMoveUp: app.sbAct_earnTurbo 2').disabled).toBe(false);
        expect(button('app.sbMoveDown: app.sbAct_earnTurbo 2').disabled).toBe(true);
        expect(button('app.sbMoveUp: app.sbAct_handoffScenario 3').disabled).toBe(true);
        fireEvent.click(button('app.sbMoveDown: app.sbAct_notify 1'));
        const draft = await saveDraft();
        expect(draft.phases.main.rules?.[0].do.map((step) => step.type)).toEqual([
            'earnTurbo',
            'notify',
            'handoffScenario',
        ]);
    });

    test('a handoff can be added while none is there, and is placed last', async () => {
        stored({});
        await renderBuilder({ initial: ruleDoc({ id: 'r1', do: [{ type: 'notify', message: 'Hi' }] }) });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbAddAction'), 'handoffScenario');
        const draft = await saveDraft();
        expect(draft.phases.main.rules?.[0].do.map((step) => step.type)).toEqual(['notify', 'handoffScenario']);
    });

    test('a handoff names a scenario of the same scope only', async () => {
        stored({
            Beach: { name: 'Beach', start: 'main', phases: { main: {} } },
            Ops: { name: 'Ops', scope: 'installation', start: 'main', phases: { main: {} } },
        });
        await renderBuilder({ initial: ruleDoc({ id: 'r1', do: [{ type: 'handoffScenario', to: null }] }) });
        await waitFor(() => expect(within(field('app.sbField_to')).queryByText('Beach')).toBeTruthy());
        expect(within(field('app.sbField_to')).queryByText('Ops')).toBeNull();
    });

    test('a phase that draws from a pool is not offered the Chosen Photos settings, and a pool is not offered over them', async () => {
        await renderBuilder({
            initial: { ...doc(), phases: { main: { photoPool: { name: 'Beach' } } } },
        });
        const picker = screen.getAllByLabelText<HTMLSelectElement>('app.sbAddSetting')[0];
        expect(within(picker).queryByText('app.chosenPhotos')).toBeNull();
        expect(within(picker).queryByText('app.exposure')).toBeTruthy();
    });

    test('a phase that already sets Chosen Photos cannot bind a pool, and says why', async () => {
        await renderBuilder({
            initial: { ...doc(), phases: { main: { settings: { chosenPhotos: ['p1'] } } } },
        });
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool').disabled).toBe(true);
        expect(screen.getByText('app.sbPoolBlocked')).toBeTruthy();
        // Taking the setting out frees the pool.
        fireEvent.click(screen.getByRole('button', { name: 'app.sbRemove: app.chosenPhotos' }));
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool').disabled).toBe(false);
        expect(screen.queryByText('app.sbPoolBlocked')).toBeNull();
    });

    test('saved profiles can be picked for a phase and for a step, and one a phase may not apply is not offered', async () => {
        // The host names the profiles a phase may apply (the runner's own check): a profile it refuses is not in the answer.
        jest.mocked(window.api.getPhaseProfiles).mockResolvedValue({
            success: true,
            profiles: ['Evening', 'Plain', 'Custom'],
        });
        await renderBuilder({ initial: ruleDoc({ id: 'r1', do: [{ type: 'useProfile', name: null }] }) });
        const phaseProfile = () => screen.getByLabelText<HTMLSelectElement>('app.sbPhaseProfile');
        await waitFor(() => expect(within(phaseProfile()).queryByText('Evening')).toBeTruthy());
        expect(within(phaseProfile()).queryByText('Plain')).toBeTruthy();
        expect(within(phaseProfile()).queryByText('Custom')).toBeTruthy();
        // A profile the host's check refuses is never offered, whatever it holds.
        expect(within(phaseProfile()).queryByText('Manual')).toBeNull();
        const step = field('app.sbField_name');
        expect(within(step).queryByText('Evening')).toBeTruthy();
        expect(within(step).queryByText('Manual')).toBeNull();
        changeSelect(phaseProfile(), 'Evening');
        changeSelect(step, 'Evening');
        let draft = await saveDraft();
        expect(draft.phases.main.profile).toBe('Evening');
        expect(draft.phases.main.rules?.[0].do[0]).toEqual({ type: 'useProfile', name: 'Evening' });
        // No profile takes the field out of the document again.
        changeSelect(phaseProfile(), '');
        draft = await saveDraft();
        expect(draft.phases.main.profile).toBeUndefined();
    });

    test('a profile the phase names that is not offered stays visible as missing', async () => {
        jest.mocked(window.api.getPhaseProfiles).mockResolvedValue({ success: true, profiles: [] });
        await renderBuilder({ initial: { ...doc(), phases: { main: { profile: 'Manual' } } } });
        const phaseProfile = screen.getByLabelText<HTMLSelectElement>('app.sbPhaseProfile');
        expect(phaseProfile.value).toBe('Manual');
        expect(within(phaseProfile).getByText(/app\.scenarioMissingOption/)).toBeTruthy();
    });

    test('a host that answers no profiles offers none', async () => {
        jest.mocked(window.api.getPhaseProfiles).mockResolvedValue({ success: false, error: 'x' });
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        const phaseProfile = screen.getByLabelText<HTMLSelectElement>('app.sbPhaseProfile');
        expect(within(phaseProfile).getAllByRole('option')).toHaveLength(1);
    });

    test('two phases that set the same key give each input its own name and its own id', async () => {
        await renderBuilder({
            initial: {
                ...doc(),
                phases: { main: { settings: { exposure: 10 } }, later: { settings: { exposure: 20 } } },
            },
        });
        const inputs = screen.getAllByLabelText<HTMLInputElement>('app.exposure');
        expect(inputs).toHaveLength(2);
        expect(new Set(inputs.map((input) => input.id)).size).toBe(2);
        expect(inputs.map((input) => input.value)).toEqual(['10', '20']);
    });

    test('removing a setting keeps the keyboard in the same part of the form', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: { settings: { exposure: 10 } } } } });
        const remove = screen.getByRole('button', { name: 'app.sbRemove: app.exposure' });
        remove.focus();
        fireEvent.click(remove);
        expect(document.activeElement?.textContent).toBe('app.sbPhaseSettings');
    });

    test('removing a live value keeps the keyboard in the same part of the form', async () => {
        await renderBuilder({
            initial: {
                ...doc(),
                phases: { main: { bindings: { exposure: { kind: 'literal', value: 5, quantity: 'percent' } } } },
            },
        });
        const remove = screen.getByRole('button', { name: 'app.sbRemove: app.exposure' });
        remove.focus();
        fireEvent.click(remove);
        expect(document.activeElement?.textContent).toBe('app.sbPhaseBindings');
    });
});

describe('a save in flight', () => {
    const held = () => {
        let release!: (answer: unknown) => void;
        const promise = new Promise((resolve) => {
            release = resolve;
        });
        return { promise, release };
    };
    const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSave' });
    /** Whether a control is off: its own switch, or the disabled fieldset that holds the draft (which turns off everything in it). */
    const isOff = (control: HTMLElement) =>
        (control as HTMLInputElement).disabled || control.closest('fieldset')?.disabled === true;

    test('two Save clicks before the page has drawn the first start one save, and a call that comes while it runs is turned away', async () => {
        const validation = held();
        window.api.checkScenario = invalid(jest.fn(() => validation.promise));
        await renderBuilder();
        // Both clicks arrive before anything re-renders: only the first may start.
        fireEvent.click(saveButton());
        fireEvent.click(saveButton());
        expect(window.api.checkScenario).toHaveBeenCalledTimes(1);
        // The handler itself refuses too, though the button is off: take its off switch away and call it again.
        saveButton().removeAttribute('disabled');
        fireEvent.click(saveButton());
        expect(window.api.checkScenario).toHaveBeenCalledTimes(1);
        validation.release({ success: true });
        await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
        expect(window.api.saveScenario).toHaveBeenCalledTimes(1);
    });

    test('the draft, Save and Cancel are locked from the validation read until the result is final, and the busy state is shown', async () => {
        const validation = held();
        window.api.checkScenario = invalid(jest.fn(() => validation.promise));
        await renderBuilder();
        click('app.sbSave');
        await waitFor(() => expect(saveButton().disabled).toBe(true));
        expect(saveButton().getAttribute('aria-busy')).toBe('true');
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.cancel' }).disabled).toBe(true);
        // Everything the draft holds is off: it cannot change under the save.
        expect(isOff(screen.getByLabelText<HTMLInputElement>('app.sbDescription'))).toBe(true);
        expect(isOff(screen.getByLabelText<HTMLInputElement>('app.sbName'))).toBe(true);
        validation.release({ success: true });
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        // The document that was sent is the one that was validated.
        expect(window.api.saveScenario).toHaveBeenCalledTimes(1);
    });

    test('a save that fails gives the draft back: it can be edited and saved again', async () => {
        window.api.saveScenario = invalid(jest.fn(async () => ({ success: false, error: 'busy' })));
        await renderBuilder();
        click('app.sbSave');
        await screen.findByRole('alert');
        expect(saveButton().disabled).toBe(false);
        expect(isOff(screen.getByLabelText<HTMLInputElement>('app.sbDescription'))).toBe(false);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.cancel' }).disabled).toBe(false);
        expect(saveButton().getAttribute('aria-busy')).toBe('false');
    });

    test('a validation that fails gives the draft back too', async () => {
        window.api.checkScenario = invalid(
            jest.fn(async () => ({ success: false, issues: [{ path: 'start', message: 'No phase' }] })),
        );
        await renderBuilder();
        click('app.sbSave');
        await screen.findByRole('alert');
        expect(saveButton().disabled).toBe(false);
        expect(isOff(screen.getByLabelText<HTMLInputElement>('app.sbDescription'))).toBe(false);
    });

    test('while the answer to a rename or a save is open the draft stays locked, and Dismiss gives it back', async () => {
        window.api.saveScenario = invalid(
            jest.fn(async () => ({ success: false, error: 'lost', unclear: true, requestId: 'req-1' })),
        );
        await renderBuilder();
        click('app.sbSave');
        await screen.findByText('app.effectUnclear');
        expect(isOff(screen.getByLabelText<HTMLInputElement>('app.sbDescription'))).toBe(true);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.cancel' }).disabled).toBe(true);
        click('errors.dismiss');
        expect(isOff(screen.getByLabelText<HTMLInputElement>('app.sbDescription'))).toBe(false);
    });
});

describe('a pool created from a phase', () => {
    const lostCreate = () =>
        jest.fn().mockResolvedValue(invalid({ success: false, error: 'lost', unclear: true, requestId: 'req-p' }));
    const appliedStatus = () =>
        invalid<Awaited<ReturnType<typeof window.api.getScenarioRequestStatus>>>({
            success: true,
            state: 'request',
            record: {
                requestId: 'req-p',
                operation: 'o',
                target: 'pools',
                status: 'applied',
                error: null,
                revision: 1,
                at: 1,
            },
        });
    const fillForm = (name: string) => {
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), '__new');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolName'), name);
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolPhotos'), 'p1');
    };

    test('the name that was sent is the one bound, whatever the form says by the time a check confirms it', async () => {
        window.api.createPhotoPool = lostCreate();
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fillForm('Beach');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await screen.findByText('app.effectUnclear');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolName'), 'Dunes');
        window.api.getScenarioRequestStatus = jest.fn().mockResolvedValueOnce(appliedStatus());
        fireEvent.click(screen.getByRole('button', { name: 'app.effectCheckStatus' }));
        await waitFor(() => expect(screen.queryByLabelText('app.sbPoolName')).toBeNull());
        const draft = await saveDraft();
        expect(draft.phases.main.photoPool).toEqual({ name: 'Beach' });
    });

    test('a late confirmation patches only the pool: an edit made meanwhile is kept', async () => {
        window.api.createPhotoPool = lostCreate();
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fillForm('Beach');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await screen.findByText('app.effectUnclear');
        // The pool form's own edit, and the scenario's, are not locked by a pool request.
        fireEvent.change(screen.getByLabelText('app.sbDescription'), { target: { value: 'Kept edit' } });
        window.api.getScenarioRequestStatus = jest.fn().mockResolvedValueOnce(appliedStatus());
        fireEvent.click(screen.getByRole('button', { name: 'app.effectCheckStatus' }));
        await waitFor(() => expect(screen.queryByLabelText('app.sbPoolName')).toBeNull());
        const draft = await saveDraft();
        expect(draft.phases.main.photoPool).toEqual({ name: 'Beach' });
        expect(draft.description).toBe('Kept edit');
    });

    test('a slow first reply does not write the earlier whole draft back over an edit made while it was out', async () => {
        let answer!: () => void;
        window.api.createPhotoPool = jest.fn(
            () =>
                new Promise<{ success: true }>((resolve) => {
                    answer = () => resolve({ success: true });
                }),
        );
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fillForm('Beach');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await waitFor(() => expect(window.api.createPhotoPool).toHaveBeenCalled());
        fireEvent.change(screen.getByLabelText('app.sbDescription'), { target: { value: 'Typed meanwhile' } });
        await act(async () => {
            answer();
        });
        await waitFor(() => expect(screen.queryByLabelText('app.sbPoolName')).toBeNull());
        const draft = await saveDraft();
        expect(draft.description).toBe('Typed meanwhile');
        expect(draft.phases.main.photoPool).toEqual({ name: 'Beach' });
    });

    test('a created pool is read into the shared list, so it is not shown as missing and its options are there', async () => {
        window.api.createPhotoPool = jest.fn().mockResolvedValue({ success: true });
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        const reads = jest.mocked(window.api.getPhotoPools).mock.calls.length;
        // The list holds the pool once the create has landed.
        jest.mocked(window.api.getPhotoPools).mockResolvedValue(
            invalid({ success: true, pools: { Beach: ['p1'], Sunsets: ['p1'] } }),
        );
        fillForm('Sunsets');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await waitFor(() => expect(screen.queryByLabelText('app.sbPoolName')).toBeNull());
        expect(jest.mocked(window.api.getPhotoPools).mock.calls.length).toBeGreaterThan(reads);
        expect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool').value).toBe('Sunsets');
        expect(screen.getByLabelText('app.sbPoolOnly')).toBeTruthy();
        expect(screen.getByLabelText('app.sbPoolInOrder')).toBeTruthy();
    });

    test('a pool created for a phase that took Chosen Photos meanwhile is not bound over them', async () => {
        let answer!: () => void;
        window.api.createPhotoPool = jest.fn(
            () =>
                new Promise<{ success: true }>((resolve) => {
                    answer = () => resolve({ success: true });
                }),
        );
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fillForm('Beach');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await waitFor(() => expect(window.api.createPhotoPool).toHaveBeenCalled());
        // The user adds the Chosen Photos setting while the create is out.
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbAddSetting')[0], 'chosenPhotos');
        await act(async () => {
            answer();
        });
        await waitFor(() => expect(screen.queryByLabelText('app.sbPoolName')).toBeNull());
        const draft = await saveDraft();
        expect(draft.phases.main.photoPool).toBeUndefined();
        expect(draft.phases.main.settings).toHaveProperty('chosenPhotos');
    });
});

describe('retyping a step', () => {
    const pickers = () => screen.getAllByLabelText<HTMLSelectElement>('app.sbPickType');
    const optionsOf = (select: HTMLSelectElement) => [...select.options].map((option) => option.value);
    const rule = (steps: Record<string, unknown>[]) =>
        invalid<ComponentProps<typeof ScenarioBuilder>['initial']>({
            ...doc(),
            phases: { main: { rules: [{ id: 'r1', do: steps }] } },
        });

    test('a step before a handoff cannot be retyped into one: only the last step may be, and only while there is none', async () => {
        await renderBuilder({
            initial: rule([
                { type: 'notify', message: 'Hi' },
                { type: 'handoffScenario', to: null },
            ]),
        });
        const [first, last] = pickers();
        expect(optionsOf(first)).not.toContain('handoffScenario');
        // The handoff itself still reads as one, and is the one place a handoff may be.
        expect(optionsOf(last)).toContain('handoffScenario');
        expect(last.value).toBe('handoffScenario');
    });

    test('with no handoff yet, only the last step may be retyped into one', async () => {
        await renderBuilder({ initial: rule([{ type: 'notify', message: 'Hi' }, { type: 'earnTurbo' }]) });
        const [first, last] = pickers();
        expect(optionsOf(first)).not.toContain('handoffScenario');
        expect(optionsOf(last)).toContain('handoffScenario');
        changeSelect(last, 'handoffScenario');
        const draft = await saveDraft();
        expect(draft.phases.main.rules?.[0].do.map((step) => step.type)).toEqual(['notify', 'handoffScenario']);
    });

    test('a handoff that is already somewhere else in the rule is not offered to the last step', async () => {
        await renderBuilder({ initial: rule([{ type: 'handoffScenario', to: null }, { type: 'earnTurbo' }]) });
        const [, last] = pickers();
        expect(optionsOf(last)).not.toContain('handoffScenario');
    });

    test('a rule in both stages is offered no automation step at all', async () => {
        await renderBuilder({ initial: rule([{ type: 'notify', message: 'Hi' }]) });
        fireEvent.click(screen.getByLabelText('app.sbStage_preJoin'));
        expect(optionsOf(pickers()[0])).not.toContain('runAutomation');
        expect(
            within(screen.getByLabelText<HTMLSelectElement>('app.sbAddAction')).queryByText('app.sbAct_runAutomation'),
        ).toBeNull();
    });
});

describe('a live value gives what its setting takes', () => {
    test('a yes/no setting’s live value is a literal, a fact or a setting — never an offset', async () => {
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbAddBinding')[0], 'autoSubmit');
        const kinds = [...screen.getAllByLabelText<HTMLSelectElement>('app.sbExprKind')[0].options].map(
            (option) => option.value,
        );
        expect(kinds).toEqual(expect.arrayContaining(['literal', 'fact']));
        for (const bad of ['offset', 'difference', 'add', 'subtract', 'earlier', 'later', 'min', 'max']) {
            expect(kinds).not.toContain(bad);
        }
    });
});

describe('a pool create with no answer yet, and the builder going away', () => {
    const saveButton = () => screen.getByRole<HTMLButtonElement>('button', { name: 'app.sbSave' });
    const lostCreate = () =>
        jest.fn().mockResolvedValue(invalid({ success: false, error: 'lost', unclear: true, requestId: 'req-p' }));
    const applied = () =>
        invalid<Awaited<ReturnType<typeof window.api.getScenarioRequestStatus>>>({
            success: true,
            state: 'request',
            record: {
                requestId: 'req-p',
                operation: 'o',
                target: 'pools',
                status: 'applied',
                error: null,
                revision: 1,
                at: 1,
            },
        });
    const fillForm = (name: string) => {
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), '__new');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolName'), name);
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolPhotos'), 'p1, p2');
    };
    const held = <T,>() => {
        let release!: (value: T) => void;
        const promise = new Promise<T>((resolve) => {
            release = resolve;
        });
        return { promise, release };
    };

    test('Save waits while a pool create has no final answer, and is back once it is dismissed, confirmed or refused', async () => {
        window.api.createPhotoPool = lostCreate();
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fillForm('Beach');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await screen.findByText('app.effectUnclear');
        expect(saveButton().disabled).toBe(true);
        // Even a click that reaches the handler starts nothing.
        saveButton().removeAttribute('disabled');
        fireEvent.click(saveButton());
        await Promise.resolve();
        expect(window.api.checkScenario).not.toHaveBeenCalled();
        click('errors.dismiss');
        await waitFor(() => expect(saveButton().disabled).toBe(false));
    });

    test('Save is off while the create itself is in flight, and on again when it is final', async () => {
        const reply = held<{ success: true }>();
        window.api.createPhotoPool = jest.fn(() => reply.promise);
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fillForm('Beach');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await waitFor(() => expect(saveButton().disabled).toBe(true));
        await act(async () => {
            reply.release({ success: true });
        });
        await waitFor(() => expect(saveButton().disabled).toBe(false));
    });

    test('a phase that is removed while its create is out no longer holds Save', async () => {
        const reply = held<{ success: true }>();
        window.api.createPhotoPool = jest.fn(() => reply.promise);
        await renderBuilder({ initial: { ...doc(), phases: { main: {}, other: {} } } });
        // The first phase's own pool form.
        changeSelect(screen.getAllByLabelText<HTMLSelectElement>('app.sbPhotoPool')[0], '__new');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolName'), 'Beach');
        changeInput(screen.getByLabelText<HTMLInputElement>('app.sbPoolPhotos'), 'p1, p2');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await waitFor(() => expect(saveButton().disabled).toBe(true));
        fireEvent.click(screen.getByRole('button', { name: 'app.sbRemovePhase: main' }));
        await waitFor(() => expect(saveButton().disabled).toBe(false));
    });

    test('a save that is still validating when the builder goes away goes no further', async () => {
        const check = held<{ success: true }>();
        window.api.checkScenario = invalid(jest.fn(() => check.promise));
        const view = await renderBuilder();
        click('app.sbSave');
        await waitFor(() => expect(window.api.checkScenario).toHaveBeenCalled());
        await act(async () => {
            view.unmount();
        });
        await act(async () => {
            check.release({ success: true });
        });
        expect(window.api.renameScenario).not.toHaveBeenCalled();
        expect(window.api.saveScenario).not.toHaveBeenCalled();
        expect(onSaved).not.toHaveBeenCalled();
    });

    test('a rename that is still out when the builder goes away is not followed by the save', async () => {
        const moved = held<{ success: true; name: string }>();
        window.api.renameScenario = invalid(jest.fn(() => moved.promise));
        const view = await renderBuilder();
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        click('app.sbSave');
        await waitFor(() => expect(window.api.renameScenario).toHaveBeenCalled());
        await act(async () => {
            view.unmount();
        });
        await act(async () => {
            moved.release({ success: true, name: 'New' });
        });
        expect(window.api.saveScenario).not.toHaveBeenCalled();
        expect(onSaved).not.toHaveBeenCalled();
    });

    test('a save that is still out when the builder goes away does not report the builder as saved', async () => {
        const saved = held<{ success: true; name: string }>();
        window.api.saveScenario = invalid(jest.fn(() => saved.promise));
        const view = await renderBuilder();
        click('app.sbSave');
        await waitFor(() => expect(window.api.saveScenario).toHaveBeenCalled());
        await act(async () => {
            view.unmount();
        });
        await act(async () => {
            saved.release({ success: true, name: 'Plan' });
        });
        expect(onSaved).not.toHaveBeenCalled();
    });

    test('the builder tells whoever holds it while a save runs, and when it is over', async () => {
        const check = held<{ success: true }>();
        window.api.checkScenario = invalid(jest.fn(() => check.promise));
        const onBusyChange = jest.fn();
        await renderBuilder({ onBusyChange });
        expect(onBusyChange).toHaveBeenLastCalledWith(false);
        click('app.sbSave');
        await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
        await act(async () => {
            check.release({ success: true });
        });
        await waitFor(() => expect(onSaved).toHaveBeenCalled());
    });

    test('choosing another pool before the first reply: the late create binds nothing, in both completion paths', async () => {
        jest.mocked(window.api.getPhotoPools).mockResolvedValue(invalid({ success: true, pools: { Dunes: ['d1'] } }));
        // The slow first reply path.
        const reply = held<{ success: true }>();
        window.api.createPhotoPool = jest.fn(() => reply.promise);
        const first = await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fillForm('Beach');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await waitFor(() => expect(window.api.createPhotoPool).toHaveBeenCalled());
        await waitFor(() =>
            expect(
                within(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool')).queryByText(/Dunes/),
            ).toBeTruthy(),
        );
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), 'Dunes');
        await act(async () => {
            reply.release({ success: true });
        });
        await waitFor(() => expect(saveButton().disabled).toBe(false));
        let draft = await saveDraft();
        expect(draft.phases.main.photoPool).toEqual({ name: 'Dunes' });
        first.unmount();
        // The lost reply path: the check finds it applied after the choice moved on.
        window.api.createPhotoPool = lostCreate();
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fillForm('Beach');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await screen.findByText('app.effectUnclear');
        await waitFor(() =>
            expect(
                within(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool')).queryByText(/Dunes/),
            ).toBeTruthy(),
        );
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), 'Dunes');
        window.api.getScenarioRequestStatus = jest.fn().mockResolvedValueOnce(applied());
        fireEvent.click(screen.getByRole('button', { name: 'app.effectCheckStatus' }));
        await waitFor(() => expect(screen.queryByText('app.effectUnclear')).toBeNull());
        jest.mocked(window.api.saveScenario).mockClear();
        draft = await saveDraft();
        expect(draft.phases.main.photoPool).toEqual({ name: 'Dunes' });
    });

    test('leaving the create form for no pool also drops the late create, though the pool exists and is listed', async () => {
        const reply = held<{ success: true }>();
        window.api.createPhotoPool = jest.fn(() => reply.promise);
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        fillForm('Beach');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await waitFor(() => expect(window.api.createPhotoPool).toHaveBeenCalled());
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool'), '');
        await act(async () => {
            reply.release({ success: true });
        });
        await waitFor(() => expect(saveButton().disabled).toBe(false));
        const draft = await saveDraft();
        expect(draft.phases.main.photoPool).toBeUndefined();
    });

    test('a confirmed pool is in the list before it is bound, whatever the re-read says, and an older read never replaces it', async () => {
        // The read that was on its way when the create landed answers late, without the new pool.
        const old = held<unknown>();
        jest.mocked(window.api.getPhotoPools)
            .mockReset()
            .mockImplementationOnce(() => old.promise as never);
        window.api.createPhotoPool = jest.fn().mockResolvedValue({ success: true });
        await renderBuilder({ initial: { ...doc(), phases: { main: {} } } });
        // The re-read after the create fails.
        jest.mocked(window.api.getPhotoPools).mockResolvedValue(invalid({ success: false, error: 'x' }));
        fillForm('Sunsets');
        fireEvent.click(screen.getByRole('button', { name: 'app.sbPoolCreate' }));
        await waitFor(() => expect(screen.queryByLabelText('app.sbPoolName')).toBeNull());
        const picker = () => screen.getByLabelText<HTMLSelectElement>('app.sbPhotoPool');
        expect(picker().value).toBe('Sunsets');
        expect(within(picker()).getByText(/Sunsets \(2\)/)).toBeTruthy();
        expect(screen.getByLabelText('app.sbPoolOnly')).toBeTruthy();
        await act(async () => {
            old.release({ success: true, pools: { Beach: ['b'] } });
        });
        expect(picker().value).toBe('Sunsets');
        expect(screen.getByLabelText('app.sbPoolInOrder')).toBeTruthy();
    });
});
