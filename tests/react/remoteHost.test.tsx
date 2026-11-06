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
import { render, act, cleanup, waitFor } from '@testing-library/preact';
import { fireSettingsChanged, mockApi } from './helpers/setup';
import {
    MAX_PEER_FIELD_LENGTH,
    MAX_PEER_MESSAGE_BYTES,
    LINK_VERSION,
    PROTOCOL_VERSION,
    REMOTE_RESULT_TOO_LARGE,
    REMOTE_RESULT_UNSENDABLE,
} from '../../src/ts/core/remote/protocol';
import { SPEND_REMOTE_CHANNELS } from '../../src/ts/core/remote/allowlist';
import { invalid } from '../helpers/invalid';
import {
    useDesktopRemoteHost,
    setActiveRemoteHost,
    subscribeRemoteConnectionCount,
    remoteConnectionCount,
    remoteRelayCount,
    pushAutovoteStateToActiveHost,
    appVersion,
} from '../../src/ts/react/api/remoteHost';
import type { AutovoteController } from '../../src/ts/core/autovote/types';

const mockRemoteAccessAnswer: { current: unknown } = { current: undefined };
/** The adapter mock's transport, with the pairing key the host asked for: a test counts only the transports made for its own key. */
class KeyedTransport extends TransportStub {
    key = '';
}
const mockAdapterTransports: KeyedTransport[] = [];

