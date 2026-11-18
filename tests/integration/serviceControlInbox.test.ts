/**
 * The Android service's control inbox end to end, over the real settings facade, the real progress ledger and the real
 * lifecycle handlers: while the service owns scenarios the window queues the five lifecycle effects and writes nothing else;
 * the service claims them at the start of its cycle, applies each through the same handler, and records the result. A request
 * queued while the service was down is applied on its next cycle, a request claimed by an earlier run is recorded interrupted
 * and not applied, and a full Stop never goes through the inbox.
 */

jest.mock('../../src/ts/core/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), success: jest.fn(), warning: jest.fn() };
    return {
        info: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        api: jest.fn(),
        isDevMode: jest.fn(() => false),
        isSourceCode: jest.fn(() => true),
        getAppName: jest.fn(() => 'gurushots-auto-vote-dev'),
        challengeTag: jest.fn((c: { id?: string | number } | null | undefined) => `[${c?.id}]`),
        withCategory: jest.fn(() => category),
        sanitizeLogString: (value: string) => value,
        debugLogEnabled: jest.fn(() => false),
        writeDebug: jest.fn(),
    };
});
// A partial mock, so the facade's members can be replaced for one test.
jest.mock('../../src/ts/core/settings', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/core/settings')>('../../src/ts/core/settings'),
}));
jest.mock('../../src/ts/core/joinStateStore', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/core/joinStateStore')>('../../src/ts/core/joinStateStore'),
}));

// First: it installs the headless platform that the stores below are built over.
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import settings = require('../../src/ts/core/settings');
import joinStateStore = require('../../src/ts/core/joinStateStore');
import storageModule = require('../../src/ts/core/settings/storage');
import loggerModule = require('../../src/ts/core/logger');
import { platform } from '../../src/ts/core/platform/port';
import { buildLifecycleHandlers } from '../../src/ts/core/ipc/scenarioLifecycle.handlers';
import { processServiceControls, RUN_ID } from '../../src/ts/shells/headless/serviceControls';
import { scenarioStateLedger, initialState, INSTALLATION_KEY } from '../../src/ts/core/scenarioStateStore';
import { CONTROLS_KEY } from '../../src/ts/core/settings/scenarioControls';
import { invalid } from '../helpers/invalid';

const log = jest.mocked(loggerModule);

const STATE_KEY = 'gs_scenario_state';
const NOW = Math.floor(Date.now() / 1000);
const handlers = buildLifecycleHandlers();

let store: MemoryStore;
let owns: jest.SpyInstance<boolean, []>;

const simple = (name: string) => ({
    name,
    version: 1,
    start: 'main',
    phases: { main: { rules: [{ id: 'fill', do: [{ type: 'notify', message: 'x' }] }] } },
});
const installationDoc = (name: string) => ({
    name,
    version: 1,
    scope: 'installation',
    start: 'main',
    phases: { main: { settings: { autoClaimPrizes: true } } },
});

const record = (key: string) => scenarioStateLedger.get(key).state;
const seed = (key: string, scenario = 'Plan') => {
    expect(scenarioStateLedger.change(key, () => ({ ...initialState(scenario, 'main', NOW) })).ok).toBe(true);
};
const status = (requestId: string) => settings.readControlStatus({ requestId }, 0);

type Call = (event: null, ...args: unknown[]) => Promise<{ success: boolean; requestId?: string; pending?: boolean }>;
/** The window's call: while the service owns scenarios it queues. */
const fromWindow = (operation: keyof typeof handlers, ...args: unknown[]) => {
    owns.mockReturnValue(true);
    try {
        return (handlers[operation] as unknown as Call)(null, ...args);
    } finally {
        owns.mockReturnValue(false);
    }
};

/** What the window queued is recorded under this identity. */
const queuedId = async (operation: keyof typeof handlers, ...args: unknown[]) => {
    const answer = await fromWindow(operation, ...args);
    expect(answer).toMatchObject({ success: true, pending: true });
    return answer.requestId!;
};

const assigned = () => {
    expect(settings.saveScenario(simple('Plan')).ok).toBe(true);
    expect(settings.saveScenario(simple('Next')).ok).toBe(true);
    expect(settings.saveScenario(installationDoc('Inst')).ok).toBe(true);
    expect(settings.setChallengeOverride('scenario', '7', 'Plan')).toBe(true);
    seed('7');
};

beforeEach(async () => {
    jest.clearAllMocks();
    store = installHeadlessStore();
    await storageModule.discardPendingWrites();
    storageModule.resumeWrites();
    jest.spyOn(joinStateStore, 'acquireUnlockLock').mockImplementation(() => ({ ok: true, release: () => {} }));
    owns = jest.spyOn(platform().capabilities, 'backgroundServiceOwnsScenarios').mockReturnValue(false);
    await settings.initializeStopFence();
});

