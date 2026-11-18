/**
 * The ordinary control inbox (settings/scenarioControls.ts): a request is persisted before it is applied and its result
 * recorded after; a repeated identity answers the record and the same identity with other arguments is a conflict; one
 * pending request per target and Stop epoch; revisions survive compaction; the inbox is bounded and refuses what does not fit
 * without dropping anything pending; an unreadable inbox is unknown, never "not received". Drives the in-memory headless seam.
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
import { platform } from '../../src/ts/core/platform/port';
import {
    CONTROLS_KEY,
    CONTROLS_MAX_BYTES,
    CONTROL_PAYLOAD_MAX_BYTES,
} from '../../src/ts/core/settings/scenarioControls';
import { SCENARIO_CAPS } from '../../src/ts/core/scenarios/vocabulary';

let store: MemoryStore;

const NOW = Date.now() + 1000;

const request = (over: Partial<Parameters<typeof settings.beginControlRequest>[0]> = {}) => ({
    requestId: 'r1',
    operation: 'pause-scenario',
    target: '7',
    args: '["7"]',
    stopEpoch: 0,
    at: NOW,
    ...over,
});

const raw = (): string | undefined => store.keys.get(CONTROLS_KEY);

beforeEach(async () => {
    store = installHeadlessStore();
    await storageModule.discardPendingWrites();
    storageModule.resumeWrites();
});

afterEach(() => {
    jest.restoreAllMocks();
    removeHeadlessStore();
});

describe('accepting a request', () => {
    test('persists it as pending before anything is applied, with its arguments, and answers the revision', async () => {
        await expect(settings.beginControlRequest(request())).resolves.toEqual({
            ok: true,
            outcome: 'accepted',
            revision: 0,
        });
        expect(parseJson(raw()!)).toMatchObject({
            targets: { '7': { revision: 0, pending: { requestId: 'r1', args: '["7"]', stopEpoch: 0 } } },
        });
    });

    test('a repeated identical request answers what is recorded and writes nothing', async () => {
        await settings.beginControlRequest(request());
        const before = raw();
        await expect(settings.beginControlRequest(request())).resolves.toEqual({
            ok: true,
            outcome: 'duplicate',
            status: 'pending',
            revision: 0,
            error: null,
        });
        expect(raw()).toBe(before);
    });

    test.each([
        ['other arguments', { args: '["8"]' }],
        ['another operation', { operation: 'resume-scenario' }],
        ['another target', { target: '8' }],
    ])('the same identity with %s is a conflict, and nothing changes', async (_label, change) => {
        await settings.beginControlRequest(request());
        const before = raw();
        await expect(settings.beginControlRequest(request(change))).resolves.toEqual({ ok: false, reason: 'conflict' });
        expect(raw()).toBe(before);
    });

    test('a conflict is told for a finished request too', async () => {
        await settings.beginControlRequest(request());
        await settings.finishControlRequest({ requestId: 'r1', target: '7', ok: true, error: null, at: NOW });
        await expect(settings.beginControlRequest(request({ args: '["9"]' }))).resolves.toEqual({
            ok: false,
            reason: 'conflict',
        });
    });

    test('a second request for a target that holds a pending one is busy; another target is not', async () => {
        await settings.beginControlRequest(request());
        const before = raw();
        await expect(settings.beginControlRequest(request({ requestId: 'r2' }))).resolves.toEqual({
            ok: false,
            reason: 'busy',
        });
        expect(raw()).toBe(before);
        await expect(settings.beginControlRequest(request({ requestId: 'r3', target: '8' }))).resolves.toMatchObject({
            ok: true,
            outcome: 'accepted',
        });
    });

    test('a pending request of an older Stop epoch no longer holds the slot, and stays inspectable as superseded', async () => {
        await settings.beginControlRequest(request({ stopEpoch: 0 }));
        await expect(settings.beginControlRequest(request({ requestId: 'r2', stopEpoch: 1 }))).resolves.toMatchObject({
            ok: true,
            outcome: 'accepted',
        });
        expect(settings.readControlStatus({ requestId: 'r1' }, 1)).toMatchObject({
            state: 'request',
            record: { requestId: 'r1', status: 'superseded', revision: 0 },
        });
        expect(settings.readControlStatus({ requestId: 'r2' }, 1)).toMatchObject({ record: { status: 'pending' } });
    });

    test('a pending request seen under a newer epoch reads superseded, and a repeat of it says so', async () => {
        await settings.beginControlRequest(request({ stopEpoch: 0 }));
        expect(settings.readControlStatus({ requestId: 'r1' }, 3)).toMatchObject({ record: { status: 'superseded' } });
        await expect(settings.beginControlRequest(request({ stopEpoch: 3 }))).resolves.toMatchObject({
            outcome: 'duplicate',
            status: 'superseded',
        });
    });

    test('a pending request an earlier run never finished does not hold the slot; it reads interrupted', async () => {
        await settings.beginControlRequest(request({ at: 1 }));
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toMatchObject({ record: { status: 'interrupted' } });
        await expect(settings.beginControlRequest(request({ requestId: 'r2' }))).resolves.toMatchObject({
            ok: true,
            outcome: 'accepted',
        });
        expect(settings.readControlStatus({ target: '7' }, 0)).toMatchObject({
            state: 'target',
            pending: { requestId: 'r2', status: 'pending' },
            results: [{ requestId: 'r1', status: 'interrupted' }],
        });
    });

    test('a request whose identity or names are not bounded text is invalid', async () => {
        await expect(settings.beginControlRequest(request({ requestId: 'a b' }))).resolves.toEqual({
            ok: false,
            reason: 'invalid',
        });
        await expect(settings.beginControlRequest(request({ operation: '' }))).resolves.toEqual({
            ok: false,
            reason: 'invalid',
        });
        await expect(settings.beginControlRequest(request({ target: 'x'.repeat(65) }))).resolves.toEqual({
            ok: false,
            reason: 'invalid',
        });
        expect(raw()).toBeUndefined();
    });
});

describe('recording the result', () => {
    test('an applied request advances the target revision, drops its arguments and is answered to a repeat', async () => {
        await settings.beginControlRequest(request());
        await expect(
            settings.finishControlRequest({ requestId: 'r1', target: '7', ok: true, error: null, at: NOW }),
        ).resolves.toEqual({ ok: true, status: 'applied', revision: 1 });
        expect(raw()).not.toContain('["7"]');
        await expect(settings.beginControlRequest(request())).resolves.toEqual({
            ok: true,
            outcome: 'duplicate',
            status: 'applied',
            revision: 1,
            error: null,
        });
        // The same result recorded twice changes nothing.
        await expect(
            settings.finishControlRequest({ requestId: 'r1', target: '7', ok: true, error: null, at: NOW }),
        ).resolves.toEqual({ ok: true, status: 'applied', revision: 1 });
    });

    test('a failed request keeps the revision, records a bounded reason and frees the slot', async () => {
        await settings.beginControlRequest(request());
        await expect(
            settings.finishControlRequest({
                requestId: 'r1',
                target: '7',
                ok: false,
                error: 'busy'.repeat(100),
                at: NOW,
            }),
        ).resolves.toEqual({ ok: true, status: 'failed', revision: 0 });
        const status = settings.readControlStatus({ requestId: 'r1' }, 0);
        expect(status).toMatchObject({ record: { status: 'failed', revision: 0 } });
        expect((status as { record: { error: string } }).record.error).toHaveLength(120);
        await expect(settings.beginControlRequest(request({ requestId: 'r2' }))).resolves.toMatchObject({
            outcome: 'accepted',
        });
    });

    test('a failed request without a reason records none', async () => {
        await settings.beginControlRequest(request());
        await settings.finishControlRequest({ requestId: 'r1', target: '7', ok: false, error: null, at: NOW });
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toMatchObject({ record: { error: null } });
        await expect(settings.beginControlRequest(request())).resolves.toMatchObject({ status: 'failed', error: null });
    });

    test('a result for a request that is not pending, or for a bad identity, is refused', async () => {
        await expect(
            settings.finishControlRequest({ requestId: 'nope', target: '7', ok: true, error: null, at: NOW }),
        ).resolves.toEqual({ ok: false, reason: 'not-pending' });
        await settings.beginControlRequest(request());
        await expect(
            settings.finishControlRequest({ requestId: 'other', target: '7', ok: true, error: null, at: NOW }),
        ).resolves.toEqual({ ok: false, reason: 'not-pending' });
        await expect(
            settings.finishControlRequest({ requestId: 'r1', target: 'x y', ok: true, error: null, at: NOW }),
        ).resolves.toEqual({ ok: false, reason: 'invalid' });
    });
});

describe('revisions and compaction', () => {
    const applyOne = async (id: string, extra: object = {}) => {
        const begun = await settings.beginControlRequest(request({ requestId: id, ...extra }));
        await settings.finishControlRequest({ requestId: id, target: '7', ok: true, error: null, at: NOW + 1 });
        return begun;
    };

    test('a request that expected an older revision is stale, and nothing is written', async () => {
        await applyOne('r1');
        const before = raw();
        await expect(settings.beginControlRequest(request({ requestId: 'r2', expectedRevision: 0 }))).resolves.toEqual({
            ok: false,
            reason: 'stale',
        });
        expect(raw()).toBe(before);
        await expect(
            settings.beginControlRequest(request({ requestId: 'r2', expectedRevision: 1 })),
        ).resolves.toMatchObject({
            outcome: 'accepted',
        });
    });

    test('keeps the latest eight results of a target, and a request that expected an older revision cannot apply again once its record is gone', async () => {
        for (let index = 0; index < 10; index++) await applyOne(`r${index}`);
        const status = settings.readControlStatus({ target: '7' }, 0);
        expect(status).toMatchObject({ state: 'target', revision: 10 });
        expect((status as { results: Array<{ requestId: string }> }).results.map((result) => result.requestId)).toEqual(
            Array.from({ length: 8 }, (_, index) => `r${index + 2}`),
        );
        expect(settings.readControlStatus({ requestId: 'r0' }, 0)).toEqual({ state: 'not-recorded' });
        // r0 was applied once and is forgotten; its replay with the revision it expected is stale, never applied again.
        await expect(settings.beginControlRequest(request({ requestId: 'r0', expectedRevision: 0 }))).resolves.toEqual({
            ok: false,
            reason: 'stale',
        });
    });

    test('a full inbox drops the oldest results first, never a pending request and never a revision', async () => {
        for (let index = 0; index < 8; index++) await applyOne(`r${index}`);
        const first = 'x'.repeat(CONTROL_PAYLOAD_MAX_BYTES);
        await expect(
            settings.beginControlRequest(request({ requestId: 'big1', target: 'a', args: first })),
        ).resolves.toMatchObject({
            ok: true,
        });
        // A second pending request that fits only once the recorded results are gone.
        const bare = raw()!.replace(/"results":\[[^\]]*\]/g, '"results":[]');
        const room = CONTROLS_MAX_BYTES - new TextEncoder().encode(bare).length;
        const second = 'y'.repeat(room - 700);
        await expect(
            settings.beginControlRequest(request({ requestId: 'big2', target: 'b', args: second })),
        ).resolves.toMatchObject({
            ok: true,
        });
        expect(settings.readControlStatus({ target: 'a' }, 0)).toMatchObject({ pending: { requestId: 'big1' } });
        expect(settings.readControlStatus({ target: 'b' }, 0)).toMatchObject({ pending: { requestId: 'big2' } });
        const seven = settings.readControlStatus({ target: '7' }, 0) as { revision: number; results: unknown[] };
        expect(seven.revision).toBe(8);
        expect(seven.results.length).toBeLessThan(8);
    });
});

describe('the bound', () => {
    test('is twice the scenario import size, so one maximum document and its metadata fit', () => {
        expect(CONTROLS_MAX_BYTES).toBe(2 * SCENARIO_CAPS.importBytes);
        expect(CONTROL_PAYLOAD_MAX_BYTES).toBe(SCENARIO_CAPS.importBytes);
    });

    test('a maximum-sized request is accepted; one byte over is too large', async () => {
        const max = 'x'.repeat(CONTROL_PAYLOAD_MAX_BYTES);
        await expect(settings.beginControlRequest(request({ args: max }))).resolves.toMatchObject({
            ok: true,
            outcome: 'accepted',
        });
        await expect(
            settings.beginControlRequest(request({ requestId: 'r2', target: '8', args: `${max}x` })),
        ).resolves.toEqual({ ok: false, reason: 'too-large' });
    });

    test('a request that does not fit beside the pending ones is refused, and nothing pending is dropped', async () => {
        const max = 'x'.repeat(CONTROL_PAYLOAD_MAX_BYTES);
        await settings.beginControlRequest(request({ requestId: 'a', target: 'a', args: max }));
        await settings.beginControlRequest(request({ requestId: 'b', target: 'b', args: max.slice(0, 1000) }));
        const before = raw();
        await expect(
            settings.beginControlRequest(request({ requestId: 'c', target: 'c', args: max })),
        ).resolves.toEqual({
            ok: false,
            reason: 'full',
        });
        expect(raw()).toBe(before);
        expect(settings.readControlStatus({ target: 'a' }, 0)).toMatchObject({ pending: { requestId: 'a' } });
        expect(settings.readControlStatus({ target: 'b' }, 0)).toMatchObject({ pending: { requestId: 'b' } });
    });

    test('a new target past the target limit is refused; a known one is not', async () => {
        for (let index = 0; index < 256; index++) {
            await settings.beginControlRequest(request({ requestId: `r${index}`, target: `t${index}` }));
        }
        await expect(settings.beginControlRequest(request({ requestId: 'extra', target: 'extra' }))).resolves.toEqual({
            ok: false,
            reason: 'full',
        });
        await expect(settings.beginControlRequest(request({ requestId: 'again', target: 't0' }))).resolves.toEqual({
            ok: false,
            reason: 'busy',
        });
    });
});

describe('what a status read answers', () => {
    test('by identity and by target, never with the arguments', async () => {
        const secret = '["SECRET-TOKEN"]';
        await settings.beginControlRequest(request({ args: secret }));
        const byId = settings.readControlStatus({ requestId: 'r1' }, 0);
        const byTarget = settings.readControlStatus({ target: '7' }, 0);
        expect(byId).toEqual({
            state: 'request',
            record: {
                requestId: 'r1',
                operation: 'pause-scenario',
                target: '7',
                status: 'pending',
                error: null,
                revision: 0,
                at: NOW,
            },
        });
        expect(byTarget).toMatchObject({
            state: 'target',
            target: '7',
            revision: 0,
            pending: { requestId: 'r1' },
            results: [],
        });
        expect(JSON.stringify([byId, byTarget])).not.toContain('SECRET-TOKEN');
    });

    test('an identity nobody recorded is not recorded, and a target nobody used is at revision 0', () => {
        expect(settings.readControlStatus({ requestId: 'ghost' }, 0)).toEqual({ state: 'not-recorded' });
        expect(settings.readControlStatus({ target: 'ghost' }, 0)).toEqual({
            state: 'target',
            target: 'ghost',
            revision: 0,
            pending: null,
            results: [],
        });
    });

    test.each([
        ['text that is not JSON', '{nope'],
        ['an extra key', JSON.stringify({ targets: {}, extra: 1 })],
        [
            'a target with an extra key',
            JSON.stringify({ targets: { a: { revision: 0, pending: null, results: [], x: 1 } } }),
        ],
        ['a negative revision', JSON.stringify({ targets: { a: { revision: -1, pending: null, results: [] } } })],
        [
            'a pending request with a value out of bounds',
            JSON.stringify({
                targets: {
                    a: {
                        revision: 0,
                        pending: { requestId: 'r', operation: 'o', digest: 'd', stopEpoch: -1, at: 1, args: '[]' },
                        results: [],
                    },
                },
            }),
        ],
        [
            'a pending request of the wrong shape',
            JSON.stringify({ targets: { a: { revision: 0, pending: { requestId: 'r' }, results: [] } } }),
        ],
        [
            'a result of the wrong shape',
            JSON.stringify({ targets: { a: { revision: 0, pending: null, results: [{ requestId: 'r' }] } } }),
        ],
        [
            'a result with an unknown status',
            JSON.stringify({
                targets: {
                    a: {
                        revision: 0,
                        pending: null,
                        results: [
                            {
                                requestId: 'r',
                                operation: 'o',
                                digest: 'd',
                                status: 'maybe',
                                error: null,
                                revision: 0,
                                at: 1,
                            },
                        ],
                    },
                },
            }),
        ],
        [
            'an unbounded error',
            JSON.stringify({
                targets: {
                    a: {
                        revision: 0,
                        pending: null,
                        results: [
                            {
                                requestId: 'r',
                                operation: 'o',
                                digest: 'd',
                                status: 'failed',
                                error: 'x'.repeat(500),
                                revision: 0,
                                at: 1,
                            },
                        ],
                    },
                },
            }),
        ],
        [
            'too many results',
            JSON.stringify({
                targets: {
                    a: {
                        revision: 0,
                        pending: null,
                        results: Array.from({ length: 9 }, () => ({
                            requestId: 'r',
                            operation: 'o',
                            digest: 'd',
                            status: 'failed',
                            error: null,
                            revision: 0,
                            at: 1,
                        })),
                    },
                },
            }),
        ],
        [
            'a target name that is not bounded text',
            JSON.stringify({ targets: { 'a b': { revision: 0, pending: null, results: [] } } }),
        ],
        ['no targets object', JSON.stringify({ targets: [] })],
        ['more bytes than the bound', JSON.stringify({ targets: {}, pad: 'x'.repeat(CONTROLS_MAX_BYTES) })],
        [
            'too many targets',
            JSON.stringify({
                targets: Object.fromEntries(
                    Array.from({ length: 257 }, (_, index) => [
                        `t${index}`,
                        { revision: 0, pending: null, results: [] },
                    ]),
                ),
            }),
        ],
    ])('an inbox that holds %s is unknown to a status read and is never written over', async (_label, text) => {
        store.keys.set(CONTROLS_KEY, text);
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toEqual({ state: 'unknown' });
        expect(settings.readControlStatus({ target: '7' }, 0)).toEqual({ state: 'unknown' });
        await expect(settings.beginControlRequest(request())).resolves.toEqual({ ok: false, reason: 'unreadable' });
        await expect(
            settings.finishControlRequest({ requestId: 'r1', target: '7', ok: true, error: null, at: NOW }),
        ).resolves.toEqual({ ok: false, reason: 'unreadable' });
        expect(raw()).toBe(text);
    });

    test('an inbox that is not loaded or cannot be read is unknown', () => {
        const loaded = jest.spyOn(platform().storage, 'loaded').mockReturnValue(false);
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toEqual({ state: 'unknown' });
        loaded.mockRestore();
        store.readKey = () => {
            throw new Error('native read failed');
        };
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toEqual({ state: 'unknown' });
        // A strict store with no bridge to read through cannot read at all.
        Object.defineProperty(store, 'readKey', { value: undefined });
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toEqual({ state: 'unknown' });
    });

    test('a write that throws is not accepted either', async () => {
        await settings.beginControlRequest(request());
        store.compareAndWriteKey = () => {
            throw new Error('native write failed');
        };
        await expect(settings.beginControlRequest(request({ requestId: 'r2', target: '8' }))).resolves.toEqual({
            ok: false,
            reason: 'not-saved',
        });
        await expect(
            settings.finishControlRequest({ requestId: 'r1', target: '7', ok: true, error: null, at: NOW }),
        ).resolves.toEqual({ ok: false, reason: 'not-saved' });
    });

    test('a write the native bridge did not persist is not accepted', async () => {
        await settings.beginControlRequest(request());
        store.writeKey = () => false;
        store.compareAndWriteKey = () => false;
        await expect(settings.beginControlRequest(request({ requestId: 'r2', target: '8' }))).resolves.toEqual({
            ok: false,
            reason: 'not-saved',
        });
        await expect(
            settings.finishControlRequest({ requestId: 'r1', target: '7', ok: true, error: null, at: NOW }),
        ).resolves.toEqual({ ok: false, reason: 'not-saved' });
        expect(settings.readControlStatus({ requestId: 'r1' }, 0)).toMatchObject({ record: { status: 'pending' } });
    });
});
