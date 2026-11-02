/**
 * The relay link: the pairing's protocol messages carried over Nostr relay events, for when
 * WebRTC cannot connect. A `RemoteTransport` over an injected `RelayIo` (the sockets in
 * production) and codec, so its tests run on an in-memory bus. Messages are encrypted with the
 * pairing key (`relayCodec.ts`); a peer is whoever sends an authentic frame, found by presence
 * frames and lost on silence or a `bye`.
 *
 * What relays still see in clear: the topic tag, the event kind, `created_at`, the signing
 * pubkey (trystero's, the same one its signalling uses), the event size and the IP addresses.
 * A recorded event cannot be replayed past a restart (epochs), outside five minutes of its
 * timestamp, or twice (the seen-set). Junk on the topic can starve real frames of the decrypt
 * cap — accepted for a fallback path. Dependency-light and DOM-free.
 */

import { RELAY_MAX_PARTS, RELAY_PART_BYTES, cryptoRandom, splitBytes, toHex } from './relayCodec';
import { createSeenSet, createTokenBucket } from './relayGuards';
import { DECRYPT_FRAMES_PER_SECOND, REPLAY_MEMORY_MS, handleContent } from './relayLinkFrames';
import { broadcastByeFrame, emitFrame, removePeer, sendPresenceOnOpen, sendPresence } from './relayLinkState';
import { createOutbox } from './relayOutbox';
import { createStreamTable } from './relayStreams';
import { isPlainObject } from '../plainObject';
import { TRYSTERO_APP_ID } from './relays';

import type { RelayCodec } from './relayCodec';
import type { LinkContext, LinkRole, Peer, RelayIo } from './relayLinkState';
import type { RemoteTransport } from './relays';

export type { LinkRole, RelayIo } from './relayLinkState';

/** The phone announces itself this often while the link is open, and the host this often while a phone is joined: below the 10 s idle timeout some relays apply. */
export const PRESENCE_MS = 8_000;

/** A peer that sent nothing for this long is gone. */
export const PEER_SILENCE_MS = 25_000;

const SWEEP_MS = 1_000;

