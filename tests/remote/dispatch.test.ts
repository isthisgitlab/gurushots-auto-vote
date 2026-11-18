/**
 * The remote dispatch: refused and host-answered channels never reach the
 * injected invoke, the autovoteRunning key is refused on every write path
 * while auto-vote runs, and get-environment-info is answered with the
 * user-data path removed.
 */

import { dispatchRemoteInvoke, withoutUserDataPath } from '../../src/ts/core/remote/dispatch';
import { AUTOVOTE_RUNNING_KEY } from '../../src/ts/core/remote/allowlist';

import type { RemoteDispatchDeps, RemoteInvoke } from '../../src/ts/core/remote/dispatch';

const depsWith = (overrides: Partial<RemoteDispatchDeps> = {}): RemoteDispatchDeps & { calls: string[] } => {
    const calls: string[] = [];
    return {
        calls,
        invoke: (async (channel: string) => {
            calls.push(channel);
            return { success: true, channel };
        }) satisfies RemoteInvoke,
        ...overrides,
    };
};

describe('dispatchRemoteInvoke', () => {
    test('an allowed channel is forwarded with its arguments', async () => {
        const deps = depsWith();
        const outcome = await dispatchRemoteInvoke('get-settings', [], deps);
        expect(deps.calls).toEqual(['get-settings']);
        expect(outcome).toEqual({ kind: 'result', result: { success: true, channel: 'get-settings' } });
    });

    test.each([
        'authenticate',
        'wipe-local-data',
        'download-update',
        'install-update',
        'open-external-url',
        'reload-window',
        'refresh-menu',
        'run-voting-cycle',
        'set-cancel-voting',
        'get-remote-access',
        'set-remote-access',
        'reset-remote-pairing',
        'reset-all-settings',
        'start-fresh-settings',
        'retry-settings-import',
        'reset-all-global-defaults',
        'reset-all-scenario-state',
        'import-scenario',
        'log-remote-info',
        'get-log-file',
        'get-error-log-file',
        'get-api-log-file',
    ])('refuses %s without calling the invoke, and names the reason', async (channel) => {
        const deps = depsWith();
        const outcome = await dispatchRemoteInvoke(channel, [], deps);
        expect(deps.calls).toEqual([]);
        expect(outcome.kind).toBe('refused');
        if (outcome.kind === 'refused') {
            expect(outcome.error.startsWith('Refused remotely: ')).toBe(true);
            expect(outcome.error.length).toBeGreaterThan('Refused remotely: '.length);
        }
    });

    test.each(['start-log-stream', 'stop-log-stream', 'cleanup-stale-metadata'])(
        'refuses the host-answered %s in dispatch',
        async (channel) => {
            const deps = depsWith();
            const outcome = await dispatchRemoteInvoke(channel, [], deps);
            expect(deps.calls).toEqual([]);
            expect(outcome.kind).toBe('refused');
        },
    );

    test('a channel that is not in the manifest is refused', async () => {
        const deps = depsWith();
        const outcome = await dispatchRemoteInvoke('steal-the-key', [], deps);
        expect(deps.calls).toEqual([]);
        expect(outcome.kind).toBe('refused');
    });

    describe('autovoteRunning is refused per key on every write path, whatever the running state', () => {
        test.each([
            ['set-setting', [AUTOVOTE_RUNNING_KEY, true]],
            ['reset-setting', [AUTOVOTE_RUNNING_KEY, null]],
            ['set-global-default', [AUTOVOTE_RUNNING_KEY, true]],
            ['reset-global-default', [AUTOVOTE_RUNNING_KEY]],
        ])('%s refuses the key while auto-vote runs', async (channel, args) => {
            const deps = depsWith();
            const outcome = await dispatchRemoteInvoke(channel, args, deps);
            expect(deps.calls).toEqual([]);
            expect(outcome.kind).toBe('refused');
            if (outcome.kind === 'refused') expect(outcome.error).toContain('auto-vote switch is not a setting');
        });

        test.each([
            ['set-setting', [AUTOVOTE_RUNNING_KEY, true]],
            ['reset-setting', [AUTOVOTE_RUNNING_KEY, null]],
            ['set-global-default', [AUTOVOTE_RUNNING_KEY, true]],
            ['reset-global-default', [AUTOVOTE_RUNNING_KEY]],
        ])('%s refuses the key while auto-vote is STOPPED too', async (channel, args) => {
            const deps = depsWith();
            const outcome = await dispatchRemoteInvoke(channel, args, deps);
            expect(deps.calls).toEqual([]);
            expect(outcome.kind).toBe('refused');
            if (outcome.kind === 'refused') expect(outcome.error).toContain('auto-vote switch is not a setting');
        });

        test('save-settings refuses an update that carries the key, stopped or running', async () => {
            for (const deps of [depsWith(), depsWith()]) {
                const outcome = await dispatchRemoteInvoke('save-settings', [{ [AUTOVOTE_RUNNING_KEY]: false }], deps);
                expect(deps.calls).toEqual([]);
                expect(outcome.kind).toBe('refused');
            }
        });

        test('other keys still write in both states', async () => {
            for (const deps of [depsWith(), depsWith()]) {
                const outcome = await dispatchRemoteInvoke('set-setting', ['boostTime', 0], deps);
                expect(deps.calls).toEqual(['set-setting']);
                expect(outcome.kind).toBe('result');
            }
        });

        test('the refusal does not tell the phone to stop auto-vote: start and stop are its own controls', async () => {
            const outcome = await dispatchRemoteInvoke('set-setting', [AUTOVOTE_RUNNING_KEY, true], depsWith());
            expect(outcome.kind).toBe('refused');
            if (outcome.kind === 'refused') expect(outcome.error).not.toContain('Stop auto-vote first');
        });
    });

    test('get-environment-info is answered with the user-data path removed', async () => {
        const deps = depsWith({
            invoke: async () => ({ platform: 'linux', userDataPath: '/home/user/.config/app', appName: 'app' }),
        });
        const outcome = await dispatchRemoteInvoke('get-environment-info', [], deps);
        expect(outcome).toEqual({ kind: 'result', result: { platform: 'linux', appName: 'app' } });
    });

    test('a handler failure is passed through as its own shape', async () => {
        const deps = depsWith({ invoke: async () => ({ success: false, error: 'handler refused it' }) });
        const outcome = await dispatchRemoteInvoke('set-setting', ['mock', true], deps);
        expect(outcome).toEqual({ kind: 'result', result: { success: false, error: 'handler refused it' } });
    });
});

