/**
 * The installation / lifecycle / pool / Stop-fence IPC handlers (ipc/scenarioLifecycle.handlers.ts): argument
 * validation, the facade result mapped onto {success, error}, the event announcement after an effect, the one
 * route that may lift a Stop block, and never a throw to the renderer.
 */

jest.mock('../../src/ts/core/settings', () => ({
    getScenarioCapabilities: jest.fn(),
    getInstallationScenario: jest.fn(),
    installationGeneration: jest.fn(),
    setInstallationScenario: jest.fn(),
    transferInstallationOwner: jest.fn(),
    requestScenarioHandoff: jest.fn(),
    setScenarioPaused: jest.fn(),
    getPhotoPools: jest.fn(),
    setPhotoPool: jest.fn(),
    createPhotoPool: jest.fn(),
    listPhaseProfiles: jest.fn(),
    deletePhotoPool: jest.fn(),
    renamePhotoPool: jest.fn(),
    getEntryPins: jest.fn(),
    getStoredEntryPins: jest.fn(),
    getChosenPoolView: jest.fn(),
    getPhaseSchedules: jest.fn(),
    getScenarioBaseSettings: jest.fn(),
    readScenarioSetting: jest.fn(),
    readInstallationSetting: jest.fn(),
    scenarioOverlayStatus: jest.fn(),
    getEffectiveSetting: jest.fn(),
    readStopFence: jest.fn(),
    readControlStatus: jest.fn(),
    beginControlRequest: jest.fn(),
    finishControlRequest: jest.fn(),
    refreshScenarioControlsAsync: jest.fn(async () => true),
    SERVICE_EXECUTOR: 'android-service',
    CONTROL_ID_PATTERN: /^[A-Za-z0-9_-]{1,64}$/,
    CONTROL_NAME_PATTERN: /^[A-Za-z0-9@:._-]{1,64}$/,
    CONTROL_MAX_ERROR: 120,
}));
// Where the lifecycle effects are applied: here (false) or by the Android service (true), per test.
jest.mock('../../src/ts/core/services/scenarioRunner', () => ({
    backgroundServiceOwnsScenarios: jest.fn(() => false),
}));
jest.mock('../../src/ts/core/services/scenarioStatus', () => ({
    ledgerForMode: jest.fn(),
    listSimulationSubjects: jest.fn(),
}));
jest.mock('../../src/ts/core/scenarioStateStore', () => ({
    INSTALLATION_KEY: '@installation',
    refreshScenarioStateAsync: jest.fn(async () => {}),
}));
jest.mock('../../src/ts/core/autovote/nodeSeams', () => ({
    nodeStopFence: {
        read: jest.fn(),
        initialize: jest.fn(),
        recordFullStop: jest.fn(),
        clearStopBlock: jest.fn(),
        isArmAllowed: jest.fn(),
        armIfAllowed: jest.fn(),
    },
    withdrawInstallation: jest.fn(),
    reArmInstallation: jest.fn(),
}));
jest.mock('../../src/ts/core/scheduling/nodeResolvers', () => ({ resolveAccountWake: jest.fn() }));
jest.mock('../../src/ts/core/services/effectiveEvents', () => ({
    announceEffectiveChange: jest.fn(),
    readEffective: jest.fn(),
}));
jest.mock('../../src/ts/core/services/auth', () => ({
    requireAuthToken: jest.fn(() => ({ ok: true, token: 'tok', settings: {} })),
}));
jest.mock('../../src/ts/core/apiFactory', () => ({ getApiStrategy: jest.fn(() => ({ strategy: true })) }));
jest.mock('../../src/ts/core/logger', () => ({
    withCategory: jest.fn(() => ({ error: jest.fn(), info: jest.fn(), warning: jest.fn() })),
    sanitizeLogString: (value: string) => value,
}));

import { invalid } from '../helpers/invalid';

import type * as handlersModule from '../../src/ts/core/ipc/scenarioLifecycle.handlers';

import settingsModule = require('../../src/ts/core/settings');
const settings = jest.mocked(settingsModule);
import scenarioStatusModule = require('../../src/ts/core/services/scenarioStatus');
const scenarioStatus = jest.mocked(scenarioStatusModule);
import seamsModule = require('../../src/ts/core/autovote/nodeSeams');
const seams = jest.mocked(seamsModule);
import resolversModule = require('../../src/ts/core/scheduling/nodeResolvers');
const resolvers = jest.mocked(resolversModule);
import eventsModule = require('../../src/ts/core/services/effectiveEvents');
const events = jest.mocked(eventsModule);
import authModule = require('../../src/ts/core/services/auth');
const auth = jest.mocked(authModule);
import runnerModule = require('../../src/ts/core/services/scenarioRunner');
const runner = jest.mocked(runnerModule);

const { buildLifecycleHandlers } = require('../../src/ts/core/ipc/scenarioLifecycle.handlers') as typeof handlersModule;
const handlers = buildLifecycleHandlers();

const FENCE = { stopEpoch: 2, blocked: true, lastStop: { requestId: 'r', at: 5, durable: true }, lastArm: null };

beforeEach(() => {
    jest.clearAllMocks();
    auth.requireAuthToken.mockReturnValue(invalid({ ok: true, token: 'tok' }));
});

