/**
 * Scenario IPC handlers: {success, error, issues} results, argument checks,
 * and never a throw to the renderer.
 */

jest.mock('../../src/js/settings', () => ({
    getScenarios: jest.fn(() => ({})),
    saveScenario: jest.fn(),
    renameScenario: jest.fn(),
    deleteScenario: jest.fn(),
    previewScenarioImport: jest.fn(),
    importScenario: jest.fn(),
    exportScenario: jest.fn(),
}));
jest.mock('../../src/js/services/scenarioStatus', () => {
    const ledger = { remove: jest.fn() };
    return { getScenarioStatus: jest.fn(), ledgerForMode: jest.fn(() => ledger), __ledger: ledger };
});
jest.mock('../../src/js/scenarioStateStore', () => ({ refreshScenarioStateAsync: jest.fn(async () => {}) }));
jest.mock('../../src/js/services/auth', () => ({ requireAuthToken: jest.fn(() => ({ ok: true, token: 'tok' })) }));
jest.mock('../../src/js/apiFactory', () => ({ getApiStrategy: jest.fn() }));
jest.mock('../../src/js/logger', () => ({
    withCategory: jest.fn(() => ({ error: jest.fn(), info: jest.fn() })),
    sanitizeLogString: (value) => value,
}));

const settings = require('../../src/js/settings');
const scenarioStatus = require('../../src/js/services/scenarioStatus');
const { refreshScenarioStateAsync } = require('../../src/js/scenarioStateStore');
const auth = require('../../src/js/services/auth');
const apiFactory = require('../../src/js/apiFactory');
const { SCENARIO_TEMPLATES } = require('../../src/js/scenarios/templates');
const { buildHandlers, register } = require('../../src/js/ipc/scenarios.handlers');

const handlers = buildHandlers();
const issue = { path: 'start', message: 'No phase named "x"' };
const NOW = Math.floor(Date.now() / 1000);

const scenario = {
    name: 'Plan',
    version: 1,
    start: 'main',
    phases: {
        main: {
            rules: [
                { id: 'r1', if: [{ type: 'entries', op: '>', value: 5 }], do: [{ type: 'fillExposure' }] },
                { id: 'r2', do: [{ type: 'fillExposure' }, { type: 'goto', phase: 'main' }] },
            ],
        },
    },
};

beforeEach(() => jest.clearAllMocks());

test('get-scenarios returns the stored scenarios and the templates', async () => {
    settings.getScenarios.mockReturnValue({ Plan: scenario });
    await expect(handlers['get-scenarios']()).resolves.toEqual({
        success: true,
        scenarios: { Plan: scenario },
        templates: SCENARIO_TEMPLATES,
    });
});

describe('save / rename / delete', () => {
    test('save passes overwrite through and maps issues', async () => {
        settings.saveScenario.mockReturnValueOnce({ ok: true, name: 'Plan' });
        await expect(handlers['save-scenario'](null, scenario)).resolves.toEqual({ success: true, name: 'Plan' });
        expect(settings.saveScenario).toHaveBeenCalledWith(scenario, { overwrite: true });
        settings.saveScenario.mockReturnValueOnce({ ok: false, issues: [issue] });
        await expect(handlers['save-scenario'](null, scenario, { overwrite: false })).resolves.toEqual({
            success: false,
            error: issue.message,
            issues: [issue],
        });
        expect(settings.saveScenario).toHaveBeenLastCalledWith(scenario, { overwrite: false });
    });

    test('an issue list without entries still yields an error', async () => {
        settings.saveScenario.mockReturnValueOnce({ ok: false, issues: [] });
        await expect(handlers['save-scenario'](null, {})).resolves.toEqual(
            expect.objectContaining({ success: false, error: 'Invalid scenario' }),
        );
    });

    test('rename checks its arguments', async () => {
        settings.renameScenario.mockReturnValueOnce({ ok: true, name: 'New' });
        await expect(handlers['rename-scenario'](null, 'Old', 'New')).resolves.toEqual(
            expect.objectContaining({ success: true, name: 'New' }),
        );
        await expect(handlers['rename-scenario'](null, '', 'New')).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        await expect(handlers['rename-scenario'](null, 'Old', 5)).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });

    test('delete reports a missing scenario', async () => {
        settings.deleteScenario.mockReturnValueOnce(true).mockReturnValueOnce(false);
        await expect(handlers['delete-scenario'](null, 'Plan')).resolves.toEqual({ success: true });
        await expect(handlers['delete-scenario'](null, 'Plan')).resolves.toEqual({
            success: false,
            error: 'not-found',
        });
        await expect(handlers['delete-scenario'](null, null)).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });
});

