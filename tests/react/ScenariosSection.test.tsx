/**
 * The settings modal's Scenarios section: list, export, rename, two-step
 * delete, a copy from a template, and import with its preview.
 */

import { act, render, screen, waitFor, fireEvent, within } from './helpers/test-utils';
import { ScenariosSection } from '@/components/app/ScenariosSection';
import { usePhotoPools } from '@/api/usePhotoPools';
import { SettingsNavProvider } from '@/contexts/SettingsNavContext';
import { mockTranslator, defaultTranslate, fillTemplate } from './helpers/setup';
import { invalid } from '../helpers/invalid';
import { markPlatformKind } from '../../src/ts/core/platform/kind';
import { resetPlatformKind } from '../helpers/platformKind';

import type { SettingsNav } from '@/contexts/SettingsNavContext';
import type { SettingsTabId } from '@/utils/groupSettings';

const plan = { name: 'Plan', start: 'main', description: 'Mine', phases: { main: {}, done: {} } };
const template = { id: 'evening', scenario: { name: 'Evening', start: 'main', phases: { main: {} } } };

const withScenarios = (scenarios: Record<string, unknown> = { Plan: plan }) =>
    jest
        .mocked(window.api.getScenarios)
        .mockResolvedValue(invalid({ success: true, scenarios, revision: 7, templates: [template] }));

// The section renders inside the modal's tab panel; give it a navigation that shows it.
const shownNav = (active: SettingsTabId): SettingsNav => ({
    query: '',
    namesOnly: false,
    isShown: () => true,
    active,
    selectionSeq: 0,
    select: () => undefined,
    setQuery: () => undefined,
    reveal: () => undefined,
    reset: () => undefined,
});