/** The topic the link's events carry: the SHA-256 hex of the app id, `relay` and the room id, so it differs from the signalling room's. */
export const relayTopic = async (roomId: string): Promise<string> => {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${TRYSTERO_APP_ID}:relay:${roomId}`),
    );
    return toHex(new Uint8Array(digest));
};

export type RelayLinkOptions = {
    io: RelayIo;
    codec: RelayCodec;
    topic: string;
    selfId: string;
    role: LinkRole;
    now?: () => number;
    random?: (length: number) => Uint8Array;
};

/** Whether a message only carries a log line — the first thing dropped under backlog. */
const isLogEvent = (message: unknown): boolean =>
    isPlainObject(message) && message.t === 'event' && message.channel === 'log-message';

/**
 * Packs, splits and queues one message; the sequence number is taken when its first frame leaves the
 * budget. A message that cannot be sent (too large, the queue full) would be lost with the peer
 * still joined and nobody the wiser, so the peer is given up on — with a link `bye` — and the other
 * side settles what it has in flight.
 */
const queueMessage = async (ctx: LinkContext, message: unknown, target: string): Promise<void> => {
    const peer = ctx.peers.get(target);
    if (ctx.closed || peer === undefined) throw new Error('The relay link does not reach that peer.');
    try {
        const parts = splitBytes(await ctx.codec.pack(message), RELAY_PART_BYTES);
        if (parts.length > RELAY_MAX_PARTS) throw new Error('The message is too large for the relay link.');
        if (ctx.peers.get(target) !== peer) throw new Error('The peer left while the message was prepared.');
        const msgId = toHex(ctx.random(16));
        const frames = parts.map((part, index) => ({
            draft: { to: peer.id, toEpoch: peer.epoch, msgId, part: index, parts: parts.length, kind: 'data' as const },
            part,
        }));
        ctx.outbox.sendMessage(peer.id, msgId, frames, isLogEvent(message));
    } catch (error) {
        if (ctx.peers.get(target) === peer) removePeer(ctx, peer, true);
        throw error;
    }
};

/** The two timers the peer table drives: the silence sweep, and the host's presence. The phone's presence runs for the link's life. */
const createTimers = (ctx: LinkContext): { sync: () => void; stop: () => void } => {
    let sweep: ReturnType<typeof setInterval> | null = null;
    let presence: ReturnType<typeof setInterval> | null = null;
    const sweepSilent = (): void => {
        for (const peer of [...ctx.peers.values()]) {
            // The host tells a silent phone it was dropped, so the phone does not keep talking to nobody.
            if (ctx.now() - peer.lastSeen > PEER_SILENCE_MS) removePeer(ctx, peer, ctx.role === 'host');
        }
    };
    const toggle = (current: ReturnType<typeof setInterval> | null, want: boolean, run: () => void, ms: number) => {
        if (want && current === null) return globalThis.setInterval(run, ms);
        if (!want && current !== null) globalThis.clearInterval(current);
        return want ? current : null;
    };
    const sync = (): void => {
        const present = ctx.peers.size > 0;
        sweep = toggle(sweep, present, sweepSilent, SWEEP_MS);
        if (ctx.role === 'host') presence = toggle(presence, present, () => sendPresence(ctx, null), PRESENCE_MS);
    };
    if (ctx.role === 'phone') {
        presence = globalThis.setInterval(() => sendPresence(ctx, null), PRESENCE_MS);
        sendPresence(ctx, null);
    }
    return {
        sync,
        stop: () => {
            if (sweep !== null) globalThis.clearInterval(sweep);
            if (presence !== null) globalThis.clearInterval(presence);
            sweep = null;
            presence = null;
        },
    };
};

export const createRelayLink = (options: RelayLinkOptions): RemoteTransport => {
    const now = options.now ?? Date.now;
    const random = options.random ?? cryptoRandom;
    const ctx: LinkContext = {
        ...options,
        now,
        random,
        epoch: toHex(random(16)),
        peers: new Map(),
        streams: createStreamTable((from, message) => {
            for (const handler of ctx.messageHandlers) handler(from, message);
        }, now),
        owedPresence: new Set(),
        seen: createSeenSet(REPLAY_MEMORY_MS, now),
        decryptBudget: createTokenBucket(DECRYPT_FRAMES_PER_SECOND, DECRYPT_FRAMES_PER_SECOND, now),
        outbox: createOutbox({
            now,
            random,
            emit: (frame) => void emitFrame(ctx, frame),
            // An unacknowledged message ends the peer, and the peer is told. A peer that left took its
            // messages with it (`forgetPeer`), so a message that gives up always has its peer here.
            giveUp: (peerId) => removePeer(ctx, ctx.peers.get(peerId) as Peer, true),
        }),
        messageHandlers: new Set(),
        joinHandlers: new Set(),
        leaveHandlers: new Set(),
        onPeersChanged: () => timers.sync(),
        closed: false,
    };
    const timers = createTimers(ctx);
    const unsubscribe = ctx.io.onEvent((content) => void handleContent(ctx, content));
    // A presence sent before any relay socket was open is sent when the first one opens, not at the next 8 s tick.
    const unsubscribeOpen = ctx.io.onOpen(() => sendPresenceOnOpen(ctx));
    ctx.io.subscribe(ctx.topic);
    /** Sends go through one chain, so two messages are numbered in the order they were sent however long each takes to compress. */
    let sends: Promise<unknown> = Promise.resolve();
    const handlerSet =
        <A extends unknown[]>(set: Set<(...args: A) => void>) =>
        (handler: (...args: A) => void) => {
            set.add(handler);
            return () => set.delete(handler);
        };

    return {
        send: (message, target) => {
            if (target === undefined) return Promise.reject(new Error('The relay link sends to one peer at a time.'));
            const queued = sends.then(() => queueMessage(ctx, message, target));
            sends = queued.catch(() => undefined);
            return queued;
        },
        onMessage: handlerSet(ctx.messageHandlers),
        onPeerJoin: handlerSet(ctx.joinHandlers),
        onPeerLeave: handlerSet(ctx.leaveHandlers),
        // A relay link has no join failures: a peer is joined by its first authentic frame.
        onJoinError: () => () => undefined,
        leave: async () => {
            if (ctx.closed) return;
            if (ctx.peers.size > 0) await emitFrame(ctx, broadcastByeFrame(ctx));
            ctx.closed = true;
            timers.stop();
            unsubscribe();
            unsubscribeOpen();
            ctx.outbox.close();
            ctx.streams.close();
            ctx.peers.clear();
            ctx.io.close();
        },
    };
};
