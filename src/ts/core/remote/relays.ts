/**
 * The shared facts of the remote-access connection: the Nostr relays the
 * signalling runs over, the STUN servers WebRTC learns the peers' addresses
 * from, the pairing link's origin, and the transport interface the desktop
 * host and the phone's peer bridge both talk to. Dependency-free, so the
 * renderer, the shells and the CSP documents all read the same lists.
 *
 * Trystero sits behind the transport interface in exactly one adapter module
 * (`trystero.ts`); everything else injects a factory, so tests run on an
 * in-memory transport without real WebRTC.
 */

/** The public Nostr relays the pairing signalling runs over, in priority order. */
export const NOSTR_RELAY_URLS = [
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://relay.snort.social',
    'wss://nostr.mom',
    'wss://offchain.pub',
] as const;

/** The STUN servers WebRTC contacts to learn each side's public address (CSP does not govern these). */
export const STUN_SERVER_URLS = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] as const;

/** The GitHub Pages origin the pairing link points at. */
export const REMOTE_PAGES_ORIGIN = 'https://isthisgitlab.github.io/gurushots-auto-vote';

/** The path of the remote page under the Pages origin (and of every versioned copy below it). */
export const REMOTE_PAGES_PATH = '/remote/';

/** Trystero's application id: rooms of other apps never collide with ours. */
export const TRYSTERO_APP_ID = 'com.isthisgitlab.gurushotsautovote';

/**
 * One live peer connection. `message` is a protocol message (core/remote/protocol.ts) already
 * parsed out of the wire format; unknown payloads arrive as `unknown` and every consumer
 * validates them before dispatch.
 */
export type RemoteTransport = {
    /** Send a protocol message to one peer, or to every peer when no target is given. */
    send: (message: unknown, target?: string) => Promise<void>;
    /** Subscribe to messages from any peer; answers the unsubscribe. */
    onMessage: (handler: (peerId: string, message: unknown) => void) => () => void;
    /** Subscribe to peer joins; answers the unsubscribe. */
    onPeerJoin: (handler: (peerId: string) => void) => () => void;
    /** Subscribe to peer leaves; answers the unsubscribe. */
    onPeerLeave: (handler: (peerId: string) => void) => () => void;
    /**
     * Subscribe to join failures: a peer that was seen but whose connection could not be
     * established. The `error` text comes from the transport; `meansConnectionFailure`
     * (protocol.ts) tells a connection failure apart from a refused handshake.
     */
    onJoinError: (handler: (details: { error: string }) => void) => () => void;
    /** Leave the room and close every connection. */
    leave: () => Promise<void>;
};

/** Builds one transport over the room the pairing key names (the trystero adapter in production). */
export type RemoteTransportFactory = (options: { key: string }) => Promise<RemoteTransport>;
