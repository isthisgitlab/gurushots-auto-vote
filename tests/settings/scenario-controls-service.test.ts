/**
 * The service's half of the ordinary control inbox (settings/scenarioControls.ts): a request queued for the Android service
 * is not tied to an app run (it stays pending across app restarts and service downtime), the service claims it by
 * compare-and-write under its run id, and a request still claimed when the next claim pass runs is recorded `interrupted`
 * and never applied again by itself. Drives the in-memory headless seam.
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
    };
});

// First: it installs the headless platform that the stores below are built over.
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import type { MemoryStore } from '../helpers/headlessStore';
import { parseJson } from '../helpers/parseJson';
import settings = require('../../src/ts/core/settings');
import storageModule = require('../../src/ts/core/settings/storage');
import {
    CONTROLS_KEY,
    CONTROLS_MAX_BYTES,
    CONTROL_PAYLOAD_MAX_BYTES,
} from '../../src/ts/core/settings/scenarioControls';

let store: MemoryStore;

const NOW = Date.now() + 1000;
const RUN = 'run-a';

const queued = (over: Partial<Parameters<typeof settings.beginControlRequest>[0]> = {}) => ({
    requestId: 'r1',
    operation: 'pause-scenario',
    target: '7',
    args: '["7"]',
    stopEpoch: 0,
    at: NOW,
    executor: 'android-service' as const,
    ...over,
});

const raw = (): string | undefined => store.keys.get(CONTROLS_KEY);
const claim = (over: Partial<Parameters<typeof settings.claimServiceControlRequests>[0]> = {}) =>
    settings.claimServiceControlRequests({ runId: RUN, epoch: 0, at: NOW + 5, ...over });

beforeEach(async () => {
    store = installHeadlessStore();
    await storageModule.discardPendingWrites();
    storageModule.resumeWrites();
});

afterEach(() => {
    jest.restoreAllMocks();
    removeHeadlessStore();
});

describe('a request queued for the service', () => {
    test('is persisted unclaimed, for the service, and stays pending when an earlier app run queued it', async () => {
        await expect(settings.beginControlRequest(queued({ at: 1 }))).resolves.toEqual({
            ok: true,
            outcome: 'accepted',
            revision: 0,
        });
        expect(parseJson(raw()!)).toMatchObject({
            targets: { '7': { pending: { executor: 'android-service', claimedBy: null, claimedAt: null } } },
        });
        // The app-run rule does not apply: it is pending, not interrupted, however long ago it was queued.
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toMatchObject({ record: { status: 'pending' } });
        // The same request from the app's own run, queued as long ago, is interrupted.
        await settings.beginControlRequest(queued({ requestId: 'r2', target: '8', at: 1, executor: undefined }));
        expect(settings.readControlStatus({ requestId: 'r2' }, 0)).toMatchObject({ record: { status: 'interrupted' } });
    });

    test('holds its target slot while it waits, however old it is', async () => {
        await settings.beginControlRequest(queued({ at: 1 }));
        await expect(settings.beginControlRequest(queued({ requestId: 'r2', at: NOW }))).resolves.toEqual({
            ok: false,
            reason: 'busy',
        });
    });

    test('a repeated identity answers the record, and the same identity with other arguments is a conflict', async () => {
        await settings.beginControlRequest(queued());
        const before = raw();
        await expect(settings.beginControlRequest(queued())).resolves.toEqual({
            ok: true,
            outcome: 'duplicate',
            status: 'pending',
            revision: 0,
            error: null,
        });
        await expect(settings.beginControlRequest(queued({ args: '["8"]' }))).resolves.toEqual({
            ok: false,
            reason: 'conflict',
        });
        expect(raw()).toBe(before);
    });

    test('is superseded by a Stop like any other, and stays inspectable', async () => {
        await settings.beginControlRequest(queued());
        expect(settings.readControlStatus({ requestId: 'r1' }, 1)).toMatchObject({ record: { status: 'superseded' } });
    });
});

describe('the service claiming', () => {
    test('claims an unclaimed request under its run id in one write, and hands back what to apply', async () => {
        await settings.beginControlRequest(queued({ at: 1 }));
        await expect(claim()).resolves.toEqual({
            ok: true,
            claimed: [{ requestId: 'r1', operation: 'pause-scenario', target: '7', args: '["7"]' }],
            interrupted: 0,
        });
        expect(parseJson(raw()!)).toMatchObject({
            targets: { '7': { pending: { requestId: 'r1', claimedBy: RUN, claimedAt: NOW + 5 } } },
        });
        // Claimed, it still reads pending to the app: only a recorded result changes that.
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toMatchObject({ record: { status: 'pending' } });
    });

    test('a recorded result follows: applied advances the revision', async () => {
        await settings.beginControlRequest(queued());
        await claim();
        await expect(
            settings.finishControlRequest({ requestId: 'r1', target: '7', ok: true, error: null, at: NOW + 6 }),
        ).resolves.toEqual({ ok: true, status: 'applied', revision: 1 });
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toMatchObject({
            record: { status: 'applied', revision: 1 },
        });
    });

    test('writes nothing when nothing is waiting', async () => {
        await expect(claim()).resolves.toEqual({ ok: true, claimed: [], interrupted: 0 });
        expect(raw()).toBeUndefined();
        await settings.beginControlRequest(queued({ executor: undefined }));
        const before = raw();
        // A request of the app's own run is not the service's to claim.
        await expect(claim()).resolves.toEqual({ ok: true, claimed: [], interrupted: 0 });
        expect(raw()).toBe(before);
    });

    test('leaves a request of an older Stop epoch alone: it is superseded, not applied', async () => {
        await settings.beginControlRequest(queued({ stopEpoch: 0 }));
        const before = raw();
        await expect(claim({ epoch: 1 })).resolves.toEqual({ ok: true, claimed: [], interrupted: 0 });
        expect(raw()).toBe(before);
        // Where the fence cannot be read the epoch is unknown: nothing is claimed under an epoch it was not queued under.
        await expect(claim({ epoch: null })).resolves.toEqual({ ok: true, claimed: [], interrupted: 0 });
    });

    test('a request queued under an unreadable fence is claimed while the fence still cannot be read', async () => {
        await settings.beginControlRequest(queued({ stopEpoch: null }));
        await expect(claim({ epoch: null })).resolves.toMatchObject({ ok: true, claimed: [{ requestId: 'r1' }] });
    });

    test('claims every target that waits, each once', async () => {
        await settings.beginControlRequest(queued({ requestId: 'a', target: '7' }));
        await settings.beginControlRequest(queued({ requestId: 'b', target: '@installation' }));
        const first = await claim();
        expect(first.ok && first.claimed.map((request) => request.requestId).sort()).toEqual(['a', 'b']);
    });

    test('a request claimed by an earlier run is recorded interrupted, freeing its slot, and is not applied again', async () => {
        await settings.beginControlRequest(queued());
        await claim({ runId: 'run-old' });
        await expect(claim({ runId: 'run-new', at: NOW + 50 })).resolves.toEqual({
            ok: true,
            claimed: [],
            interrupted: 1,
        });
        expect(settings.readControlStatus({ target: '7' }, 0)).toMatchObject({
            pending: null,
            revision: 0,
            results: [{ requestId: 'r1', status: 'interrupted', revision: 0 }],
        });
        await expect(settings.beginControlRequest(queued({ requestId: 'r2' }))).resolves.toMatchObject({
            ok: true,
            outcome: 'accepted',
        });
    });

    test('a request this run claimed and never finished is interrupted too, and a new one in the same pass is claimed', async () => {
        await settings.beginControlRequest(queued());
        await claim();
        await settings.beginControlRequest(queued({ requestId: 'r2', target: '8' }));
        const next = await claim();
        expect(next).toMatchObject({ ok: true, interrupted: 1, claimed: [{ requestId: 'r2' }] });
    });

    test('a run id that is not bounded text is invalid, and nothing is written', async () => {
        await settings.beginControlRequest(queued());
        const before = raw();
        await expect(claim({ runId: 'has space' })).resolves.toEqual({ ok: false, reason: 'invalid' });
        expect(raw()).toBe(before);
    });

    test('an inbox that cannot be read is not claimed over', async () => {
        store.keys.set(CONTROLS_KEY, '{"nope":1}');
        await expect(claim()).resolves.toEqual({ ok: false, reason: 'unreadable' });
        expect(raw()).toBe('{"nope":1}');
    });

    test('a claim the native bridge did not persist is not made', async () => {
        await settings.beginControlRequest(queued());
        store.compareAndWriteKey = () => false;
        await expect(claim()).resolves.toEqual({ ok: false, reason: 'not-saved' });
    });

    test('a claim that would not fit beside what is pending is refused, nothing dropped', async () => {
        // Two requests that together fill the inbox to its last byte: claiming adds the run id and time to each.
        const build = (padding: number) =>
            JSON.stringify({
                targets: {
                    a: {
                        revision: 0,
                        pending: {
                            requestId: 'a',
                            operation: 'pause-scenario',
                            digest: 'd',
                            stopEpoch: 0,
                            at: NOW,
                            args: 'x'.repeat(CONTROL_PAYLOAD_MAX_BYTES),
                            executor: 'android-service',
                            claimedBy: null,
                            claimedAt: null,
                        },
                        results: [],
                    },
                    b: {
                        revision: 0,
                        pending: {
                            requestId: 'b',
                            operation: 'pause-scenario',
                            digest: 'd',
                            stopEpoch: 0,
                            at: NOW,
                            args: 'y'.repeat(padding),
                            executor: 'android-service',
                            claimedBy: null,
                            claimedAt: null,
                        },
                        results: [],
                    },
                },
            });
        const base = new TextEncoder().encode(build(0)).length;
        const full = build(CONTROLS_MAX_BYTES - base);
        expect(new TextEncoder().encode(full).length).toBe(CONTROLS_MAX_BYTES);
        store.keys.set(CONTROLS_KEY, full);
        await expect(claim()).resolves.toEqual({ ok: false, reason: 'full' });
        expect(raw()).toBe(full);
    });
});

describe('the strict shape of a pending request', () => {
    const pending = (over: Record<string, unknown>) =>
        JSON.stringify({
            targets: {
                '7': {
                    revision: 0,
                    pending: {
                        requestId: 'r1',
                        operation: 'pause-scenario',
                        digest: 'd',
                        stopEpoch: 0,
                        at: NOW,
                        args: '[]',
                        executor: 'android-service',
                        claimedBy: null,
                        claimedAt: null,
                        ...over,
                    },
                    results: [],
                },
            },
        });

    test('a well-formed claimed request reads', () => {
        store.keys.set(CONTROLS_KEY, pending({ claimedBy: 'run-a', claimedAt: 5 }));
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toMatchObject({ state: 'request' });
    });

    test.each([
        ['an executor that is not the service', { executor: 'cli' }],
        ['a claim with no time', { claimedBy: 'run-a' }],
        ['a claim time with no claimer', { claimedAt: 5 }],
        ['a claim on a request of the app run', { executor: null, claimedBy: 'run-a', claimedAt: 5 }],
        ['a claimer that is not bounded text', { claimedBy: 'a b', claimedAt: 5 }],
        ['a negative claim time', { claimedBy: 'run-a', claimedAt: -1 }],
    ])('%s makes the inbox unreadable', (_label, over) => {
        store.keys.set(CONTROLS_KEY, pending(over));
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toEqual({ state: 'unknown' });
    });

    test.each(['executor', 'claimedBy', 'claimedAt'])('a pending request without %s makes it unreadable', (key) => {
        const value = parseJson(pending({})) as { targets: { '7': { pending: Record<string, unknown> } } };
        delete value.targets['7'].pending[key];
        store.keys.set(CONTROLS_KEY, JSON.stringify(value));
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toEqual({ state: 'unknown' });
    });
});

describe('refreshing the cache', () => {
    test('reads what is stored again', async () => {
        await expect(settings.refreshScenarioControlsAsync()).resolves.toBe(true);
    });
});
