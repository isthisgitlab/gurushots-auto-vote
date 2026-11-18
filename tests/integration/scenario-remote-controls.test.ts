/**
 * A paired phone's scenario changes end to end over the real control inbox: the remote dispatch, the inbox handlers and the
 * persisted inbox. A lost connection before or after acceptance, a duplicate delivery, a conflicting identity, the status a
 * reconnected phone asks for by identity and by target, a record compacted away, a generic write that carries the scenario key,
 * and a save that races committed work. The effect handlers are counted stand-ins: what is under test is that each runs at most
 * once per identity and that the recorded status says what happened.
 */

// First: it installs the headless platform that the stores below are built over.
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';

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
        challengeTag: jest.fn(),
        withCategory: jest.fn(() => category),
        sanitizeLogString: (value: string) => value,
    };
});
jest.mock('../../src/ts/core/services/scenarioStatus', () => ({
    ledgerForMode: jest.fn(),
    listSimulationSubjects: jest.fn(),
}));
jest.mock('../../src/ts/core/scenarioStateStore', () => ({
    INSTALLATION_KEY: '@installation',
    refreshScenarioStateAsync: jest.fn(async () => {}),
}));
jest.mock('../../src/ts/core/autovote/nodeSeams', () => ({
    nodeStopFence: { read: jest.fn() },
    withdrawInstallation: jest.fn(),
    reArmInstallation: jest.fn(),
}));
jest.mock('../../src/ts/core/scheduling/nodeResolvers', () => ({ resolveAccountWake: jest.fn() }));
jest.mock('../../src/ts/core/services/effectiveEvents', () => ({
    announceEffectiveChange: jest.fn(),
    readEffective: jest.fn(),
}));
jest.mock('../../src/ts/core/services/auth', () => ({ requireAuthToken: jest.fn() }));
jest.mock('../../src/ts/core/apiFactory', () => ({ getApiStrategy: jest.fn() }));

import storageModule = require('../../src/ts/core/settings/storage');
import { dispatchRemoteInvoke } from '../../src/ts/core/remote/dispatch';
import { buildLifecycleHandlers } from '../../src/ts/core/ipc/scenarioLifecycle.handlers';
import type { MemoryStore } from '../helpers/headlessStore';
import type { RemoteInvokeRequest } from '../../src/ts/core/remote/dispatch';

let store: MemoryStore;
const handlers = buildLifecycleHandlers();

/** What each stand-in effect did, by channel. */
let applied: Array<{ channel: string; args: unknown[] }>;
/** What an effect answers; a function runs at the moment the effect runs (work that lands meanwhile). */
let effectAnswer: (channel: string) => unknown;

/** The host's window.api: the inbox routes are the real handlers; every other channel is a counted stand-in. */
const hostInvoke = async (channel: string, args: unknown[]): Promise<unknown> => {
    if (
        channel === 'begin-scenario-request' ||
        channel === 'finish-scenario-request' ||
        channel === 'get-scenario-request-status'
    ) {
        const handler = handlers[channel] as (event: null, ...rest: unknown[]) => Promise<unknown>;
        return handler(null, ...args);
    }
    applied.push({ channel, args });
    return effectAnswer(channel);
};

/** One phone's invoke through the dispatch, as the host would run it. */
const phoneInvoke = (channel: string, args: unknown[], request: RemoteInvokeRequest = {}) =>
    dispatchRemoteInvoke(channel, args, { invoke: hostInvoke }, request);

const status = (query: object) => hostInvoke('get-scenario-request-status', [query]);

beforeEach(async () => {
    store = installHeadlessStore();
    await storageModule.discardPendingWrites();
    storageModule.resumeWrites();
    applied = [];
    effectAnswer = () => ({ success: true });
});

afterEach(() => {
    jest.restoreAllMocks();
    removeHeadlessStore();
    expect(store).toBeDefined();
});

describe('a scenario change that arrives once', () => {
    test("is recorded as pending before it runs, then as applied with the target's next revision", async () => {
        let during: unknown;
        effectAnswer = () => {
            during = JSON.parse(store.keys.get('gs_scenario_controls') ?? 'null');
            return { success: true };
        };
        const outcome = await phoneInvoke('save-scenario', [{ name: 'Plan' }], { requestId: 'save-1' });
        expect(during).toMatchObject({ targets: { definitions: { revision: 0, pending: { requestId: 'save-1' } } } });
        expect(outcome).toMatchObject({
            kind: 'result',
            result: { success: true },
            control: { requestId: 'save-1', target: 'definitions', revision: 1 },
        });
        await expect(status({ requestId: 'save-1' })).resolves.toMatchObject({
            success: true,
            state: 'request',
            record: { requestId: 'save-1', status: 'applied', revision: 1 },
        });
    });

    test("a change the handler refuses is recorded as failed, and the target's revision does not move", async () => {
        effectAnswer = () => ({ success: false, error: 'unresolved-work' });
        const outcome = await phoneInvoke('delete-scenario', ['Plan'], { requestId: 'del-1' });
        expect(outcome).toMatchObject({
            result: { success: false, error: 'unresolved-work' },
            control: { revision: 0 },
        });
        await expect(status({ target: 'definitions' })).resolves.toMatchObject({
            state: 'target',
            revision: 0,
            results: [{ requestId: 'del-1', status: 'failed', error: 'unresolved-work' }],
        });
    });
});