const renderSection = async () => {
    render(
        <SettingsNavProvider value={shownNav('scenarios')}>
            <ScenariosSection isOpen={true} onDirtyChange={jest.fn()} />
        </SettingsNavProvider>,
    );
    await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

// A <select>'s onChange stays a native 'change' listener under preact/compat
// (see ChallengeProfilesBar.test.tsx), so dispatch the real event.
const changeSelect = (sel: HTMLSelectElement, value: string) =>
    act(() => {
        sel.value = value;
        sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });

beforeEach(() => {
    withScenarios();
    window.api.checkScenario = invalid(jest.fn(async () => ({ success: true })));
});

describe('listing', () => {
    test('shows each scenario with its phase count and description', async () => {
        await renderSection();
        expect(screen.getByText('Plan')).toBeTruthy();
        expect(screen.getByText('app.scenarioPhaseCount')).toBeTruthy();
        expect(screen.getByText('Mine')).toBeTruthy();
    });

    test('an empty list and a failed load', async () => {
        withScenarios({});
        await renderSection();
        expect(screen.getByText('app.scenariosEmpty')).toBeTruthy();
    });

    test('a failed load shows an alert', async () => {
        jest.mocked(window.api.getScenarios).mockResolvedValue({ success: false, error: 'x' });
        await renderSection();
        expect(screen.getByRole('alert').textContent).toBe('app.scenariosLoadError');
    });
});

describe('a scenario row', () => {
    test('export shows the JSON, and hides again', async () => {
        jest.mocked(window.api.exportScenario).mockResolvedValue({
            success: true,
            json: '{"name":"Plan"}',
            omitted: [],
        });
        await renderSection();
        click('app.scenarioExport: Plan');
        const box = await screen.findByLabelText<HTMLTextAreaElement>('app.scenarioExportLabel');
        expect(box.value).toBe('{"name":"Plan"}');
        expect(box.getAttribute('autocapitalize')).toBe('off');
        fireEvent.focus(box);
        click('app.scenarioExportClose');
        expect(screen.queryByLabelText('app.scenarioExportLabel')).toBeNull();
    });

    test('export names the settings it left out', async () => {
        jest.mocked(window.api.exportScenario).mockResolvedValue({
            success: true,
            json: '{"name":"Plan"}',
            omitted: ['chosenPhotos'],
        });
        await renderSection();
        click('app.scenarioExport: Plan');
        await screen.findByLabelText('app.scenarioExportLabel');
        // Translations echo their key in tests; the omitted setting's label key is the placeholder value.
        expect(screen.getByText('app.scenarioExportOmitted')).toBeTruthy();
    });

    test('export without omissions shows no note', async () => {
        jest.mocked(window.api.exportScenario).mockResolvedValue({ success: true, json: '{}', omitted: [] });
        await renderSection();
        click('app.scenarioExport: Plan');
        await screen.findByLabelText('app.scenarioExportLabel');
        expect(screen.queryByText('app.scenarioExportOmitted')).toBeNull();
    });

    test('a failed export shows the error', async () => {
        jest.mocked(window.api.exportScenario).mockResolvedValue({ success: false, error: 'not-found' });
        await renderSection();
        click('app.scenarioExport: Plan');
        expect((await screen.findByRole('alert')).textContent).toContain('app.scenarioExportFailed');
    });

    test('rename saves the new name; cancel leaves it', async () => {
        jest.mocked(window.api.renameScenario).mockResolvedValue({ success: true, name: 'New' });
        await renderSection();
        click('app.scenarioRename: Plan');
        fireEvent.change(screen.getByLabelText('app.scenarioRenameLabel'), { target: { value: 'New' } });
        click('app.scenarioRenameSave');
        await waitFor(() => expect(window.api.renameScenario).toHaveBeenCalledWith('Plan', 'New'));
        await waitFor(() => expect(screen.queryByLabelText('app.scenarioRenameLabel')).toBeNull());
        click('app.scenarioRename: Plan');
        click('app.cancel');
        expect(screen.queryByLabelText('app.scenarioRenameLabel')).toBeNull();
    });

    test('a refused rename lists the problems', async () => {
        jest.mocked(window.api.renameScenario).mockResolvedValue(
            invalid({
                success: false,
                issues: [
                    { path: 'name', message: 'taken' },
                    { path: '', message: 'root' },
                ],
            }),
        );
        await renderSection();
        click('app.scenarioRename: Plan');
        click('app.scenarioRenameSave');
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('app.scenarioRenameFailed');
        // The path stays; the validator's English wording is replaced by the UI language's (generic here).
        expect(alert.textContent).toContain('name');
        expect(alert.textContent).not.toContain('taken');
        expect(alert.querySelectorAll('li')).toHaveLength(2);
        expect(alert.textContent).toContain('app.scenarioIssueGeneric');
    });

    test('an issue names its place in words, not as a JSON path', async () => {
        jest.mocked(window.api.renameScenario).mockResolvedValue(
            invalid({
                success: false,
                issues: [{ path: 'phases.main.rules[0].if[0].window', message: 'Name is required' }],
            }),
        );
        await renderSection();
        click('app.scenarioRename: Plan');
        click('app.scenarioRenameSave');
        const alert = await screen.findByRole('alert');
        // The test translator returns keys, so the segment words are keys and the raw segments stay as written.
        expect(alert.querySelector('li')?.textContent).toBe(
            'app.scenarioPathPhase › Rule 1 › app.scenarioPathCondition › window: app.scenarioIssueNameRequired',
        );
        expect(alert.textContent).not.toContain('phases.main');
    });

    test('only an issue with no wording is logged as missing; one with wording is shown translated', async () => {
        jest.mocked(window.api.renameScenario).mockResolvedValue(
            invalid({
                success: false,
                issues: [
                    { path: 'name', message: 'Name is required' },
                    { path: 'start', message: 'something new' },
                ],
            }),
        );
        await renderSection();
        click('app.scenarioRename: Plan');
        click('app.scenarioRenameSave');
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('app.scenarioIssueNameRequired');
        // The logging effect runs after paint: wait for the unknown one, then see the known one was not reported.
        await waitFor(() =>
            expect(window.api.logDebug).toHaveBeenCalledWith(
                'Scenario issue without wording at "start": something new',
            ),
        );
        expect(window.api.logDebug).toHaveBeenCalledTimes(1);
    });

    test('delete needs a second click, which then deletes', async () => {
        jest.mocked(window.api.deleteScenario).mockResolvedValue({ success: true });
        await renderSection();
        click('app.scenarioDelete: Plan');
        expect(window.api.deleteScenario).not.toHaveBeenCalled();
        click('app.scenarioDeleteConfirm: Plan');
        await waitFor(() => expect(window.api.deleteScenario).toHaveBeenCalledWith('Plan'));
    });

    test('an armed delete disarms itself; a failed delete shows the error', async () => {
        jest.useFakeTimers();
        try {
            jest.mocked(window.api.deleteScenario).mockResolvedValue(invalid({ success: false }));
            render(
                <SettingsNavProvider value={shownNav('scenarios')}>
                    <ScenariosSection isOpen={true} onDirtyChange={jest.fn()} />
                </SettingsNavProvider>,
            );
            await act(async () => {
                await Promise.resolve();
            });
            await act(async () => {
                await Promise.resolve();
            });
            click('app.scenarioDelete: Plan');
            act(() => jest.advanceTimersByTime(4000));
            expect(screen.getByRole('button', { name: 'app.scenarioDelete: Plan' })).toBeTruthy();
            click('app.scenarioDelete: Plan');
            click('app.scenarioDeleteConfirm: Plan');
            await act(async () => {
                await Promise.resolve();
            });
            expect(screen.getByRole('alert').textContent).toContain('app.scenarioDeleteFailed');
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('templates', () => {
    test('adds a copy under a free name', async () => {
        withScenarios({ Plan: plan, Evening: plan, 'evening 2': plan });
        jest.mocked(window.api.saveScenario).mockResolvedValue({ success: true, name: 'Evening 3' });
        await renderSection();
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.scenarioAddTemplate' }).disabled).toBe(true);
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.scenarioTemplatePick'), 'evening');
        click('app.scenarioAddTemplate');
        await waitFor(() =>
            expect(window.api.saveScenario).toHaveBeenCalledWith(expect.objectContaining({ name: 'Evening 3' }), {
                overwrite: false,
            }),
        );
    });

    test('a refused copy shows the error', async () => {
        jest.mocked(window.api.saveScenario).mockResolvedValue(invalid({ success: false }));
        await renderSection();
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.scenarioTemplatePick'), 'evening');
        click('app.scenarioAddTemplate');
        expect((await screen.findByRole('alert')).textContent).toContain('app.scenarioTemplateFailed');
    });
});

describe('import', () => {
    const preview = (overrides = {}) => ({
        success: true,
        exists: false,
        preview: {
            name: 'Shared',
            start: 'main',
            description: 'From a friend',
            phases: [
                { name: 'main', rules: 1, settings: ['exposure'] },
                { name: 'done', rules: 0, settings: [] },
            ],
            spending: [{ action: 'swap', rule: 'Hold' }],
            flagged: [],
            limits: { swaps: 2 },
            ...overrides,
        },
    });

    const openImport = async () => {
        await renderSection();
        click('app.scenarioImport');
        fireEvent.change(screen.getByLabelText('app.scenarioImportLabel'), { target: { value: '{"name":"Shared"}' } });
    };

    test('the pasted JSON is not auto-capitalised', async () => {
        await openImport();
        const box = screen.getByLabelText('app.scenarioImportLabel');
        expect(box.getAttribute('autocapitalize')).toBe('off');
    });

    test('an import over a collection whose revision cannot be read states none', async () => {
        jest.mocked(window.api.getScenarios).mockResolvedValue(
            invalid({ success: true, scenarios: { Plan: plan }, revision: null, templates: [template] }),
        );
        jest.mocked(window.api.previewScenarioImport).mockResolvedValue(invalid(preview()));
        jest.mocked(window.api.importScenario).mockResolvedValue({ success: true, name: 'Shared', unboundPools: [] });
        await openImport();
        click('app.scenarioPreview');
        expect(await screen.findByText('From a friend')).toBeTruthy();
        click('app.scenarioImportConfirm');
        await waitFor(() =>
            expect(window.api.importScenario).toHaveBeenCalledWith('{"name":"Shared"}', {
                overwrite: false,
                expectedDefinitionRevision: undefined,
            }),
        );
    });

    test('check shows what it does; import stores it and closes the panel', async () => {
        jest.mocked(window.api.previewScenarioImport).mockResolvedValue(invalid(preview()));
        jest.mocked(window.api.importScenario).mockResolvedValue({ success: true, name: 'Shared', unboundPools: [] });
        await openImport();
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.scenarioImportConfirm' }).disabled).toBe(
            true,
        );
        click('app.scenarioPreview');
        expect(await screen.findByText('From a friend')).toBeTruthy();
        expect(screen.getByText('app.scenarioSpends')).toBeTruthy();
        expect(screen.getByText('app.scenarioLimits')).toBeTruthy();
        click('app.scenarioImportConfirm');
        await waitFor(() =>
            expect(window.api.importScenario).toHaveBeenCalledWith('{"name":"Shared"}', {
                overwrite: false,
                expectedDefinitionRevision: 7,
            }),
        );
        await waitFor(() => expect(screen.queryByLabelText('app.scenarioImportLabel')).toBeNull());
    });

    test('the preview calls out chosen-photo settings, and only when present', async () => {
        jest.mocked(window.api.previewScenarioImport).mockResolvedValueOnce(
            invalid(preview({ flagged: [{ phase: 'main', key: 'chosenPhotos' }] })),
        );
        await openImport();
        click('app.scenarioPreview');
        expect(await screen.findByText('app.scenarioFlagged')).toBeTruthy();
    });

    test('each flagged setting names its phase as "(phase N)"', async () => {
        mockTranslator.t.mockImplementation((key, vars) =>
            fillTemplate(
                key === 'app.scenarioFlagged'
                    ? 'Review: {settings}'
                    : key === 'app.scenarioStatusPhase'
                      ? 'phase {phase}'
                      : key === 'app.chosenPhotos'
                        ? 'Chosen Photos'
                        : key,
                vars,
            ),
        );
        try {
            jest.mocked(window.api.previewScenarioImport).mockResolvedValueOnce(
                invalid(preview({ flagged: [{ phase: 'main', key: 'chosenPhotos' }] })),
            );
            await openImport();
            click('app.scenarioPreview');
            expect(await screen.findByText('Review: Chosen Photos (phase main)')).toBeTruthy();
        } finally {
            mockTranslator.t.mockImplementation(defaultTranslate);
        }
    });

    test('a preview with nothing flagged has no review line', async () => {
        jest.mocked(window.api.previewScenarioImport).mockResolvedValueOnce(invalid(preview()));
        await openImport();
        click('app.scenarioPreview');
        await screen.findByText('From a friend');
        expect(screen.queryByText('app.scenarioFlagged')).toBeNull();
    });

    test('a scenario that exists needs the overwrite box; editing the text drops the preview', async () => {
        jest.mocked(window.api.previewScenarioImport).mockResolvedValue(
            invalid({
                ...preview({ spending: [], limits: {}, description: '' }),
                exists: true,
            }),
        );
        await openImport();
        click('app.scenarioPreview');
        expect(await screen.findByText('app.scenarioSpendsNothing')).toBeTruthy();
        expect(screen.getByText('app.scenarioNoLimits')).toBeTruthy();
        const confirm = screen.getByRole<HTMLButtonElement>('button', { name: 'app.scenarioImportConfirm' });
        expect(confirm.disabled).toBe(true);
        fireEvent.click(screen.getByRole('checkbox'));
        expect(confirm.disabled).toBe(false);
        fireEvent.change(screen.getByLabelText('app.scenarioImportLabel'), { target: { value: '{}' } });
        expect(screen.queryByText('app.scenarioSpendsNothing')).toBeNull();
    });

    test('an invalid file and a refused import list the problems', async () => {
        jest.mocked(window.api.previewScenarioImport).mockResolvedValueOnce(
            invalid({
                success: false,
                issues: [{ path: 'start', message: 'No phase' }],
            }),
        );
        await openImport();
        click('app.scenarioPreview');
        expect((await screen.findByRole('alert')).textContent).toContain('app.scenarioImportInvalid');
        jest.mocked(window.api.previewScenarioImport).mockResolvedValueOnce(invalid(preview()));
        jest.mocked(window.api.importScenario).mockResolvedValueOnce(invalid({ success: false }));
        click('app.scenarioPreview');
        await screen.findByText('From a friend');
        click('app.scenarioImportConfirm');
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('app.scenarioImportFailed'));
    });

    test('a rejected bridge call shows the failure instead of leaking the rejection', async () => {
        jest.mocked(window.api.previewScenarioImport).mockRejectedValueOnce(new Error('ipc down'));
        await openImport();
        click('app.scenarioPreview');
        expect((await screen.findByRole('alert')).textContent).toContain('app.scenarioImportInvalid');
    });

    test('cancel closes the panel', async () => {
        await openImport();
        click('app.cancel');
        expect(screen.queryByLabelText('app.scenarioImportLabel')).toBeNull();
    });
});

describe('builder', () => {
    test('New opens the builder on an empty scenario under a free name; cancel returns', async () => {
        withScenarios({ 'app.sbNew': plan });
        await renderSection();
        click('app.sbNew');
        expect(screen.getByText('app.sbTitleNew')).toBeTruthy();
        expect(screen.getByLabelText<HTMLInputElement>('app.sbName').value).toBe('app.sbNew 2');
        click('app.cancel');
        // Back on the list: the stored scenario's row is there again.
        expect(screen.getByTitle('app.sbNew')).toBeTruthy();
    });

    test('Edit opens the scenario; saving returns to the refreshed list', async () => {
        jest.mocked(window.api.saveScenario).mockResolvedValue({ success: true, name: 'Plan' });
        await renderSection();
        click('app.sbEdit: Plan');
        expect(screen.getByText('app.sbTitleEdit')).toBeTruthy();
        expect(screen.getByLabelText<HTMLInputElement>('app.sbName').value).toBe('Plan');
        const loads = jest.mocked(window.api.getScenarios).mock.calls.length;
        click('app.sbSave');
        await waitFor(() => expect(jest.mocked(window.api.getScenarios).mock.calls.length).toBeGreaterThan(loads));
        expect(screen.queryByText('app.sbTitleEdit')).toBeNull();
    });
});

describe('a rename inside the builder', () => {
    test('the list reloads under the open builder: the warning and the edits stay, and the retry saves under the new name and revision without renaming again', async () => {
        window.api.renameScenario = jest.fn().mockResolvedValue({ success: true, name: 'New' });
        window.api.saveScenario = jest
            .fn()
            .mockResolvedValueOnce(invalid({ success: false, error: 'busy' }))
            .mockResolvedValueOnce({ success: true, name: 'New' });
        await renderSection();
        click('app.sbEdit: Plan');
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        fireEvent.change(screen.getByLabelText('app.sbDescription'), { target: { value: 'Kept edit' } });
        // The reload after the rename is held back, so the list is loading while the builder is open.
        const loadsBefore = jest.mocked(window.api.getScenarios).mock.calls.length;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        jest.mocked(window.api.getScenarios).mockImplementation(async () => {
            await held;
            return invalid({
                success: true,
                scenarios: { New: { ...plan, name: 'New' } },
                revision: 8,
                templates: [template],
            });
        });
        click('app.sbSave');
        await waitFor(() =>
            expect(window.api.renameScenario).toHaveBeenCalledWith('Plan', 'New', { expectedDefinitionRevision: 7 }),
        );
        expect(await screen.findByText('app.sbRenamedNotSaved')).toBeTruthy();
        // The loader never replaced the builder: the same form is there, with the user's edit.
        expect(screen.queryByText('common.loading')).toBeNull();
        expect(screen.getByLabelText<HTMLInputElement>('app.sbDescription').value).toBe('Kept edit');
        release();
        await waitFor(() =>
            expect(jest.mocked(window.api.getScenarios).mock.calls.length).toBeGreaterThan(loadsBefore),
        );
        expect(screen.getByLabelText<HTMLInputElement>('app.sbName').value).toBe('New');
        expect(screen.getByRole('alert').textContent).toContain('app.scenarioRefusal_busy');
        // The retry names the scenario as it is stored now, and the revision the rename left.
        click('app.sbSave');
        await waitFor(() => expect(window.api.saveScenario).toHaveBeenCalledTimes(2));
        expect(window.api.renameScenario).toHaveBeenCalledTimes(1);
        expect(window.api.saveScenario).toHaveBeenLastCalledWith(
            expect.objectContaining({ name: 'New', description: 'Kept edit' }),
            { overwrite: true, expectedDefinitionRevision: 8 },
        );
    });

    test('a list that fails to reload under the open builder leaves the builder where it is', async () => {
        window.api.renameScenario = jest.fn().mockResolvedValue({ success: true, name: 'New' });
        window.api.saveScenario = jest.fn().mockResolvedValue(invalid({ success: false, error: 'busy' }));
        await renderSection();
        click('app.sbEdit: Plan');
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'New' } });
        const loadsBefore = jest.mocked(window.api.getScenarios).mock.calls.length;
        jest.mocked(window.api.getScenarios).mockResolvedValue({ success: false, error: 'x' });
        click('app.sbSave');
        expect(await screen.findByText('app.sbRenamedNotSaved')).toBeTruthy();
        await waitFor(() =>
            expect(jest.mocked(window.api.getScenarios).mock.calls.length).toBeGreaterThan(loadsBefore),
        );
        expect(screen.getByLabelText<HTMLInputElement>('app.sbName').value).toBe('New');
        expect(screen.queryByText('app.scenariosLoadError')).toBeNull();
    });

    test('a failed delete says its reason, not a bare failure', async () => {
        window.api.deleteScenario = jest.fn().mockResolvedValue(invalid({ success: false, error: 'unresolved-work' }));
        await renderSection();
        click('app.scenarioDelete: Plan');
        click('app.scenarioDeleteConfirm: Plan');
        expect((await screen.findByRole('alert')).textContent).toContain('app.scenarioRefusal_unresolvedWork');
    });
});

describe('the installation scenario', () => {
    const ops = { name: 'Ops', scope: 'installation', start: 'main', phases: { main: {} } };

    beforeEach(() => {
        withScenarios({ Plan: plan, Ops: ops });
        jest.mocked(window.api.getInstallationScenario).mockResolvedValue(
            invalid({
                success: true,
                installation: invalid({ scenario: 'Ops', executor: 'electron', generation: 3 }),
                generation: 3,
            }),
        );
    });

    test('shows the selected scenario, its owner and the generation, and saves a change under both', async () => {
        window.api.setInstallationScenario = jest
            .fn()
            .mockResolvedValue({ success: true, installation: null, generation: 4 });
        await renderSection();
        await screen.findByText('app.installationTitle');
        expect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario').value).toBe('Ops');
        expect(screen.getByLabelText<HTMLSelectElement>('app.installationOwner').value).toBe('electron');
        expect(screen.getByText(/app.installationGeneration/)).toBeTruthy();
        // Only installation scenarios are offered for the app.
        expect(
            within(screen.getByLabelText<HTMLSelectElement>('app.installationScenario')).queryByText('Plan'),
        ).toBeNull();
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario'), '');
        click('app.installationSave');
        await waitFor(() => expect(window.api.setInstallationScenario).toHaveBeenCalledWith(null, 'electron', 3));
    });

    test('a change of owner alone is a local transfer', async () => {
        window.api.transferInstallationScenarioOwner = jest
            .fn()
            .mockResolvedValue({ success: true, installation: null, generation: 4 });
        await renderSection();
        await screen.findByText('app.installationTitle');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationOwner'), 'cli');
        click('app.installationSave');
        await waitFor(() => expect(window.api.transferInstallationScenarioOwner).toHaveBeenCalledWith('cli', 3));
        expect(window.api.setInstallationScenario).not.toHaveBeenCalled();
    });

    test('a refused write shows its reason in plain words; a queued one keeps its request identity', async () => {
        window.api.setInstallationScenario = jest
            .fn()
            .mockResolvedValue(invalid({ success: false, error: 'stale-generation', generation: 9 }));
        await renderSection();
        await screen.findByText('app.installationTitle');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario'), '');
        click('app.installationSave');
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('alert').textContent).toContain('app.scenarioRefusal_staleGeneration');
    });

    test('an unanswered change asks to be checked, not sent again', async () => {
        window.api.setInstallationScenario = jest
            .fn()
            .mockResolvedValue(
                invalid({ success: true, pending: true, requestId: 'req-1', target: '@installation', revision: 2 }),
            );
        await renderSection();
        await screen.findByText('app.installationTitle');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario'), '');
        click('app.installationSave');
        await screen.findByText('app.effectQueued');
        click('app.installationSave');
        await waitFor(() => expect(window.api.setInstallationScenario).toHaveBeenCalledTimes(1));
    });
});