describe('reads', () => {
    test('get-scenario-capabilities returns the catalogue', async () => {
        const capabilities = { settings: [], remoteEnabled: {} };
        settings.getScenarioCapabilities.mockReturnValue(invalid(capabilities));
        await expect(handlers['get-scenario-capabilities']()).resolves.toEqual({ success: true, capabilities });
    });

    test('get-scenario-capabilities never throws to the renderer', async () => {
        settings.getScenarioCapabilities.mockImplementation(() => {
            throw new Error('boom');
        });
        await expect(handlers['get-scenario-capabilities']()).resolves.toEqual({ success: false, error: 'boom' });
    });

    test('get-installation-scenario returns the assignment and its generation', async () => {
        settings.getInstallationScenario.mockReturnValue({ scenario: 'Plan', executor: 'cli', generation: 3 });
        settings.installationGeneration.mockReturnValue(3);
        await expect(handlers['get-installation-scenario']()).resolves.toEqual({
            success: true,
            installation: { scenario: 'Plan', executor: 'cli', generation: 3 },
            generation: 3,
        });
    });

    test('get-photo-pools returns the pools', async () => {
        settings.getPhotoPools.mockReturnValue({ a: ['1'] });
        await expect(handlers['get-photo-pools']()).resolves.toEqual({ success: true, pools: { a: ['1'] } });
    });

    test('get-effective-entry-pins checks its id and returns the pins in force', async () => {
        settings.getEntryPins.mockReturnValue({ boost: '1', turbo: null });
        await expect(handlers['get-effective-entry-pins'](null, 7)).resolves.toEqual({
            success: true,
            pins: { boost: '1', turbo: null },
        });
        expect(settings.getEntryPins).toHaveBeenCalledWith(7);
        await expect(handlers['get-effective-entry-pins'](null, invalid<number>({}))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });

    test('get-effective-installation-settings and get-effective-presentation answer the current projections', async () => {
        events.readEffective.mockReturnValue(
            invalid({
                settings: { revision: 5, values: {} },
                presentation: { revision: 5, available: true, theme: 'dark', language: 'en', reason: null },
            }),
        );
        await expect(handlers['get-effective-installation-settings']()).resolves.toEqual({
            success: true,
            revision: 5,
            values: {},
        });
        await expect(handlers['get-effective-presentation']()).resolves.toEqual({
            success: true,
            revision: 5,
            available: true,
            theme: 'dark',
            language: 'en',
            reason: null,
        });
    });

    test('a projection that cannot be built answers a failure', async () => {
        events.readEffective.mockImplementation(() => {
            throw new Error('no read');
        });
        await expect(handlers['get-effective-presentation']()).resolves.toEqual({ success: false, error: 'no read' });
    });
});

describe('list-simulation-subjects', () => {
    test('lists the subjects of a kind through the read-only producers, and refuses an unknown kind', async () => {
        scenarioStatus.listSimulationSubjects.mockResolvedValue({
            readable: true,
            subjects: [{ id: '1', label: 'A' }],
        });
        await expect(handlers['list-simulation-subjects'](null, 'active')).resolves.toEqual({
            success: true,
            readable: true,
            subjects: [{ id: '1', label: 'A' }],
        });
        expect(scenarioStatus.listSimulationSubjects).toHaveBeenCalledWith('active', 'tok', { strategy: true });
        await expect(handlers['list-simulation-subjects'](null, invalid<'active'>('other'))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });

    test('refuses without a signed-in account', async () => {
        auth.requireAuthToken.mockReturnValue({ ok: false, response: { success: false, error: 'No token' } });
        await expect(handlers['list-simulation-subjects'](null, 'active')).resolves.toEqual({
            success: false,
            error: 'No token',
        });
    });
});

describe('get-scenario-snapshot', () => {
    const text = (value: string) => ({ state: 'known' as const, value: { kind: 'string' as const, value } });
    const base = {
        'a.key': { state: 'known' as const, value: { kind: 'number' as const, value: 1, quantity: 'count' as const } },
        token: text('secret'),
    };
    beforeEach(() => {
        settings.getScenarioCapabilities.mockReturnValue(
            invalid({
                settings: [
                    { key: 'a.key', read: 'value', phaseWrite: ['challenge'] },
                    { key: 'token', read: 'value', phaseWrite: [] },
                    { key: 'restricted', read: 'restricted', phaseWrite: [] },
                ],
            }),
        );
        settings.getScenarioBaseSettings.mockReturnValue(invalid(base));
        settings.readScenarioSetting.mockReturnValue(text('two'));
        settings.readInstallationSetting.mockReturnValue(text('three'));
        settings.scenarioOverlayStatus.mockReturnValue(invalid({ bound: false, available: true }));
        settings.getPhaseSchedules.mockReturnValue(invalid({ state: 'none' }));
        settings.getEntryPins.mockReturnValue({ boost: null, turbo: null });
        settings.getStoredEntryPins.mockReturnValue({ boost: '9', turbo: null });
        settings.getChosenPoolView.mockReturnValue(null);
        settings.getEffectiveSetting.mockReturnValue('Plan');
        settings.installationGeneration.mockReturnValue(4);
        settings.getInstallationScenario.mockReturnValue({ scenario: 'Inst', executor: 'electron', generation: 4 });
        scenarioStatus.ledgerForMode.mockReturnValue(
            invalid({
                get: () => ({
                    corrupt: false,
                    state: {
                        generation: 6,
                        paused: { at: 1, reason: 'x' },
                        published: { revision: 2, bindings: { secret: 1 } },
                    },
                }),
            }),
        );
    });

    test('a challenge: base and effective values, schedules, pins, pool, pause and generation; no hidden key', async () => {
        const result = await handlers['get-scenario-snapshot'](null, 11);
        expect(result).toMatchObject({
            success: true,
            subject: '11',
            assignment: 'Plan',
            paused: { at: 1, reason: 'x' },
            generation: 6,
            corrupt: false,
            base: { 'a.key': base['a.key'] },
            effective: { 'a.key': text('two') },
            schedules: { state: 'none' },
            pins: { effective: { boost: null, turbo: null }, stored: { boost: '9', turbo: null } },
            pool: null,
            publication: { revision: 2 },
        });
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('secret');
        expect(Object.keys((result as { base: object }).base)).toEqual(['a.key']);
        expect(settings.readScenarioSetting).toHaveBeenCalledWith('a.key', 'effective', '11');
    });

    test('the installation: effective values come from the installation reader, with its assignment and generation', async () => {
        const result = await handlers['get-scenario-snapshot'](null, '@installation');
        expect(result).toMatchObject({
            success: true,
            subject: '@installation',
            assignment: { scenario: 'Inst', executor: 'electron', generation: 4 },
            generation: 4,
            effective: { 'a.key': text('three') },
            schedules: null,
            pins: null,
            pool: null,
            overlay: null,
        });
        expect(settings.getScenarioBaseSettings).toHaveBeenCalledWith(null);
    });

    test('a progress record that cannot be read says so and has no generation', async () => {
        scenarioStatus.ledgerForMode.mockReturnValue(invalid({ get: () => ({ corrupt: 'record', state: null }) }));
        await expect(handlers['get-scenario-snapshot'](null, 11)).resolves.toMatchObject({
            success: true,
            corrupt: 'record',
            generation: null,
            paused: null,
            publication: null,
        });
    });

    test('a challenge with no assignment has none', async () => {
        settings.getEffectiveSetting.mockReturnValue('');
        await expect(handlers['get-scenario-snapshot'](null, 11)).resolves.toMatchObject({ assignment: null });
    });

    test('a subject with no progress record has generation 0 and no pause', async () => {
        scenarioStatus.ledgerForMode.mockReturnValue(invalid({ get: () => ({ corrupt: false, state: null }) }));
        await expect(handlers['get-scenario-snapshot'](null, 11)).resolves.toMatchObject({
            generation: 0,
            paused: null,
            publication: null,
        });
    });

    test('an unknown subject is refused', async () => {
        await expect(handlers['get-scenario-snapshot'](null, invalid<number>('@other'))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });

    test('an installation whose generation cannot be read has none', async () => {
        settings.installationGeneration.mockReturnValue(null);
        await expect(handlers['get-scenario-snapshot'](null, '@installation')).resolves.toMatchObject({
            generation: null,
        });
    });
});

describe('get-stop-status', () => {
    test('reports the fence, its durability, and whether the owner withdrew under that epoch', async () => {
        seams.nodeStopFence.read.mockResolvedValue({ state: 'ok', fence: FENCE });
        scenarioStatus.ledgerForMode.mockReturnValue(
            invalid({ get: () => ({ corrupt: false, state: { withdrawn: { at: 1, epoch: 2 } } }) }),
        );
        await expect(handlers['get-stop-status']()).resolves.toEqual({
            success: true,
            fence: { state: 'ok', stopEpoch: 2, blocked: true, lastStop: FENCE.lastStop, lastArm: null },
            durable: true,
            ownerAcknowledged: true,
        });
    });

    test('an owner that has not withdrawn under the epoch is not acknowledged, and no installation record is unknown', async () => {
        seams.nodeStopFence.read.mockResolvedValue({ state: 'ok', fence: FENCE });
        scenarioStatus.ledgerForMode.mockReturnValue(
            invalid({ get: () => ({ corrupt: false, state: { withdrawn: { at: 1, epoch: 1 } } }) }),
        );
        await expect(handlers['get-stop-status']()).resolves.toMatchObject({ ownerAcknowledged: false });
        scenarioStatus.ledgerForMode.mockReturnValue(invalid({ get: () => ({ corrupt: false, state: null }) }));
        await expect(handlers['get-stop-status']()).resolves.toMatchObject({ ownerAcknowledged: null });
        scenarioStatus.ledgerForMode.mockReturnValue(invalid({ get: () => ({ corrupt: 'file', state: null }) }));
        await expect(handlers['get-stop-status']()).resolves.toMatchObject({ ownerAcknowledged: null });
    });

    test('an installation record with no withdrawal is not acknowledged', async () => {
        seams.nodeStopFence.read.mockResolvedValue({ state: 'ok', fence: FENCE });
        scenarioStatus.ledgerForMode.mockReturnValue(invalid({ get: () => ({ corrupt: false, state: {} }) }));
        await expect(handlers['get-stop-status']()).resolves.toMatchObject({ ownerAcknowledged: false });
    });

    test('a Stop that was only local is not durable, and a fence with no Stop has no durability to report', async () => {
        scenarioStatus.ledgerForMode.mockReturnValue(invalid({ get: () => ({ corrupt: false, state: null }) }));
        seams.nodeStopFence.read.mockResolvedValue({
            state: 'ok',
            fence: { ...FENCE, lastStop: { requestId: 'r', at: 5, durable: false } },
        });
        await expect(handlers['get-stop-status']()).resolves.toMatchObject({ durable: false });
        seams.nodeStopFence.read.mockResolvedValue({ state: 'ok', fence: { ...FENCE, lastStop: null } });
        await expect(handlers['get-stop-status']()).resolves.toMatchObject({ durable: null });
    });

    test('a missing or unreadable fence is reported as it is, never as epoch 0', async () => {
        scenarioStatus.ledgerForMode.mockReturnValue(invalid({ get: () => ({ corrupt: false, state: null }) }));
        seams.nodeStopFence.read.mockResolvedValue({ state: 'missing' });
        await expect(handlers['get-stop-status']()).resolves.toMatchObject({
            success: true,
            fence: { state: 'missing' },
            durable: null,
        });
        seams.nodeStopFence.read.mockResolvedValue({ state: 'unreadable', reason: 'malformed' });
        await expect(handlers['get-stop-status']()).resolves.toMatchObject({
            fence: { state: 'unreadable', reason: 'malformed' },
        });
    });
});

describe('installation effects', () => {
    test('set-installation-scenario maps the result and announces the change', async () => {
        const installation = { scenario: 'Plan', executor: 'cli' as const, generation: 4 };
        settings.setInstallationScenario.mockReturnValue({ ok: true, installation, generation: 4 });
        await expect(handlers['set-installation-scenario'](null, 'Plan', 'cli', 3)).resolves.toEqual({
            success: true,
            installation,
            generation: 4,
        });
        expect(settings.setInstallationScenario).toHaveBeenCalledWith('Plan', 'cli', 3, undefined);
        expect(events.announceEffectiveChange).toHaveBeenCalledTimes(1);
    });

    test('a refusal carries its reason and the current generation, and announces nothing', async () => {
        settings.setInstallationScenario.mockReturnValue({ ok: false, reason: 'stale-generation', generation: 9 });
        await expect(handlers['set-installation-scenario'](null, null, 'cli', 3)).resolves.toEqual({
            success: false,
            error: 'stale-generation',
            generation: 9,
        });
        expect(events.announceEffectiveChange).not.toHaveBeenCalled();
        settings.setInstallationScenario.mockReturnValue({ ok: false, reason: 'busy' });
        await expect(handlers['set-installation-scenario'](null, null, 'cli', 3)).resolves.toEqual({
            success: false,
            error: 'busy',
        });
    });

    test('arguments are checked at runtime', async () => {
        const bad = { success: false, error: 'invalid-args' };
        await expect(handlers['set-installation-scenario'](null, invalid<string>(''), 'cli', 1)).resolves.toEqual(bad);
        await expect(handlers['set-installation-scenario'](null, 'Plan', invalid<'cli'>(7), 1)).resolves.toEqual(bad);
        await expect(handlers['set-installation-scenario'](null, 'Plan', 'cli', invalid<number>(-1))).resolves.toEqual(
            bad,
        );
        await expect(handlers['transfer-installation-scenario-owner'](null, invalid<'cli'>(null), 1)).resolves.toEqual(
            bad,
        );
        await expect(
            handlers['transfer-installation-scenario-owner'](null, 'cli', invalid<number>(1.5)),
        ).resolves.toEqual(bad);
        expect(settings.setInstallationScenario).not.toHaveBeenCalled();
        expect(settings.transferInstallationOwner).not.toHaveBeenCalled();
    });

    test('transfer-installation-scenario-owner maps the result and announces', async () => {
        const installation = { scenario: 'Plan', executor: 'web' as const, generation: 5 };
        settings.transferInstallationOwner.mockReturnValue({ ok: true, installation, generation: 5 });
        await expect(handlers['transfer-installation-scenario-owner'](null, 'web', 4)).resolves.toEqual({
            success: true,
            installation,
            generation: 5,
        });
        expect(events.announceEffectiveChange).toHaveBeenCalledTimes(1);
    });

    test('clear-scenario-assignment clears the installation under its own executor', async () => {
        settings.getInstallationScenario.mockReturnValue({ scenario: 'Plan', executor: 'electron', generation: 4 });
        settings.setInstallationScenario.mockReturnValue({ ok: true, installation: null, generation: 5 });
        await expect(handlers['clear-scenario-assignment'](null, '@installation', 4)).resolves.toEqual({
            success: true,
            generation: 5,
        });
        expect(settings.setInstallationScenario).toHaveBeenCalledWith(null, 'electron', 4);
        expect(events.announceEffectiveChange).toHaveBeenCalledTimes(1);
    });

    test('a refused clear of the installation carries its reason and generation, and announces nothing', async () => {
        settings.getInstallationScenario.mockReturnValue({ scenario: 'Plan', executor: 'cli', generation: 4 });
        settings.setInstallationScenario.mockReturnValue({ ok: false, reason: 'stale-generation', generation: 6 });
        await expect(handlers['clear-scenario-assignment'](null, '@installation', 4)).resolves.toEqual({
            success: false,
            error: 'stale-generation',
            generation: 6,
        });
        expect(events.announceEffectiveChange).not.toHaveBeenCalled();
    });

    test('clearing an installation with no scenario assigned says so', async () => {
        settings.getInstallationScenario.mockReturnValue(null);
        await expect(handlers['clear-scenario-assignment'](null, '@installation', 0)).resolves.toEqual({
            success: false,
            error: 'no-installation',
        });
        expect(settings.setInstallationScenario).not.toHaveBeenCalled();
    });

    test('clearing a challenge hands it off to no scenario', async () => {
        settings.requestScenarioHandoff.mockResolvedValue({ ok: true, generation: 8 });
        await expect(handlers['clear-scenario-assignment'](null, 12, 7)).resolves.toEqual({
            success: true,
            generation: 8,
        });
        expect(settings.requestScenarioHandoff).toHaveBeenCalledWith('12', null, 7);
        settings.requestScenarioHandoff.mockResolvedValue({ ok: false, reason: 'unresolved-spend' });
        await expect(handlers['clear-scenario-assignment'](null, 12, 7)).resolves.toEqual({
            success: false,
            error: 'unresolved-spend',
        });
        await expect(handlers['clear-scenario-assignment'](null, invalid<number>('@x'), 7)).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        await expect(handlers['clear-scenario-assignment'](null, 12, invalid<number>('7'))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });
});

describe('pause / resume / handoff', () => {
    test('pause-scenario pauses a subject with an optional bounded reason and announces', async () => {
        settings.setScenarioPaused.mockReturnValue({ ok: true, paused: true });
        await expect(handlers['pause-scenario'](null, 12, 'later')).resolves.toEqual({ success: true, paused: true });
        expect(settings.setScenarioPaused).toHaveBeenCalledWith('12', true, 'later');
        await handlers['pause-scenario'](null, '@installation');
        expect(settings.setScenarioPaused).toHaveBeenLastCalledWith('@installation', true, '');
        expect(events.announceEffectiveChange).toHaveBeenCalledTimes(2);
        await expect(handlers['pause-scenario'](null, 12, invalid<string>('x'.repeat(201)))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        await expect(handlers['pause-scenario'](null, 12, invalid<string>(4))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        await expect(handlers['pause-scenario'](null, invalid<number>('@x'))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });

    test('a pause the facade refuses carries its reason', async () => {
        settings.setScenarioPaused.mockReturnValue({ ok: false, reason: 'no-progress' });
        await expect(handlers['pause-scenario'](null, 12)).resolves.toEqual({ success: false, error: 'no-progress' });
        await expect(handlers['resume-scenario'](null, 12)).resolves.toEqual({ success: false, error: 'no-progress' });
        expect(events.announceEffectiveChange).not.toHaveBeenCalled();
    });

    test('resume-scenario resumes and announces', async () => {
        settings.setScenarioPaused.mockReturnValue({ ok: true, paused: false });
        await expect(handlers['resume-scenario'](null, 12)).resolves.toEqual({ success: true, paused: false });
        expect(settings.setScenarioPaused).toHaveBeenCalledWith('12', false);
        expect(events.announceEffectiveChange).toHaveBeenCalledTimes(1);
        await expect(handlers['resume-scenario'](null, invalid<number>(''))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });

    test('handoff-scenario hands a subject to a named scenario under the generation the caller saw', async () => {
        settings.requestScenarioHandoff.mockResolvedValue({ ok: true, generation: 3 });
        await expect(handlers['handoff-scenario'](null, 12, 'Next', 2)).resolves.toEqual({
            success: true,
            generation: 3,
        });
        expect(settings.requestScenarioHandoff).toHaveBeenCalledWith('12', 'Next', 2);
        expect(events.announceEffectiveChange).toHaveBeenCalledTimes(1);
        settings.requestScenarioHandoff.mockResolvedValue({ ok: false, reason: 'stale-generation' });
        await expect(handlers['handoff-scenario'](null, 12, 'Next', 2)).resolves.toEqual({
            success: false,
            error: 'stale-generation',
        });
        const bad = { success: false, error: 'invalid-args' };
        await expect(handlers['handoff-scenario'](null, invalid<number>('@x'), 'Next', 2)).resolves.toEqual(bad);
        await expect(handlers['handoff-scenario'](null, 12, invalid<string>(''), 2)).resolves.toEqual(bad);
        await expect(handlers['handoff-scenario'](null, 12, 'Next', invalid<number>(-2))).resolves.toEqual(bad);
    });
});

describe('while the Android service owns scenarios', () => {
    const OK_FENCE = { state: 'ok', fence: FENCE } as const;

    beforeEach(() => {
        runner.backgroundServiceOwnsScenarios.mockReturnValue(true);
        settings.readStopFence.mockReturnValue(OK_FENCE);
        settings.beginControlRequest.mockResolvedValue({ ok: true, outcome: 'accepted', revision: 4 });
    });

    afterEach(() => {
        runner.backgroundServiceOwnsScenarios.mockReturnValue(false);
    });

    const queued = (target: string, revision = 4) => ({
        success: true,
        pending: true,
        requestId: expect.stringMatching(/^app-[a-z0-9]+-[a-z0-9]+$/),
        target,
        revision,
    });

    test.each([
        ['set-installation-scenario', ['Plan', 'android-service', 3], '@installation'],
        // The owner-keeping option travels with the queued request, so the service applies it under the same rule.
        ['set-installation-scenario', ['Plan', 'android-service', 3, { keepExecutor: true }], '@installation'],
        ['pause-scenario', [12, 'later'], '12'],
        ['pause-scenario', ['@installation'], '@installation'],
        ['resume-scenario', [12], '12'],
        ['handoff-scenario', [12, 'Plan', 2], '12'],
        ['clear-scenario-assignment', ['@installation', 5], '@installation'],
        ['clear-scenario-assignment', [9, 5], '9'],
    ] as const)(
        '%s %j is queued for the service as pending, never applied, never announced',
        async (operation, args, target) => {
            const call = handlers[operation] as (event: null, ...rest: unknown[]) => Promise<unknown>;
            await expect(call(null, ...args)).resolves.toEqual(queued(target));
            expect(settings.beginControlRequest).toHaveBeenCalledWith({
                requestId: expect.any(String),
                operation,
                target,
                args: JSON.stringify(args),
                stopEpoch: 2,
                at: expect.any(Number),
                executor: 'android-service',
            });
            // The window writes no progress or configuration for these operations.
            expect(settings.setInstallationScenario).not.toHaveBeenCalled();
            expect(settings.setScenarioPaused).not.toHaveBeenCalled();
            expect(settings.requestScenarioHandoff).not.toHaveBeenCalled();
            expect(events.announceEffectiveChange).not.toHaveBeenCalled();
        },
    );

    test('each call is a request of its own identity', async () => {
        await handlers['resume-scenario'](null, 12);
        await handlers['resume-scenario'](null, 12);
        const ids = settings.beginControlRequest.mock.calls.map(([asked]) => asked.requestId);
        expect(new Set(ids).size).toBe(2);
    });

    test('a pause with no reason queues the subject alone', async () => {
        await handlers['pause-scenario'](null, 12);
        expect(settings.beginControlRequest.mock.calls[0][0].args).toBe('[12]');
    });

    test('with no readable fence the request carries no epoch', async () => {
        settings.readStopFence.mockReturnValue({ state: 'missing' });
        await handlers['resume-scenario'](null, 12);
        expect(settings.beginControlRequest.mock.calls[0][0].stopEpoch).toBeNull();
    });

    test.each(['busy', 'full', 'unreadable', 'not-saved', 'too-large'] as const)(
        'an inbox that answers %s refuses the request, and nothing is applied',
        async (reason) => {
            settings.beginControlRequest.mockResolvedValue({ ok: false, reason });
            await expect(handlers['pause-scenario'](null, 12)).resolves.toEqual({ success: false, error: reason });
            expect(settings.setScenarioPaused).not.toHaveBeenCalled();
        },
    );

    test('arguments are still checked before anything is queued', async () => {
        await expect(handlers['pause-scenario'](null, invalid<number>('@x'))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        await expect(handlers['handoff-scenario'](null, 12, invalid<string>(1), 1)).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
        expect(settings.beginControlRequest).not.toHaveBeenCalled();
    });

    test('an inbox that throws is a failure, never a throw', async () => {
        settings.beginControlRequest.mockRejectedValue(new Error('inbox down'));
        await expect(handlers['resume-scenario'](null, 12)).resolves.toEqual({ success: false, error: 'inbox down' });
    });

    test('the effects that keep their own path are applied here: pools and the owner transfer', async () => {
        settings.setPhotoPool.mockReturnValue('ok');
        settings.transferInstallationOwner.mockReturnValue({ ok: true, installation: null, generation: 1 });
        await expect(handlers['set-photo-pool'](null, 'a', ['1'])).resolves.toEqual({ success: true });
        await handlers['transfer-installation-scenario-owner'](null, 'cli', 1);
        expect(settings.setPhotoPool).toHaveBeenCalled();
        expect(settings.transferInstallationOwner).toHaveBeenCalled();
        expect(settings.beginControlRequest).not.toHaveBeenCalled();
    });

    test('a full Stop never uses the inbox', async () => {
        seams.nodeStopFence.recordFullStop.mockResolvedValue({ ok: true, epoch: 3 });
        await expect(handlers['record-full-stop'](null, 'stop-1', 1700)).resolves.toEqual({ success: true, epoch: 3 });
        expect(settings.beginControlRequest).not.toHaveBeenCalled();
        expect(settings.finishControlRequest).not.toHaveBeenCalled();
    });

    test('a status read looks at what the service recorded, not at the window cache', async () => {
        settings.readControlStatus.mockReturnValue({ state: 'not-recorded' });
        await handlers['get-scenario-request-status'](null, { requestId: 'r1' });
        expect(settings.refreshScenarioControlsAsync).toHaveBeenCalledTimes(1);
        expect(settings.refreshScenarioControlsAsync.mock.invocationCallOrder[0]).toBeLessThan(
            settings.readControlStatus.mock.invocationCallOrder[0],
        );
    });
});

describe('without service ownership the window applies the effects directly', () => {
    test('each of the five calls reaches the facade, and none touches the inbox', async () => {
        settings.setInstallationScenario.mockReturnValue({ ok: true, installation: null, generation: 1 });
        settings.setScenarioPaused.mockReturnValue({ ok: true, paused: true });
        settings.requestScenarioHandoff.mockResolvedValue({ ok: true, generation: 2 });
        settings.getInstallationScenario.mockReturnValue({ scenario: 'Plan', executor: 'cli', generation: 1 });
        await handlers['set-installation-scenario'](null, 'Plan', 'cli', 0);
        await handlers['pause-scenario'](null, 12);
        await handlers['resume-scenario'](null, 12);
        await handlers['handoff-scenario'](null, 12, 'Plan', 1);
        await handlers['clear-scenario-assignment'](null, '@installation', 1);
        expect(settings.setInstallationScenario).toHaveBeenCalledTimes(2);
        expect(settings.setScenarioPaused).toHaveBeenCalledTimes(2);
        expect(settings.requestScenarioHandoff).toHaveBeenCalledTimes(1);
        expect(settings.beginControlRequest).not.toHaveBeenCalled();
    });

    test('a status read does not refresh a cache nobody else writes', async () => {
        settings.readStopFence.mockReturnValue({ state: 'missing' });
        settings.readControlStatus.mockReturnValue({ state: 'not-recorded' });
        await handlers['get-scenario-request-status'](null, { requestId: 'r1' });
        expect(settings.refreshScenarioControlsAsync).not.toHaveBeenCalled();
    });
});

describe('photo pools', () => {
    test('set-photo-pool saves a pool and maps each refusal', async () => {
        settings.setPhotoPool.mockReturnValue('ok');
        await expect(handlers['set-photo-pool'](null, 'a', ['1', '2'])).resolves.toEqual({ success: true });
        expect(settings.setPhotoPool).toHaveBeenCalledWith('a', ['1', '2']);
        for (const outcome of ['invalid', 'cap', 'exists', 'write-failed'] as const) {
            settings.setPhotoPool.mockReturnValue(outcome);
            await expect(handlers['set-photo-pool'](null, 'a', [])).resolves.toEqual({
                success: false,
                error: outcome,
            });
        }
        const bad = { success: false, error: 'invalid-args' };
        await expect(handlers['set-photo-pool'](null, invalid<string>(3), [])).resolves.toEqual(bad);
        await expect(handlers['set-photo-pool'](null, 'a', invalid<string[]>('x'))).resolves.toEqual(bad);
        await expect(handlers['set-photo-pool'](null, 'a', invalid<string[]>(['1', 2]))).resolves.toEqual(bad);
    });

    test('create-photo-pool creates, answers a name that is taken as exists, and maps each refusal', async () => {
        settings.createPhotoPool.mockReturnValue('ok');
        await expect(handlers['create-photo-pool'](null, 'a', ['1', '2'])).resolves.toEqual({ success: true });
        expect(settings.createPhotoPool).toHaveBeenCalledWith('a', ['1', '2']);
        for (const outcome of ['invalid', 'cap', 'exists', 'write-failed'] as const) {
            settings.createPhotoPool.mockReturnValue(outcome);
            await expect(handlers['create-photo-pool'](null, 'a', ['1'])).resolves.toEqual({
                success: false,
                error: outcome,
            });
        }
        const bad = { success: false, error: 'invalid-args' };
        await expect(handlers['create-photo-pool'](null, invalid<string>(3), [])).resolves.toEqual(bad);
        await expect(handlers['create-photo-pool'](null, 'a', invalid<string[]>('x'))).resolves.toEqual(bad);
        await expect(handlers['create-photo-pool'](null, 'a', invalid<string[]>(['1', 2]))).resolves.toEqual(bad);
    });

    test('set-photo-pool takes a name and a list and nothing else: it is the upsert, never a create', async () => {
        settings.setPhotoPool.mockClear();
        settings.setPhotoPool.mockReturnValue('ok');
        await handlers['set-photo-pool'](null, 'a', ['1']);
        expect(settings.setPhotoPool).toHaveBeenCalledWith('a', ['1']);
    });

    test('delete and rename answer the facade result', async () => {
        settings.deletePhotoPool.mockReturnValue({ ok: true });
        await expect(handlers['delete-photo-pool'](null, 'a')).resolves.toEqual({ success: true });
        settings.deletePhotoPool.mockReturnValue({ ok: false, reason: 'unresolved-work' });
        await expect(handlers['delete-photo-pool'](null, 'a')).resolves.toEqual({
            success: false,
            error: 'unresolved-work',
        });
        settings.renamePhotoPool.mockReturnValue({ ok: true });
        await expect(handlers['rename-photo-pool'](null, 'a', 'b')).resolves.toEqual({ success: true });
        expect(settings.renamePhotoPool).toHaveBeenCalledWith('a', 'b');
        settings.renamePhotoPool.mockReturnValue({ ok: false, reason: 'exists' });
        await expect(handlers['rename-photo-pool'](null, 'a', 'b')).resolves.toEqual({
            success: false,
            error: 'exists',
        });
        const bad = { success: false, error: 'invalid-args' };
        await expect(handlers['delete-photo-pool'](null, invalid<string>(1))).resolves.toEqual(bad);
        await expect(handlers['rename-photo-pool'](null, 'a', invalid<string>(1))).resolves.toEqual(bad);
        await expect(handlers['rename-photo-pool'](null, invalid<string>(1), 'b')).resolves.toEqual(bad);
    });
});

describe('the controller seams', () => {
    test('scenario-stop-fence reads the fence; a read never lifts a block or arms', async () => {
        seams.nodeStopFence.read.mockResolvedValue({ state: 'ok', fence: FENCE });
        await expect(handlers['scenario-stop-fence'](null)).resolves.toEqual({
            success: true,
            fence: { state: 'ok', fence: FENCE },
        });
        expect(seams.nodeStopFence.clearStopBlock).not.toHaveBeenCalled();
        expect(seams.nodeStopFence.armIfAllowed).not.toHaveBeenCalled();
    });

    test('scenario-stop-fence can create a fence that was never created, and ask whether an epoch may arm', async () => {
        seams.nodeStopFence.initialize.mockResolvedValue({ ok: true, created: true });
        seams.nodeStopFence.read.mockResolvedValue({ state: 'ok', fence: { ...FENCE, blocked: false } });
        seams.nodeStopFence.isArmAllowed.mockResolvedValue(true);
        await expect(handlers['scenario-stop-fence'](null, { initialize: true, armEpoch: 2 })).resolves.toEqual({
            success: true,
            fence: { state: 'ok', fence: { ...FENCE, blocked: false } },
            created: true,
            armAllowed: true,
        });
        expect(seams.nodeStopFence.isArmAllowed).toHaveBeenCalledWith(2);
    });

    test('a fence that cannot be created fails with its reason', async () => {
        seams.nodeStopFence.initialize.mockResolvedValue({ ok: false, reason: 'not-saved' });
        await expect(handlers['scenario-stop-fence'](null, { initialize: true })).resolves.toEqual({
            success: false,
            error: 'not-saved',
        });
    });

    test('scenario-stop-fence refuses options that are not what it takes', async () => {
        const bad = { success: false, error: 'invalid-args' };
        await expect(handlers['scenario-stop-fence'](null, invalid<{ initialize: true }>('x'))).resolves.toEqual(bad);
        await expect(
            handlers['scenario-stop-fence'](null, invalid<{ initialize: true }>({ initialize: 'yes' })),
        ).resolves.toEqual(bad);
        await expect(
            handlers['scenario-stop-fence'](null, invalid<{ armEpoch: number }>({ armEpoch: -1 })),
        ).resolves.toEqual(bad);
    });

    test('record-full-stop records the Stop in the fence and announces', async () => {
        seams.nodeStopFence.recordFullStop.mockResolvedValue({ ok: true, epoch: 3 });
        await expect(handlers['record-full-stop'](null, 'req-1', 1000)).resolves.toEqual({ success: true, epoch: 3 });
        expect(seams.nodeStopFence.recordFullStop).toHaveBeenCalledWith('req-1', 1000);
        expect(events.announceEffectiveChange).toHaveBeenCalledTimes(1);
        seams.nodeStopFence.recordFullStop.mockResolvedValue({ ok: false, reason: 'unreadable' });
        await expect(handlers['record-full-stop'](null, 'req-1', 1000)).resolves.toEqual({
            success: false,
            error: 'unreadable',
        });
        const bad = { success: false, error: 'invalid-args' };
        await expect(handlers['record-full-stop'](null, invalid<string>(''), 1)).resolves.toEqual(bad);
        await expect(handlers['record-full-stop'](null, 'x'.repeat(129), 1)).resolves.toEqual(bad);
        await expect(handlers['record-full-stop'](null, 'r', invalid<number>(Number.NaN))).resolves.toEqual(bad);
    });

    test('arm-autovote is the user route: it lifts the block at the epoch the user saw, then arms there', async () => {
        seams.nodeStopFence.clearStopBlock.mockResolvedValue({ ok: true });
        seams.nodeStopFence.armIfAllowed.mockResolvedValue({ ok: true });
        await expect(handlers['arm-autovote'](null, 2)).resolves.toEqual({ success: true });
        expect(seams.nodeStopFence.clearStopBlock).toHaveBeenCalledWith(2);
        expect(seams.nodeStopFence.armIfAllowed).toHaveBeenCalledWith(2, expect.any(Number));
    });

    test('a stale epoch leaves the block, and arms nothing', async () => {
        seams.nodeStopFence.clearStopBlock.mockResolvedValue({ ok: false, reason: 'stale-epoch' });
        await expect(handlers['arm-autovote'](null, 1)).resolves.toEqual({ success: false, error: 'stale-epoch' });
        expect(seams.nodeStopFence.armIfAllowed).not.toHaveBeenCalled();
    });

    test('an arm the fence then refuses reports why', async () => {
        seams.nodeStopFence.clearStopBlock.mockResolvedValue({ ok: true });
        seams.nodeStopFence.armIfAllowed.mockResolvedValue({ ok: false, reason: 'blocked' });
        await expect(handlers['arm-autovote'](null, 2)).resolves.toEqual({ success: false, error: 'blocked' });
        await expect(handlers['arm-autovote'](null, invalid<number>(-1))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });

    test('arm-if-allowed is the CAS alone: it never lifts a block', async () => {
        seams.nodeStopFence.armIfAllowed.mockResolvedValue({ ok: false, reason: 'blocked' });
        await expect(handlers['arm-if-allowed'](null, 2)).resolves.toEqual({ success: false, error: 'blocked' });
        seams.nodeStopFence.armIfAllowed.mockResolvedValue({ ok: true });
        await expect(handlers['arm-if-allowed'](null, 2)).resolves.toEqual({ success: true });
        expect(seams.nodeStopFence.clearStopBlock).not.toHaveBeenCalled();
        await expect(handlers['arm-if-allowed'](null, invalid<number>('2'))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });

    test('only arm-autovote ever reaches clearStopBlock', async () => {
        seams.nodeStopFence.read.mockResolvedValue({ state: 'ok', fence: FENCE });
        seams.nodeStopFence.initialize.mockResolvedValue({ ok: true, created: false });
        seams.nodeStopFence.isArmAllowed.mockResolvedValue(false);
        seams.nodeStopFence.recordFullStop.mockResolvedValue({ ok: true, epoch: 3 });
        seams.nodeStopFence.armIfAllowed.mockResolvedValue({ ok: true });
        seams.withdrawInstallation.mockReturnValue('none');
        seams.reArmInstallation.mockReturnValue('none');
        scenarioStatus.ledgerForMode.mockReturnValue(invalid({ get: () => ({ corrupt: false, state: null }) }));
        for (const [name, args] of Object.entries({
            'scenario-stop-fence': [{ initialize: true, armEpoch: 2 }],
            'record-full-stop': ['r', 1],
            'arm-if-allowed': [2],
            'withdraw-installation': [3],
            'rearm-installation': [],
            'get-stop-status': [],
        })) {
            await (handlers as unknown as Record<string, (...a: unknown[]) => unknown>)[name](null, ...args);
        }
        expect(seams.nodeStopFence.clearStopBlock).not.toHaveBeenCalled();
    });

    test('withdraw-installation withdraws the publication under an epoch and announces', async () => {
        seams.withdrawInstallation.mockReturnValue('withdrawn');
        await expect(handlers['withdraw-installation'](null, 3)).resolves.toEqual({
            success: true,
            outcome: 'withdrawn',
        });
        expect(seams.withdrawInstallation).toHaveBeenCalledWith(3);
        expect(events.announceEffectiveChange).toHaveBeenCalledTimes(1);
        await expect(handlers['withdraw-installation'](null, invalid<number>('3'))).resolves.toEqual({
            success: false,
            error: 'invalid-args',
        });
    });

    test('a withdrawal or a lift that did not land is a failure, and announces nothing', async () => {
        seams.withdrawInstallation.mockReturnValue('failed');
        await expect(handlers['withdraw-installation'](null, 3)).resolves.toEqual({
            success: false,
            error: 'withdrawal-not-saved',
        });
        seams.reArmInstallation.mockReturnValue('failed');
        await expect(handlers['rearm-installation']()).resolves.toEqual({
            success: false,
            error: 'restore-not-saved',
        });
        expect(events.announceEffectiveChange).not.toHaveBeenCalled();
    });

    test('rearm-installation lifts the withdrawal and announces', async () => {
        seams.reArmInstallation.mockReturnValue('restored');
        await expect(handlers['rearm-installation']()).resolves.toEqual({ success: true, outcome: 'restored' });
        expect(events.announceEffectiveChange).toHaveBeenCalledTimes(1);
    });

    test('get-account-wake returns the account boundaries the main process worked out', async () => {
        const wake = { installation: null, candidates: [], claimAt: null, missionExpiry: null };
        resolvers.resolveAccountWake.mockReturnValue(wake);
        await expect(handlers['get-account-wake']()).resolves.toEqual({ success: true, wake });
        resolvers.resolveAccountWake.mockImplementation(() => {
            throw new Error('no wake');
        });
        await expect(handlers['get-account-wake']()).resolves.toEqual({ success: false, error: 'no wake' });
    });

    test('a seam that rejects answers a failure instead of throwing', async () => {
        seams.nodeStopFence.recordFullStop.mockRejectedValue(new Error('disk'));
        await expect(handlers['record-full-stop'](null, 'r', 1)).resolves.toEqual({ success: false, error: 'disk' });
    });
});

describe('the control inbox routes', () => {
    const OK_FENCE = { state: 'ok', fence: FENCE } as const;

    describe('get-scenario-request-status', () => {
        test.each([
            ['by identity', { requestId: 'r1' }],
            ['by target', { target: '7' }],
        ])("answers %s with the inbox's status under the current Stop epoch", async (_label, query) => {
            settings.readStopFence.mockReturnValue(OK_FENCE);
            settings.readControlStatus.mockReturnValue({ state: 'not-recorded' });
            await expect(handlers['get-scenario-request-status'](null, query)).resolves.toEqual({
                success: true,
                state: 'not-recorded',
            });
            expect(settings.readControlStatus).toHaveBeenCalledWith(query, 2);
        });

        test('reads the epoch as unknown where the fence cannot be read', async () => {
            settings.readStopFence.mockReturnValue({ state: 'unreadable', reason: 'malformed' });
            settings.readControlStatus.mockReturnValue({ state: 'unknown' });
            await expect(handlers['get-scenario-request-status'](null, { target: '7' })).resolves.toEqual({
                success: true,
                state: 'unknown',
            });
            expect(settings.readControlStatus).toHaveBeenCalledWith({ target: '7' }, null);
        });

        test.each([
            ['nothing', undefined],
            ['a string', 'r1'],
            ['an empty query', {}],
            ['both keys', { requestId: 'r1', target: '7' }],
            ['an identity that is not bounded text', { requestId: 'a b' }],
            ['a target that is not text', { target: 7 }],
            ['an extra key', { target: '7', also: 1 }],
        ])('refuses %s', async (_label, query) => {
            await expect(handlers['get-scenario-request-status'](null, invalid(query))).resolves.toEqual({
                success: false,
                error: 'invalid-args',
            });
        });

        test('never throws to the renderer', async () => {
            settings.readStopFence.mockImplementation(() => {
                throw new Error('fence');
            });
            await expect(handlers['get-scenario-request-status'](null, { target: '7' })).resolves.toEqual({
                success: false,
                error: 'fence',
            });
        });
    });

    describe('begin-scenario-request', () => {
        const asked = { requestId: 'r1', operation: 'pause-scenario', target: '7', args: '["7"]' };

        test("persists the request under the current Stop epoch and the clock, and answers the inbox's outcome", async () => {
            settings.readStopFence.mockReturnValue(OK_FENCE);
            settings.beginControlRequest.mockResolvedValue({ ok: true, outcome: 'accepted', revision: 1 });
            await expect(handlers['begin-scenario-request'](null, { ...asked, expectedRevision: 1 })).resolves.toEqual({
                success: true,
                ok: true,
                outcome: 'accepted',
                revision: 1,
            });
            expect(settings.beginControlRequest).toHaveBeenCalledWith({
                ...asked,
                expectedRevision: 1,
                stopEpoch: 2,
                at: expect.any(Number),
            });
        });

        test('without an expected revision passes none, and with no readable fence passes no epoch', async () => {
            settings.readStopFence.mockReturnValue({ state: 'missing' });
            settings.beginControlRequest.mockResolvedValue({ ok: true, outcome: 'accepted', revision: 0 });
            await handlers['begin-scenario-request'](null, asked);
            expect(settings.beginControlRequest).toHaveBeenCalledWith({
                ...asked,
                stopEpoch: null,
                at: expect.any(Number),
            });
        });

        test.each(['conflict', 'stale', 'busy', 'full', 'too-large', 'unreadable', 'not-saved', 'invalid'] as const)(
            'answers a refusal (%s) as its reason',
            async (reason) => {
                settings.readStopFence.mockReturnValue(OK_FENCE);
                settings.beginControlRequest.mockResolvedValue({ ok: false, reason });
                await expect(handlers['begin-scenario-request'](null, asked)).resolves.toEqual({
                    success: false,
                    error: reason,
                });
            },
        );

        test.each([
            ['nothing', undefined],
            ['arguments that are not text', { ...asked, args: ['7'] }],
            ['an expected revision that is not a count', { ...asked, expectedRevision: -1 }],
            ['an identity that is not bounded text', { ...asked, requestId: 'a b' }],
            ['an operation that is not bounded text', { ...asked, operation: '' }],
            ['a target that is not bounded text', { ...asked, target: 7 }],
            ['an extra key', { ...asked, also: 1 }],
        ])('refuses %s', async (_label, request) => {
            await expect(handlers['begin-scenario-request'](null, invalid(request))).resolves.toEqual({
                success: false,
                error: 'invalid-args',
            });
            expect(settings.beginControlRequest).not.toHaveBeenCalled();
        });
    });

    describe('finish-scenario-request', () => {
        const asked = { requestId: 'r1', target: '7', ok: true };

        test("records the result with the clock and answers the inbox's outcome", async () => {
            settings.finishControlRequest.mockResolvedValue({ ok: true, status: 'applied', revision: 2 });
            await expect(handlers['finish-scenario-request'](null, asked)).resolves.toEqual({
                success: true,
                ok: true,
                status: 'applied',
                revision: 2,
            });
            expect(settings.finishControlRequest).toHaveBeenCalledWith({
                ...asked,
                error: null,
                at: expect.any(Number),
            });
        });

        test('passes the reason of a failed one', async () => {
            settings.finishControlRequest.mockResolvedValue({ ok: true, status: 'failed', revision: 2 });
            await handlers['finish-scenario-request'](null, { ...asked, ok: false, error: 'busy' });
            expect(settings.finishControlRequest).toHaveBeenCalledWith({
                requestId: 'r1',
                target: '7',
                ok: false,
                error: 'busy',
                at: expect.any(Number),
            });
        });

        test.each(['not-pending', 'unreadable', 'not-saved', 'invalid'] as const)(
            'answers a refusal (%s) as its reason',
            async (reason) => {
                settings.finishControlRequest.mockResolvedValue({ ok: false, reason });
                await expect(handlers['finish-scenario-request'](null, asked)).resolves.toEqual({
                    success: false,
                    error: reason,
                });
            },
        );

        test.each([
            ['nothing', undefined],
            ['a result that is not a boolean', { ...asked, ok: 'yes' }],
            ['a reason that is not text', { ...asked, error: 5 }],
            ['a reason over the bound', { ...asked, error: 'x'.repeat(121) }],
            ['an identity that is not bounded text', { ...asked, requestId: 'a b' }],
            ['a target that is not bounded text', { ...asked, target: 'a b' }],
            ['an extra key', { ...asked, also: 1 }],
        ])('refuses %s', async (_label, request) => {
            await expect(handlers['finish-scenario-request'](null, invalid(request))).resolves.toEqual({
                success: false,
                error: 'invalid-args',
            });
            expect(settings.finishControlRequest).not.toHaveBeenCalled();
        });
    });
});

describe('set-installation-scenario owner-keeping option', () => {
    test('is passed to the settings change, which judges it with the generation', async () => {
        settings.setInstallationScenario.mockReturnValue({ ok: false, reason: 'owner-policy', generation: 3 });
        await expect(
            handlers['set-installation-scenario'](null, 'Plan', 'cli', 3, { keepExecutor: true }),
        ).resolves.toEqual({ success: false, error: 'owner-policy', generation: 3 });
        expect(settings.setInstallationScenario).toHaveBeenLastCalledWith('Plan', 'cli', 3, { keepExecutor: true });
    });

    test.each([
        ['null', null],
        ['text', 'keepExecutor'],
        ['a list', [true]],
        ['an empty object', {}],
        ['keepExecutor false', { keepExecutor: false }],
        ['keepExecutor that is no boolean', { keepExecutor: 'yes' }],
        ['an extra key', { keepExecutor: true, also: 1 }],
    ])('refuses an option that is %s, and nothing is changed', async (_label, options) => {
        settings.setInstallationScenario.mockClear();
        await expect(
            handlers['set-installation-scenario'](null, 'Plan', 'cli', 3, invalid<{ keepExecutor: true }>(options)),
        ).resolves.toEqual({ success: false, error: 'invalid-args' });
        expect(settings.setInstallationScenario).not.toHaveBeenCalled();
    });
});

describe('begin-scenario-request on a stale revision', () => {
    test('answers where the target stands now', async () => {
        settings.readStopFence.mockReturnValue({ state: 'missing' });
        settings.beginControlRequest.mockResolvedValue({ ok: false, reason: 'stale', revision: 9 });
        await expect(
            handlers['begin-scenario-request'](null, {
                requestId: 'r1',
                operation: 'pause-scenario',
                target: '7',
                args: '["7"]',
            }),
        ).resolves.toEqual({ success: false, error: 'stale', revision: 9 });
    });
});

describe('get-phase-profiles', () => {
    test('answers the saved profiles a phase may apply, as the host’s own check names them', async () => {
        settings.listPhaseProfiles.mockReturnValue(['Evening', 'Night']);
        await expect(handlers['get-phase-profiles']()).resolves.toEqual({
            success: true,
            profiles: ['Evening', 'Night'],
        });
    });

    test('a read that throws is a failure the caller can show, never a throw', async () => {
        settings.listPhaseProfiles.mockImplementation(() => {
            throw new Error('unreadable');
        });
        await expect(handlers['get-phase-profiles']()).resolves.toMatchObject({ success: false });
    });
});
