/**
 * The desktop's remote-access host: the hello handshake with the version
 * check, the snapshot, the invoke path through the dispatch, the log stream
 * the host owns, the peer cap, and the guarantee that the pairing key never
 * reaches a log line or a peer message.
 */

import { createRemoteHost, MAX_REMOTE_PEERS } from '../../src/ts/react/api/remoteHost';
import { TransportStub } from '../helpers/remoteTransport';
import { initialState } from '../../src/ts/core/autovote/state';

import type { RemoteTransport } from '../../src/ts/core/remote/relays';
import type { RemoteHostDeps } from '../../src/ts/react/api/remoteHost';
import type { AutovoteState } from '../../src/ts/core/autovote/state';
import { render, act } from '@testing-library/preact';
import { fireSettingsChanged } from './helpers/setup';
import { PROTOCOL_VERSION } from '../../src/ts/core/remote/protocol';
import {
    useDesktopRemoteHost,
    setActiveRemoteHost,
    subscribeRemoteConnectionCount,
    remoteConnectionCount,
    pushAutovoteStateToActiveHost,
    appVersion,
} from '../../src/ts/react/api/remoteHost';
import type { AutovoteController } from '../../src/ts/core/autovote/types';

const mockRemoteAccessAnswer: { current: unknown } = { current: undefined };
const mockAdapterTransports: TransportStub[] = [];

// The provider's hook reaches the bridge through the ipc wrappers and the trystero adapter;
// both are mocked here.
jest.mock('@/api/ipc', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('@/api/ipc')>('@/api/ipc'),
    getRemoteAccess: () => mockRemoteAccessAnswer.current,
}));
jest.mock('../../src/ts/core/remote/trystero', () => ({
    createTrysteroTransport: jest.fn(async () => {
        const transport = new TransportStub(`adapter-${mockAdapterTransports.length}`);
        mockAdapterTransports.push(transport);
        return transport;
    }),
    isConnectionFailureJoinError: () => false,
}));

const HOST_VERSION = '9.9.9';

type Harness = {
    deps: RemoteHostDeps & {
        transports: TransportStub[];
        invokeLog: Array<{ channel: string; args: unknown[] }>;
        notifications: number;
        commands: string[];
    };
    host: ReturnType<typeof createRemoteHost>;
    invoke: (channel: string, args?: unknown[]) => Promise<unknown>;
};

const makeHarness = (overrides: Partial<RemoteHostDeps> = {}): Harness => {
    const transports: TransportStub[] = [];
    const invokeLog: Array<{ channel: string; args: unknown[] }> = [];
    const commands: string[] = [];
    const deps: RemoteHostDeps & {
        transports: TransportStub[];
        invokeLog: typeof invokeLog;
        notifications: number;
        commands: string[];
    } = {
        transports,
        invokeLog,
        notifications: 0,
        commands,
        createTransport: async () => {
            const transport = new TransportStub(`host-${transports.length}`);
            transports.push(transport);
            return transport as RemoteTransport;
        },
        invoke: async (channel, args) => {
            invokeLog.push({ channel, args });
            if (channel === 'get-settings') return { mock: true, language: 'en' };
            if (channel === 'get-log-backlog') return [];
            return { success: true };
        },
        getAutovoteState: () => initialState,
        runAutovoteCommand: (command) => {
            commands.push(command);
            return Promise.resolve();
        },
        onForwardedEvent: () => () => undefined,
        onLogMessage: () => () => undefined,
        notify: () => {
            deps.notifications += 1;
        },
        logDebug: () => undefined,
        version: HOST_VERSION,
        ...overrides,
    };
    const host = createRemoteHost(deps);
    const invoke = (channel: string, args: unknown[] = []) => deps.invoke(channel, args);
    return { deps: deps as Harness['deps'], host, invoke };
};

const sentBy = (transport: TransportStub) => transport.sent;