describe('the installation scenario edges', () => {
    const ops = { name: 'Ops', scope: 'installation', start: 'main', phases: { main: {} } };

    test('a refused owner transfer says its reason', async () => {
        withScenarios({ Ops: ops });
        jest.mocked(window.api.getInstallationScenario).mockResolvedValue(
            invalid({
                success: true,
                installation: invalid({ scenario: 'Ops', executor: 'electron', generation: 1 }),
                generation: 1,
            }),
        );
        window.api.transferInstallationScenarioOwner = jest
            .fn()
            .mockResolvedValue(invalid({ success: false, error: 'unresolved-work' }));
        await renderSection();
        await screen.findByText('app.installationTitle');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationOwner'), 'web');
        click('app.installationSave');
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('alert').textContent).toContain('app.scenarioRefusal_unresolvedWork');
    });

    test('an assignment that names a scenario no longer stored stays visible as missing', async () => {
        withScenarios({});
        jest.mocked(window.api.getInstallationScenario).mockResolvedValue(
            invalid({
                success: true,
                installation: invalid({ scenario: 'Gone', executor: 'cli', generation: 2 }),
                generation: 2,
            }),
        );
        await renderSection();
        const picker = await screen.findByLabelText<HTMLSelectElement>('app.installationScenario');
        expect(picker.value).toBe('Gone');
        expect(within(picker).getByText(/app\.scenarioMissingOption/)).toBeTruthy();
    });

    test('a read that fails leaves the panel on no assignment and Save disabled', async () => {
        withScenarios({ Ops: ops });
        jest.mocked(window.api.getInstallationScenario).mockResolvedValue(invalid({ success: false, error: 'x' }));
        await renderSection();
        await screen.findByText('app.installationTitle');
        expect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario').value).toBe('');
        window.api.setInstallationScenario = jest
            .fn()
            .mockResolvedValue({ success: true, installation: null, generation: 1 });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario'), 'Ops');
        // No generation was read, so nothing can be saved under one.
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.installationSave' }).disabled).toBe(true);
        click('app.installationSave');
        expect(window.api.setInstallationScenario).not.toHaveBeenCalled();
    });

    test('a read of a cleared assignment shows none selected', async () => {
        withScenarios({ Ops: ops });
        jest.mocked(window.api.getInstallationScenario).mockResolvedValue(
            invalid({ success: true, installation: null, generation: 4 }),
        );
        await renderSection();
        await screen.findByText('app.installationTitle');
        expect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario').value).toBe('');
    });

    test('a failure no wording knows reads the generic line', async () => {
        withScenarios({ Ops: ops });
        jest.mocked(window.api.getInstallationScenario).mockResolvedValue(
            invalid({
                success: true,
                installation: invalid({ scenario: 'Ops', executor: 'electron', generation: 1 }),
                generation: 1,
            }),
        );
        window.api.setInstallationScenario = jest.fn().mockResolvedValue(invalid({ success: false, error: 'mystery' }));
        await renderSection();
        await screen.findByText('app.installationTitle');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario'), '');
        click('app.installationSave');
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(screen.getByRole('alert').textContent).toContain('errors.actionFailed');
    });
});