describe('a handler that throws', () => {
    test("is recorded as failed with the target's revision, answered with the report, and the next change is not busy", async () => {
        effectAnswer = () => {
            throw new Error('handler blew up');
        };
        const outcome = await phoneInvoke('pause-scenario', ['7'], { requestId: 'boom' });
        expect(outcome).toMatchObject({
            result: { success: false, error: 'handler blew up' },
            control: { requestId: 'boom', target: '7', revision: 0 },
        });
        await expect(status({ requestId: 'boom' })).resolves.toMatchObject({ record: { status: 'failed' } });
        effectAnswer = () => ({ success: true });
        await expect(
            phoneInvoke('pause-scenario', ['7'], { requestId: 'again', expectedRevision: 0 }),
        ).resolves.toMatchObject({
            result: { success: true },
            control: { revision: 1 },
        });
    });
});

describe('connection loss', () => {
    test('a loss before acceptance leaves no record: the phone asks and finds nothing recorded, and a retry is applied once', async () => {
        // The invoke never reached the host. Its identity is unknown to the inbox, and says so — never "applied".
        await expect(status({ requestId: 'lost-before' })).resolves.toEqual({ success: true, state: 'not-recorded' });
        await phoneInvoke('pause-scenario', ['7'], { requestId: 'lost-before' });
        expect(applied.map((entry) => entry.channel)).toEqual(['pause-scenario']);
    });

    test('a loss after acceptance: the reconnected phone finds the result by identity and by target, and the retry is not applied again', async () => {
        await phoneInvoke('pause-scenario', ['7'], { requestId: 'lost-after' });
        // The answer never reached the phone. After the reconnect it asks (reads are allowed) and then repeats the request.
        await expect(status({ requestId: 'lost-after' })).resolves.toMatchObject({
            record: { status: 'applied', revision: 1 },
        });
        await expect(status({ target: '7' })).resolves.toMatchObject({
            state: 'target',
            revision: 1,
            pending: null,
            results: [{ requestId: 'lost-after', status: 'applied' }],
        });
        const retry = await phoneInvoke('pause-scenario', ['7'], { requestId: 'lost-after' });
        expect(retry).toMatchObject({ result: { success: true, duplicate: true }, control: { revision: 1 } });
        expect(applied).toHaveLength(1);
    });

    test('a host that stopped between acceptance and result leaves it pending, and the status says pending', async () => {
        const begun = await hostInvoke('begin-scenario-request', [
            { requestId: 'half', operation: 'pause-scenario', target: '7', args: '["7"]' },
        ]);
        expect(begun).toMatchObject({ success: true, outcome: 'accepted' });
        await expect(status({ requestId: 'half' })).resolves.toMatchObject({ record: { status: 'pending' } });
        // Another change to that target waits for it.
        await expect(phoneInvoke('resume-scenario', ['7'], { requestId: 'next' })).resolves.toMatchObject({
            result: { success: false, error: 'busy' },
        });
        expect(applied).toEqual([]);
    });
});

describe('duplicate and conflicting identities', () => {
    test('the same request delivered twice is applied once, and answered both times', async () => {
        const first = await phoneInvoke('rename-photo-pool', ['a', 'b'], { requestId: 'dup' });
        const second = await phoneInvoke('rename-photo-pool', ['a', 'b'], { requestId: 'dup' });
        expect(first).toMatchObject({ result: { success: true } });
        expect(second).toMatchObject({ result: { success: true, duplicate: true } });
        expect(applied).toHaveLength(1);
    });

    test('the same identity with other arguments is a conflict, and nothing runs', async () => {
        await phoneInvoke('set-photo-pool', ['a', ['1']], { requestId: 'same' });
        const other = await phoneInvoke('set-photo-pool', ['a', ['2']], { requestId: 'same' });
        expect(other).toMatchObject({ result: { success: false, error: 'conflict' } });
        const elsewhere = await phoneInvoke('delete-photo-pool', ['a'], { requestId: 'same' });
        expect(elsewhere).toMatchObject({ result: { success: false, error: 'conflict' } });
        expect(applied).toHaveLength(1);
    });

    test('a request that expected an older revision is stale; once its record is compacted away it still cannot apply again', async () => {
        await phoneInvoke('save-scenario', [{ name: 'A' }], { requestId: 'first' });
        for (let index = 0; index < 9; index++) {
            await phoneInvoke('save-scenario', [{ name: 'A' }, index], {
                requestId: `more-${index}`,
                expectedRevision: index + 1,
            });
        }
        await expect(status({ requestId: 'first' })).resolves.toEqual({ success: true, state: 'not-recorded' });
        const replay = await phoneInvoke('save-scenario', [{ name: 'A' }], { requestId: 'first', expectedRevision: 0 });
        expect(replay).toMatchObject({ result: { success: false, error: 'stale' } });
        expect(applied).toHaveLength(10);
        await expect(status({ target: 'definitions' })).resolves.toMatchObject({ revision: 10 });
    });
});