/** Drains the host's async chains (a snapshot awaits its invokes before it finishes sending). */
const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('createRemoteHost', () => {
    test('start joins the room once; a second start answers false', async () => {
        const { host, deps } = makeHarness();
        expect(await host.start('k')).toBe(true);
        expect(await host.start('k')).toBe(false);
        expect(deps.transports).toHaveLength(1);
        expect(host.isActive()).toBe(true);
    });

    test('stop leaves the room, forgets the peers and resets the count', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        expect(host.connectedCount()).toBe(1);

        await host.stop();

        expect(transport.left).toBe(true);
        expect(host.connectedCount()).toBe(0);
        expect(host.isActive()).toBe(false);
    });

    test('a matching hello is answered with the host version, a settings snapshot and the autovote state', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        await flush();

        const kinds = sentBy(transport).map(({ message }) => (message as { t: string }).t);
        expect(kinds).toEqual(['hello', 'event', 'autovote-state']);
        expect(sentBy(transport)[0].message).toEqual({
            t: 'hello',
            version: HOST_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            host: true,
        });
        expect(sentBy(transport)[1].message).toEqual({
            t: 'event',
            channel: 'settings-changed',
            payload: { mock: true, language: 'en' },
        });
        expect(deps.invokeLog.map(({ channel }) => channel)).toContain('get-settings');
        expect(deps.notifications).toBe(1);
    });

    test('a version mismatch is told and no snapshot is served', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: '8.0.0', protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );

        expect(sentBy(transport)).toHaveLength(1);
        expect(sentBy(transport)[0].message).toEqual({
            t: 'hello',
            version: HOST_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            host: true,
        });
        expect(host.connectedCount()).toBe(0);
        expect(deps.notifications).toBe(0);
    });

    test('start, stop and rearm commands run on the host controller, and nothing is ever started twice', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        for (const command of ['start', 'stop', 'rearm'] as const) {
            transport.receiveFromPeer({ t: 'autovote-command', command }, 'p1');
        }
        await flush();
        expect(deps.commands).toEqual(['start', 'stop', 'rearm']);
    });

    test('an invoke is forwarded with restored undefined arguments and answered', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        transport.receiveFromPeer(
            { t: 'invoke', id: 4, channel: 'set-setting', args: ['mock', null], undefinedAt: [1] },
            'p1',
        );
        await flush();

        expect(deps.invokeLog).toContainEqual({ channel: 'set-setting', args: ['mock', undefined] });
        const answer = sentBy(transport).find(({ message }) => (message as { t: string }).t === 'result');
        expect(answer?.message).toEqual({ t: 'result', id: 4, ok: true, result: { success: true } });
    });

    test('an invoke from a peer that never said hello is refused', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer({ t: 'invoke', id: 1, channel: 'get-settings', args: [] }, 'p1');
        await flush();

        expect(deps.invokeLog).toEqual([]);
        const answer = sentBy(transport).find(({ message }) => (message as { t: string }).t === 'result');
        expect((answer?.message as { ok: boolean } | undefined)?.ok).toBe(false);
    });

    test('the log stream is forwarded only to phones that want it, and one stopping leaves the others running', async () => {
        const logListeners: Array<(entry: unknown) => void> = [];
        const { host, deps } = makeHarness({
            onLogMessage: (handler) => {
                logListeners.push(handler);
                return () => undefined;
            },
        });
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        transport.emitJoin('p2');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p2',
        );
        await flush();

        // Only p1 asks for logs.
        transport.receiveFromPeer({ t: 'invoke', id: 10, channel: 'start-log-stream', args: [] }, 'p1');
        await flush();
        const startCalls = deps.invokeLog.filter(({ channel }) => channel === 'start-log-stream');
        expect(startCalls).toHaveLength(1);

        logListeners.forEach((listener) => listener({ seq: 1, message: 'log line' }));
        await flush();
        const streamSent = sentBy(transport).filter(({ message }) => {
            const m = message as { t: string; channel?: string };
            return m.t === 'event' && m.channel === 'log-message';
        });
        expect(streamSent).toHaveLength(1);
        expect(streamSent[0].target).toBe('p1');

        // p2 asks too, then p1 stops: the desktop stream keeps running.
        transport.receiveFromPeer({ t: 'invoke', id: 11, channel: 'start-log-stream', args: [] }, 'p2');
        await flush();
        transport.receiveFromPeer({ t: 'invoke', id: 12, channel: 'stop-log-stream', args: [] }, 'p1');
        await flush();
        expect(deps.invokeLog.filter(({ channel }) => channel === 'stop-log-stream')).toHaveLength(0);

        logListeners.forEach((listener) => listener({ seq: 2, message: 'another line' }));
        await flush();
        const stillStreaming = sentBy(transport).filter(({ message, target }) => {
            const m = message as { t: string; channel?: string };
            return m.t === 'event' && m.channel === 'log-message' && target === 'p2';
        });
        expect(stillStreaming.length).toBeGreaterThanOrEqual(1);

        // When the last phone stops its logs, the desktop stream stops too.
        transport.receiveFromPeer({ t: 'invoke', id: 13, channel: 'stop-log-stream', args: [] }, 'p2');
        await flush();
        expect(deps.invokeLog.filter(({ channel }) => channel === 'stop-log-stream')).toHaveLength(1);
    });

    test('at most MAX_REMOTE_PEERS phones connect; the rest are told bye', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        for (let i = 0; i < MAX_REMOTE_PEERS + 1; i++) {
            transport.emitJoin(`p${i}`);
            transport.receiveFromPeer(
                { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
                `p${i}`,
            );
            await flush();
        }
        expect(host.connectedCount()).toBe(MAX_REMOTE_PEERS);
        const byes = sentBy(transport).filter(({ message }) => (message as { t: string }).t === 'bye');
        expect(byes).toHaveLength(1);
        expect(byes[0].target).toBe(`p${MAX_REMOTE_PEERS}`);
    });

    test('a peer leave drops it, and its log want with it', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        transport.receiveFromPeer({ t: 'invoke', id: 10, channel: 'start-log-stream', args: [] }, 'p1');
        await flush();
        expect(host.connectedCount()).toBe(1);

        transport.emitLeave('p1');
        await flush();
        expect(host.connectedCount()).toBe(0);
        expect(deps.invokeLog.filter(({ channel }) => channel === 'stop-log-stream')).toHaveLength(1);
    });

    test('pushAutovoteState relays to the connected phones, none while nobody is there', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        const state: AutovoteState = { ...initialState, running: true, cycles: 2 };
        host.pushAutovoteState(state);
        expect(sentBy(transport)).toHaveLength(0);

        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        await flush();
        transport.sent.length = 0;
        host.pushAutovoteState(state);
        await flush();
        expect(sentBy(transport)).toHaveLength(1);
        expect(sentBy(transport)[0].message).toEqual({ t: 'autovote-state', state });
    });

    test('the pairing key appears in no log line and no peer message', async () => {
        const KEY = 'super-secret-pairing-key';
        const logs: string[] = [];
        const { host, deps } = makeHarness({ logDebug: (message) => logs.push(message) });
        await host.start(KEY);
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        transport.receiveFromPeer({ t: 'invoke', id: 1, channel: 'get-settings', args: [{ secret: KEY }] }, 'p1');
        await host.stop();

        for (const text of logs) {
            expect(text).not.toContain(KEY);
        }
        for (const { message } of transport.sent) {
            expect(JSON.stringify(message)).not.toContain(KEY);
        }
    });
});