describe('the installation scenario from a paired phone', () => {
    const ops = { name: 'Ops', scope: 'installation', start: 'main', phases: { main: {} } };
    const other = { name: 'Other', scope: 'installation', start: 'main', phases: { main: {} } };

    // The host's providers read the kind as they mount; the panel reads it when it renders, after the list has loaded.
    const renderOnPhone = async () => {
        render(
            <SettingsNavProvider value={shownNav('scenarios')}>
                <ScenariosSection isOpen={true} onDirtyChange={jest.fn()} />
            </SettingsNavProvider>,
        );
        markPlatformKind('remote');
        await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
    };
    afterEach(resetPlatformKind);

    test('the owner is text, and a change of scenario keeps the owner the installation has', async () => {
        withScenarios({ Ops: ops, Other: other });
        jest.mocked(window.api.getInstallationScenario).mockResolvedValue(
            invalid({
                success: true,
                installation: invalid({ scenario: 'Ops', executor: 'cli', generation: 3 }),
                generation: 3,
            }),
        );
        window.api.setInstallationScenario = jest
            .fn()
            .mockResolvedValue({ success: true, installation: null, generation: 4 });
        window.api.transferInstallationScenarioOwner = jest.fn();
        await renderOnPhone();
        await screen.findByText('app.installationTitle');
        expect(screen.queryByLabelText('app.installationOwner')).toBeNull();
        expect(screen.getByText('app.installationOwner_cli')).toBeTruthy();
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario'), 'Other');
        click('app.installationSave');
        await waitFor(() => expect(window.api.setInstallationScenario).toHaveBeenCalledWith('Other', 'cli', 3));
        expect(window.api.transferInstallationScenarioOwner).not.toHaveBeenCalled();
    });

    test('with no assignment there is no owner to keep: the phone is told to choose on the computer and cannot save', async () => {
        withScenarios({ Ops: ops });
        jest.mocked(window.api.getInstallationScenario).mockResolvedValue(
            invalid({ success: true, installation: null, generation: 0 }),
        );
        window.api.setInstallationScenario = jest.fn();
        await renderOnPhone();
        await screen.findByText('app.installationTitle');
        expect(screen.getByText('app.installationOwnerOnComputer')).toBeTruthy();
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.installationSave' }).disabled).toBe(true);
        // Even a click that reaches the handler (the button's own off switch taken away) sends nothing: with no owner
        // there is none to keep.
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario'), 'Ops');
        const save = screen.getByRole<HTMLButtonElement>('button', { name: 'app.installationSave' });
        save.removeAttribute('disabled');
        fireEvent.click(save);
        await Promise.resolve();
        expect(window.api.setInstallationScenario).not.toHaveBeenCalled();
    });
});

