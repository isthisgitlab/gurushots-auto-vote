/**
 * Scenario IPC handlers: {success, error, issues} results, argument checks,
 * and never a throw to the renderer.
 */

jest.mock('../../src/ts/settings', () => ({
    checkScenario: jest.fn(),
    getScenarios: jest.fn(() => ({})),
    saveScenario: jest.fn(),
    renameScenario: jest.fn(),
    deleteScenario: jest.fn(),
    previewScenarioImport: jest.fn(),
    importScenario: jest.fn(),
    exportScenario: jest.fn(),
    exportScenarioWithNotes: jest.fn(),
    getEffectiveSetting: jest.fn(() => false),
}));
jest.mock('../../src/ts/services/scenarioStatus', () => {
    const ledger = { remove: jest.fn(async () => 'removed'), removeAll: jest.fn(async () => 'removed') };
    const release = jest.fn();
    return {
        getScenarioStatus: jest.fn(),
        ledgerForMode: jest.fn(() => ledger),
        stepLockForMode: jest.fn((_id: string | number) => ({ ok: true, release })),
        __ledger: ledger,
        __release: release,
    };
});
jest.mock('../../src/ts/scenarioStateStore', () => ({
    refreshScenarioStateAsync: jest.fn(async () => {}),
}));
jest.mock('../../src/ts/services/scenarioRunner', () => ({ backgroundServiceOwnsScenarios: jest.fn(() => false) }));
jest.mock('../../src/ts/services/auth', () => ({ requireAuthToken: jest.fn(() => ({ ok: true, token: 'tok' })) }));
jest.mock('../../src/ts/apiFactory', () => ({ getApiStrategy: jest.fn() }));
jest.mock('../../src/ts/logger', () => ({
    withCategory: jest.fn(() => ({ error: jest.fn(), info: jest.fn(), warning: jest.fn() })),
    sanitizeLogString: (value: string) => value,
}));

import type { ScenarioDocument } from '../../src/ts/settings/scenarioSchema';
import type { ScenarioStateLedger } from '../../src/ts/types/votingPass';
import type { ScenarioState } from '../../src/ts/types/stores';
import { invalid } from '../helpers/invalid';