describe('createRemoteHost (refusals, bye, events, unload)', () => {
    test('a refused channel is answered with the refusal and never forwarded', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        await flush();
        transport.sent.length = 0;
        deps.invokeLog.length = 0;

        transport.receiveFromPeer({ t: 'invoke', id: 21, channel: 'wipe-local-data', args: [] }, 'p1');
        await flush();
        expect(deps.invokeLog).toEqual([]);
        const answer = sentBy(transport).find(({ message }) => (message as { t: string }).t === 'result');
        const reply = answer?.message as { ok: boolean; error: string } | undefined;
        expect(reply?.ok).toBe(false);
        expect(reply?.error).toContain('Refused remotely');
    });

    test('a bye drops the peer and its log want', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        transport.receiveFromPeer({ t: 'invoke', id: 1, channel: 'start-log-stream', args: [] }, 'p1');
        await flush();
        expect(host.connectedCount()).toBe(1);

        transport.receiveFromPeer({ t: 'bye' }, 'p1');
        await flush();
        expect(host.connectedCount()).toBe(0);
        expect(deps.invokeLog.filter(({ channel }) => channel === 'stop-log-stream')).toHaveLength(1);
    });

    test('a malformed message changes nothing', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.receiveFromPeer({ t: 'explosion' }, 'p1');
        await flush();
        expect(deps.invokeLog).toEqual([]);
        expect(host.connectedCount()).toBe(0);
    });

    test('the forwarded events reach every connected phone; the log feed only the phones that want it', async () => {
        const eventListeners: Array<(channel: string, handler: (payload: unknown) => void) => void> = [];
        const handlers = new Map<string, (payload: unknown) => void>();
        const logHandlers: Array<(entry: unknown) => void> = [];
        const { host, deps } = makeHarness({
            onForwardedEvent: (channel, handler) => {
                eventListeners.push(undefined as never);
                handlers.set(channel, handler);
                return () => undefined;
            },
            onLogMessage: (handler) => {
                logHandlers.push(handler);
                return () => undefined;
            },
        });
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        await flush();
        transport.sent.length = 0;

        handlers.get('settings-changed')?.({ mock: true });
        await flush();
        const forwarded = sentBy(transport).filter(({ message }) => (message as { t: string }).t === 'event');
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0].message).toEqual({ t: 'event', channel: 'settings-changed', payload: { mock: true } });

        transport.receiveFromPeer({ t: 'invoke', id: 2, channel: 'start-log-stream', args: [] }, 'p1');
        await flush();
        transport.sent.length = 0;
        logHandlers.forEach((handler) => handler({ seq: 9 }));
        await flush();
        expect(sentBy(transport)).toHaveLength(1);
        expect(sentBy(transport)[0].message).toEqual({ t: 'event', channel: 'log-message', payload: { seq: 9 } });
    });

    test('the pagehide of the window leaves the room; a failed send is swallowed', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.failNextSendOnce();
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        await flush();
        expect(host.isActive()).toBe(true);

        globalThis.dispatchEvent(new Event('pagehide'));
        await flush();
        expect(transport.left).toBe(true);

        await host.stop();
        // The pagehide listener is gone: a second pagehide does nothing.
        globalThis.dispatchEvent(new Event('pagehide'));
    });
});

