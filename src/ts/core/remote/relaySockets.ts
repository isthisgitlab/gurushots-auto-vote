/**
 * The relay link's own WebSockets: one per relay in the list, opened apart from trystero's so a
 * relay's refusal of our data events (`rate-limited`, `blocked`) cannot back off or retire
 * trystero's signalling relays. An event is signed once (`createEvent`, injected from the
 * trystero adapter, the only module that imports the library) and the same string goes to every
 * open relay. To spare mobile data the link listens on at most `MAX_SUBSCRIBED_RELAYS` open
 * relays, in list order, and moves to the next open one when a listening relay closes.
 *
 * Both paths sign with trystero's one pubkey from one IP, so a relay's rate limit or block by
 * pubkey hits both; the link's send budget keeps that unlikely.
 */

import { RELAY_CONTENT_MAX_BYTES, toHex } from './relayCodec';
import { createSeenSet } from './relayGuards';
import { isPlainObject } from '../plainObject';

import type { RelayIo } from './relayLinkState';

/** The WebSocket surface the sockets use; the browser's `WebSocket` satisfies it. */
export type SocketLike = {
    readonly readyState: number;
    send: (data: string) => void;
    close: () => void;
    onopen: (() => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: (() => void) | null;
};

export type RelaySocketsOptions = {
    urls: readonly string[];
    /** Opens a socket (`new WebSocket(url)` in production). */
    createSocket: (url: string) => SocketLike;
    /** Signs `content` into a `["EVENT",{…}]` frame for `topic` (trystero's `createEvent`). */
    createEvent: (topic: string, content: string) => Promise<string>;
    /** The `["REQ",subId,{…}]` frame that starts listening to `topic` (trystero's `subscribe`). */
    subscribeFrame: (subId: string, topic: string) => string;
    /** A relay refused one of our events (`OK false`) or closed our subscription. Nothing in the app acts on it; the live probe and tests read it. */
    onRefused?: (url: string, reason: string) => void;
    /** The clock in milliseconds, for the cooldowns and the copy memory (Date.now by default). */
    now?: () => number;
    /** The digest an event's content is remembered by (hex SHA-256 by default). */
    hash?: (text: string) => Promise<string>;
    /** How many open relays the link listens on at once (MAX_SUBSCRIBED_RELAYS by default). The desktop host listens on all of them, so a phone's first presence reaches it whichever relay the phone opens first. */
    maxListening?: number;
};

/** The most relays a phone listens on at once (it spares mobile data); the host listens on every relay. */
export const MAX_SUBSCRIBED_RELAYS = 3;

/** The first wait before a closed relay is reconnected; it doubles to RECONNECT_MAX_MS and starts over when a socket opens. */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/** The subscription id on every socket: events and closes for any other id are not ours. */
export const RELAY_SUB_ID = 'gs-relay';

/** The first cooldown after a relay refuses our events as rate-limited or banned; it doubles on each new refusal up to COOLDOWN_MAX_MS. */
export const COOLDOWN_BASE_MS = 60_000;
export const COOLDOWN_MAX_MS = 900_000;

/** The `OK false` reasons (NIP-01 machine-readable prefixes) that mean the relay does not want our events for now: publishing to it stops for a cooldown. */
const COOLDOWN_REASON = /^(?:rate-limited|blocked|banned|restricted|pow|auth-required):/;

/** How long the content of a delivered event is remembered, so the copy of it that a second relay delivers is not decrypted again. */
export const COPY_MEMORY_MS = 60_000;

/** The most content digests computed at once; an event that arrives past it is dropped unread. */
export const MAX_PENDING_DIGESTS = 64;

/** The most contents remembered; past it the oldest is forgotten, so memory stays bounded before the decrypt budget applies. */
export const MAX_REMEMBERED_COPIES = 4096;

/** The `pubkey` of a signed event frame (trystero's `createEvent`): a hex field no base64url content can imitate. */
const EVENT_PUBKEY = /"pubkey":"([0-9a-f]{64})"/;

const sha256Hex = async (text: string): Promise<string> =>
    toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));

/** How many relays a role listens on at once: the desktop host on every relay, a phone on a few to spare mobile data. */
export const listeningLimit = (role: 'host' | 'phone', relayCount: number): number =>
    Math.min(role === 'host' ? relayCount : MAX_SUBSCRIBED_RELAYS, relayCount);

const OPEN = 1;

type Relay = {
    readonly url: string;
    socket: SocketLike | null;
    /** The relay is listening for our topic on its current socket. */
    subscribed: boolean;
    /** The relay closed our subscription: it is not asked again on this socket. */
    refused: boolean;
    delay: number;
    timer: ReturnType<typeof setTimeout> | null;
    /** No event is published to the relay before this time. */
    coolUntil: number;
    /** How long the next refusal's cooldown lasts. */
    cooldown: number;
};

const isOpen = (relay: Relay): relay is Relay & { socket: SocketLike } => relay.socket?.readyState === OPEN;