// The provider's hook reaches the bridge through the ipc wrappers and the trystero adapter;
// both are mocked here.
jest.mock('@/api/ipc', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('@/api/ipc')>('@/api/ipc'),
    getRemoteAccess: () => mockRemoteAccessAnswer.current,
}));
jest.mock('../../src/ts/core/remote/trystero', () => ({
    createTrysteroTransport: jest.fn(async (options: { key: string }) => {
        const transport = new KeyedTransport(`adapter-${mockAdapterTransports.length}`);
        transport.key = options.key;
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
        logInfo: () => undefined,
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

describe('createRemoteHost: the path a phone is reached over', () => {
    const hello = {
        t: 'hello',
        version: HOST_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        linkVersion: LINK_VERSION,
        host: false,
    };

    test('the host asks for a transport as the host, and logs each join with its path', async () => {
        const created: Array<{ key: string; role: string }> = [];
        const logs: string[] = [];
        const transport = new TransportStub('host-x');
        Object.assign(transport, { peerPath: (peerId: string) => (peerId === 'p-relay' ? 'relay' : 'direct') });
        const { host } = makeHarness({
            createTransport: async (options) => {
                created.push(options);
                return transport;
            },
            logInfo: (message) => logs.push(message),
        });
        await host.start('the-key');
        expect(created).toEqual([{ key: 'the-key', role: 'host' }]);
        transport.emitJoin('p-relay');
        transport.emitJoin('p-direct');
        expect(logs).toEqual(
            expect.arrayContaining(['Remote peer seen: p-relay (relay)', 'Remote peer seen: p-direct (direct)']),
        );
        expect(logs.join('\n')).not.toContain('the-key');
    });

    test('"A phone connected" shows once per peer id and host session: a phone that drops and returns does not notify again', async () => {
        const transport = new TransportStub('host-x');
        const { host, deps } = makeHarness({ createTransport: async () => transport });
        await host.start('k');
        transport.receiveFromPeer(hello, 'p1');
        await flush();
        expect(deps.notifications).toBe(1);
        transport.emitLeave('p1'); // a background tab dropped for silence
        transport.receiveFromPeer(hello, 'p1');
        await flush();
        expect(host.connectedCount()).toBe(1);
        expect(deps.notifications).toBe(1);
        transport.receiveFromPeer(hello, 'p2'); // another phone does notify
        await flush();
        expect(deps.notifications).toBe(2);
        await host.stop(); // a new host session starts over
        await host.start('k');
        transport.receiveFromPeer(hello, 'p1');
        await flush();
        expect(deps.notifications).toBe(3);
    });

    test('counts the connected phones that are reached only over the relays', async () => {
        const transport = new TransportStub('host-x');
        const relayed = new Set(['r1', 'r2']);
        Object.assign(transport, { peerPath: (peerId: string) => (relayed.has(peerId) ? 'relay' : 'direct') });
        const { host } = makeHarness({ createTransport: async () => transport });
        expect(host.relayCount()).toBe(0); // not started
        await host.start('k');
        for (const peerId of ['r1', 'd1', 'r2']) transport.receiveFromPeer(hello, peerId);
        await flush();
        expect(host.connectedCount()).toBe(3);
        expect(host.relayCount()).toBe(2);
        transport.emitLeave('r1');
        expect(host.relayCount()).toBe(1);
        setActiveRemoteHost(host);
        expect(remoteRelayCount()).toBe(1);
        setActiveRemoteHost(null);
        expect(remoteRelayCount()).toBe(0);
    });

    describe('a phone that moves from the relay to WebRTC', () => {
        const connect = async (peerIds: string[]) => {
            const transport = new TransportStub('host-x');
            const relayed = new Set(peerIds);
            Object.assign(transport, { peerPath: (peerId: string) => (relayed.has(peerId) ? 'relay' : 'direct') });
            const made = makeHarness({ createTransport: async () => transport });
            await made.host.start('k');
            for (const peerId of peerIds) transport.receiveFromPeer(hello, peerId);
            await flush();
            return { ...made, transport, relayed };
        };

        test('is sent the current auto-vote state and nothing else, and the relay count is read again', async () => {
            const { host, transport, relayed, deps } = await connect(['p1']);
            const counts: number[] = [];
            host.onCountChange(() => counts.push(host.relayCount()));
            expect(host.relayCount()).toBe(1);
            transport.sent.length = 0;
            deps.getAutovoteState = () => ({ ...initialState, running: true, cycles: 5 });
            relayed.delete('p1'); // the transport now reaches it over WebRTC
            transport.emitPathChange('p1', 'direct');
            await flush();
            // Only the state: no hello, no settings-changed event, so the phone refetches nothing.
            expect(sentBy(transport).map(({ message }) => (message as { t: string }).t)).toEqual(['autovote-state']);
            expect(sentBy(transport)[0]).toMatchObject({
                target: 'p1',
                message: { state: { running: true, cycles: 5 }, hostRun: expect.any(String), n: expect.any(Number) },
            });
            expect(counts).toEqual([0]);
            expect(host.relayCount()).toBe(0);
        });

        test('is logged with the clipped peer id and the new path, whether or not the phone has said hello', async () => {
            const logs: string[] = [];
            const transport = new TransportStub('host-x');
            const { host } = makeHarness({
                createTransport: async () => transport,
                logInfo: (message) => logs.push(message),
            });
            await host.start('k');
            transport.receiveFromPeer(hello, 'p1');
            await flush();
            transport.emitPathChange('p1', 'direct');
            transport.emitPathChange('x'.repeat(600), 'direct');
            expect(logs).toContain('Remote peer path changed: p1 (direct)');
            expect(logs.filter((line) => line.startsWith('Remote peer path changed: ')).length).toBe(2);
            expect(logs).toContain(`Remote peer path changed: ${'x'.repeat(512)} (direct)`); // clipped to the field limit
        });

        test('a phone that has not said hello yet is sent nothing: its snapshot will be complete', async () => {
            const { host, transport } = await connect([]);
            const counts: number[] = [];
            host.onCountChange(() => counts.push(host.connectedCount()));
            transport.emitJoin('late');
            transport.emitPathChange('late', 'direct');
            await flush();
            expect(sentBy(transport)).toEqual([]);
            expect(counts).toEqual([]);
        });

        test('is not listened for once the host has stopped', async () => {
            const { host, transport } = await connect(['p1']);
            await host.stop();
            transport.sent.length = 0;
            transport.emitPathChange('p1', 'direct');
            await flush();
            expect(sentBy(transport)).toEqual([]);
        });

        test('a transport that has no path changes (one direct path) is hosted as before', async () => {
            const transport = new TransportStub('host-x');
            Object.defineProperty(transport, 'onPathChange', { value: undefined });
            const { host } = makeHarness({ createTransport: async () => transport });
            await host.start('k');
            transport.receiveFromPeer(hello, 'p1');
            await flush();
            expect(host.connectedCount()).toBe(1);
            await host.stop();
        });
    });

    test('a transport that names no paths counts no relay phones', async () => {
        const transport = new TransportStub('host-x');
        const { host } = makeHarness({ createTransport: async () => transport });
        await host.start('k');
        transport.receiveFromPeer(hello, 'p1');
        await flush();
        expect(host.relayCount()).toBe(0);
    });
});

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
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
            'p1',
        );
        await flush();

        const kinds = sentBy(transport).map(({ message }) => (message as { t: string }).t);
        expect(kinds).toEqual(['hello', 'event', 'autovote-state']);
        expect(sentBy(transport)[0].message).toEqual({
            t: 'hello',
            version: HOST_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            linkVersion: LINK_VERSION,
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

    test('a phone on another app version but the same link version is served', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: '8.0.0', protocolVersion: PROTOCOL_VERSION, linkVersion: LINK_VERSION, host: false },
            'p1',
        );
        await flush();

        expect(sentBy(transport).map(({ message }) => (message as { t: string }).t)).toEqual([
            'hello',
            'event',
            'autovote-state',
        ]);
        expect(host.connectedCount()).toBe(1);
    });

    test('a phone with another link version is told our hello and no snapshot is served', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION + 1,
                host: false,
            },
            'p1',
        );

        expect(sentBy(transport)).toHaveLength(1);
        expect(sentBy(transport)[0].message).toEqual({
            t: 'hello',
            version: HOST_VERSION,
            protocolVersion: PROTOCOL_VERSION,
            linkVersion: LINK_VERSION,
            host: true,
        });
        expect(host.connectedCount()).toBe(0);
        expect(deps.notifications).toBe(0);
    });

    test('a phone hello without a link version is dropped: no answer, no slot, no notice', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            { t: 'hello', version: HOST_VERSION, protocolVersion: PROTOCOL_VERSION, host: false },
            'p1',
        );

        expect(sentBy(transport)).toHaveLength(0);
        expect(host.connectedCount()).toBe(0);
        expect(deps.notifications).toBe(0);
    });

    test('start, stop and rearm commands run on the host controller, and nothing is ever started twice', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
            'p1',
        );
        transport.emitJoin('p2');
        transport.receiveFromPeer(
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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
                {
                    t: 'hello',
                    version: HOST_VERSION,
                    protocolVersion: PROTOCOL_VERSION,
                    linkVersion: LINK_VERSION,
                    host: false,
                },
                `p${i}`,
            );
            await flush();
        }
        expect(host.connectedCount()).toBe(MAX_REMOTE_PEERS);
        const byes = sentBy(transport).filter(({ message }) => (message as { t: string }).t === 'bye');
        expect(byes).toHaveLength(1);
        expect(byes[0].target).toBe(`p${MAX_REMOTE_PEERS}`);
        // The reason says the desktop is full, not gone.
        expect(byes[0].message).toEqual({ t: 'bye', reason: 'full' });
    });

    test('a peer leave drops it, and its log want with it', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
            'p1',
        );
        await flush();
        transport.sent.length = 0;
        host.pushAutovoteState(state);
        await flush();
        expect(sentBy(transport)).toHaveLength(1);
        expect(sentBy(transport)[0].message).toEqual({
            t: 'autovote-state',
            state,
            hostRun: expect.stringMatching(/^[0-9a-f]{16}$/),
            n: expect.any(Number),
        });
    });

    test("every autovote-state carries this run's id and a count that only grows, the same count to every phone of one push", async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        for (const peerId of ['p1', 'p2']) {
            transport.emitJoin(peerId);
            transport.receiveFromPeer(
                {
                    t: 'hello',
                    version: HOST_VERSION,
                    protocolVersion: PROTOCOL_VERSION,
                    linkVersion: LINK_VERSION,
                    host: false,
                },
                peerId,
            );
        }
        await flush();
        const stamps = (): Array<{ to: string | undefined; hostRun: string; n: number }> =>
            sentBy(transport)
                .filter(({ message }) => (message as { t: string }).t === 'autovote-state')
                .map(({ message, target }) => {
                    const { hostRun, n } = message as { hostRun: string; n: number };
                    return { to: target, hostRun, n };
                });
        transport.sent.length = 0;
        host.pushAutovoteState({ ...initialState, cycles: 1 });
        host.pushAutovoteState({ ...initialState, cycles: 2 });
        await flush();
        const pushed = stamps();
        expect(pushed.map(({ to }) => to)).toEqual(['p1', 'p2', 'p1', 'p2']);
        expect(new Set(pushed.map(({ hostRun }) => hostRun)).size).toBe(1);
        expect(pushed[0].n).toBe(pushed[1].n); // one push, one count
        expect(pushed[2].n).toBe(pushed[0].n + 1);
        // The next host of the same renderer goes on counting: a phone that stayed keeps its comparison.
        const next = makeHarness();
        await next.host.start('k');
        const nextTransport = next.deps.transports[0];
        nextTransport.emitJoin('p1');
        nextTransport.receiveFromPeer(
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
            'p1',
        );
        await flush();
        const snapshotState = sentBy(nextTransport).find(
            ({ message }) => (message as { t: string }).t === 'autovote-state',
        );
        const snapshotStamp = snapshotState?.message as { n: number } | undefined;
        expect(snapshotStamp?.n ?? -1).toBeGreaterThan(pushed[3].n);
    });

    test('the pairing key appears in no log line and no peer message', async () => {
        const KEY = 'super-secret-pairing-key';
        const logs: string[] = [];
        const { host, deps } = makeHarness({ logInfo: (message) => logs.push(message) });
        await host.start(KEY);
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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

describe('createRemoteHost (failures answer the phone)', () => {
    const connectPhone = async (harness: Harness, peer = 'p1'): Promise<TransportStub> => {
        await harness.host.start('k');
        const transport = harness.deps.transports[0];
        transport.emitJoin(peer);
        transport.receiveFromPeer(
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
            peer,
        );
        await flush();
        transport.sent.length = 0;
        return transport;
    };

    const resultOf = (transport: TransportStub, id: number) =>
        transport.sent
            .map(({ message }) => message as Record<string, unknown>)
            .find((m) => m.t === 'result' && m.id === id);

    test('an invoke whose handler rejects is answered ok:false with a short error, not left hanging', async () => {
        const harness = makeHarness({
            invoke: async (channel) => {
                if (channel === 'get-bankroll') throw new Error('GuruShots said no');
                return { success: true };
            },
        });
        const transport = await connectPhone(harness);
        transport.receiveFromPeer({ t: 'invoke', id: 5, channel: 'get-bankroll', args: [] }, 'p1');
        await flush();
        expect(resultOf(transport, 5)).toEqual({ t: 'result', id: 5, ok: false, error: 'GuruShots said no' });
    });

    test('the error is one bounded line, and a rejection with no message still says something', async () => {
        const harness = makeHarness({
            invoke: async (channel) => {
                if (channel === 'get-bankroll') throw new Error(`first line\n  second ${'x'.repeat(2000)}`);
                return Promise.reject(null);
            },
        });
        const transport = await connectPhone(harness);
        transport.receiveFromPeer({ t: 'invoke', id: 6, channel: 'get-bankroll', args: [] }, 'p1');
        transport.receiveFromPeer({ t: 'invoke', id: 7, channel: 'get-settings', args: [] }, 'p1');
        await flush();
        const long = resultOf(transport, 6) as { error: string };
        expect(long.error.startsWith('first line second xxx')).toBe(true);
        expect(long.error).not.toContain('\n');
        expect(long.error.length).toBe(MAX_PEER_FIELD_LENGTH);
        expect(resultOf(transport, 7)).toEqual({
            t: 'result',
            id: 7,
            ok: false,
            error: 'The computer could not run this.',
        });
    });

    test('a failing log-stream start is answered too', async () => {
        const harness = makeHarness({
            invoke: async (channel) => {
                if (channel === 'start-log-stream') throw new Error('no stream');
                return { success: true };
            },
        });
        const transport = await connectPhone(harness);
        transport.receiveFromPeer({ t: 'invoke', id: 8, channel: 'start-log-stream', args: [] }, 'p1');
        await flush();
        expect(resultOf(transport, 8)).toEqual({ t: 'result', id: 8, ok: false, error: 'no stream' });
    });

    test('a result over the message limit is answered ok:false "too large"; one under it goes through', async () => {
        const harness = makeHarness({
            invoke: async (channel) => {
                if (channel === 'get-library-photos') return 'x'.repeat(MAX_PEER_MESSAGE_BYTES);
                if (channel === 'get-bankroll') return { coins: 'y'.repeat(1000) };
                return { success: true };
            },
        });
        const transport = await connectPhone(harness);
        transport.receiveFromPeer({ t: 'invoke', id: 1, channel: 'get-library-photos', args: [] }, 'p1');
        transport.receiveFromPeer({ t: 'invoke', id: 2, channel: 'get-bankroll', args: [] }, 'p1');
        await flush();
        expect(resultOf(transport, 1)).toEqual({
            t: 'result',
            id: 1,
            ok: false,
            error: REMOTE_RESULT_TOO_LARGE,
            reason: 'too-large',
        });
        expect(resultOf(transport, 2)).toMatchObject({ ok: true });
    });

    test('a result JSON cannot serialize is answered unsendable, with the unsendable reason', async () => {
        const harness = makeHarness({ invoke: async () => ({ big: BigInt(1) }) });
        const transport = await connectPhone(harness);
        transport.receiveFromPeer({ t: 'invoke', id: 3, channel: 'get-bankroll', args: [] }, 'p1');
        await flush();
        expect(resultOf(transport, 3)).toEqual({
            t: 'result',
            id: 3,
            ok: false,
            error: REMOTE_RESULT_UNSENDABLE,
            reason: 'unsendable',
        });
    });

    test('a spend channel whose result is over the limit carries the too-large marker (the phone answers "unclear")', async () => {
        // `fill-exposure` is one of the spend channels: the phone maps its too-large answer to
        // "unclear — check before retrying", the same rule a lost in-flight spend follows.
        expect(SPEND_REMOTE_CHANNELS.has('fill-exposure')).toBe(true);
        const harness = makeHarness({
            invoke: async (channel) =>
                channel === 'fill-exposure' ? 'x'.repeat(MAX_PEER_MESSAGE_BYTES) : { success: true },
        });
        const transport = await connectPhone(harness);
        transport.receiveFromPeer({ t: 'invoke', id: 4, channel: 'fill-exposure', args: ['c1'] }, 'p1');
        await flush();
        expect(resultOf(transport, 4)).toEqual({
            t: 'result',
            id: 4,
            ok: false,
            error: REMOTE_RESULT_TOO_LARGE,
            reason: 'too-large',
        });
    });

    test('cleanup-stale-metadata is answered with success and nothing reaches the desktop', async () => {
        const harness = makeHarness();
        const transport = await connectPhone(harness);
        harness.deps.invokeLog.length = 0;
        transport.receiveFromPeer({ t: 'invoke', id: 9, channel: 'cleanup-stale-metadata', args: [['1', '2']] }, 'p1');
        await flush();
        expect(resultOf(transport, 9)).toEqual({ t: 'result', id: 9, ok: true, result: { success: true } });
        expect(harness.deps.invokeLog).toEqual([]);
    });

    test('a snapshot whose settings read fails still announces the host and relays the state', async () => {
        const logs: string[] = [];
        const harness = makeHarness({
            invoke: async () => {
                throw new Error('unreadable');
            },
            logInfo: (message) => logs.push(message),
        });
        await harness.host.start('k');
        const transport = harness.deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
            'p1',
        );
        await flush();
        expect(transport.sent.map(({ message }) => (message as { t: string }).t)).toEqual(['hello', 'autovote-state']);
        expect(logs).toContain('Remote invoke failed: get-settings');
    });

    test('an auto-vote command that rejects is logged and does not escape', async () => {
        const logs: string[] = [];
        const harness = makeHarness({
            runAutovoteCommand: () => Promise.reject(new Error('timer broke')),
            logInfo: (message) => logs.push(message),
        });
        const transport = await connectPhone(harness);
        transport.receiveFromPeer({ t: 'autovote-command', command: 'start' }, 'p1');
        await flush();
        expect(logs).toContain('Remote auto-vote command failed: start');
    });

    test('stopping the host while it holds the log stream releases it', async () => {
        const harness = makeHarness();
        const transport = await connectPhone(harness);
        transport.receiveFromPeer({ t: 'invoke', id: 1, channel: 'start-log-stream', args: [] }, 'p1');
        await flush();
        harness.deps.invokeLog.length = 0;
        await harness.host.stop();
        expect(harness.deps.invokeLog).toEqual([{ channel: 'stop-log-stream', args: [] }]);
        expect(transport.left).toBe(true);
    });

    test('stopping the host without a log stream calls nothing, and a failing release is not an error', async () => {
        const quiet = makeHarness();
        await connectPhone(quiet);
        quiet.deps.invokeLog.length = 0;
        await quiet.host.stop();
        expect(quiet.deps.invokeLog).toEqual([]);

        const failing = makeHarness({
            invoke: async (channel) => {
                if (channel === 'stop-log-stream') throw new Error('gone');
                return { success: true };
            },
        });
        const transport = await connectPhone(failing);
        transport.receiveFromPeer({ t: 'invoke', id: 2, channel: 'start-log-stream', args: [] }, 'p1');
        await flush();
        await expect(failing.host.stop()).resolves.toBeUndefined();
        expect(transport.left).toBe(true);
        // And the last log phone leaving with a failing release is quiet too.
        const leaving = makeHarness({
            invoke: async (channel) => {
                if (channel === 'stop-log-stream') throw new Error('gone');
                return { success: true };
            },
        });
        const t2 = await connectPhone(leaving);
        t2.receiveFromPeer({ t: 'invoke', id: 3, channel: 'start-log-stream', args: [] }, 'p1');
        await flush();
        t2.emitLeave('p1');
        await flush();
        expect(leaving.host.connectedCount()).toBe(0);
    });

    test('a leave of a phone that wanted no logs does not touch the log stream', async () => {
        const harness = makeHarness();
        const transport = await connectPhone(harness);
        harness.deps.invokeLog.length = 0;
        transport.emitLeave('p1');
        await flush();
        expect(harness.deps.invokeLog).toEqual([]);
    });
});

describe('createRemoteHost (the loader is not a phone)', () => {
    const loaderHello = (version: string) => ({
        t: 'hello',
        version,
        protocolVersion: PROTOCOL_VERSION,
        linkVersion: LINK_VERSION,
        host: false,
        role: 'loader',
    });

    test.each([HOST_VERSION, '1.0.0'])(
        'a loader hello (version %s) is answered with the version only: no snapshot, no slot, no count, no notice',
        async (loaderVersion) => {
            const { host, deps } = makeHarness();
            await host.start('k');
            const transport = deps.transports[0];
            transport.emitJoin('loader');
            const changes: number[] = [];
            host.onCountChange(() => changes.push(host.connectedCount()));
            transport.receiveFromPeer(loaderHello(loaderVersion), 'loader');
            await flush();
            expect(sentBy(transport).map(({ message, target }) => ({ message, target }))).toEqual([
                {
                    message: {
                        t: 'hello',
                        version: HOST_VERSION,
                        protocolVersion: PROTOCOL_VERSION,
                        linkVersion: LINK_VERSION,
                        host: true,
                    },
                    target: 'loader',
                },
            ]);
            expect(host.connectedCount()).toBe(0);
            expect(changes).toEqual([]);
            expect(deps.notifications).toBe(0);
            expect(deps.invokeLog).toEqual([]);
        },
    );

    test('a loader is answered even when every phone slot is taken, and takes none', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        for (let i = 0; i < MAX_REMOTE_PEERS; i++) {
            transport.emitJoin(`p${i}`);
            transport.receiveFromPeer(
                {
                    t: 'hello',
                    version: HOST_VERSION,
                    protocolVersion: PROTOCOL_VERSION,
                    linkVersion: LINK_VERSION,
                    host: false,
                },
                `p${i}`,
            );
        }
        await flush();
        transport.sent.length = 0;
        transport.receiveFromPeer(loaderHello(HOST_VERSION), 'loader');
        await flush();
        expect(sentBy(transport)).toHaveLength(1);
        expect((sentBy(transport)[0].message as { t: string }).t).toBe('hello');
        expect(host.connectedCount()).toBe(MAX_REMOTE_PEERS);
    });

    test('an invoke from a loader is refused: it never said hello as a phone', async () => {
        const { host, deps } = makeHarness();
        await host.start('k');
        const transport = deps.transports[0];
        transport.receiveFromPeer(loaderHello(HOST_VERSION), 'loader');
        transport.receiveFromPeer({ t: 'invoke', id: 1, channel: 'get-settings', args: [] }, 'loader');
        await flush();
        expect(deps.invokeLog).toEqual([]);
    });
});

