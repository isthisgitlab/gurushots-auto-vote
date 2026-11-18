/**
 * Scenario IPC handlers: {success, error, issues} results, argument checks,
 * and never a throw to the renderer.
 */

jest.mock('../../src/ts/core/settings', () => ({
    checkScenario: jest.fn(),
    getScenario: jest.fn(),
    getScenarioLibrary: jest.fn(() => ({ scenarios: {}, revision: 0 })),
    saveScenario: jest.fn(),
    renameScenario: jest.fn(),
    deleteScenario: jest.fn(),
    previewScenarioImport: jest.fn(),
    importScenario: jest.fn(),
    exportScenario: jest.fn(),
    exportScenarioWithNotes: jest.fn(),
    getEffectiveSetting: jest.fn(() => false),
    scenarioOverlayStatus: jest.fn(() => ({
        bound: false,
        available: true,
        reason: null,
        sources: { literals: [], bindings: [], profile: [] },
        published: null,
    })),
    readScenarioSetting: jest.fn(),
}));
jest.mock('../../src/ts/core/services/scenarioStatus', () => {
    const ledger = { remove: jest.fn(async () => 'removed'), removeAll: jest.fn(async () => 'removed') };
    const release = jest.fn();
    return {
        getScenarioStatus: jest.fn(),
        readSubjectRows: jest.fn(),
        ledgerForMode: jest.fn(() => ledger),
        stepLockForMode: jest.fn((_id: string | number) => ({ ok: true, release })),
        __ledger: ledger,
        __release: release,
    };
});
jest.mock('../../src/ts/core/scenarioStateStore', () => ({
    refreshScenarioStateAsync: jest.fn(async () => {}),
}));
jest.mock('../../src/ts/core/services/scenarioRunner', () => ({
    backgroundServiceOwnsScenarios: jest.fn(() => false),
}));
jest.mock('../../src/ts/core/services/scenarioRunner/simulation', () => ({ runSimulation: jest.fn() }));
jest.mock('../../src/ts/core/services/auth', () => ({ requireAuthToken: jest.fn(() => ({ ok: true, token: 'tok' })) }));
jest.mock('../../src/ts/core/apiFactory', () => ({ getApiStrategy: jest.fn() }));
jest.mock('../../src/ts/core/logger', () => ({
    withCategory: jest.fn(() => ({ error: jest.fn(), info: jest.fn(), warning: jest.fn() })),
    sanitizeLogString: (value: string) => value,
}));

import type { ScenarioDocument } from '../../src/ts/core/settings/scenarioSchema';
import type { SimulationResult } from '../../src/ts/core/types/scenario';
import type { ScenarioStateLedger } from '../../src/ts/core/types/votingPass';
import type { ScenarioState } from '../../src/ts/core/types/stores';
import { invalid } from '../helpers/invalid';

import scenarioRunner = require('../../src/ts/core/services/scenarioRunner');
import settingsModule = require('../../src/ts/core/settings');
const settings = jest.mocked(settingsModule);
import scenarioStatusModule = require('../../src/ts/core/services/scenarioStatus');
const scenarioStatus = jest.mocked(scenarioStatusModule);
const { refreshScenarioStateAsync } = jest.mocked(
    require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule,
);
import simulationModule = require('../../src/ts/core/services/scenarioRunner/simulation');
const simulation = jest.mocked(simulationModule);
import authModule = require('../../src/ts/core/services/auth');
const auth = jest.mocked(authModule);
import apiFactoryModule = require('../../src/ts/core/apiFactory');
const apiFactory = jest.mocked(apiFactoryModule);
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import type * as templatesModule from '../../src/ts/core/scenarios/templates';
import type * as scenarios_handlersModule from '../../src/ts/core/ipc/scenarios.handlers';
const { SCENARIO_TEMPLATES } = require('../../src/ts/core/scenarios/templates') as typeof templatesModule;
const { buildHandlers } = require('../../src/ts/core/ipc/scenarios.handlers') as typeof scenarios_handlersModule;

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