afterEach(() => {
    jest.restoreAllMocks();
    removeHeadlessStore();
});

describe('the window while the service owns scenarios', () => {
    test('queues the operation and writes neither the ledger nor the configuration', async () => {
        assigned();
        const ledger = store.keys.get(STATE_KEY);
        const config = store.value;
        const id = await queuedId('pause-scenario', '7', 'later');
        expect(store.keys.get(STATE_KEY)).toBe(ledger);
        expect(store.value).toBe(config);
        expect(record('7')?.paused).toBeFalsy();
        // The window reports pending until a result is recorded.
        expect(status(id)).toMatchObject({
            state: 'request',
            record: { status: 'pending', operation: 'pause-scenario' },
        });
    });

    test('a second request for a subject that is waiting is busy', async () => {
        assigned();
        await queuedId('pause-scenario', '7');
        await expect(fromWindow('resume-scenario', '7')).resolves.toMatchObject({ success: false, error: 'busy' });
    });
});

describe('the service applying what is queued', () => {
    test('pause and resume of a challenge: recorded applied, the revision advances', async () => {
        assigned();
        const pause = await queuedId('pause-scenario', '7', 'later');
        await processServiceControls();
        expect(status(pause)).toMatchObject({ record: { status: 'applied', revision: 1 } });
        expect(record('7')).toMatchObject({ paused: { reason: 'later' } });

        const resume = await queuedId('resume-scenario', '7');
        await processServiceControls();
        expect(status(resume)).toMatchObject({ record: { status: 'applied', revision: 2 } });
        expect(record('7')?.paused).toBeFalsy();
    });

    test('handoff of a challenge to another scenario', async () => {
        assigned();
        const id = await queuedId('handoff-scenario', '7', 'Next', 0);
        await processServiceControls();
        expect(status(id)).toMatchObject({ record: { status: 'applied' } });
        expect(record('7')).toMatchObject({ scenario: 'Next', generation: 1 });
        expect(settings.getEffectiveSetting('scenario', '7')).toBe('Next');
    });

    test('set-installation-scenario, then clear-scenario-assignment of the installation', async () => {
        assigned();
        const set = await queuedId('set-installation-scenario', 'Inst', 'android-service', 0);
        await processServiceControls();
        expect(status(set)).toMatchObject({ record: { status: 'applied' } });
        expect(settings.getInstallationScenario()).toMatchObject({ scenario: 'Inst', executor: 'android-service' });

        const generation = settings.installationGeneration()!;
        const clear = await queuedId('clear-scenario-assignment', INSTALLATION_KEY, generation);
        await processServiceControls();
        expect(status(clear)).toMatchObject({ record: { status: 'applied' } });
        expect(settings.getInstallationScenario()).toBeNull();
    });

    test('a change the facade refuses is recorded failed with its reason, and its revision does not move', async () => {
        assigned();
        const id = await queuedId('handoff-scenario', '7', 'Next', 9);
        await processServiceControls();
        expect(status(id)).toMatchObject({ record: { status: 'failed', error: 'stale-generation', revision: 0 } });
        expect(record('7')).toMatchObject({ scenario: 'Plan' });
        expect(record('7')?.generation ?? 0).toBe(0);
    });

    test('a request queued while the service was down, long before this run began, is applied, not interrupted', async () => {
        assigned();
        await settings.beginControlRequest({
            requestId: 'old-1',
            operation: 'pause-scenario',
            target: '7',
            args: '["7"]',
            stopEpoch: 0,
            at: 1,
            executor: settings.SERVICE_EXECUTOR,
        });
        expect(status('old-1')).toMatchObject({ record: { status: 'pending' } });
        await processServiceControls();
        expect(status('old-1')).toMatchObject({ record: { status: 'applied' } });
        expect(record('7')?.paused).toBeTruthy();
    });

    test('a request claimed by an earlier run is recorded interrupted and is not applied again', async () => {
        assigned();
        const id = await queuedId('pause-scenario', '7');
        await settings.claimServiceControlRequests({ runId: 'run-before-restart', epoch: 0, at: Date.now() });
        await processServiceControls();
        expect(status(id)).toMatchObject({ record: { status: 'interrupted', revision: 0 } });
        expect(record('7')?.paused).toBeFalsy();
        // Its slot is free for a new request, which this run applies.
        const again = await queuedId('pause-scenario', '7');
        await processServiceControls();
        expect(status(again)).toMatchObject({ record: { status: 'applied' } });
    });

    test('a request queued before a Stop is superseded and is not applied', async () => {
        assigned();
        const id = await queuedId('pause-scenario', '7');
        expect((await settings.recordFullStop('stop-1', 1)).ok).toBe(true);
        await processServiceControls();
        expect(record('7')?.paused).toBeFalsy();
        expect(settings.readControlStatus({ requestId: id }, 1)).toMatchObject({ record: { status: 'superseded' } });
    });

    test('nothing queued: the pass writes nothing', async () => {
        const before = store.keys.get(CONTROLS_KEY);
        await processServiceControls();
        expect(store.keys.get(CONTROLS_KEY)).toBe(before);
    });

    test('a request with an operation the service does not apply, or arguments that are not a list, fails and is recorded', async () => {
        const ask = (requestId: string, operation: string, args: string, target: string) =>
            settings.beginControlRequest({
                requestId,
                operation,
                target,
                args,
                stopEpoch: 0,
                at: Date.now(),
                executor: settings.SERVICE_EXECUTOR,
            });
        await ask('u1', 'save-scenario', '[]', 'definitions');
        await ask('u2', 'pause-scenario', 'not json', '7');
        await ask('u3', 'pause-scenario', '{}', '8');
        await processServiceControls();
        expect(status('u1')).toMatchObject({ record: { status: 'failed', error: 'unsupported-operation' } });
        expect(status('u2')).toMatchObject({ record: { status: 'failed', error: 'invalid-args' } });
        expect(status('u3')).toMatchObject({ record: { status: 'failed', error: 'invalid-args' } });
    });

    test('a handler that throws is recorded failed with a bounded reason', async () => {
        assigned();
        const id = await queuedId('pause-scenario', '7');
        log.debugLogEnabled.mockImplementationOnce(() => {
            throw new Error('x'.repeat(300));
        });
        await processServiceControls();
        expect(status(id)).toMatchObject({ record: { status: 'failed', error: 'x'.repeat(120) } });
    });

    test('a handler that throws with no message is recorded as failed', async () => {
        assigned();
        const id = await queuedId('pause-scenario', '7');
        log.debugLogEnabled.mockImplementationOnce(() => {
            throw invalid<Error>({});
        });
        await processServiceControls();
        expect(status(id)).toMatchObject({ record: { status: 'failed' } });
    });

    test('a handler that answers false is a change that did not land', async () => {
        assigned();
        const id = await queuedId('pause-scenario', '7');
        jest.spyOn(settings, 'setScenarioPaused').mockReturnValue(invalid(false));
        await processServiceControls();
        // `false` from the facade is an unusable answer to the handler, which refuses it: failed, nothing applied.
        expect(status(id)).toMatchObject({ record: { status: 'failed' } });
    });
});

