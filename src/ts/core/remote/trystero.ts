/* istanbul ignore file -- a real join needs WebRTC, a WebSocket pool and ICE negotiation, which
   cannot run under Jest; the tests inject an in-memory transport and cover this module's
   constants and classifier, so only the join wiring itself stays uncovered. */

/**
 * The one trystero adapter: joins the Nostr-signalled WebRTC room a pairing key names and
 * exposes it as a RemoteTransport (core/remote/relays.ts). This is the only module that
 * imports `trystero`, and the only remote module Jest does not fully cover — a real
 * RTCPeerConnection, WebSocket pool and ICE negotiation cannot run under Jest, so the unit
 * tests inject an in-memory transport instead and leave this adapter's join/leave wiring to
 * it. Everything it decides (the relay and STUN lists, the room identity, the error
 * classification) is pinned by tests that read this file's constants and call its pure
 * classifier.
 *
 * Loaded only on the `electron` and `remote` kinds (the desktop host and the phone page), so
 * the web and capacitor bundles externalize it (scripts/build-react.ts) and never grow by it.
 */

import { NOSTR_RELAY_URLS, STUN_SERVER_URLS, TRYSTERO_APP_ID } from './relays';

import type { RemoteTransportFactory } from './relays';
import type { JoinError, JsonValue, Room } from 'trystero';

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

/** Builds the transport: joins the room and wires its callbacks to the fan-out listeners. */
export const createTrysteroTransport: RemoteTransportFactory = async (options) => {
    // Loaded at call time so a module import of this file never loads the library (the tests
    // import the classifier; the web and capacitor bundles carry this file but never call it).
    const { joinRoom } = (await import('trystero')) as typeof import('trystero');
    const roomId = await roomIdForKey(options.key);

    const messageHandlers = new Set<(peerId: string, message: unknown) => void>();
    const joinHandlers = new Set<(peerId: string) => void>();
    const leaveHandlers = new Set<(peerId: string) => void>();
    const joinErrorHandlers = new Set<(details: { error: string }) => void>();

    const room: Room = joinRoom(
        {
            appId: TRYSTERO_APP_ID,
            relayConfig: { urls: [...NOSTR_RELAY_URLS] },
            password: options.key,
            rtcConfig: { iceServers: RTC_ICE_SERVERS },
        },
        roomId,
        {
            onJoinError: (details: JoinError) => {
                for (const handler of joinErrorHandlers) handler({ error: details.error });
            },
        },
    );

    // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- trystero's message action to the pairing peers, never a frame send
    const { send: sendRaw } = room.makeAction<JsonValue>(TRYSTERO_ACTION_NAMESPACE, {
        onMessage: (data, context) => {
            for (const handler of messageHandlers) handler(context.peerId, data);
        },
    });

    room.onPeerJoin = (peerId) => {
        for (const handler of joinHandlers) handler(peerId);
    };
    room.onPeerLeave = (peerId) => {
        for (const handler of leaveHandlers) handler(peerId);
    };

    return {
        send: (message, target) => sendRaw(message as JsonValue, target === undefined ? {} : { target }),
        onMessage: (handler) => {
            messageHandlers.add(handler);
            return () => messageHandlers.delete(handler);
        },
        onPeerJoin: (handler) => {
            joinHandlers.add(handler);
            return () => joinHandlers.delete(handler);
        },
        onPeerLeave: (handler) => {
            leaveHandlers.add(handler);
            return () => leaveHandlers.delete(handler);
        },
        onJoinError: (handler) => {
            joinErrorHandlers.add(handler);
            return () => joinErrorHandlers.delete(handler);
        },
        leave: () => room.leave(),
    };
};