describe('import / export', () => {
    test('preview and import', async () => {
        settings.previewScenarioImport.mockReturnValue({
            ok: true,
            scenario,
            preview: { name: 'Plan' },
            exists: false,
        });
        await expect(handlers['preview-scenario-import'](null, '{}')).resolves.toEqual(
            expect.objectContaining({ success: true, exists: false }),
        );
        settings.importScenario.mockReturnValue({ ok: true, name: 'Plan' });
        await handlers['import-scenario'](null, '{}');
        expect(settings.importScenario).toHaveBeenLastCalledWith('{}', { overwrite: false });
        await handlers['import-scenario'](null, '{}', { overwrite: true });
        expect(settings.importScenario).toHaveBeenLastCalledWith('{}', { overwrite: true });
    });

    test('export returns the JSON or not-found', async () => {
        settings.exportScenario.mockReturnValueOnce('{"name":"Plan"}\n').mockReturnValueOnce(null);
        await expect(handlers['export-scenario'](null, 'Plan')).resolves.toEqual({
            success: true,
            json: '{"name":"Plan"}\n',
        });
        await expect(handlers['export-scenario'](null, 'Plan')).resolves.toEqual({
            success: false,
            error: 'not-found',
        });
        await expect(handlers['export-scenario'](null, '')).resolves.toEqual({ success: false, error: 'invalid-args' });
    });
});

describe('status and reset', () => {
    test('status re-reads the shared state first', async () => {
        scenarioStatus.getScenarioStatus.mockReturnValue({ assigned: 'Plan', scenario, state: null, corrupt: false });
        await expect(handlers['get-scenario-status'](null, 7)).resolves.toEqual(
            expect.objectContaining({ success: true, assigned: 'Plan' }),
        );
        expect(refreshScenarioStateAsync).toHaveBeenCalled();
    });

    test.each([[undefined], [''], ['  '], [Number.NaN], [{}]])('refuses a bad challenge id %p', async (id) => {
        for (const channel of ['get-scenario-status', 'reset-scenario-state', 'dry-run-scenario']) {
            await expect(handlers[channel](null, id)).resolves.toEqual({ success: false, error: 'invalid-args' });
        }
    });

    test('reset forgets the challenge progress', async () => {
        await expect(handlers['reset-scenario-state'](null, 7)).resolves.toEqual({ success: true });
        expect(scenarioStatus.__ledger.remove).toHaveBeenCalledWith('7');
    });

    test('a throw becomes an error result', async () => {
        scenarioStatus.getScenarioStatus.mockImplementationOnce(() => {
            throw new Error('boom');
        });
        await expect(handlers['get-scenario-status'](null, '7')).resolves.toEqual({ success: false, error: 'boom' });
        scenarioStatus.getScenarioStatus.mockImplementationOnce(() => {
            throw null;
        });
        await expect(handlers['get-scenario-status'](null, '7')).resolves.toEqual({
            success: false,
            error: 'The get-scenario-status request failed',
        });
    });
});

describe('dry-run-scenario', () => {
    const strategy = {
        getActiveChallenges: jest.fn(async () => ({
            challenges: [{ id: 7, close_time: NOW + 86400, member: { ranking: { entries: [] } } }],
        })),
        getBankroll: jest.fn(async () => ({ keys: 1 })),
    };

    beforeEach(() => {
        apiFactory.getApiStrategy.mockReturnValue(strategy);
        scenarioStatus.getScenarioStatus.mockReturnValue({
            assigned: 'Plan',
            scenario,
            state: null,
            corrupt: false,
            timezone: 'UTC',
        });
    });

    test('reports what would fire now, from the start phase when the plan has not started', async () => {
        const result = await handlers['dry-run-scenario'](null, 7);
        expect(result).toEqual(
            expect.objectContaining({
                success: true,
                scenario: 'Plan',
                phase: 'main',
                started: false,
                halted: null,
                fire: { ruleId: 'r2', startIndex: 0, actions: ['fillExposure', 'goto'] },
            }),
        );
        expect(result.explain[0]).toEqual(expect.objectContaining({ ruleId: 'r1', status: 'waiting' }));
    });

    test('uses the stored state once started; nothing ready → no fire', async () => {
        scenarioStatus.getScenarioStatus.mockReturnValue({
            assigned: 'Plan',
            scenario: { ...scenario, phases: { main: { rules: [scenario.phases.main.rules[0]] } } },
            state: { phase: 'main', phaseEnteredAt: NOW, memory: {}, fired: {}, inFlight: null },
            corrupt: false,
            timezone: 'UTC',
        });
        await expect(handlers['dry-run-scenario'](null, 7)).resolves.toEqual(
            expect.objectContaining({ started: true, fire: null }),
        );
    });

    test.each([
        [{ assigned: '', scenario: null }, 'no-scenario'],
        [{ assigned: 'Gone', scenario: null }, 'unknown-scenario'],
        [{ assigned: 'Plan', scenario, corrupt: true }, 'state-unreadable'],
    ])('refuses %p', async (status, error) => {
        scenarioStatus.getScenarioStatus.mockReturnValue(status);
        await expect(handlers['dry-run-scenario'](null, 7)).resolves.toEqual({ success: false, error });
    });

    test('needs a token and a live challenge', async () => {
        auth.requireAuthToken.mockReturnValueOnce({ ok: false, response: { success: false, error: 'no token' } });
        await expect(handlers['dry-run-scenario'](null, 7)).resolves.toEqual({ success: false, error: 'no token' });
        await expect(handlers['dry-run-scenario'](null, 8)).resolves.toEqual({
            success: false,
            error: 'challenge-not-found',
        });
    });
});

test('register wires every handler through the trusted-sender wrapper', () => {
    const ipcMain = { handle: jest.fn() };
    register(ipcMain);
    expect(ipcMain.handle.mock.calls.map(([channel]) => channel)).toEqual(Object.keys(handlers));
});
