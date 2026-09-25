/**
 * The settings modal's Scenarios section: list, export, rename, two-step
 * delete, a copy from a template, and import with its preview.
 */

import { act, render, screen, waitFor, fireEvent } from './helpers/test-utils';
import { ScenariosSection } from '@/components/app/ScenariosSection';

const plan = { name: 'Plan', start: 'main', description: 'Mine', phases: { main: {}, done: {} } };
const template = { id: 'evening', scenario: { name: 'Evening', start: 'main', phases: { main: {} } } };

const withScenarios = (scenarios = { Plan: plan }) =>
    window.api.getScenarios.mockResolvedValue({ success: true, scenarios, templates: [template] });

const renderSection = async () => {
    render(<ScenariosSection isOpen={true} />);
    await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

const click = (name) => fireEvent.click(screen.getByRole('button', { name }));

// A <select>'s onChange stays a native 'change' listener under preact/compat
// (see ChallengeProfilesBar.test.jsx), so dispatch the real event.
const changeSelect = (sel, value) =>
    act(() => {
        sel.value = value;
        sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    });

beforeEach(() => {
    withScenarios();
    window.api.checkScenario = jest.fn(async () => ({ success: true }));
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
        window.api.getScenarios.mockResolvedValue({ success: false, error: 'x' });
        await renderSection();
        expect(screen.getByRole('alert').textContent).toBe('app.scenariosLoadError');
    });
});

