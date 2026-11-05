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