export const createRelaySockets = (options: RelaySocketsOptions): RelayIo => {
    const relays: Relay[] = options.urls.map((url) => ({
        url,
        socket: null,
        subscribed: false,
        refused: false,
        delay: RECONNECT_BASE_MS,
        timer: null,
        coolUntil: 0,
        cooldown: COOLDOWN_BASE_MS,
    }));
    const now = options.now ?? Date.now;
    const maxListening = options.maxListening ?? MAX_SUBSCRIBED_RELAYS;
    /** The pubkey our events are signed with (trystero's, one per page), read off the first one we sign: the relay echoes our own events back. */
    let ownPubkey: string | null = null;
    const hashOf = options.hash ?? sha256Hex;
    /** How many content digests are being computed right now. */
    let digesting = 0;
    const copies = createSeenSet(COPY_MEMORY_MS, now, MAX_REMEMBERED_COPIES);
    const handlers = new Set<(content: string) => void>();
    const openHandlers = new Set<() => void>();
    let topic: string | null = null;
    let closed = false;

    /** Listens on the first open relays, up to the limit. */
    const rebalance = (): void => {
        if (topic === null) return;
        let listening = relays.filter((relay) => relay.subscribed).length;
        for (const relay of relays) {
            if (listening >= maxListening) return;
            if (!isOpen(relay) || relay.subscribed || relay.refused) continue;
            // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a WebSocket to a public relay, never a window frame
            relay.socket.send(options.subscribeFrame(RELAY_SUB_ID, topic));
            relay.subscribed = true;
            listening += 1;
        }
    };

    /** Hands the content to the listeners unless a copy of it was handed over lately. */
    const deliverOnce = async (content: string): Promise<void> => {
        try {
            const digest = await hashOf(content);
            if (copies.has(digest)) return;
            copies.add(digest);
            for (const handler of handlers) handler(content);
        } catch {
            // The digest failed (no `crypto.subtle`, say): the event is dropped, and the sender's resend or another relay's copy recovers it.
        } finally {
            digesting -= 1;
        }
    };

    const receive = (relay: Relay, data: unknown): void => {
        if (typeof data !== 'string') return;
        let frame: unknown;
        try {
            frame = JSON.parse(data);
        } catch {
            return;
        }
        if (!Array.isArray(frame)) return;
        const [type, id, body, reason] = frame;
        if (type === 'EVENT' && id === RELAY_SUB_ID) {
            if (!isPlainObject(body) || typeof body.content !== 'string') return;
            if (body.content.length > RELAY_CONTENT_MAX_BYTES) return;
            // Our own echo is dropped before anything is decrypted, and so is a second relay's copy of an
            // event, so the decrypt budget goes to events from others. A copy is told by the SHA-256 of its
            // content, never by the relay's `id`: a relay could stamp a real event's id on a forged one and
            // so block the real copies. The content is remembered only once it has passed the echo check.
            if (body.pubkey === ownPubkey) return;
            // The digests in flight are bounded too: past the cap an event is dropped unread.
            if (digesting >= MAX_PENDING_DIGESTS) return;
            digesting += 1;
            void deliverOnce(body.content);
        } else if (type === 'OK' && body === true) {
            relay.coolUntil = 0;
            relay.cooldown = COOLDOWN_BASE_MS;
        } else if (type === 'OK' && body === false) {
            const why = typeof reason === 'string' ? reason : '';
            options.onRefused?.(relay.url, why);
            // A reply that arrives during a cooldown answers an event sent before it began: the same refusal, not a new one.
            if (COOLDOWN_REASON.test(why) && now() >= relay.coolUntil) {
                relay.coolUntil = now() + relay.cooldown;
                relay.cooldown = Math.min(relay.cooldown * 2, COOLDOWN_MAX_MS);
            }
        } else if (type === 'CLOSED' && id === RELAY_SUB_ID) {
            options.onRefused?.(relay.url, typeof body === 'string' ? body : '');
            relay.subscribed = false;
            relay.refused = true;
            rebalance();
        }
    };

    const connect = (relay: Relay): void => {
        relay.timer = null;
        const socket = options.createSocket(relay.url);
        relay.socket = socket;
        socket.onopen = () => {
            relay.delay = RECONNECT_BASE_MS;
            rebalance();
            for (const handler of openHandlers) handler();
        };
        socket.onmessage = (event) => receive(relay, event.data);
        socket.onclose = () => {
            relay.socket = null;
            relay.subscribed = false;
            relay.refused = false;
            if (closed) return;
            rebalance();
            relay.timer = globalThis.setTimeout(() => connect(relay), relay.delay);
            relay.delay = Math.min(relay.delay * 2, RECONNECT_MAX_MS);
        };
    };

    for (const relay of relays) connect(relay);

    return {
        publish: async (eventTopic, content) => {
            const event = await options.createEvent(eventTopic, content);
            ownPubkey ??= EVENT_PUBKEY.exec(event)?.[1] ?? null;
            // A relay in cooldown keeps its socket and its subscription; it just gets no events of ours.
            const open = relays.filter(
                (relay): relay is Relay & { socket: SocketLike } => isOpen(relay) && now() >= relay.coolUntil,
            );
            if (closed || open.length === 0) throw new Error('No relay is connected.');
            // oxlint-disable-next-line frame-guard/no-unfiltered-frame-send -- a WebSocket to a public relay, never a window frame
            for (const relay of open) relay.socket.send(event);
        },
        onEvent: (handler) => {
            handlers.add(handler);
            return () => handlers.delete(handler);
        },
        onOpen: (handler) => {
            openHandlers.add(handler);
            return () => openHandlers.delete(handler);
        },
        subscribe: (next) => {
            topic = next;
            rebalance();
        },
        close: () => {
            closed = true;
            for (const relay of relays) {
                if (relay.timer !== null) globalThis.clearTimeout(relay.timer);
                relay.timer = null;
                relay.socket?.close();
            }
        },
    };
};