import scenarioRunner = require('../../src/ts/services/scenarioRunner');
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import scenarioStatusModule = require('../../src/ts/services/scenarioStatus');
const scenarioStatus = jest.mocked(scenarioStatusModule);
const { refreshScenarioStateAsync } = jest.mocked(
    require('../../src/ts/scenarioStateStore') as typeof scenarioStateStoreModule,
);
import authModule = require('../../src/ts/services/auth');
const auth = jest.mocked(authModule);
import apiFactoryModule = require('../../src/ts/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import type * as scenarioStateStoreModule from '../../src/ts/scenarioStateStore';
import type * as templatesModule from '../../src/ts/scenarios/templates';
import type * as scenarios_handlersModule from '../../src/ts/ipc/scenarios.handlers';
const { SCENARIO_TEMPLATES } = require('../../src/ts/scenarios/templates') as typeof templatesModule;
const { buildHandlers, register } = require('../../src/ts/ipc/scenarios.handlers') as typeof scenarios_handlersModule;

const handlers = buildHandlers();
const issue = { path: 'start', message: 'No phase named "x"' };
const NOW = Math.floor(Date.now() / 1000);

const scenario: ScenarioDocument = {
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
        await expect(handlers['rename-scenario'](null, 'Old', invalid(5))).resolves.toEqual({
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
        await expect(handlers['delete-scenario'](null, invalid(null))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });
});

test('check-scenario validates without storing', async () => {
    settings.checkScenario
        .mockReturnValueOnce({ ok: true, scenario: invalid({}) })
        .mockReturnValueOnce({ ok: false, issues: [issue] });
    await expect(handlers['check-scenario'](null, {})).resolves.toEqual({ success: true });
    await expect(handlers['check-scenario'](null, {})).resolves.toEqual({
        success: false,
        error: issue.message,
        issues: [issue],
    });
});

describe('import / export', () => {
    test('preview and import', async () => {
        settings.previewScenarioImport.mockReturnValue({
            ok: true,
            scenario,
            preview: invalid({ name: 'Plan' }),
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
        settings.exportScenarioWithNotes
            .mockReturnValueOnce({ json: '{"name":"Plan"}\n', omitted: ['chosenPhotos'] })
            .mockReturnValueOnce(null);
        await expect(handlers['export-scenario'](null, 'Plan')).resolves.toEqual({
            success: true,
            json: '{"name":"Plan"}\n',
            omitted: ['chosenPhotos'],
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
        scenarioStatus.getScenarioStatus.mockReturnValue(
            invalid({ assigned: 'Plan', scenario, state: null, corrupt: false }),
        );
        await expect(handlers['get-scenario-status'](null, 7)).resolves.toEqual(
            expect.objectContaining({ success: true, assigned: 'Plan' }),
        );
        expect(refreshScenarioStateAsync).toHaveBeenCalled();
    });

    test('status carries Manual Only, read from the settings and never from the caller', async () => {
        scenarioStatus.getScenarioStatus.mockReturnValue(
            invalid({ assigned: 'Plan', scenario, state: null, corrupt: false }),
        );
        await expect(handlers['get-scenario-status'](null, 7)).resolves.toMatchObject({ manualOnly: false });
        settings.getEffectiveSetting.mockReturnValueOnce(true);
        await expect(handlers['get-scenario-status'](null, 7)).resolves.toMatchObject({ manualOnly: true });
        expect(settings.getEffectiveSetting).toHaveBeenLastCalledWith('manualPhotosOnly', '7');
    });

    test('status says whether the background service runs the plans, whatever this process could read', async () => {
        scenarioStatus.getScenarioStatus.mockReturnValue(
            invalid({ assigned: 'Plan', scenario, state: null, corrupt: 'unloaded' }),
        );
        await expect(handlers['get-scenario-status'](null, 7)).resolves.toMatchObject({ serviceRuns: false });
        jest.mocked(scenarioRunner.backgroundServiceOwnsScenarios).mockReturnValueOnce(true);
        await expect(handlers['get-scenario-status'](null, 7)).resolves.toMatchObject({ serviceRuns: true });
    });

    test.each([[undefined], [''], ['  '], [Number.NaN], [{}]])('refuses a bad challenge id %p', async (id) => {
        for (const channel of ['get-scenario-status', 'reset-scenario-state', 'dry-run-scenario'] as const) {
            await expect(handlers[channel](null, invalid(id))).resolves.toEqual({
                success: false,
                error: 'invalid-args',
            });
        }
    });

    // The ledger and the lock the module mock hands out, with what each did.
    const mocked = scenarioStatus as typeof scenarioStatus & {
        __ledger: {
            remove: jest.MockedFunction<ScenarioStateLedger['remove']>;
            removeAll: jest.MockedFunction<ScenarioStateLedger['removeAll']>;
        };
        __release: jest.Mock<void, []>;
    };

    test('the reserved key of the every-challenge reset is no challenge id: a reset of it is refused', async () => {
        await expect(handlers['reset-scenario-state'](null, '@all')).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        expect(mocked.__ledger.remove).not.toHaveBeenCalled();
    });

    test('reset forgets the challenge progress, under the challenge’s step lock, which is let go', async () => {
        await expect(handlers['reset-scenario-state'](null, 7)).resolves.toEqual({ success: true });
        expect(scenarioStatus.stepLockForMode).toHaveBeenCalledWith(7);
        expect(mocked.__ledger.remove).toHaveBeenCalledWith('7');
        expect(mocked.__release).toHaveBeenCalledTimes(1);
    });

    test('a challenge whose rule steps another process is running is busy: nothing is reset, and it is not reported as done', async () => {
        scenarioStatus.stepLockForMode.mockReturnValueOnce({ ok: false, release: mocked.__release });
        await expect(handlers['reset-scenario-state'](null, 7)).resolves.toEqual({ success: false, error: 'busy' });
        expect(mocked.__ledger.remove).not.toHaveBeenCalled();
        expect(mocked.__release).not.toHaveBeenCalled();
    });

    test('a lock the app cannot make at all is said so, not called busy: for the step lock and for the file', async () => {
        scenarioStatus.stepLockForMode.mockReturnValueOnce({ ok: false, release: mocked.__release, unavailable: true });
        await expect(handlers['reset-scenario-state'](null, 7)).resolves.toEqual({
            success: false,
            error: 'locks-unavailable',
        });
        mocked.__ledger.remove.mockResolvedValueOnce('unavailable');
        await expect(handlers['reset-scenario-state'](null, 7)).resolves.toEqual({
            success: false,
            error: 'locks-unavailable',
        });
        mocked.__ledger.removeAll.mockResolvedValueOnce('unavailable');
        await expect(handlers['reset-all-scenario-state'](null)).resolves.toEqual({
            success: false,
            error: 'locks-unavailable',
        });
    });

    test.each<['busy' | 'unreadable' | 'unloaded' | 'not-saved', string]>([
        ['busy', 'busy'],
        ['unreadable', 'state-unreadable'],
        ['unloaded', 'state-unloaded'],
        ['not-saved', 'not-saved'],
    ])('a ledger that answers %s is reported as %s, never as done, and the lock is let go', async (answer, error) => {
        mocked.__ledger.remove.mockResolvedValueOnce(answer);
        await expect(handlers['reset-scenario-state'](null, 7)).resolves.toEqual({ success: false, error });
        expect(mocked.__release).toHaveBeenCalledTimes(1);
    });

    test.each<['busy' | 'unreadable' | 'unloaded' | 'readable' | 'not-saved', string]>([
        ['busy', 'busy'],
        ['unloaded', 'state-unloaded'],
        ['readable', 'state-readable'],
        ['not-saved', 'not-saved'],
    ])('a reset of every challenge that the ledger answers %s is reported as %s', async (answer, error) => {
        mocked.__ledger.removeAll.mockResolvedValueOnce(answer);
        await expect(handlers['reset-all-scenario-state'](null)).resolves.toEqual({ success: false, error });
    });

    test('a reset of every challenge, the only way past an unreadable file; asked for only while it is unreadable when the caller says so', async () => {
        await expect(handlers['reset-all-scenario-state'](null)).resolves.toEqual({ success: true });
        expect(refreshScenarioStateAsync).toHaveBeenCalled();
        expect(mocked.__ledger.removeAll).toHaveBeenLastCalledWith(false);
        await handlers['reset-all-scenario-state'](null, true);
        expect(mocked.__ledger.removeAll).toHaveBeenLastCalledWith(true);
        await handlers['reset-all-scenario-state'](null, invalid<boolean>('yes'));
        expect(mocked.__ledger.removeAll).toHaveBeenLastCalledWith(false);
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
        apiFactory.getApiStrategy.mockReturnValue(invalid(strategy));
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
        expect((result as Extract<typeof result, { success: true }>).explain[0]).toEqual(
            expect.objectContaining({ ruleId: 'r1', status: 'waiting' }),
        );
    });

    test('Manual Only pauses the plan: manualOnly is set, nothing fires and no wake is due', async () => {
        settings.getEffectiveSetting.mockReturnValue(true);
        try {
            await expect(handlers['dry-run-scenario'](null, 7)).resolves.toEqual(
                expect.objectContaining({ success: true, manualOnly: true, fire: null, nextWakeAt: null }),
            );
        } finally {
            settings.getEffectiveSetting.mockReturnValue(false);
        }
        await expect(handlers['dry-run-scenario'](null, 7)).resolves.toEqual(
            expect.objectContaining({ manualOnly: false, fire: expect.objectContaining({ ruleId: 'r2' }) }),
        );
    });

    test('a plan that has not started has no phase clock: its in-phase bound is no wake', async () => {
        const phased: ScenarioDocument = {
            name: 'Phased',
            version: 1,
            start: 'main',
            phases: {
                main: {
                    rules: [
                        {
                            id: 'p',
                            if: [{ type: 'inPhaseFor', min: '4m' }],
                            do: [{ type: 'notify', message: 'x' }],
                        },
                    ],
                },
            },
        };
        const state = invalid<ScenarioState>({
            phase: 'main',
            phaseEnteredAt: NOW,
            memory: {},
            fired: {},
            inFlight: null,
        });
        scenarioStatus.getScenarioStatus.mockReturnValue({
            assigned: 'Phased',
            scenario: phased,
            state: null,
            corrupt: false,
            timezone: 'UTC',
        });
        await expect(handlers['dry-run-scenario'](null, 7)).resolves.toEqual(
            expect.objectContaining({ started: false, nextWakeAt: null }),
        );
        scenarioStatus.getScenarioStatus.mockReturnValue({
            assigned: 'Phased',
            scenario: phased,
            state,
            corrupt: false,
            timezone: 'UTC',
        });
        await expect(handlers['dry-run-scenario'](null, 7)).resolves.toEqual(
            expect.objectContaining({ started: true, nextWakeAt: NOW + 240 }),
        );
    });

    test('reads the speed history the live pass would: a sample is recorded and the old ones aged out', async () => {
        const speedy: ScenarioDocument = {
            name: 'Speedy',
            version: 1,
            start: 'main',
            phases: {
                main: {
                    rules: [
                        {
                            id: 's',
                            if: [
                                {
                                    type: 'entry',
                                    select: { by: 'mostVotes' },
                                    field: 'votesPerHour',
                                    op: '>',
                                    value: 0,
                                },
                            ],
                            do: [{ type: 'notify', message: 'x' }],
                        },
                    ],
                },
            },
        };
        strategy.getActiveChallenges.mockResolvedValueOnce(
            invalid({
                challenges: [
                    {
                        id: 7,
                        close_time: NOW + 86400,
                        member: { ranking: { entries: [{ id: 11, votes: 90, rank: 1 }] } },
                    },
                ],
            }),
        );
        // The only sample is older than the 48 h the live pass keeps: it is dropped, the fresh one is too
        // recent to measure from, so the speed reads nothing and the rule waits.
        scenarioStatus.getScenarioStatus.mockReturnValue({
            assigned: 'Speedy',
            scenario: speedy,
            state: invalid({
                phase: 'main',
                phaseEnteredAt: NOW - 400000,
                memory: {},
                fired: {},
                inFlight: null,
                history: { '11': [[NOW - 3 * 86400, 10]] },
            }),
            corrupt: false,
            timezone: 'UTC',
        });
        await expect(handlers['dry-run-scenario'](null, 7)).resolves.toEqual(
            expect.objectContaining({ fire: null, explain: [expect.objectContaining({ status: 'waiting' })] }),
        );
        // Samples inside the 48 h are kept, so the speed over the whole gap reads.
        strategy.getActiveChallenges.mockResolvedValueOnce(
            invalid({
                challenges: [
                    {
                        id: 7,
                        close_time: NOW + 86400,
                        member: { ranking: { entries: [{ id: 11, votes: 90, rank: 1 }] } },
                    },
                ],
            }),
        );
        scenarioStatus.getScenarioStatus.mockReturnValue({
            assigned: 'Speedy',
            scenario: speedy,
            state: invalid({
                phase: 'main',
                phaseEnteredAt: NOW - 400000,
                memory: {},
                fired: {},
                inFlight: null,
                history: { '11': [[NOW - 86400, 10]] },
            }),
            corrupt: false,
            timezone: 'UTC',
        });
        await expect(handlers['dry-run-scenario'](null, 7)).resolves.toEqual(
            expect.objectContaining({ fire: expect.objectContaining({ ruleId: 's' }) }),
        );
    });

    test('uses the stored state once started; nothing ready → no fire', async () => {
        scenarioStatus.getScenarioStatus.mockReturnValue({
            assigned: 'Plan',
            scenario: { ...scenario, phases: { main: { rules: [scenario.phases.main.rules![0]] } } },
            state: invalid({ phase: 'main', phaseEnteredAt: NOW, memory: {}, fired: {}, inFlight: null }),
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
        [{ assigned: 'Plan', scenario, corrupt: 'unloaded' }, 'state-unloaded'],
    ])('refuses %p', async (status, error) => {
        scenarioStatus.getScenarioStatus.mockReturnValue(invalid(status));
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

describe('simulate-scenario', () => {
    const strategy = {
        getActiveChallenges: jest.fn(async () => ({
            challenges: [{ id: 7, close_time: NOW + 3600, member: { ranking: { entries: [] } } }],
        })),
        getBankroll: jest.fn(async () => ({})),
    };
    const timed: ScenarioDocument = {
        name: 'Draft',
        version: 1,
        start: 'main',
        phases: {
            main: {
                rules: [{ id: 't', if: [{ type: 'inPhaseFor', min: '4m' }], do: [{ type: 'notify', message: 'x' }] }],
            },
        },
    };

    beforeEach(() => {
        apiFactory.getApiStrategy.mockReturnValue(invalid(strategy));
        scenarioStatus.getScenarioStatus.mockReturnValue({
            assigned: 'Plan',
            scenario,
            state: null,
            corrupt: false,
            timezone: 'UTC',
        });
    });

    test('simulates the assigned scenario from its current state', async () => {
        const result = await handlers['simulate-scenario'](null, 7);
        expect(result).toEqual(
            expect.objectContaining({
                success: true,
                scenario: 'Plan',
                startPhase: 'main',
                stoppedBecause: expect.any(String),
            }),
        );
        expect((result as Extract<typeof result, { events: unknown }>).events[0]).toEqual(
            expect.objectContaining({ ruleId: 'r2' }),
        );
    });

    test('Manual Only is carried with the timeline, which stays', async () => {
        settings.getEffectiveSetting.mockReturnValueOnce(true);
        const result = await handlers['simulate-scenario'](null, 7);
        expect(result).toEqual(expect.objectContaining({ success: true, manualOnly: true }));
        expect((result as Extract<typeof result, { events: unknown }>).events[0]).toEqual(
            expect.objectContaining({ ruleId: 'r2' }),
        );
        await expect(handlers['simulate-scenario'](null, 7)).resolves.toEqual(
            expect.objectContaining({ manualOnly: false }),
        );
    });

    test('simulates an unsaved draft from its start phase, even without an assignment', async () => {
        scenarioStatus.getScenarioStatus.mockReturnValue({
            assigned: '',
            scenario: null,
            state: null,
            corrupt: 'file',
            timezone: 'UTC',
        });
        settings.checkScenario.mockReturnValue({ ok: true, scenario: timed });
        const result = await handlers['simulate-scenario'](null, 7, timed);
        expect(settings.checkScenario).toHaveBeenCalledWith(timed);
        expect((result as Extract<typeof result, { events: unknown }>).events).toEqual([
            expect.objectContaining({ ruleId: 't', at: expect.any(Number) }),
        ]);
    });

    test('an invalid draft reports its issues; a bad id is refused', async () => {
        settings.checkScenario.mockReturnValueOnce({ ok: false, issues: [{ path: 'start', message: 'No phase' }] });
        await expect(handlers['simulate-scenario'](null, 7, {})).resolves.toEqual({
            success: false,
            error: 'No phase',
            issues: [{ path: 'start', message: 'No phase' }],
        });
        settings.checkScenario.mockReturnValueOnce({ ok: false, issues: [] });
        await expect(handlers['simulate-scenario'](null, 7, {})).resolves.toEqual(
            expect.objectContaining({ error: 'Invalid scenario' }),
        );
        await expect(handlers['simulate-scenario'](null, '')).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });

    test('refuses what the dry run refuses', async () => {
        scenarioStatus.getScenarioStatus.mockReturnValue(invalid({ assigned: '', scenario: null }));
        await expect(handlers['simulate-scenario'](null, 7)).resolves.toEqual({
            success: false,
            error: 'no-scenario',
        });
    });
});

test('register wires every handler through the trusted-sender wrapper', () => {
    const ipcMain = { handle: jest.fn<void, [channel: string, listener: unknown]>() };
    register(invalid(ipcMain));
    expect(ipcMain.handle.mock.calls.map(([channel]) => channel)).toEqual(Object.keys(handlers));
});