test('get-scenarios returns the stored scenarios, the revision they were read at, and the templates', async () => {
    settings.getScenarioLibrary.mockReturnValue({ scenarios: { Plan: scenario }, revision: 3 });
    await expect(handlers['get-scenarios']()).resolves.toEqual({
        success: true,
        scenarios: { Plan: scenario },
        revision: 3,
        templates: SCENARIO_TEMPLATES,
    });
});

describe('save / rename / delete', () => {
    test('save passes overwrite through and maps issues', async () => {
        settings.saveScenario.mockReturnValueOnce({ ok: true, name: 'Plan' });
        await expect(handlers['save-scenario'](null, scenario)).resolves.toEqual({ success: true, name: 'Plan' });
        expect(settings.saveScenario).toHaveBeenCalledWith(scenario, {
            overwrite: true,
            expectedDefinitionRevision: undefined,
        });
        settings.saveScenario.mockReturnValueOnce({ ok: false, issues: [issue] });
        await expect(handlers['save-scenario'](null, scenario, { overwrite: false })).resolves.toEqual({
            success: false,
            error: issue.message,
            issues: [issue],
        });
        expect(settings.saveScenario).toHaveBeenLastCalledWith(scenario, {
            overwrite: false,
            expectedDefinitionRevision: undefined,
        });
    });

    test('an overwrite states the revision it was edited on, and a refusal says why', async () => {
        settings.saveScenario.mockReturnValueOnce({
            ok: false,
            reason: 'conflict',
            issues: [{ path: '', message: 'conflict' }],
        });
        await expect(
            handlers['save-scenario'](null, scenario, { overwrite: true, expectedDefinitionRevision: 4 }),
        ).resolves.toEqual({
            success: false,
            error: 'conflict',
            issues: [{ path: '', message: 'conflict' }],
            reason: 'conflict',
        });
        expect(settings.saveScenario).toHaveBeenLastCalledWith(scenario, {
            overwrite: true,
            expectedDefinitionRevision: 4,
        });
    });

    test.each([-1, 1.5, '3', null, Number.NaN])('a revision that is not a count (%p) is invalid', async (bad) => {
        const options = { expectedDefinitionRevision: invalid<number>(bad) };
        const refused = { success: false, error: 'invalid-args' };
        await expect(handlers['save-scenario'](null, scenario, options)).resolves.toEqual(refused);
        await expect(handlers['rename-scenario'](null, 'Old', 'New', options)).resolves.toEqual(refused);
        await expect(handlers['delete-scenario'](null, 'Plan', options)).resolves.toEqual(refused);
        await expect(handlers['import-scenario'](null, '{}', options)).resolves.toEqual(refused);
    });

    test('an issue list without entries still yields an error', async () => {
        settings.saveScenario.mockReturnValueOnce({ ok: false, issues: [] });
        await expect(handlers['save-scenario'](null, {})).resolves.toEqual(
            expect.objectContaining({ success: false, error: 'Invalid scenario' }),
        );
    });

    test('rename checks its arguments', async () => {
        settings.renameScenario.mockReturnValueOnce({ ok: true, name: 'New' });
        await expect(
            handlers['rename-scenario'](null, 'Old', 'New', { expectedDefinitionRevision: 2 }),
        ).resolves.toEqual(expect.objectContaining({ success: true, name: 'New' }));
        expect(settings.renameScenario).toHaveBeenCalledWith('Old', 'New', { expectedDefinitionRevision: 2 });
        await expect(handlers['rename-scenario'](null, '', 'New')).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        await expect(handlers['rename-scenario'](null, 'Old', invalid(5))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });

    test('delete reports a missing scenario, and why a refused one was not deleted', async () => {
        settings.deleteScenario
            .mockReturnValueOnce({ ok: true })
            .mockReturnValueOnce({ ok: false, reason: 'not-found' })
            .mockReturnValueOnce({ ok: false, reason: 'unresolved-work' });
        await expect(handlers['delete-scenario'](null, 'Plan')).resolves.toEqual({ success: true });
        expect(settings.deleteScenario).toHaveBeenCalledWith('Plan', { expectedDefinitionRevision: undefined });
        await expect(handlers['delete-scenario'](null, 'Plan', { expectedDefinitionRevision: 2 })).resolves.toEqual({
            success: false,
            error: 'not-found',
        });
        expect(settings.deleteScenario).toHaveBeenLastCalledWith('Plan', { expectedDefinitionRevision: 2 });
        await expect(handlers['delete-scenario'](null, 'Plan')).resolves.toEqual({
            success: false,
            error: 'unresolved-work',
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
            unboundPools: [],
        });
        await expect(handlers['preview-scenario-import'](null, '{}')).resolves.toEqual(
            expect.objectContaining({ success: true, exists: false }),
        );
        settings.importScenario.mockReturnValue({ ok: true, name: 'Plan', unboundPools: [] });
        await handlers['import-scenario'](null, '{}');
        expect(settings.importScenario).toHaveBeenLastCalledWith('{}', {
            overwrite: false,
            expectedDefinitionRevision: undefined,
        });
        await handlers['import-scenario'](null, '{}', { overwrite: true, expectedDefinitionRevision: 6 });
        expect(settings.importScenario).toHaveBeenLastCalledWith('{}', {
            overwrite: true,
            expectedDefinitionRevision: 6,
        });
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

    test('status carries where the phase settings come from, read from the settings', async () => {
        const overlay = {
            bound: true,
            available: false,
            reason: 'nothing is published for this phase yet',
            sources: { patch: [], literals: [], bindings: ['exposure'], profile: [] },
            published: null,
        };
        settings.scenarioOverlayStatus.mockReturnValueOnce(overlay);
        scenarioStatus.getScenarioStatus.mockReturnValueOnce(
            invalid({ assigned: 'Plan', scenario, state: null, corrupt: false }),
        );
        await expect(handlers['get-scenario-status'](null, 7)).resolves.toMatchObject({ success: true, overlay });
        expect(settings.scenarioOverlayStatus).toHaveBeenLastCalledWith(7);
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

    test('a setting a rule reads is read privately: the base and the effective value the settings give, no write', async () => {
        const reading: ScenarioDocument = {
            name: 'Reads',
            version: 1,
            start: 'main',
            phases: {
                main: {
                    rules: [
                        {
                            id: 'r',
                            if: [
                                {
                                    type: 'compare',
                                    left: { kind: 'setting', key: 'exposure', view: 'effective' },
                                    op: '=',
                                    right: { kind: 'literal', value: 60, quantity: 'percent' },
                                },
                            ],
                            do: [{ type: 'notify', message: 'x' }],
                        },
                    ],
                },
            },
        };
        scenarioStatus.getScenarioStatus.mockReturnValue({
            assigned: 'Reads',
            scenario: reading,
            state: null,
            corrupt: false,
            timezone: 'UTC',
        });
        settings.readScenarioSetting.mockReturnValueOnce({
            state: 'known',
            value: { kind: 'number', value: 60, quantity: 'percent' },
        });
        await expect(handlers['dry-run-scenario'](null, 7)).resolves.toEqual(
            expect.objectContaining({ fire: expect.objectContaining({ ruleId: 'r' }) }),
        );
        expect(settings.readScenarioSetting).toHaveBeenCalledWith('exposure', 'effective', 7);
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

    test('a marked challenge, or one a prune-unsafe read lost, refuses as challenge-data-incomplete', async () => {
        strategy.getActiveChallenges.mockResolvedValueOnce(
            invalid({ challenges: [{ id: 7, dataIssues: ['close_time'], member: { ranking: { entries: [] } } }] }),
        );
        await expect(handlers['dry-run-scenario'](null, 7)).resolves.toEqual({
            success: false,
            error: 'challenge-data-incomplete',
        });
        strategy.getActiveChallenges.mockResolvedValueOnce(invalid({ challenges: [], pruneUnsafe: true }));
        await expect(handlers['dry-run-scenario'](null, 7)).resolves.toEqual({
            success: false,
            error: 'challenge-data-incomplete',
        });
    });
});

describe('simulate-scenario', () => {
    const FUTURE = NOW + 3600;
    const draft: ScenarioDocument = {
        name: 'Draft',
        version: 1,
        start: 'main',
        phases: { main: { rules: [{ id: 't', do: [{ type: 'notify', message: 'x' }] }] } },
    };
    const installationScenario: ScenarioDocument = { ...scenario, scope: 'installation' };
    const strategy = { getBankroll: jest.fn(async () => ({ keys: 1, swaps: 1, fills: 1, coins: 1 })) };
    const result: SimulationResult = {
        events: [],
        assumptions: {},
        diagnostics: [],
        deadlines: [],
        finalState: null,
        stopReason: 'idle',
        stoppedAt: NOW,
        passes: [NOW],
        needs: null,
        halted: null,
    };
    const activeRow = { id: 7, title: 'Seven', close_time: FUTURE, member: { ranking: { entries: [] } } };
    const request = (patch: Record<string, unknown> = {}) => ({
        scenario: { name: 'Plan' },
        subject: { kind: 'active', challengeId: '7' },
        until: FUTURE,
        ...patch,
    });

    beforeEach(() => {
        apiFactory.getApiStrategy.mockReturnValue(invalid(strategy));
        settings.getScenario.mockReturnValue(scenario);
        scenarioStatus.readSubjectRows.mockResolvedValue({
            readable: true,
            kind: 'active',
            rows: [invalid(activeRow)],
            pruneUnsafe: false,
        });
        simulation.runSimulation.mockResolvedValue({ ok: true, result });
    });

    test('runs the coordinator on the one request: scenario, subject, horizon, assumptions, starting evidence', async () => {
        const assumptions = { outcomes: { submit: 'success' } };
        const response = await handlers['simulate-scenario'](null, request({ assumptions }));
        expect(response).toEqual({
            success: true,
            scenario: 'Plan',
            subject: { kind: 'active', challengeId: '7' },
            now: expect.any(Number),
            until: FUTURE,
            manualOnly: false,
            ...result,
        });
        expect(simulation.runSimulation).toHaveBeenCalledWith({
            scenario,
            source: 'stored',
            subject: { kind: 'active', challengeId: '7' },
            evidence: {
                provenance: 'active-list',
                challenge: activeRow,
                bankroll: { keys: 1, swaps: 1, fills: 1, coins: 1 },
            },
            start: expect.any(Number),
            until: FUTURE,
            assumptions,
        });
        expect(scenarioStatus.readSubjectRows).toHaveBeenCalledWith('active', 'tok', strategy);
    });

    test('Manual Only is carried with the result, which stays', async () => {
        settings.getEffectiveSetting.mockReturnValueOnce(true);
        await expect(handlers['simulate-scenario'](null, request())).resolves.toEqual(
            expect.objectContaining({ success: true, manualOnly: true }),
        );
    });

    test('an unsaved draft is checked and simulated as the draft, with no assignment needed', async () => {
        settings.checkScenario.mockReturnValue({ ok: true, scenario: draft });
        await handlers['simulate-scenario'](null, request({ scenario: { draft } }));
        expect(settings.checkScenario).toHaveBeenCalledWith(draft);
        expect(settings.getScenario).not.toHaveBeenCalled();
        expect(simulation.runSimulation).toHaveBeenCalledWith(
            expect.objectContaining({ scenario: draft, source: 'draft' }),
        );
    });

    test('an invalid draft reports its issues', async () => {
        settings.checkScenario.mockReturnValueOnce({ ok: false, issues: [{ path: 'start', message: 'No phase' }] });
        await expect(handlers['simulate-scenario'](null, request({ scenario: { draft: {} } }))).resolves.toEqual({
            success: false,
            error: 'No phase',
            issues: [{ path: 'start', message: 'No phase' }],
        });
        settings.checkScenario.mockReturnValueOnce({ ok: false, issues: [] });
        await expect(handlers['simulate-scenario'](null, request({ scenario: { draft: {} } }))).resolves.toEqual(
            expect.objectContaining({ error: 'Invalid scenario' }),
        );
        expect(simulation.runSimulation).not.toHaveBeenCalled();
    });

    test.each([
        [null, 'invalid-request'],
        [{ ...request(), extra: 1 }, 'invalid-request'],
        [request({ scenario: {} }), 'invalid-scenario'],
        [request({ subject: { kind: 'active' } }), 'challenge-required'],
        [request({ subject: { kind: 'installation', challengeId: '7' } }), 'installation-takes-no-challenge'],
        [request({ until: 'soon' }), 'invalid-until'],
        [request({ assumptions: { outcomes: { fly: 'success' } } }), 'invalid-assumptions'],
    ])('refuses a request that is not valid: %p', async (bad, error) => {
        await expect(handlers['simulate-scenario'](null, bad)).resolves.toEqual({ success: false, error });
        expect(simulation.runSimulation).not.toHaveBeenCalled();
    });

    test('needs a token', async () => {
        auth.requireAuthToken.mockReturnValueOnce({ ok: false, response: { success: false, error: 'no token' } });
        await expect(handlers['simulate-scenario'](null, request())).resolves.toEqual({
            success: false,
            error: 'no token',
        });
    });

    test('refuses an unknown scenario, and one of the wrong scope for the subject', async () => {
        settings.getScenario.mockReturnValueOnce(null);
        await expect(handlers['simulate-scenario'](null, request())).resolves.toEqual({
            success: false,
            error: 'unknown-scenario',
        });
        settings.getScenario.mockReturnValueOnce(installationScenario);
        await expect(handlers['simulate-scenario'](null, request())).resolves.toEqual({
            success: false,
            error: 'scenario-scope-mismatch',
        });
        settings.getScenario.mockReturnValueOnce(scenario);
        await expect(
            handlers['simulate-scenario'](null, request({ subject: { kind: 'installation' } })),
        ).resolves.toEqual({ success: false, error: 'scenario-scope-mismatch' });
    });

    test('a horizon already past is refused', async () => {
        await expect(handlers['simulate-scenario'](null, request({ until: NOW - 60 }))).resolves.toEqual({
            success: false,
            error: 'until-in-past',
        });
    });

    test('an installation takes no challenge, reads only the bankroll, and refuses a challenge snapshot', async () => {
        settings.getScenario.mockReturnValue(installationScenario);
        await expect(
            handlers['simulate-scenario'](
                null,
                request({
                    subject: { kind: 'installation' },
                    assumptions: { snapshots: [{ at: NOW, facts: { challenge: { id: 7 } } }] },
                }),
            ),
        ).resolves.toEqual({ success: false, error: 'invalid-assumptions' });
        const response = await handlers['simulate-scenario'](null, request({ subject: { kind: 'installation' } }));
        expect(response).toEqual(
            expect.objectContaining({ success: true, subject: { kind: 'installation' }, manualOnly: false }),
        );
        expect(scenarioStatus.readSubjectRows).not.toHaveBeenCalled();
        expect(simulation.runSimulation).toHaveBeenCalledWith(
            expect.objectContaining({
                evidence: { provenance: 'installation', bankroll: { keys: 1, swaps: 1, fills: 1, coins: 1 } },
            }),
        );
    });

    test('a candidate and a completed challenge come from their own lists', async () => {
        const candidateRow = { id: 8, title: 'Open' };
        scenarioStatus.readSubjectRows.mockResolvedValueOnce({
            readable: true,
            kind: 'candidate',
            rows: [invalid(candidateRow)],
            pruneUnsafe: false,
        });
        await handlers['simulate-scenario'](null, request({ subject: { kind: 'candidate', challengeId: '8' } }));
        expect(simulation.runSimulation).toHaveBeenLastCalledWith(
            expect.objectContaining({
                evidence: expect.objectContaining({ provenance: 'open-list', challenge: candidateRow }),
            }),
        );
        const completedRow = { id: 9, title: 'Done' };
        scenarioStatus.readSubjectRows.mockResolvedValueOnce({
            readable: true,
            kind: 'completed',
            rows: [invalid(completedRow)],
            pruneUnsafe: false,
        });
        await handlers['simulate-scenario'](null, request({ subject: { kind: 'completed', challengeId: '9' } }));
        expect(simulation.runSimulation).toHaveBeenLastCalledWith(
            expect.objectContaining({
                evidence: expect.objectContaining({ provenance: 'completed-list', challenge: completedRow }),
            }),
        );
        expect(scenarioStatus.readSubjectRows).toHaveBeenLastCalledWith('completed', 'tok', strategy);
    });

    test('a list that cannot be read is not an empty one, and a subject that is not in it is not found', async () => {
        scenarioStatus.readSubjectRows.mockResolvedValueOnce({ readable: false });
        await expect(handlers['simulate-scenario'](null, request())).resolves.toEqual({
            success: false,
            error: 'subjects-unreadable',
        });
        scenarioStatus.readSubjectRows.mockResolvedValueOnce({
            readable: true,
            kind: 'active',
            rows: [],
            pruneUnsafe: false,
        });
        await expect(handlers['simulate-scenario'](null, request())).resolves.toEqual({
            success: false,
            error: 'challenge-not-found',
        });
        scenarioStatus.readSubjectRows.mockResolvedValueOnce({
            readable: true,
            kind: 'completed',
            rows: [],
            pruneUnsafe: false,
        });
        await expect(
            handlers['simulate-scenario'](null, request({ subject: { kind: 'completed', challengeId: '9' } })),
        ).resolves.toEqual({ success: false, error: 'challenge-not-found' });
        expect(simulation.runSimulation).not.toHaveBeenCalled();
    });

    test('a marked challenge, or one a prune-unsafe read may have lost, refuses as challenge-data-incomplete', async () => {
        scenarioStatus.readSubjectRows.mockResolvedValueOnce({
            readable: true,
            kind: 'active',
            rows: [invalid({ ...activeRow, dataIssues: ['close_time'] })],
            pruneUnsafe: false,
        });
        await expect(handlers['simulate-scenario'](null, request())).resolves.toEqual({
            success: false,
            error: 'challenge-data-incomplete',
        });
        scenarioStatus.readSubjectRows.mockResolvedValueOnce({
            readable: true,
            kind: 'active',
            rows: [],
            pruneUnsafe: true,
        });
        await expect(handlers['simulate-scenario'](null, request())).resolves.toEqual({
            success: false,
            error: 'challenge-data-incomplete',
        });
    });

    test('a second simulation while one runs is refused as busy', async () => {
        simulation.runSimulation.mockResolvedValueOnce({ ok: false, error: 'simulation-busy' });
        await expect(handlers['simulate-scenario'](null, request())).resolves.toEqual({
            success: false,
            error: 'simulation-busy',
        });
    });

    test('a failure of the run is an error result, never a throw', async () => {
        simulation.runSimulation.mockRejectedValueOnce(new Error('boom'));
        await expect(handlers['simulate-scenario'](null, request())).resolves.toEqual(
            expect.objectContaining({ success: false }),
        );
    });
});