describe('a scenario row', () => {
    test('export shows the JSON, and hides again', async () => {
        window.api.exportScenario.mockResolvedValue({ success: true, json: '{"name":"Plan"}' });
        await renderSection();
        click('app.scenarioExport');
        const box = await screen.findByLabelText('app.scenarioExportLabel');
        expect(box.value).toBe('{"name":"Plan"}');
        fireEvent.focus(box);
        click('app.scenarioExportClose');
        expect(screen.queryByLabelText('app.scenarioExportLabel')).toBeNull();
    });

    test('a failed export shows the error', async () => {
        window.api.exportScenario.mockResolvedValue({ success: false, error: 'not-found' });
        await renderSection();
        click('app.scenarioExport');
        expect((await screen.findByRole('alert')).textContent).toContain('app.scenarioExportFailed');
    });

    test('rename saves the new name; cancel leaves it', async () => {
        window.api.renameScenario.mockResolvedValue({ success: true, name: 'New' });
        await renderSection();
        click('app.scenarioRename');
        fireEvent.change(screen.getByLabelText('app.scenarioRenameLabel'), { target: { value: 'New' } });
        click('app.scenarioRenameSave');
        await waitFor(() => expect(window.api.renameScenario).toHaveBeenCalledWith('Plan', 'New'));
        await waitFor(() => expect(screen.queryByLabelText('app.scenarioRenameLabel')).toBeNull());
        click('app.scenarioRename');
        click('app.cancel');
        expect(screen.queryByLabelText('app.scenarioRenameLabel')).toBeNull();
    });

    test('a refused rename lists the problems', async () => {
        window.api.renameScenario.mockResolvedValue({
            success: false,
            issues: [
                { path: 'name', message: 'taken' },
                { path: '', message: 'root' },
            ],
        });
        await renderSection();
        click('app.scenarioRename');
        click('app.scenarioRenameSave');
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain('app.scenarioRenameFailed');
        expect(alert.textContent).toContain('name taken');
        expect(alert.textContent).toContain('root');
    });

    test('delete needs a second click, which then deletes', async () => {
        window.api.deleteScenario.mockResolvedValue({ success: true });
        await renderSection();
        click('app.scenarioDelete');
        expect(window.api.deleteScenario).not.toHaveBeenCalled();
        click('app.scenarioDeleteConfirm');
        await waitFor(() => expect(window.api.deleteScenario).toHaveBeenCalledWith('Plan'));
    });

    test('an armed delete disarms itself; a failed delete shows the error', async () => {
        jest.useFakeTimers();
        try {
            window.api.deleteScenario.mockResolvedValue({ success: false });
            render(<ScenariosSection isOpen={true} />);
            await act(async () => {
                await Promise.resolve();
            });
            await act(async () => {
                await Promise.resolve();
            });
            click('app.scenarioDelete');
            act(() => jest.advanceTimersByTime(4000));
            expect(screen.getByRole('button', { name: 'app.scenarioDelete' })).toBeTruthy();
            click('app.scenarioDelete');
            click('app.scenarioDeleteConfirm');
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
        window.api.saveScenario.mockResolvedValue({ success: true, name: 'Evening 3' });
        await renderSection();
        expect(screen.getByRole('button', { name: 'app.scenarioAddTemplate' }).disabled).toBe(true);
        changeSelect(screen.getByLabelText('app.scenarioTemplatePick'), 'evening');
        click('app.scenarioAddTemplate');
        await waitFor(() =>
            expect(window.api.saveScenario).toHaveBeenCalledWith(expect.objectContaining({ name: 'Evening 3' }), {
                overwrite: false,
            }),
        );
    });

    test('a refused copy shows the error', async () => {
        window.api.saveScenario.mockResolvedValue({ success: false });
        await renderSection();
        changeSelect(screen.getByLabelText('app.scenarioTemplatePick'), 'evening');
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
            limits: { swaps: 2 },
            ...overrides,
        },
    });

    const openImport = async () => {
        await renderSection();
        click('app.scenarioImport');
        fireEvent.change(screen.getByLabelText('app.scenarioImportLabel'), { target: { value: '{"name":"Shared"}' } });
    };

    test('check shows what it does; import stores it and closes the panel', async () => {
        window.api.previewScenarioImport.mockResolvedValue(preview());
        window.api.importScenario.mockResolvedValue({ success: true, name: 'Shared' });
        await openImport();
        expect(screen.getByRole('button', { name: 'app.scenarioImportConfirm' }).disabled).toBe(true);
        click('app.scenarioPreview');
        expect(await screen.findByText('From a friend')).toBeTruthy();
        expect(screen.getByText('app.scenarioSpends')).toBeTruthy();
        expect(screen.getByText('app.scenarioLimits')).toBeTruthy();
        click('app.scenarioImportConfirm');
        await waitFor(() =>
            expect(window.api.importScenario).toHaveBeenCalledWith('{"name":"Shared"}', { overwrite: false }),
        );
        await waitFor(() => expect(screen.queryByLabelText('app.scenarioImportLabel')).toBeNull());
    });

    test('a scenario that exists needs the overwrite box; editing the text drops the preview', async () => {
        window.api.previewScenarioImport.mockResolvedValue({
            ...preview({ spending: [], limits: {}, description: '' }),
            exists: true,
        });
        await openImport();
        click('app.scenarioPreview');
        expect(await screen.findByText('app.scenarioSpendsNothing')).toBeTruthy();
        expect(screen.getByText('app.scenarioNoLimits')).toBeTruthy();
        const confirm = screen.getByRole('button', { name: 'app.scenarioImportConfirm' });
        expect(confirm.disabled).toBe(true);
        fireEvent.click(screen.getByRole('checkbox'));
        expect(confirm.disabled).toBe(false);
        fireEvent.change(screen.getByLabelText('app.scenarioImportLabel'), { target: { value: '{}' } });
        expect(screen.queryByText('app.scenarioSpendsNothing')).toBeNull();
    });

    test('an invalid file and a refused import list the problems', async () => {
        window.api.previewScenarioImport.mockResolvedValueOnce({
            success: false,
            issues: [{ path: 'start', message: 'No phase' }],
        });
        await openImport();
        click('app.scenarioPreview');
        expect((await screen.findByRole('alert')).textContent).toContain('app.scenarioImportInvalid');
        window.api.previewScenarioImport.mockResolvedValueOnce(preview());
        window.api.importScenario.mockResolvedValueOnce({ success: false });
        click('app.scenarioPreview');
        await screen.findByText('From a friend');
        click('app.scenarioImportConfirm');
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('app.scenarioImportFailed'));
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
        expect(screen.getByLabelText('app.sbName').value).toBe('app.sbNew 2');
        click('app.cancel');
        // Back on the list: the stored scenario's row is there again.
        expect(screen.getByTitle('app.sbNew')).toBeTruthy();
    });

    test('Edit opens the scenario; saving returns to the refreshed list', async () => {
        window.api.saveScenario.mockResolvedValue({ success: true, name: 'Plan' });
        await renderSection();
        click('app.sbEdit');
        expect(screen.getByText('app.sbTitleEdit')).toBeTruthy();
        expect(screen.getByLabelText('app.sbName').value).toBe('Plan');
        const loads = window.api.getScenarios.mock.calls.length;
        click('app.sbSave');
        await waitFor(() => expect(window.api.getScenarios.mock.calls.length).toBeGreaterThan(loads));
        expect(screen.queryByText('app.sbTitleEdit')).toBeNull();
    });
});