describe('the installation scenario with a request still open', () => {
    const ops = { name: 'Ops', scope: 'installation', start: 'main', phases: { main: {} } };
    const settled = (status: string): Awaited<ReturnType<typeof window.api.getScenarioRequestStatus>> =>
        invalid({
            success: true,
            state: 'request',
            record: {
                requestId: 'req-1',
                operation: 'o',
                target: '@installation',
                status,
                error: null,
                revision: 1,
                at: 1,
            },
        });

    beforeEach(() => {
        withScenarios({ Ops: ops });
        jest.mocked(window.api.getInstallationScenario).mockResolvedValue(
            invalid({
                success: true,
                installation: invalid({ scenario: 'Ops', executor: 'electron', generation: 3 }),
                generation: 3,
            }),
        );
        window.api.setInstallationScenario = jest
            .fn()
            .mockResolvedValue(
                invalid({ success: true, pending: true, requestId: 'req-1', target: '@installation', revision: 2 }),
            );
        window.api.transferInstallationScenarioOwner = jest
            .fn()
            .mockResolvedValue({ success: true, installation: null, generation: 5 });
    });

    test('a queued assignment keeps the form and the generation, blocks every write, and is checked by its own request', async () => {
        await renderSection();
        await screen.findByText('app.installationTitle');
        const reads = jest.mocked(window.api.getInstallationScenario).mock.calls.length;
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario'), '');
        click('app.installationSave');
        await screen.findByText('app.effectQueued');
        // Not applied yet: the pick stays and the generation is not read again.
        expect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario').value).toBe('');
        expect(jest.mocked(window.api.getInstallationScenario).mock.calls.length).toBe(reads);
        // Picking another owner now cannot send a transfer, and cannot move the notice to the transfer's request.
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationOwner'), 'cli');
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.installationSave' }).disabled).toBe(true);
        click('app.installationSave');
        expect(window.api.transferInstallationScenarioOwner).not.toHaveBeenCalled();
        jest.mocked(window.api.getScenarioRequestStatus).mockResolvedValueOnce(settled('applied'));
        click('app.effectCheckStatus');
        await waitFor(() => expect(screen.queryByText('app.effectQueued')).toBeNull());
        expect(window.api.getScenarioRequestStatus).toHaveBeenCalledWith({ requestId: 'req-1' });
        // The check was final, so the generation is read again.
        await waitFor(() =>
            expect(jest.mocked(window.api.getInstallationScenario).mock.calls.length).toBeGreaterThan(reads),
        );
        expect(window.api.transferInstallationScenarioOwner).not.toHaveBeenCalled();
    });

    test('a queued owner transfer is checked and dismissed as the transfer, not as an assignment', async () => {
        window.api.transferInstallationScenarioOwner = jest
            .fn()
            .mockResolvedValue(
                invalid({ success: true, pending: true, requestId: 'req-1', target: '@installation', revision: 2 }),
            );
        await renderSection();
        await screen.findByText('app.installationTitle');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationOwner'), 'cli');
        click('app.installationSave');
        await screen.findByText('app.effectQueued');
        // The form now matches the stored owner again, which would pick the assignment hook; the notice still acts on the transfer.
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationOwner'), 'electron');
        jest.mocked(window.api.getScenarioRequestStatus).mockResolvedValueOnce(settled('applied'));
        click('app.effectCheckStatus');
        await waitFor(() => expect(screen.queryByText('app.effectQueued')).toBeNull());
        expect(window.api.setInstallationScenario).not.toHaveBeenCalled();
    });

    test('the submitted form is frozen while its request is open; once it is confirmed the form shows what is stored, and Save waits for a fresh generation', async () => {
        window.api.transferInstallationScenarioOwner = jest
            .fn()
            .mockResolvedValue(
                invalid({ success: true, pending: true, requestId: 'req-1', target: '@installation', revision: 2 }),
            );
        await renderSection();
        await screen.findByText('app.installationTitle');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationOwner'), 'cli');
        click('app.installationSave');
        await screen.findByText('app.effectQueued');
        // The picks cannot change under the open request: nothing can be selected back to the old owner and sent.
        expect(screen.getByLabelText<HTMLSelectElement>('app.installationOwner').disabled).toBe(true);
        expect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario').disabled).toBe(true);
        // The check finds the transfer applied: the host now says the owner is the CLI, at generation 4 — but only after a read.
        let reply!: () => void;
        jest.mocked(window.api.getInstallationScenario).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    reply = () =>
                        resolve(
                            invalid({
                                success: true,
                                installation: invalid({ scenario: 'Ops', executor: 'cli', generation: 4 }),
                                generation: 4,
                            }),
                        );
                }),
        );
        jest.mocked(window.api.getScenarioRequestStatus).mockResolvedValueOnce(settled('applied'));
        click('app.effectCheckStatus');
        await waitFor(() => expect(screen.queryByText('app.effectQueued')).toBeNull());
        // The old generation (3) may not be sent again while the fresh one is being read.
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.installationSave' }).disabled).toBe(true);
        await act(async () => {
            reply();
        });
        await waitFor(() =>
            expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.installationSave' }).disabled).toBe(
                false,
            ),
        );
        expect(screen.getByLabelText<HTMLSelectElement>('app.installationOwner').value).toBe('cli');
        expect(screen.getByLabelText<HTMLSelectElement>('app.installationOwner').disabled).toBe(false);
        // A Save now is no change of owner: the picks that were submitted are gone.
        window.api.setInstallationScenario = jest
            .fn()
            .mockResolvedValue({ success: true, installation: null, generation: 5 });
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario'), '');
        click('app.installationSave');
        await waitFor(() => expect(window.api.setInstallationScenario).toHaveBeenCalledWith(null, 'cli', 4));
        expect(window.api.transferInstallationScenarioOwner).toHaveBeenCalledTimes(1);
    });

    test('a confirmed change whose re-read fails leaves no generation to send: Save stays off', async () => {
        window.api.setInstallationScenario = jest
            .fn()
            .mockResolvedValue({ success: true, installation: null, generation: 4 });
        await renderSection();
        await screen.findByText('app.installationTitle');
        jest.mocked(window.api.getInstallationScenario).mockResolvedValue(invalid({ success: false, error: 'x' }));
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario'), '');
        click('app.installationSave');
        await waitFor(() => expect(window.api.setInstallationScenario).toHaveBeenCalled());
        await waitFor(() =>
            expect(jest.mocked(window.api.getInstallationScenario).mock.calls.length).toBeGreaterThan(1),
        );
        await waitFor(() =>
            expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.installationSave' }).disabled).toBe(true),
        );
        expect(screen.queryByText(/app.installationGeneration/)).toBeNull();
    });

    test('a check that finds the request still open keeps the notice and reads nothing again', async () => {
        await renderSection();
        await screen.findByText('app.installationTitle');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario'), '');
        click('app.installationSave');
        await screen.findByText('app.effectQueued');
        const reads = jest.mocked(window.api.getInstallationScenario).mock.calls.length;
        jest.mocked(window.api.getScenarioRequestStatus).mockResolvedValueOnce(settled('pending'));
        click('app.effectCheckStatus');
        await waitFor(() => expect(window.api.getScenarioRequestStatus).toHaveBeenCalledWith({ requestId: 'req-1' }));
        expect(screen.getByText('app.effectQueued')).toBeTruthy();
        expect(jest.mocked(window.api.getInstallationScenario).mock.calls.length).toBe(reads);
    });

    test('Dismiss gives up the open request and unblocks Save', async () => {
        await renderSection();
        await screen.findByText('app.installationTitle');
        changeSelect(screen.getByLabelText<HTMLSelectElement>('app.installationScenario'), '');
        click('app.installationSave');
        await screen.findByText('app.effectQueued');
        click('errors.dismiss');
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'app.installationSave' }).disabled).toBe(false);
    });
});

