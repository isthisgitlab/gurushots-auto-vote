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

/**
 * The public Nostr relays the pairing signalling and the relay fallback run over, in priority
 * order. Each one accepts our anonymous ephemeral events up to `RELAY_EVENT_MAX_BYTES`
 * (core/remote/relayCodec.ts) and delivers them to subscribers; a relay that drops ephemeral
 * events (relay.snort.social), refuses unknown pubkeys (offchain.pub) or bans an IP after a few
 * rate limits (relay.damus.io) cannot carry either.
 */
export const NOSTR_RELAY_URLS = [
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://nostr.mom',
    'wss://nostr.oxtr.dev',
] as const;

/** The STUN servers WebRTC contacts to learn each side's public address (CSP does not govern these). */
export const STUN_SERVER_URLS = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] as const;

/** The GitHub Pages origin the pairing link points at. */
export const REMOTE_PAGES_ORIGIN = 'https://isthisgitlab.github.io/gurushots-auto-vote';

/** The path of the remote page under the Pages origin (and of every versioned copy below it). */
export const REMOTE_PAGES_PATH = '/remote/';

/** Trystero's application id: rooms of other apps never collide with ours. */
export const TRYSTERO_APP_ID = 'com.isthisgitlab.gurushotsautovote';

/** The path a peer is reached over: a direct WebRTC connection, or the Nostr relay fallback. */
export type RemotePath = 'direct' | 'relay';

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
     * established. The `error` text comes from the transport; `isConnectionFailureJoinError`
     * (core/remote/trystero.ts) tells a connection failure apart from a refused handshake.
     * `peerId` is the peer the failure is about: a fellow phone's failed connection says
     * nothing about the desktop's.
     */
    onJoinError: (handler: (details: { error: string; peerId: string }) => void) => () => void;
    /** Leave the room and close every connection. */
    leave: () => Promise<void>;
    /**
     * Which path a joined peer is reached over (null for a peer that is not joined). Only the
     * hybrid transport answers it; a transport without it is one direct path.
     */
    peerPath?: (peerId: string) => RemotePath | null;
    /** Whether the relay fallback can run at all here (false in a browser without `CompressionStream`). Only the hybrid transport answers it. */
    relayAvailable?: () => boolean;
};

/**
 * Builds one transport over the room the pairing key names (the trystero adapter in production).
 * `role` is the side of the pairing the transport is for: the desktop host, or a phone page.
 */
export type RemoteTransportFactory = (options: { key: string; role: 'host' | 'phone' }) => Promise<RemoteTransport>;