describe('a pass that cannot be made', () => {
    test('an inbox that cannot be read is said once and the cycle goes on', async () => {
        store.keys.set(CONTROLS_KEY, '{"nope":1}');
        await expect(processServiceControls()).resolves.toBeUndefined();
        expect(log.withCategory('scenario').warning).toHaveBeenCalledWith(
            'The control inbox could not be claimed (unreadable)',
            null,
        );
    });

    test('a claim that throws is logged and never reaches the cycle', async () => {
        jest.spyOn(settings, 'claimServiceControlRequests').mockRejectedValue(new Error('inbox down'));
        await expect(processServiceControls()).resolves.toBeUndefined();
        expect(log.withCategory('scenario').error).toHaveBeenCalledWith('The control inbox pass failed', 'inbox down');
    });

    test('a result that cannot be recorded is said, and the request stays claimed for the next pass to settle', async () => {
        assigned();
        const id = await queuedId('pause-scenario', '7');
        jest.spyOn(settings, 'finishControlRequest').mockResolvedValue({ ok: false, reason: 'not-saved' });
        await processServiceControls();
        expect(log.withCategory('scenario').warning).toHaveBeenCalledWith(
            "A queued request's result was not recorded (not-saved)",
            null,
        );
        jest.restoreAllMocks();
        await processServiceControls();
        expect(status(id)).toMatchObject({ record: { status: 'interrupted' } });
    });

    test('with no readable fence the epoch is unknown and what was queued under one is left waiting', async () => {
        assigned();
        await queuedId('pause-scenario', '7');
        store.keys.set('gs_scenario_stop_fence', '{"nope":1}');
        await processServiceControls();
        expect(record('7')?.paused).toBeFalsy();
    });
});

describe('the run id and the Stop', () => {
    test('the run id is a random bounded id made once per process', () => {
        expect(RUN_ID).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    });

    test('a full Stop never uses the inbox: it advances the fence and queues nothing', async () => {
        const before = store.keys.get(CONTROLS_KEY);
        owns.mockReturnValue(true);
        await expect(handlers['record-full-stop'](null, 'stop-1', Date.now())).resolves.toMatchObject({
            success: true,
            epoch: 1,
        });
        expect(store.keys.get(CONTROLS_KEY)).toBe(before);
    });
});