describe('reading the photo pools', () => {
    test('a host that answers nothing, and one that holds no pools', async () => {
        jest.mocked(window.api.getPhotoPools)
            .mockResolvedValueOnce(undefined as never)
            .mockResolvedValueOnce(invalid({ success: true }));
        const first = render(<PoolsProbe />);
        await waitFor(() => expect(screen.getByTestId('pools').textContent).toBe('{}'));
        first.unmount();
        render(<PoolsProbe />);
        await waitFor(() => expect(screen.getByTestId('pools').textContent).toBe('{}'));
    });

    function PoolsProbe() {
        const { pools } = usePhotoPools();
        return <output data-testid="pools">{JSON.stringify(pools)}</output>;
    }
});

describe('the builder inside the section', () => {
    test('a rename that landed keeps the builder up, and a retry saves without renaming again', async () => {
        window.api.renameScenario = jest.fn().mockResolvedValue({ success: true, name: 'Renamed' });
        window.api.saveScenario = jest
            .fn()
            .mockResolvedValueOnce({ success: false, issues: [{ path: '', message: 'disk full' }] })
            .mockResolvedValueOnce({ success: true, name: 'Renamed' });
        await renderSection();
        click('app.sbEdit: Plan');
        await screen.findByText('app.sbTitleEdit');
        fireEvent.change(screen.getByLabelText('app.sbName'), { target: { value: 'Renamed' } });
        // The list re-reads once the rename lands, even though the save after it fails — and the open
        // builder (its warning, its edits, its retry state) stays mounted through that re-read.
        const before = jest.mocked(window.api.getScenarios).mock.calls.length;
        click('app.sbSave');
        await waitFor(() => expect(jest.mocked(window.api.getScenarios).mock.calls.length).toBeGreaterThan(before));
        expect(await screen.findByText('app.sbRenamedNotSaved')).toBeTruthy();
        click('app.sbSave');
        await waitFor(() => expect(screen.queryByText('app.sbTitleEdit')).toBeNull());
        expect(window.api.renameScenario).toHaveBeenCalledTimes(1);
        // The retry overwrites under the new name at the revision the rename advanced to.
        expect(window.api.saveScenario).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Renamed' }), {
            overwrite: true,
            expectedDefinitionRevision: 8,
        });
    });
});