describe('createRemoteHost (activity is logged at INFO, never with a key or arguments)', () => {
    test('peer connect, invoke, refusal, command, refusal for a full house and leave each leave a line', async () => {
        const logs: string[] = [];
        const { host, deps } = makeHarness({ logInfo: (message) => logs.push(message) });
        await host.start('the-key');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
            'p1',
        );
        transport.receiveFromPeer({ t: 'invoke', id: 1, channel: 'get-settings', args: [{ secret: 'arg' }] }, 'p1');
        transport.receiveFromPeer({ t: 'invoke', id: 2, channel: 'wipe-local-data', args: [] }, 'p1');
        transport.receiveFromPeer({ t: 'autovote-command', command: 'start' }, 'p1');
        for (let i = 2; i < MAX_REMOTE_PEERS + 2; i++) {
            transport.receiveFromPeer(
                {
                    t: 'hello',
                    version: HOST_VERSION,
                    protocolVersion: PROTOCOL_VERSION,
                    linkVersion: LINK_VERSION,
                    host: false,
                },
                `p${i}`,
            );
        }
        transport.emitLeave('p1');
        await flush();
        await host.stop();

        expect(logs).toEqual(
            expect.arrayContaining([
                'Remote access host started',
                'Remote peer seen: p1 (direct)',
                'Remote peer connected: p1',
                'Remote invoke: get-settings',
                'Remote invoke refused: wipe-local-data',
                'Remote auto-vote command: start',
                `Remote peer refused: at most ${MAX_REMOTE_PEERS} phones can be connected`,
                'Remote peer left: p1',
                'Remote access host stopped',
            ]),
        );
        expect(logs.join('\n')).not.toContain('the-key');
        expect(logs.join('\n')).not.toContain('arg');
    });

    test('the failure lines name the channel only', async () => {
        const logs: string[] = [];
        const { host, deps } = makeHarness({
            invoke: async () => {
                throw new Error('secret detail');
            },
            logInfo: (message) => logs.push(message),
        });
        await host.start('k');
        const transport = deps.transports[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
            'p1',
        );
        transport.receiveFromPeer({ t: 'invoke', id: 1, channel: 'get-bankroll', args: [] }, 'p1');
        await flush();
        expect(logs).toContain('Remote invoke failed: get-bankroll');
        expect(logs.join('\n')).not.toContain('secret detail');
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

    // Every test pairs under a key of its own, and counts only the transports made for that key: a join that
    // outlives its test (an unmounted Probe's start chain finishing late) cannot be mistaken for this test's.
    let testKey = '';
    let testCounter = 0;
    /** The pairing key a test names `name` pairs with. */
    const keyFor = (name: string): string => `${testKey}-${name}`;
    /** The transports the host made for this test's keys. */
    const mine = (): KeyedTransport[] =>
        mockAdapterTransports.filter((transport) => transport.key.startsWith(`${testKey}-`));

    const enabledLink = (key: string): unknown => ({
        success: true,
        enabled: true,
        link: `https://pages/remote/#k=${keyFor(key)}`,
        qrDataUrl: '',
    });

    beforeEach(() => {
        testKey = `test${++testCounter}`;
        mockAdapterTransports.length = 0;
        mockRemoteAccessAnswer.current = undefined;
    });

    afterEach(async () => {
        // Unmount every Probe now, and let the async start and stop chains they began settle before the next
        // test resets the shared state they write to. The 50 ms is a margin, not the isolation: the per-test
        // key and the `mine()` filter are what keep a late join of an earlier test out of this one's counts.
        cleanup();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });
        await flush();
        setActiveRemoteHost(null);
        mockAdapterTransports.length = 0;
        mockRemoteAccessAnswer.current = undefined;
    });

    test('while the pairing is enabled the host joins the room and runs commands on its controller', async () => {
        mockRemoteAccessAnswer.current = enabledLink('k1');
        render(<Probe />);
        await flush();
        expect(mine()).toHaveLength(1);
        expect(remoteConnectionCount()).toBe(0);

        mine()[0].emitJoin('p1');
        mine()[0].receiveFromPeer(
            {
                t: 'hello',
                version: appVersion(),
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
            'p1',
        );
        await flush();
        expect(remoteConnectionCount()).toBe(1);

        mine()[0].receiveFromPeer({ t: 'autovote-command', command: 'start' }, 'p1');
        await flush();
        expect(controller.start).toHaveBeenCalled();

        // A phone-side invoke rides the bridge: the host calls window.api and answers.
        mine()[0].sent.length = 0;
        mine()[0].receiveFromPeer({ t: 'invoke', id: 7, channel: 'get-active-challenges', args: [] }, 'p1');
        await flush();
        const answer = mine()[0].sent.find(({ message }) => (message as { t: string }).t === 'result');
        expect((answer?.message as { id: number } | undefined)?.id).toBe(7);

        // A forwarded event with a payload crosses the (handler, args) wrapper.
        mine()[0].sent.length = 0;
        fireSettingsChanged({ app: { language: 'en' } });
        await flush();
        const forwarded = mine()[0].sent.filter(
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
        expect(mine()).toHaveLength(1);

        mockRemoteAccessAnswer.current = enabledLink('k2');
        window.dispatchEvent(new CustomEvent('remote-access:changed'));
        await flush();
        await flush();
        expect(mine()[0].left).toBe(true);
        expect(mine()).toHaveLength(2);

        mockRemoteAccessAnswer.current = { success: false };
        window.dispatchEvent(new CustomEvent('remote-access:changed'));
        await flush();
        await flush();
        expect(mine()[1].left).toBe(true);
        expect(remoteConnectionCount()).toBe(0);
    });

    test('unmount leaves the room', async () => {
        mockRemoteAccessAnswer.current = enabledLink('k1');
        const view = render(<Probe />);
        await flush();
        expect(mine()[0].left).toBe(false);
        view.unmount();
        // preact flushes effect cleanups on its own schedule, not on microtasks: wait for the room to be left.
        await waitFor(() => expect(mine()[0].left).toBe(true));
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
        expect(mine()).toHaveLength(0);
    });

    test('the hook forwards stop and rearm to its controller, and tolerates unsubscribe-less event mocks', async () => {
        mockRemoteAccessAnswer.current = enabledLink('k1');
        render(<Probe />);
        await flush();
        const transport = mine()[0];
        transport.emitJoin('p1');
        transport.receiveFromPeer(
            {
                t: 'hello',
                version: appVersion(),
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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
            expect(mine()).toHaveLength(0);
            view.unmount();
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
            resolveAnswer(enabledLink('k1'));
            await flush();
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
            expect(mine()).toHaveLength(0);
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
                {
                    t: 'hello',
                    version: HOST_VERSION,
                    protocolVersion: PROTOCOL_VERSION,
                    linkVersion: LINK_VERSION,
                    host: false,
                },
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
        const saved = mockApi.onSettingsChanged;
        // A subscribe typed to the real signature that answers no unsubscribe
        // (an undefined at runtime): the host's fallback must wrap it in a no-op.
        mockApi.onSettingsChanged = jest.fn<() => void, [(...args: never[]) => void]>(() =>
            invalid<() => void>(undefined),
        );
        try {
            render(<Probe />);
            await flush();
            expect(mine()).toHaveLength(1);
        } finally {
            mockApi.onSettingsChanged = saved;
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
        createSpy.mockImplementation(async (options) => {
            await gate;
            const transport = new KeyedTransport(`adapter-${mockAdapterTransports.length}`);
            transport.key = options.key;
            mockAdapterTransports.push(transport);
            return transport;
        });
        try {
            const view = render(<Probe />);
            await flush();
            expect(mine()).toHaveLength(0);
            // Unmounting inside act runs the effect cleanups before the join is let go.
            await act(async () => {
                view.unmount();
            });
            (release as () => void)();
            await flush();
            await waitFor(() => expect(mine()).toHaveLength(1));
            await waitFor(() => expect(mine()[0].left).toBe(true));
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
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
            'p1',
        );
        await flush();
        // A repeat hello from the known phone: not a new connection, no second notification.
        deps.notifications = 0;
        transport.receiveFromPeer(
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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
            {
                t: 'hello',
                version: HOST_VERSION,
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
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

    describe('the window.api method that serves a channel', () => {
        const connectPhone = async (): Promise<TransportStub> => {
            mockRemoteAccessAnswer.current = enabledLink('k1');
            render(<Probe />);
            await flush();
            const transport = mine()[0];
            transport.emitJoin('p1');
            transport.receiveFromPeer(
                {
                    t: 'hello',
                    version: appVersion(),
                    protocolVersion: PROTOCOL_VERSION,
                    linkVersion: LINK_VERSION,
                    host: false,
                },
                'p1',
            );
            await flush();
            transport.sent.length = 0;
            return transport;
        };
        const answerTo = (transport: TransportStub, id: number) =>
            transport.sent
                .map(({ message }) => message as Record<string, unknown>)
                .find((m) => m.t === 'result' && m.id === id);

        test('the turbo alias channel reaches applyTurbo, not a method named after the channel', async () => {
            mockApi.applyTurbo.mockClear();
            mockApi.applyTurbo.mockResolvedValueOnce({ success: true, message: 'turbo applied' });
            const transport = await connectPhone();
            transport.receiveFromPeer(
                { t: 'invoke', id: 11, channel: 'apply-turbo-to-entry', args: ['c1', 'e1'] },
                'p1',
            );
            await flush();
            expect(mockApi.applyTurbo).toHaveBeenCalledWith('c1', 'e1');
            expect(answerTo(transport, 11)).toEqual({
                t: 'result',
                id: 11,
                ok: true,
                result: { success: true, message: 'turbo applied' },
            });
        });

        test('the other alias (boost) and a plain channel keep their methods', async () => {
            mockApi.applyBoost.mockClear();
            const transport = await connectPhone();
            transport.receiveFromPeer(
                { t: 'invoke', id: 12, channel: 'apply-boost-to-entry', args: ['c1', 'e1'] },
                'p1',
            );
            await flush();
            expect(mockApi.applyBoost).toHaveBeenCalledWith('c1', 'e1');
        });

        test('a channel the window has no method for is answered ok:false, not left hanging', async () => {
            const saved = mockApi.getBankroll;
            Reflect.deleteProperty(mockApi, 'getBankroll');
            try {
                const transport = await connectPhone();
                transport.receiveFromPeer({ t: 'invoke', id: 13, channel: 'get-bankroll', args: [] }, 'p1');
                await flush();
                expect(answerTo(transport, 13)).toEqual({
                    t: 'result',
                    id: 13,
                    ok: false,
                    error: 'No window.api method serves get-bankroll',
                });
            } finally {
                mockApi.getBankroll = saved;
            }
        });
    });

    describe('overlapping syncs never leave a host in the room', () => {
        /** Holds every join until the test opens the gate; the room objects are recorded as they open. */
        const holdJoins = () => {
            const gates: Array<() => void> = [];
            const adapterModule = jest.requireMock('../../src/ts/core/remote/trystero') as {
                createTrysteroTransport: jest.MockedFunction<
                    (typeof import('../../src/ts/core/remote/trystero'))['createTrysteroTransport']
                >;
            };
            const createSpy = adapterModule.createTrysteroTransport;
            const defaultImpl = createSpy.getMockImplementation();
            createSpy.mockImplementation(async (options) => {
                await new Promise<void>((resolve) => gates.push(resolve));
                const transport = new KeyedTransport(`adapter-${mockAdapterTransports.length}`);
                transport.key = options.key;
                mockAdapterTransports.push(transport);
                return transport;
            });
            return {
                open: async () => {
                    gates.splice(0).forEach((open) => open());
                    await flush();
                    await flush();
                },
                restore: () => createSpy.mockImplementation(defaultImpl),
            };
        };

        test('switched on and off again before the join resolves: the room is left and nothing stays registered', async () => {
            const held = holdJoins();
            try {
                mockRemoteAccessAnswer.current = enabledLink('k1');
                render(<Probe />);
                await flush();
                expect(mine()).toHaveLength(0);

                mockRemoteAccessAnswer.current = {
                    success: true,
                    enabled: false,
                    link: 'https://pages/remote/#k=k1',
                    qrDataUrl: '',
                };
                window.dispatchEvent(new CustomEvent('remote-access:changed'));
                await flush();
                await held.open();

                expect(mine()).toHaveLength(1);
                expect(mine()[0].left).toBe(true);
                expect(remoteConnectionCount()).toBe(0);
                // Nobody is hearing the room any more.
                mine()[0].emitJoin('p1');
                mine()[0].receiveFromPeer(
                    {
                        t: 'hello',
                        version: appVersion(),
                        protocolVersion: PROTOCOL_VERSION,
                        linkVersion: LINK_VERSION,
                        host: false,
                    },
                    'p1',
                );
                await flush();
                expect(remoteConnectionCount()).toBe(0);
            } finally {
                held.restore();
            }
        });

        test('re-keyed while the first join is in flight: the old room is left, the new one is the host', async () => {
            const held = holdJoins();
            try {
                mockRemoteAccessAnswer.current = enabledLink('k1');
                render(<Probe />);
                await flush();
                mockRemoteAccessAnswer.current = enabledLink('k2');
                window.dispatchEvent(new CustomEvent('remote-access:changed'));
                await flush();
                await held.open();
                await held.open();

                expect(mine()).toHaveLength(2);
                expect(mine()[0].left).toBe(true);
                expect(mine()[1].left).toBe(false);
                mine()[1].emitJoin('p1');
                mine()[1].receiveFromPeer(
                    {
                        t: 'hello',
                        version: appVersion(),
                        protocolVersion: PROTOCOL_VERSION,
                        linkVersion: LINK_VERSION,
                        host: false,
                    },
                    'p1',
                );
                await flush();
                expect(remoteConnectionCount()).toBe(1);
            } finally {
                held.restore();
            }
        });

        test('the same pairing announced again while the join is in flight keeps that join', async () => {
            const held = holdJoins();
            try {
                mockRemoteAccessAnswer.current = enabledLink('k1');
                render(<Probe />);
                await flush();
                window.dispatchEvent(new CustomEvent('remote-access:changed'));
                await flush();
                await held.open();

                expect(mine()).toHaveLength(1);
                expect(mine()[0].left).toBe(false);
                mine()[0].emitJoin('p1');
                mine()[0].receiveFromPeer(
                    {
                        t: 'hello',
                        version: appVersion(),
                        protocolVersion: PROTOCOL_VERSION,
                        linkVersion: LINK_VERSION,
                        host: false,
                    },
                    'p1',
                );
                await flush();
                expect(remoteConnectionCount()).toBe(1);
            } finally {
                held.restore();
            }
        });
    });

    test('the badge store serves the active host count and relays the controller state', async () => {
        const seen: number[] = [];
        const unsubscribe = subscribeRemoteConnectionCount(() => seen.push(remoteConnectionCount()));
        expect(remoteConnectionCount()).toBe(0);

        mockRemoteAccessAnswer.current = enabledLink('k1');
        render(<Probe />);
        await flush();
        seen.length = 0;
        mine()[0].emitJoin('p1');
        mine()[0].receiveFromPeer(
            {
                t: 'hello',
                version: appVersion(),
                protocolVersion: PROTOCOL_VERSION,
                linkVersion: LINK_VERSION,
                host: false,
            },
            'p1',
        );
        await flush();
        expect(seen).toEqual([1]);

        const state = { ...initialState, running: true, cycles: 4 };
        pushAutovoteStateToActiveHost(state);
        await flush();
        const relayed = mine()[0]
            .sent.filter(({ message }) => (message as { t: string }).t === 'autovote-state')
            .at(-1);
        expect((relayed?.message as { state: unknown } | undefined)?.state).toEqual(state);
        unsubscribe();
    });
});
