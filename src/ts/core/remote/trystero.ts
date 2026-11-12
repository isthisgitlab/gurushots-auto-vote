/**
 * The one trystero adapter: joins the Nostr-signalled WebRTC room a pairing key names and
 * exposes it as a RemoteTransport (core/remote/relays.ts). This is the only module that
 * imports `trystero`. Its public room API is adapted here while the relay fallback uses its
 * own ephemeral Nostr signer. Everything else here (the relay and STUN lists, the room
 * identity, the error classification) is plain code that tests read and call.
 *
 * Loaded only on the `electron` and `remote` kinds (the desktop host and the phone page), so
 * the web and capacitor bundles externalize the library and the relay modules this file loads at
 * call time (scripts/build-react/entries.ts), so they never grow by them.
 */

import { isSafeToSendTwice } from './protocol';
import { NOSTR_RELAY_URLS, STUN_SERVER_URLS, TRYSTERO_APP_ID } from './relays';

import type { RemoteTransport, RemoteTransportFactory } from './relays';
import type { SocketLike } from './relaySockets';
import type { JsonValue, Room, RoomError } from 'trystero';

/** Trystero's one protocol namespace: every remote message rides it. */
export const TRYSTERO_ACTION_NAMESPACE = 'gs-remote';

/** The ICE servers every peer connection is built with, instead of the library's defaults. */
export const RTC_ICE_SERVERS: RTCIceServer[] = STUN_SERVER_URLS.map((urls) => ({ urls }));

/**
 * The room id trystero bands the pairing peers together with: the SHA-256 hex digest of the
 * pairing key's UTF-8 bytes, so the key itself never appears in relay traffic — only its
 * hash, and the room's AES-GCM password (the key itself) guards even that.
 */
export const roomIdForKey = async (key: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * The single classifier of a trystero join failure (decision 7 of the brief): only the
 * "the peers exchanged SDP but WebRTC still could not connect" error is the phone's
 * "try Wi-Fi" state. A wrong room password or a handshake failure or timeout maps to the
 * offline-or-reset message instead.
 *
 * Source of the strings: @trystero-p2p/core/dist/signal-handler.mjs (the SDP-exchange
 * failure is built at line 64 and reported through onJoinError at lines 65-73; the
 * wrong-password errors are reported at lines 317 and 399) and @trystero-p2p/core/dist/
 * handshake.mjs (the handshake failures, e.g. the timeout at line 92).
 */
export const isConnectionFailureJoinError = (error: string): boolean =>
    error.startsWith('could not connect to peer') && error.includes('after exchanging SDP');

type PeerRoomError = Extract<
    RoomError,
    { code: 'room-full' | 'banned' | 'decrypt-failed' | 'peer-connect-failed' | 'handshake-failed' | 'peer-error' }
>;

const isPeerRoomError = (error: RoomError): error is PeerRoomError & { peerId: string } =>
    'peerId' in error && typeof error.peerId === 'string';

const forwardPeerRoomError = (
    error: RoomError,
    handler: (details: { error: string; peerId: string }) => void,
): void => {
    if (isPeerRoomError(error)) handler({ error: error.message, peerId: error.peerId });
};

/** Adapts the WebRTC room (signalled over the Nostr relays) as the direct transport path. */
const joinDirect = (room: Room): RemoteTransport => {
    const startupErrors: RoomError[] = [];
    const stopStartupCollector = room.onError((error) => startupErrors.push(error));
    const action = room.makeAction<JsonValue>(TRYSTERO_ACTION_NAMESPACE);

    const takeStartupErrors = (): RoomError[] => {
        stopStartupCollector();
        return startupErrors.splice(0);
    };

    return {
        // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- trystero's message action to the pairing peers, never a frame send
        send: (message, target) => action.send(message as JsonValue, target === undefined ? {} : { target }),
        onMessage: (handler) => action.onMessage((message, { peerId }) => handler(peerId, message)),
        onPeerJoin: (handler) => room.onPeerJoin(({ peerId }) => handler(peerId), { replay: true }),
        onPeerLeave: (handler) => room.onPeerLeave(({ peerId }) => handler(peerId)),
        onJoinError: (handler) => {
            const unsubscribe = room.onError((error) => forwardPeerRoomError(error, handler));
            for (const error of takeStartupErrors()) forwardPeerRoomError(error, handler);
            return unsubscribe;
        },
        leave: async () => {
            takeStartupErrors();
            await room.leave();
        },
    };
};

/**
 * The relay fallback over the pairing key: our own WebSockets to the relays, signed with
 * this transport's own ephemeral signer and carrying the room's peer id, so a peer has the same
 * id on both paths. Null where the browser lacks `CompressionStream` (iOS Safari before
 * 16.4): only the relay path is off then.
 */
const buildRelayLink = async (
    room: Room,
    key: string,
    roomId: string,
    role: 'host' | 'phone',
): Promise<RemoteTransport | null> => {
    if (typeof CompressionStream === 'undefined') return null;
    const [
        { createRelayCodec },
        { createRelayLink, relayTopic },
        { createRelaySockets, listeningLimit },
        { createNostrFrames },
    ] = await Promise.all([
        import('./relayCodec'),
        import('./relayLink'),
        import('./relaySockets'),
        import('./nostrFrames'),
    ]);
    const { createEvent, subscribeFrame } = createNostrFrames();
    const { peerId: selfId } = await room.getSelf();
    return createRelayLink({
        io: createRelaySockets({
            urls: NOSTR_RELAY_URLS,
            createSocket: (url) => new WebSocket(url) as SocketLike,
            createEvent,
            subscribeFrame,
            // The host listens on every relay; a phone on a few, to spare mobile data.
            maxListening: listeningLimit(role, NOSTR_RELAY_URLS.length),
        }),
        codec: createRelayCodec(key),
        topic: await relayTopic(roomId),
        selfId,
        role,
    });
};

/**
 * Builds the transport: the WebRTC room and the relay link behind one hybrid transport
 * (core/remote/hybridTransport.ts).
 */
export const createTrysteroTransport: RemoteTransportFactory = async (options) => {
    // Loaded at call time so a module import of this file never loads the library (the tests
    // import the classifier; the web and capacitor bundles carry this file but never call it).
    const trystero = (await import('trystero')) as typeof import('trystero');
    const roomId = await roomIdForKey(options.key);
    const { createHybridTransport } = await import('./hybridTransport');
    const room = trystero.joinRoom(
        {
            appId: TRYSTERO_APP_ID,
            identity: 'none',
            relayConfig: { urls: [...NOSTR_RELAY_URLS] },
            password: options.key,
            rtcConfig: { iceServers: RTC_ICE_SERVERS },
        },
        roomId,
    );
    return createHybridTransport({
        direct: joinDirect(room),
        relay: await buildRelayLink(room, options.key, roomId, options.role),
        role: options.role,
        // The desktop sends a second copy of what the phone shrugs off; the phone sends invokes, which a duplicate would harm.
        isSafeDuplicate: options.role === 'host' ? isSafeToSendTwice : undefined,
    });
};
