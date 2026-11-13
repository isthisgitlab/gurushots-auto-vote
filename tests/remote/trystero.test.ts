import { createTrysteroTransport, isConnectionFailureJoinError } from '../../src/ts/core/remote/trystero';
import { NOSTR_RELAY_URLS, STUN_SERVER_URLS, TRYSTERO_APP_ID } from '../../src/ts/core/remote/relays';
import { TransportStub } from '../helpers/remoteTransport';

import type {
    JsonValue,
    MessageAction,
    MessageContext,
    PeerJoinContext,
    PeerLeaveContext,
    ReplayListenerOptions,
    RoomError,
    RoomErrorHandler,
    SelfInfo,
    Unsubscribe,
} from 'trystero';
import type { RemoteTransport } from '../../src/ts/core/remote/relays';
import type { createRelayCodec } from '../../src/ts/core/remote/relayCodec';
import type { createRelayLink, relayTopic } from '../../src/ts/core/remote/relayLink';
import type { createRelaySockets, listeningLimit } from '../../src/ts/core/remote/relaySockets';

type JoinRoom = typeof import('trystero').joinRoom;
type RelayLinkOptions = Parameters<typeof createRelayLink>[0];
type RelayCodec = ReturnType<typeof createRelayCodec>;
type RelaySocketsOptions = Parameters<typeof createRelaySockets>[0];
type RelayIo = ReturnType<typeof createRelaySockets>;
type ActionSendOptions = Parameters<MessageAction<JsonValue>['send']>[1];
type NostrFrames = {
    createEvent: (topic: string, content: string) => Promise<string>;
    subscribeFrame: (subId: string, topic: string) => string;
};

type AdapterRoom = {
    makeAction: (namespace: string) => MessageAction<JsonValue>;
    getSelf: () => Promise<SelfInfo>;
    onPeerJoin: (handler: (context: PeerJoinContext) => unknown, options?: ReplayListenerOptions) => Unsubscribe;
    onPeerLeave: (handler: (context: PeerLeaveContext) => unknown) => Unsubscribe;
    onError: (handler: RoomErrorHandler) => Unsubscribe;
    leave: () => Promise<void>;
};

const mockJoinRoom = jest.fn<AdapterRoom, Parameters<JoinRoom>>();
const mockCreateRelayCodec = jest.fn<RelayCodec, [string]>();
const mockRelayTopic = jest.fn<ReturnType<typeof relayTopic>, Parameters<typeof relayTopic>>();
const mockCreateRelayLink = jest.fn<RemoteTransport, [RelayLinkOptions]>();
const mockCreateRelaySockets = jest.fn<RelayIo, [RelaySocketsOptions]>();
const mockListeningLimit = jest.fn<ReturnType<typeof listeningLimit>, Parameters<typeof listeningLimit>>();
const mockFrames: NostrFrames = {
    createEvent: jest.fn<Promise<string>, [string, string]>(),
    subscribeFrame: jest.fn<string, [string, string]>(),
};
const mockCreateNostrFrames = jest.fn<NostrFrames, []>();

jest.mock('trystero', () => ({ __esModule: true, joinRoom: mockJoinRoom }));
jest.mock('../../src/ts/core/remote/relayCodec', () => ({ __esModule: true, createRelayCodec: mockCreateRelayCodec }));
jest.mock('../../src/ts/core/remote/relayLink', () => ({
    __esModule: true,
    createRelayLink: mockCreateRelayLink,
    relayTopic: mockRelayTopic,
}));
jest.mock('../../src/ts/core/remote/relaySockets', () => ({
    __esModule: true,
    createRelaySockets: mockCreateRelaySockets,
    listeningLimit: mockListeningLimit,
}));
jest.mock('../../src/ts/core/remote/nostrFrames', () => ({
    __esModule: true,
    createNostrFrames: mockCreateNostrFrames,
}));
jest.mock('../../src/ts/core/remote/hybridTransport', () => {
    const actual = jest.requireActual<typeof import('../../src/ts/core/remote/hybridTransport')>(
        '../../src/ts/core/remote/hybridTransport',
    );
    return { __esModule: true, ...actual, createHybridTransport: jest.fn(actual.createHybridTransport) };
});

const hybridModule =
    require('../../src/ts/core/remote/hybridTransport') as typeof import('../../src/ts/core/remote/hybridTransport');