describe('a generic write cannot go around the lifecycle', () => {
    test.each([
        ['set-setting', ['scenario', 'Plan']],
        ['set-global-default', ['scenario', 'Plan']],
        ['set-challenge-override', ['scenario', '7', 'Plan']],
        ['save-settings', [{ challengeSettings: { 7: { values: { scenario: 'Plan' } } } }]],
        ['replace-challenge-overrides', ['7', { scenario: 'Plan' }]],
        ['apply-challenge-profile', ['7', 'profile']],
        ['set-title-rules', [[{ pattern: 'x', settings: { scenario: 'Plan' } }]]],
    ])('%s with the scenario key is refused without an identity', async (channel, args) => {
        await expect(phoneInvoke(channel, args)).resolves.toMatchObject({ kind: 'refused' });
        expect(applied).toEqual([]);
    });

    test('with an identity it runs through the inbox like any scenario change, once', async () => {
        const request = { requestId: 'generic-1' };
        await phoneInvoke('set-setting', ['scenario', 'Plan'], request);
        await phoneInvoke('set-setting', ['scenario', 'Plan'], request);
        expect(applied).toEqual([{ channel: 'set-setting', args: ['scenario', 'Plan'] }]);
        await expect(status({ target: 'assignments' })).resolves.toMatchObject({ revision: 1 });
    });

    test('a write of any other key needs no identity and never touches the inbox', async () => {
        await phoneInvoke('set-setting', ['exposure', 50]);
        expect(applied).toEqual([{ channel: 'set-setting', args: ['exposure', 50] }]);
        expect(store.keys.get('gs_scenario_controls')).toBeUndefined();
    });
});

describe('effectful saves racing committed work', () => {
    test('a save refused because work is committed is recorded as failed and leaves the target where it was; the retry after the work settles applies once', async () => {
        effectAnswer = () => ({ success: false, error: 'unresolved-work' });
        const refused = await phoneInvoke('save-scenario', [{ name: 'Plan' }], {
            requestId: 's1',
            expectedRevision: 0,
        });
        expect(refused).toMatchObject({
            result: { success: false, error: 'unresolved-work' },
            control: { revision: 0 },
        });
        // The work settles; the phone, told the target is still at revision 0, repeats with a new identity.
        effectAnswer = () => ({ success: true });
        const retried = await phoneInvoke('save-scenario', [{ name: 'Plan' }], {
            requestId: 's2',
            expectedRevision: 0,
        });
        expect(retried).toMatchObject({ result: { success: true }, control: { revision: 1 } });
        // The first save's identity, repeated, still answers failed: it is not applied now behind the new definition.
        const repeat = await phoneInvoke('save-scenario', [{ name: 'Plan' }], { requestId: 's1', expectedRevision: 0 });
        expect(repeat).toMatchObject({ result: { success: false, error: 'unresolved-work' } });
        expect(applied).toHaveLength(2);
    });

    test('a second save that arrives while the first is still being applied is busy and applies nothing; after the first it applies', async () => {
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        effectAnswer = () => held.then(() => ({ success: true }));
        const first = phoneInvoke('save-scenario', [{ name: 'Plan' }], { requestId: 'race-1' });
        // The first is accepted (pending) and waiting on its handler: wait until it has been persisted.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const second = await phoneInvoke('save-scenario', [{ name: 'Plan' }, 2], { requestId: 'race-2' });
        expect(second).toMatchObject({ result: { success: false, error: 'busy' } });
        expect(applied).toHaveLength(1);
        release();
        await expect(first).resolves.toMatchObject({ control: { revision: 1 } });
        effectAnswer = () => ({ success: true });
        const again = await phoneInvoke('save-scenario', [{ name: 'Plan' }, 2], {
            requestId: 'race-2',
            expectedRevision: 1,
        });
        expect(again).toMatchObject({ result: { success: true }, control: { revision: 2 } });
        expect(applied).toHaveLength(2);
    });
});

describe('what the inbox never shows', () => {
    test('no status carries the arguments of a request', async () => {
        await hostInvoke('begin-scenario-request', [
            {
                requestId: 'secret',
                operation: 'save-scenario',
                target: 'definitions',
                args: '[{"token":"SECRET-TOKEN"}]',
            },
        ]);
        const byId = await status({ requestId: 'secret' });
        const byTarget = await status({ target: 'definitions' });
        expect(JSON.stringify([byId, byTarget])).not.toContain('SECRET-TOKEN');
    });

    test('an unreadable inbox answers unknown, never not-recorded, and a change is refused rather than applied', async () => {
        store.keys.set('gs_scenario_controls', '{broken');
        await expect(status({ requestId: 'x' })).resolves.toEqual({ success: true, state: 'unknown' });
        await expect(phoneInvoke('pause-scenario', ['7'], { requestId: 'x' })).resolves.toMatchObject({
            result: { success: false, error: 'unreadable' },
        });
        expect(applied).toEqual([]);
    });
});