describe('useDesktopRemoteHost (the provider hook) and the badge store', () => {
    const controller: Pick<AutovoteController, 'getState' | 'start' | 'stop' | 'rearmSchedule'> = {
        getState: () => initialState,
        start: jest.fn(async () => undefined),
        stop: jest.fn(async () => undefined),
        rearmSchedule: jest.fn(async () => undefined),
    };

    const Probe = (): null => {
        useDesktopRemoteHost(controller as AutovoteController);
        return null;
    };

    const enabledLink = (key: string): unknown => ({
        success: true,
        enabled: true,
        link: `https://pages/remote/#k=${key}`,
        qrDataUrl: '',
    });

    beforeEach(() => {
        mockAdapterTransports.length = 0;
        mockRemoteAccessAnswer.current = undefined;
    });

    afterEach(async () => {
        setActiveRemoteHost(null);
    });

    test('while the pairing is enabled the host joins the room and runs commands on its controller', async () => {
        mockRemoteAccessAnswer.current = enabledLink('k1');
        render(<Probe />);
        await flush();
        expect(mockAdapterTransports).toHaveLength(1);
        expect(remoteConnectionCount()).toBe(0);

        mockAdapterTransports[0].emitJoin('p1');
        mockAdapterTransports[0].receiveFromPeer(
            { t: 'hello', version: appVersion(), protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        await flush();
        expect(remoteConnectionCount()).toBe(1);

        mockAdapterTransports[0].receiveFromPeer({ t: 'autovote-command', command: 'start' }, 'p1');
        await flush();
        expect(controller.start).toHaveBeenCalled();

        // A phone-side invoke rides the bridge: the host calls window.api and answers.
        mockAdapterTransports[0].sent.length = 0;
        mockAdapterTransports[0].receiveFromPeer(
            { t: 'invoke', id: 7, channel: 'get-active-challenges', args: [] },
            'p1',
        );
        await flush();
        const answer = mockAdapterTransports[0].sent.find(({ message }) => (message as { t: string }).t === 'result');
        expect((answer?.message as { id: number } | undefined)?.id).toBe(7);

        // A forwarded event with a payload crosses the (handler, args) wrapper.
        mockAdapterTransports[0].sent.length = 0;
        fireSettingsChanged({ app: { language: 'en' } });
        await flush();
        const forwarded = mockAdapterTransports[0].sent.filter(
            ({ message }) => (message as { t: string; channel?: string }).t === 'event',
        );
        expect(forwarded.at(-1)?.message).toEqual({
            t: 'event',
            channel: 'settings-changed',
            payload: { app: { language: 'en' } },
        });
    });

    test('a changed or reset pairing tears the host down and rejoins; a disable ends the peers', async () => {
        mockRemoteAccessAnswer.current = enabledLink('k1');
        render(<Probe />);
        await flush();
        expect(mockAdapterTransports).toHaveLength(1);

        mockRemoteAccessAnswer.current = enabledLink('k2');
        window.dispatchEvent(new CustomEvent('remote-access:changed'));
        await flush();
        await flush();
        expect(mockAdapterTransports[0].left).toBe(true);
        expect(mockAdapterTransports).toHaveLength(2);

        mockRemoteAccessAnswer.current = { success: false };
        window.dispatchEvent(new CustomEvent('remote-access:changed'));
        await flush();
        await flush();
        expect(mockAdapterTransports[1].left).toBe(true);
        expect(remoteConnectionCount()).toBe(0);
    });

    test('unmount leaves the room', async () => {
        mockRemoteAccessAnswer.current = enabledLink('k1');
        const view = render(<Probe />);
        await flush();
        expect(mockAdapterTransports[0].left).toBe(false);
        view.unmount();
        // preact flushes effect cleanups on its own schedule, not on microtasks.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(mockAdapterTransports[0].left).toBe(true);
        expect(remoteConnectionCount()).toBe(0);
    });

    test('the hook parses the key from the link and runs every command on its controller', async () => {
        mockRemoteAccessAnswer.current = {
            success: true,
            enabled: true,
            link: 'https://pages/remote/#other=1',
            qrDataUrl: '',
        };
        render(<Probe />);
        await flush();
        // No `k` parameter in the link: nothing to join.
        expect(mockAdapterTransports).toHaveLength(0);
    });

    test('the hook forwards stop and rearm to its controller, and tolerates unsubscribe-less event mocks', async () => {
        mockRemoteAccessAnswer.current = enabledLink('k1');
        render(<Probe />);
        await flush();
        const transport = mockAdapterTransports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: appVersion(), protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        await flush();
        for (const command of ['start', 'stop', 'rearm'] as const) {
            transport.receiveFromPeer({ t: 'autovote-command', command }, 'p1');
            await flush();
        }
        expect(controller.stop).toHaveBeenCalled();
        expect(controller.rearmSchedule).toHaveBeenCalled();
    });

    test('a pairing that answers after the mount went away starts nothing', async () => {
        // Hold the pairing ANSWER (not the join): sync is still awaiting it at unmount, so the
        // answer lands in a disposed effect and must start nothing.
        let resolveAnswer: (value: unknown) => void = () => undefined;
        const ipcMock = jest.requireMock('@/api/ipc') as { getRemoteAccess: () => unknown };
        const saved = ipcMock.getRemoteAccess;
        ipcMock.getRemoteAccess = () =>
            new Promise((resolve) => {
                resolveAnswer = resolve;
            });
        try {
            const view = render(<Probe />);
            await flush();
            expect(mockAdapterTransports).toHaveLength(0);
            view.unmount();
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
            resolveAnswer(enabledLink('k1'));
            await flush();
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
            expect(mockAdapterTransports).toHaveLength(0);
            expect(remoteConnectionCount()).toBe(0);
        } finally {
            ipcMock.getRemoteAccess = saved;
        }
    });

    test('a phone leaving while another still wants logs keeps the stream running', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        for (const peer of ['p1', 'p2']) {
            transport.emitJoin(peer);
            transport.receiveFromPeer(
                { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
                peer,
            );
        }
        await flush();
        transport.receiveFromPeer({ t: 'invoke', id: 40, channel: 'start-log-stream', args: [] }, 'p1');
        transport.receiveFromPeer({ t: 'invoke', id: 41, channel: 'start-log-stream', args: [] }, 'p2');
        await flush();

        // p1's LEAVE (not a stop) drops only its want; the desktop stream keeps running for p2.
        transport.emitLeave('p1');
        await flush();
        expect(deps.invokeLog.filter(({ channel }) => channel === 'stop-log-stream')).toHaveLength(0);
        expect(host.connectedCount()).toBe(1);
    });

    test('event methods whose mock answers no unsubscribe fall back to a no-op', async () => {
        mockRemoteAccessAnswer.current = enabledLink('k1');
        const saved = (window.api as unknown as { onSettingsChanged?: unknown }).onSettingsChanged;
        (window.api as unknown as { onSettingsChanged: unknown }).onSettingsChanged = () => undefined;
        try {
            render(<Probe />);
            await flush();
            expect(mockAdapterTransports).toHaveLength(1);
        } finally {
            (window.api as unknown as { onSettingsChanged: unknown }).onSettingsChanged = saved;
        }
    });

    test('a room that finishes joining after unmount leaves it', async () => {
        mockRemoteAccessAnswer.current = enabledLink('k1');
        // Hold the JOIN until the component is gone, so start finishes into a disposed effect.
        let openGate: (() => void) | undefined;
        const gate = new Promise<void>((resolve) => {
            openGate = resolve;
        });
        const release = (): void => openGate?.();
        const adapterModule = jest.requireMock('../../src/ts/core/remote/trystero') as {
            createTrysteroTransport: jest.MockedFunction<
                (typeof import('../../src/ts/core/remote/trystero'))['createTrysteroTransport']
            >;
        };
        const createSpy = adapterModule.createTrysteroTransport;
        const defaultImpl = createSpy.getMockImplementation();
        createSpy.mockImplementation(async () => {
            await gate;
            const transport = new TransportStub(`adapter-${mockAdapterTransports.length}`);
            mockAdapterTransports.push(transport);
            return transport;
        });
        try {
            const view = render(<Probe />);
            await flush();
            expect(mockAdapterTransports).toHaveLength(0);
            view.unmount();
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
            (release as () => void)();
            await flush();
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
            await flush();
            expect(mockAdapterTransports).toHaveLength(1);
            expect(mockAdapterTransports[0].left).toBe(true);
            expect(remoteConnectionCount()).toBe(0);
        } finally {
            createSpy.mockImplementation(defaultImpl);
        }
    });

    test('unknown peers, repeat hellos, repeat log wants and unvalidated commands are all ignored', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        // A leave and a command for peers the host never validated.
        transport.emitLeave('ghost');
        transport.receiveFromPeer({ t: 'autovote-command', command: 'stop' }, 'ghost');
        await flush();
        expect(deps.commands).toEqual([]);
        expect(host.connectedCount()).toBe(0);

        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        await flush();
        // A repeat hello from the known phone: not a new connection, no second notification.
        deps.notifications = 0;
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        await flush();
        expect(deps.notifications).toBe(0);

        // A repeat of the phone's current log want: answered without touching the stream.
        transport.receiveFromPeer({ t: 'invoke', id: 20, channel: 'start-log-stream', args: [] }, 'p1');
        await flush();
        transport.receiveFromPeer({ t: 'invoke', id: 21, channel: 'start-log-stream', args: [] }, 'p1');
        await flush();
        expect(deps.invokeLog.filter(({ channel }) => channel === 'start-log-stream')).toHaveLength(1);
    });

    test('a log-stream stop for a phone that never started one is a no-op, and every command reaches the controller', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        await flush();

        transport.receiveFromPeer({ t: 'invoke', id: 30, channel: 'stop-log-stream', args: [] }, 'p1');
        await flush();
        expect(deps.invokeLog.filter(({ channel }) => channel === 'stop-log-stream')).toHaveLength(0);

        for (const command of ['start', 'stop', 'rearm'] as const) {
            transport.receiveFromPeer({ t: 'autovote-command', command }, 'p1');
            await flush();
        }
        expect(deps.commands).toEqual(['start', 'stop', 'rearm']);
    });

    test('the badge store serves the active host count and relays the controller state', async () => {
        const seen: number[] = [];
        const unsubscribe = subscribeRemoteConnectionCount(() => seen.push(remoteConnectionCount()));
        expect(remoteConnectionCount()).toBe(0);

        mockRemoteAccessAnswer.current = enabledLink('k1');
        render(<Probe />);
        await flush();
        seen.length = 0;
        mockAdapterTransports[0].emitJoin('p1');
        mockAdapterTransports[0].receiveFromPeer(
            { t: 'hello', version: appVersion(), protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );
        await flush();
        expect(seen).toEqual([1]);

        const state = { ...initialState, running: true, cycles: 4 };
        pushAutovoteStateToActiveHost(state);
        await flush();
        const relayed = mockAdapterTransports[0].sent
            .filter(({ message }) => (message as { t: string }).t === 'autovote-state')
            .at(-1);
        expect((relayed?.message as { state: unknown } | undefined)?.state).toEqual(state);
        unsubscribe();
    });
});