const mockCreateHybridTransport = jest.mocked(hybridModule.createHybridTransport);

const self = (peerId = 'shared-peer'): SelfInfo => ({
    peerId,
    userId: 'user',
    identityPersistence: 'none',
    roomId: 'room',
    baseRoomId: 'room',
    isAdmin: false,
    roles: [],
});

class RoomMock implements AdapterRoom {
    readonly sent = jest.fn<Promise<void>, [JsonValue, ActionSendOptions?]>().mockResolvedValue(undefined);
    readonly leave = jest.fn<Promise<void>, []>().mockResolvedValue(undefined);
    readonly getSelf = jest.fn<Promise<SelfInfo>, []>();
    readonly action: MessageAction<JsonValue>;
    readonly peerJoinCalls: Array<{ options: ReplayListenerOptions | undefined }> = [];
    private readonly peers = new Set<string>();
    private readonly messageHandlers = new Set<Parameters<MessageAction<JsonValue>['onMessage']>[0]>();
    private readonly peerJoinHandlers = new Set<(context: PeerJoinContext) => unknown>();
    private readonly peerLeaveHandlers = new Set<(context: PeerLeaveContext) => unknown>();
    private readonly errorHandlers = new Set<RoomErrorHandler>();

    constructor() {
        this.action = {
            send: this.sent,
            onMessage: (handler) => {
                this.messageHandlers.add(handler);
                return () => this.messageHandlers.delete(handler);
            },
            onReceiveProgress: () => () => undefined,
            onReceive: () => () => undefined,
        };
    }

    makeAction = jest.fn<MessageAction<JsonValue>, [string]>(() => this.action);

    onPeerJoin = (handler: (context: PeerJoinContext) => unknown, options?: ReplayListenerOptions): Unsubscribe => {
        this.peerJoinCalls.push({ options });
        this.peerJoinHandlers.add(handler);
        if (options?.replay) for (const peerId of this.peers) handler({ peerId, userId: 'peer-user', roles: [] });
        return () => this.peerJoinHandlers.delete(handler);
    };

    onPeerLeave = (handler: (context: PeerLeaveContext) => unknown): Unsubscribe => {
        this.peerLeaveHandlers.add(handler);
        return () => this.peerLeaveHandlers.delete(handler);
    };

    onError = (handler: RoomErrorHandler): Unsubscribe => {
        this.errorHandlers.add(handler);
        return () => this.errorHandlers.delete(handler);
    };

    emitJoin(peerId: string): void {
        this.peers.add(peerId);
        for (const handler of this.peerJoinHandlers) handler({ peerId, userId: 'peer-user', roles: [] });
    }

    emitLeave(peerId: string): void {
        this.peers.delete(peerId);
        for (const handler of this.peerLeaveHandlers) handler({ peerId, userId: 'peer-user' });
    }

    emitMessage(message: JsonValue, peerId: string): void {
        const context: MessageContext = { peerId, userId: 'peer-user', roles: [] };
        for (const handler of this.messageHandlers) handler(message, context);
    }

    emitError(error: RoomError): void {
        for (const handler of this.errorHandlers) handler(error);
    }
}