describe('withoutUserDataPath', () => {
    test('keeps every other field and tolerates non-objects', () => {
        expect(withoutUserDataPath(null)).toBeNull();
        expect(withoutUserDataPath('x')).toBe('x');
        expect(withoutUserDataPath([1])).toEqual([1]);
        expect(withoutUserDataPath({ a: 1 })).toEqual({ a: 1 });
    });
});

describe('a scenario change goes through the control inbox', () => {
    /** A host whose inbox answers what the test scripts and whose handlers answer `handler`. */
    const scripted = (
        script: { begin?: unknown; finish?: unknown; handler?: unknown; handlerThrows?: unknown } = {},
    ): RemoteDispatchDeps & { calls: Array<{ channel: string; args: unknown[] }> } => {
        const calls: Array<{ channel: string; args: unknown[] }> = [];
        return {
            calls,
            invoke: async (channel: string, args: unknown[]) => {
                calls.push({ channel, args });
                if (channel === 'begin-scenario-request') {
                    return script.begin ?? { success: true, ok: true, outcome: 'accepted', revision: 4 };
                }
                if (channel === 'finish-scenario-request') {
                    return script.finish ?? { success: true, ok: true, status: 'applied', revision: 5 };
                }
                if (script.handlerThrows) throw script.handlerThrows;
                return script.handler ?? { success: true };
            },
        };
    };
    const names = (deps: { calls: Array<{ channel: string }> }): string[] => deps.calls.map((call) => call.channel);

    test('a change without a request identity is refused, and nothing reaches the handlers or the inbox', async () => {
        const deps = scripted();
        for (const [channel, args] of [
            ['pause-scenario', ['7']],
            ['set-installation-scenario', ['Plan', 'electron', 0]],
            ['save-scenario', [{}]],
            ['set-setting', ['scenario', 'Plan']],
            ['save-settings', [{ challengeSettings: { 7: { values: { scenario: 'Plan' } } } }]],
            ['set-title-rules', [[]]],
        ] as const) {
            const outcome = await dispatchRemoteInvoke(channel, [...args], deps);
            expect(outcome).toEqual({
                kind: 'refused',
                error: 'Refused remotely: a scenario change needs a request identity.',
            });
        }
        expect(deps.calls).toEqual([]);
    });

    test('an accepted change is persisted, applied by the same handler and recorded, in that order', async () => {
        const deps = scripted();
        const outcome = await dispatchRemoteInvoke('pause-scenario', ['7', 'later'], deps, {
            requestId: 'r1',
            expectedRevision: 4,
        });
        expect(names(deps)).toEqual(['begin-scenario-request', 'pause-scenario', 'finish-scenario-request']);
        expect(deps.calls[0].args).toEqual([
            { requestId: 'r1', operation: 'pause-scenario', target: '7', args: '["7","later"]', expectedRevision: 4 },
        ]);
        expect(deps.calls[1].args).toEqual(['7', 'later']);
        expect(deps.calls[2].args).toEqual([{ requestId: 'r1', target: '7', ok: true }]);
        expect(outcome).toEqual({
            kind: 'result',
            result: { success: true },
            control: { requestId: 'r1', target: '7', revision: 5 },
        });
    });

    test('the expected revision is left out when the phone has none', async () => {
        const deps = scripted();
        await dispatchRemoteInvoke('delete-scenario', ['Plan'], deps, { requestId: 'r1' });
        expect(deps.calls[0].args).toEqual([
            { requestId: 'r1', operation: 'delete-scenario', target: 'definitions', args: '["Plan"]' },
        ]);
    });

    test.each([
        ['a refused result', { success: false, error: 'busy' }, { ok: false, error: 'busy' }],
        ['a bare false', false, { ok: false }],
        ['a bare true', true, { ok: true }],
        ['a result of another shape', { installation: null, generation: 1 }, { ok: true }],
    ])('the handler answering %s is recorded as it came out', async (_label, handler, recorded) => {
        const deps = scripted({ handler });
        const outcome = await dispatchRemoteInvoke('set-installation-scenario', ['Plan', 'electron', 0], deps, {
            requestId: 'r1',
        });
        expect(deps.calls[2].args).toEqual([{ requestId: 'r1', target: '@installation', ...recorded }]);
        expect(outcome).toMatchObject({ kind: 'result', result: handler });
    });

    test('a recorded reason is cut to what the inbox keeps', async () => {
        const deps = scripted({ handler: { success: false, error: 'x'.repeat(300) } });
        await dispatchRemoteInvoke('pause-scenario', ['7'], deps, { requestId: 'r1' });
        const recorded = deps.calls[2].args[0] as { error: string };
        expect(recorded.error).toHaveLength(120);
    });

    test.each([
        ['an error', new Error('handler blew up'), 'handler blew up'],
        ['a value with no message', 'boom', 'failed'],
    ])(
        'a handler that throws %s is recorded as failed and answered with its report, never rethrown',
        async (_label, thrown, reason) => {
            const deps = scripted({ handlerThrows: thrown });
            const outcome = await dispatchRemoteInvoke('pause-scenario', ['7'], deps, { requestId: 'r1' });
            expect(names(deps)).toEqual(['begin-scenario-request', 'pause-scenario', 'finish-scenario-request']);
            expect(deps.calls[2].args).toEqual([{ requestId: 'r1', target: '7', ok: false, error: reason }]);
            expect(outcome).toEqual({
                kind: 'result',
                result: { success: false, error: reason },
                control: { requestId: 'r1', target: '7', revision: 5 },
            });
        },
    );

    test.each([
        ['busy', { success: false, error: 'busy' }],
        ['a conflict', { success: false, error: 'conflict' }],
        ['a stale revision', { success: false, error: 'stale' }],
        ['a full inbox', { success: false, error: 'full' }],
        ['an unreadable inbox', { success: false, error: 'unreadable' }],
        ['an answer that is not an object', 'nope'],
    ])(
        "a change the inbox does not accept (%s) is answered with the inbox's answer and applies nothing",
        async (_label, begin) => {
            const deps = scripted({ begin });
            const outcome = await dispatchRemoteInvoke('pause-scenario', ['7'], deps, { requestId: 'r1' });
            expect(outcome).toEqual({ kind: 'result', result: begin });
            expect(names(deps)).toEqual(['begin-scenario-request']);
        },
    );

    test.each([
        ['applied', { success: true, duplicate: true }],
        ['pending', { success: false, error: 'pending' }],
        ['superseded', { success: false, error: 'superseded' }],
        ['interrupted', { success: false, error: 'interrupted' }],
    ])('a repeated identity that is %s answers its record and applies nothing again', async (status, recorded) => {
        const deps = scripted({
            begin: { success: true, ok: true, outcome: 'duplicate', status, revision: 7, error: null },
        });
        const outcome = await dispatchRemoteInvoke('pause-scenario', ['7'], deps, { requestId: 'r1' });
        expect(outcome).toEqual({
            kind: 'result',
            result: recorded,
            control: { requestId: 'r1', target: '7', revision: 7 },
        });
        expect(names(deps)).toEqual(['begin-scenario-request']);
    });

    test('a repeated identity that failed answers the reason recorded for it, or "failed"', async () => {
        const withReason = scripted({
            begin: {
                success: true,
                ok: true,
                outcome: 'duplicate',
                status: 'failed',
                revision: 2,
                error: 'unresolved-work',
            },
        });
        await expect(
            dispatchRemoteInvoke('pause-scenario', ['7'], withReason, { requestId: 'r1' }),
        ).resolves.toMatchObject({
            result: { success: false, error: 'unresolved-work' },
        });
        const without = scripted({
            begin: { success: true, ok: true, outcome: 'duplicate', status: 'failed', revision: 2, error: null },
        });
        await expect(
            dispatchRemoteInvoke('pause-scenario', ['7'], without, { requestId: 'r1' }),
        ).resolves.toMatchObject({
            result: { success: false, error: 'failed' },
        });
    });

    test('a duplicate whose revision is not told is read as the start of the target', async () => {
        const deps = scripted({ begin: { success: true, ok: true, outcome: 'duplicate', status: 'applied' } });
        await expect(dispatchRemoteInvoke('pause-scenario', ['7'], deps, { requestId: 'r1' })).resolves.toMatchObject({
            control: { revision: 0 },
        });
    });

    test('a result the inbox could not record is still answered, without the control report', async () => {
        const deps = scripted({ finish: { success: false, error: 'not-saved' } });
        await expect(dispatchRemoteInvoke('pause-scenario', ['7'], deps, { requestId: 'r1' })).resolves.toEqual({
            kind: 'result',
            result: { success: true },
        });
    });

    test('a refused channel is refused before the inbox: an owner transfer never reaches it, identity or not', async () => {
        const deps = scripted();
        const outcome = await dispatchRemoteInvoke(
            'transfer-installation-scenario-owner',
            ['android-service', 1],
            deps,
            {
                requestId: 'r1',
            },
        );
        expect(outcome).toEqual({
            kind: 'refused',
            error: 'Refused remotely: Owner transfer is done on the selected computer.',
        });
        expect(deps.calls).toEqual([]);
    });

    test.each(['begin-scenario-request', 'finish-scenario-request', 'arm-autovote', 'record-full-stop'])(
        "the host's own route %s cannot be called by a phone",
        async (channel) => {
            const deps = scripted();
            const outcome = await dispatchRemoteInvoke(channel, [{ requestId: 'r1' }], deps, { requestId: 'r1' });
            expect(outcome).toMatchObject({ kind: 'refused' });
            expect(deps.calls).toEqual([]);
        },
    );

    test('the auto-vote switch is refused on a scenario-key write too, whatever the identity', async () => {
        const deps = scripted();
        const outcome = await dispatchRemoteInvoke('save-settings', [{ autovoteRunning: true, scenario: 'x' }], deps, {
            requestId: 'r1',
        });
        expect(outcome).toMatchObject({ kind: 'refused' });
        expect(deps.calls).toEqual([]);
    });

    test('a read and a write that does not touch a scenario never need an identity and never reach the inbox', async () => {
        const deps = scripted();
        await dispatchRemoteInvoke('get-scenario-request-status', [{ requestId: 'r1' }], deps);
        await dispatchRemoteInvoke('set-setting', ['exposure', 50], deps);
        expect(names(deps)).toEqual(['get-scenario-request-status', 'set-setting']);
    });
});