describe('createTrysteroTransport', () => {
    let room: RoomMock;
    let relay: TransportStub;
    let compressionDescriptor: PropertyDescriptor | undefined;
    let webSocketDescriptor: PropertyDescriptor | undefined;
    let mockWebSocket: jest.MockedFunction<(url: string) => object>;

    beforeEach(() => {
        room = new RoomMock();
        room.getSelf.mockResolvedValue(self());
        relay = new TransportStub('shared-peer');
        mockJoinRoom.mockReturnValue(room);
        mockCreateRelayLink.mockReturnValue(relay);
        mockRelayTopic.mockResolvedValue('relay-topic');
        mockListeningLimit.mockReturnValue(NOSTR_RELAY_URLS.length);
        mockCreateNostrFrames.mockReturnValue(mockFrames);
        compressionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CompressionStream');
        webSocketDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
        mockWebSocket = jest.fn<object, [string]>(() => ({}));
        Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: mockWebSocket });
        mockJoinRoom.mockClear();
        mockCreateRelayCodec.mockClear();
        mockRelayTopic.mockClear();
        mockCreateRelayLink.mockClear();
        mockCreateRelaySockets.mockClear();
        mockListeningLimit.mockClear();
        mockCreateNostrFrames.mockClear();
        mockCreateHybridTransport.mockClear();
    });

    afterEach(() => {
        if (compressionDescriptor) Object.defineProperty(globalThis, 'CompressionStream', compressionDescriptor);
        else Reflect.deleteProperty(globalThis, 'CompressionStream');
        if (webSocketDescriptor) Object.defineProperty(globalThis, 'WebSocket', webSocketDescriptor);
        else Reflect.deleteProperty(globalThis, 'WebSocket');
        jest.clearAllMocks();
    });

    test('recognizes only an SDP exchange connection failure', () => {
        expect(isConnectionFailureJoinError('could not connect to peer abc after exchanging SDP')).toBe(true);
        expect(isConnectionFailureJoinError('could not connect to peer abc')).toBe(false);
        expect(isConnectionFailureJoinError('handshake failed after exchanging SDP')).toBe(false);
    });

    test.each(['host', 'phone'] as const)(
        'uses the public room configuration and shared room peer id for %s',
        async (role) => {
            const transport = await createTrysteroTransport({ key: 'pairing-key', role });

            expect(mockJoinRoom).toHaveBeenCalledWith(
                {
                    appId: TRYSTERO_APP_ID,
                    identity: 'none',
                    relayConfig: { urls: [...NOSTR_RELAY_URLS] },
                    password: 'pairing-key',
                    rtcConfig: { iceServers: STUN_SERVER_URLS.map((urls) => ({ urls })) },
                },
                expect.any(String),
            );
            expect(mockCreateRelayLink).toHaveBeenCalledWith(expect.objectContaining({ selfId: 'shared-peer', role }));
            const relayOptions = mockCreateRelaySockets.mock.calls.at(-1)?.[0];
            if (relayOptions === undefined) throw new Error('Relay sockets were not created');
            relayOptions.createSocket('wss://relay.test');
            expect(mockWebSocket).toHaveBeenCalledWith('wss://relay.test');
            expect(transport.relayAvailable?.()).toBe(true);
        },
    );

    test('adapts action sends, events, errors and unsubscriptions through the public room API', async () => {
        const transport = await createTrysteroTransport({ key: 'pairing-key', role: 'host' });
        const direct = mockCreateHybridTransport.mock.calls[0][0].direct;
        const messages: Array<[string, unknown]> = [];
        const joins: string[] = [];
        const leaves: string[] = [];
        const errors: Array<{ error: string; peerId: string }> = [];
        const offMessage = direct.onMessage((peerId, message) => messages.push([peerId, message]));
        const offJoin = direct.onPeerJoin((peerId) => joins.push(peerId));
        const offLeave = direct.onPeerLeave((peerId) => leaves.push(peerId));
        const offError = direct.onJoinError((details) => errors.push(details));

        await direct.send({ t: 'hello' });
        await direct.send({ t: 'hello' }, 'peer');
        room.emitMessage({ t: 'result' }, 'peer');
        room.emitJoin('peer');
        room.emitLeave('peer');
        room.emitError({
            message: 'could not connect to peer peer after exchanging SDP',
            appId: TRYSTERO_APP_ID,
            roomId: 'room',
            code: 'peer-connect-failed',
            peerId: 'peer',
            turnConfigured: false,
        });
        room.emitError({ message: 'relay unavailable', appId: TRYSTERO_APP_ID, roomId: 'room', code: 'relay-failed' });
        room.emitError({ message: 'room ban', appId: TRYSTERO_APP_ID, roomId: 'room', code: 'banned' });
        room.emitError({
            message: 'peer ban',
            appId: TRYSTERO_APP_ID,
            roomId: 'room',
            code: 'banned',
            peerId: 'banned-peer',
        });
        offMessage();
        offJoin();
        offLeave();
        offError();
        room.emitMessage({ t: 'later' }, 'peer');
        room.emitJoin('later');
        room.emitLeave('later');
        room.emitError({
            message: 'later failure',
            appId: TRYSTERO_APP_ID,
            roomId: 'room',
            code: 'handshake-failed',
            peerId: 'later',
        });
        await transport.leave();

        expect(room.sent).toHaveBeenNthCalledWith(1, { t: 'hello' }, {});
        expect(room.sent).toHaveBeenNthCalledWith(2, { t: 'hello' }, { target: 'peer' });
        expect(messages).toEqual([['peer', { t: 'result' }]]);
        expect(joins).toEqual(['peer']);
        expect(leaves).toEqual(['peer']);
        expect(errors).toEqual([
            { error: 'could not connect to peer peer after exchanging SDP', peerId: 'peer' },
            { error: 'peer ban', peerId: 'banned-peer' },
        ]);
        expect(room.peerJoinCalls.every(({ options }) => options?.replay === true)).toBe(true);
        expect(room.leave).toHaveBeenCalledTimes(1);
    });

    test('replays an early direct join after the room waits for relay setup and after a late hybrid subscription', async () => {
        const identity = Promise.withResolvers<SelfInfo>();
        const started = Promise.withResolvers<void>();
        room.getSelf.mockImplementation(() => {
            started.resolve();
            return identity.promise;
        });
        const pending = createTrysteroTransport({ key: 'pairing-key', role: 'phone' });
        await started.promise;
        room.emitJoin('early-peer');
        identity.resolve(self());
        const transport = await pending;
        const seen: string[] = [];
        const off = transport.onPeerJoin((peerId) => seen.push(peerId));

        room.emitJoin('later-peer');
        off();
        room.emitJoin('unheard-peer');

        expect(seen).toEqual(['early-peer', 'later-peer']);
        expect(transport.peerPath?.('early-peer')).toBe('direct');
    });

    test('replays a direct peer that joined before joinRoom returned when CompressionStream is unavailable', async () => {
        Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, value: undefined });
        mockJoinRoom.mockImplementationOnce(() => {
            room.emitJoin('early-peer');
            return room;
        });

        const transport = await createTrysteroTransport({ key: 'pairing-key', role: 'phone' });
        const seen: string[] = [];
        const off = transport.onPeerJoin((peerId) => seen.push(peerId));
        off();
        room.emitJoin('also-unheard-peer');

        expect(transport.relayAvailable?.()).toBe(false);
        expect(seen).toEqual(['early-peer']);
        expect(transport.peerPath?.('early-peer')).toBe('direct');
        expect(room.getSelf).not.toHaveBeenCalled();
        expect(mockCreateRelayLink).not.toHaveBeenCalled();
    });

    test('replays a native peer error queued before a direct-only factory resolves', async () => {
        Object.defineProperty(globalThis, 'CompressionStream', { configurable: true, value: undefined });
        mockJoinRoom.mockImplementationOnce(() => {
            queueMicrotask(() => {
                room.emitError({
                    message: 'early peer failure',
                    appId: TRYSTERO_APP_ID,
                    roomId: 'room',
                    code: 'handshake-failed',
                    peerId: 'early-peer',
                });
            });
            return room;
        });

        const transport = await createTrysteroTransport({ key: 'pairing-key', role: 'phone' });
        const errors: Array<{ error: string; peerId: string }> = [];
        transport.onJoinError((details) => errors.push(details));

        expect(errors).toEqual([{ error: 'early peer failure', peerId: 'early-peer' }]);
    });

    test('replays a startup peer error through delayed relay setup after its normal relay hold', async () => {
        const identity = Promise.withResolvers<SelfInfo>();
        const started = Promise.withResolvers<void>();
        room.getSelf.mockImplementation(() => {
            started.resolve();
            return identity.promise;
        });
        const pending = createTrysteroTransport({ key: 'pairing-key', role: 'phone' });
        await started.promise;
        room.emitError({
            message: 'delayed startup failure',
            appId: TRYSTERO_APP_ID,
            roomId: 'room',
            code: 'handshake-failed',
            peerId: 'early-peer',
        });
        jest.useFakeTimers();
        try {
            identity.resolve(self());
            const transport = await pending;
            const errors: Array<{ error: string; peerId: string }> = [];
            transport.onJoinError((details) => errors.push(details));

            jest.advanceTimersByTime(11_999);
            expect(errors).toEqual([]);
            jest.advanceTimersByTime(1);
            expect(errors).toEqual([{ error: 'delayed startup failure', peerId: 'early-peer' }]);
        } finally {
            jest.useRealTimers();
        }
    });
});
