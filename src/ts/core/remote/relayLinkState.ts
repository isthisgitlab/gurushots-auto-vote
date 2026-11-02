/**
 * The relay link's shared state and the plumbing around it: the peer table, the control frames
 * (presence, ack, bye), a frame's trip out through the codec to the sockets, and the peer joins
 * and leaves. `relayLinkFrames.ts` (what an inbound frame does) and `relayLink.ts` (the transport
 * and its timers) both work on this context.
 */

import { batchFits } from './relayBatchCodec';
import { toHex } from './relayWire';
import { createReassembler } from './relayInbox';

import type { FrameHeader, RelayCodec } from './relayCodec';
import type { Batch } from './relayBatchCodec';
import type { Reassembler } from './relayInbox';
import type { InflateQueue } from './relayInflate';
import type { StreamTable } from './relayStreams';
import type { EmitBatch, EmitFrame, OutFrame, Outbox } from './relayOutbox';
import type { SeenSet, TokenBucket } from './relayGuards';

/** The link's two roles: the phone announces itself, the desktop host only answers. */
export type LinkRole = 'phone' | 'host';

/** What carries the link's events: the sockets in production, an in-memory bus in tests. */
export type RelayIo = {
    /** Signs `content` into an event for `topic` and sends it to every open relay. */
    publish: (topic: string, content: string) => Promise<void>;
    /** Subscribes to the `content` of every event on the subscribed topic; answers the unsubscribe. */
    onEvent: (handler: (content: string) => void) => () => void;
    /** Starts listening to a topic. */
    subscribe: (topic: string) => void;
    /** Calls the handler each time a relay socket opens; answers the unsubscribe. */
    onOpen: (handler: () => void) => () => void;
    close: () => void;
};

/** The most finished messages kept per peer for answering a duplicate with its ack again. */
export const MAX_COMPLETED_PER_PEER = 256;

export type Peer = {
    readonly id: string;
    readonly epoch: string;
    lastSeen: number;
    /** The newest timestamp of any frame accepted from this peer: a frame of another epoch replaces the peer only if it is newer. */
    newestTs: number;
    readonly reassembler: Reassembler;
    /** Finished message ids → when they were last acknowledged. */
    readonly completed: Map<string, number>;
    /** Whether the peer's latest presence advertised batch events (or it sent one): only then is it sent any. A new epoch starts without it. */
    batch: boolean;
};

export type LinkContext = {
    readonly io: RelayIo;
    readonly codec: RelayCodec;
    readonly topic: string;
    readonly selfId: string;
    readonly role: LinkRole;
    /** Whether this link sends and reads batch events and says so in its presence; off, it behaves as the first release of the link did. */
    readonly batching: boolean;
    readonly now: () => number;
    readonly random: (length: number) => Uint8Array;
    /** Random per link instance, announced in every frame: a frame made for an earlier instance never matches. */
    readonly epoch: string;
    readonly peers: Map<string, Peer>;
    /** The ordered inboxes of the senders' streams; they outlive the peer records. */
    readonly streams: StreamTable;
    /** Who a presence frame was lost for ('' is everyone): no relay was open, so it is sent again when one opens. */
    readonly owedPresence: Set<string>;
    readonly seen: SeenSet;
    readonly decryptBudget: TokenBucket;
    /** How many data messages may finish a second: each is unzipped and parsed, and one batch event can finish up to 64 of them for one decrypt. */
    readonly finishedBudget: TokenBucket;
    /** Where a finished message waits to be unzipped and parsed: at most a few run at once. */
    readonly inflater: InflateQueue;
    readonly outbox: Outbox;
    readonly messageHandlers: Set<(peerId: string, message: unknown) => void>;
    readonly joinHandlers: Set<(peerId: string) => void>;
    readonly leaveHandlers: Set<(peerId: string, unacked: number) => void>;
    /** How many sends are waiting in the send chain or being packed for each peer: not queued yet, and in flight all the same. */
    readonly sending: Map<string, number>;
    /** Where a message for a peer goes when it finishes packing instead of the outbox, while the peer's messages are being moved to another path. */
    readonly redirects: Map<string, (message: unknown) => void>;
    /** The callbacks waiting for a peer to have nothing in flight; each is called once. */
    readonly idleWaiters: Map<string, Set<() => void>>;
    /** Called whenever the peer table changes, so the timers that depend on it can start or stop. */
    onPeersChanged: () => void;
    closed: boolean;
};

const NO_BYTES = new Uint8Array(0);

/** A control frame: one part, outside the data sequence. `peer` null addresses everyone. */
const controlFrame = (
    ctx: LinkContext,
    kind: 'presence' | 'ack' | 'bye',
    peer: Peer | null,
    msgId?: string,
): OutFrame => ({
    draft: {
        to: peer?.id ?? '',
        toEpoch: peer?.epoch ?? '',
        msgId: msgId ?? toHex(ctx.random(16)),
        part: 0,
        parts: 1,
        kind,
        // Presence tells the receiver this link reads batch events; an older link ignores the flag.
        ...(kind === 'presence' && ctx.batching ? { batch: true as const } : {}),
    },
    part: NO_BYTES,
});

/**
 * A frame's trip out: filled in, sealed, published. A failure is nobody's to answer — a data message
 * is sent again until acknowledged — except a presence, which is owed again for the next relay that opens.
 */
export const emitFrame = (ctx: LinkContext, frame: EmitFrame): Promise<void> => {
    const header: FrameHeader = { v: 1, from: ctx.selfId, epoch: ctx.epoch, ts: ctx.now(), ...frame.draft };
    return ctx.codec
        .seal(header, frame.part)
        .then((content) => ctx.io.publish(ctx.topic, content))
        .catch(() => {
            if (frame.draft.kind === 'presence') ctx.owedPresence.add(frame.draft.to);
        });
};

/** A batch's trip out: sealed and published. A failure is nobody's to answer: its parts are sent again until acknowledged, its acks when the message arrives again. */
export const emitBatch = (ctx: LinkContext, { to, toEpoch, acks, frames }: EmitBatch): Promise<void> => {
    const batch: Batch = {
        header: { v: 2, id: toHex(ctx.random(16)), from: ctx.selfId, to, toEpoch, epoch: ctx.epoch, ts: ctx.now() },
        acks,
        frames,
    };
    return ctx.codec
        .sealBatch(batch)
        .then((content) => ctx.io.publish(ctx.topic, content))
        .catch(() => undefined);
};

/**
 * A relay socket opened. The presence frames that found no relay open are sent again, once each.
 * A phone that knows no peer yet announces itself on every open too: the desktop may listen on
 * another relay than the one that was open first. The relay count bounds this; it is no retry loop.
 */
export const sendPresenceOnOpen = (ctx: LinkContext): void => {
    const targets = new Set(ctx.owedPresence);
    ctx.owedPresence.clear();
    if (ctx.role === 'phone' && ctx.peers.size === 0) targets.add('');
    for (const to of targets) sendPresence(ctx, ctx.peers.get(to) ?? null);
};

/** Presence to one peer, or to everyone with null. */
export const sendPresence = (ctx: LinkContext, peer: Peer | null): void =>
    ctx.outbox.sendControl(controlFrame(ctx, 'presence', peer));

/** How many messages to the peer are in flight: waiting to be packed, being packed, or started and not acknowledged. Messages queued and not started can still be taken back, so they are not in flight. */
export const inFlight = (ctx: LinkContext, peerId: string): number =>
    (ctx.sending.get(peerId) ?? 0) + ctx.outbox.startedMessages(peerId).length;

/** Calls the callbacks waiting for the peer to be idle, if it is: called when a message was acknowledged or finished packing. */
export const settleIfIdle = (ctx: LinkContext, peerId: string): void => {
    const waiters = ctx.idleWaiters.get(peerId);
    if (waiters === undefined || inFlight(ctx, peerId) !== 0) return;
    ctx.idleWaiters.delete(peerId);
    for (const callback of waiters) callback();
};

/** Whether the peer is sent batch events: this link batches, the peer said it reads them, and a batch between the two can be made (see `batchFits`). */
export const canBatch = (ctx: LinkContext, peerId: string): boolean =>
    ctx.batching && ctx.peers.get(peerId)?.batch === true && batchFits(ctx.selfId, peerId);

/** An ack rides in a batch to a peer that reads them, and leaves as its own frame to any other. */
export const sendAck = (ctx: LinkContext, peer: Peer, msgId: string): void =>
    canBatch(ctx, peer.id)
        ? ctx.outbox.sendBatchedAck(peer.id, peer.epoch, msgId)
        : ctx.outbox.sendControl(controlFrame(ctx, 'ack', peer, msgId));

/** A link `bye` to one peer. */
export const sendBye = (ctx: LinkContext, peer: Peer): void => ctx.outbox.sendControl(controlFrame(ctx, 'bye', peer));

/** The frame that tells every peer this link is going away; it leaves at once, outside the send budget. */
export const broadcastByeFrame = (ctx: LinkContext): EmitFrame => {
    const { draft, part } = controlFrame(ctx, 'bye', null);
    return { draft: { ...draft, seq: 0, stream: '' }, part };
};

const createPeer = (ctx: LinkContext, id: string, epoch: string, ts: number): Peer => ({
    id,
    epoch,
    lastSeen: ctx.now(),
    newestTs: ts,
    reassembler: createReassembler(),
    completed: new Map(),
    batch: false,
});

/** Ends a peer: forgets its streams and unacknowledged messages and reports the leave. `bye` tells the peer too. */
export const removePeer = (ctx: LinkContext, peer: Peer, bye: boolean, lost = 0): void => {
    ctx.peers.delete(peer.id);
    // A leave is a loss, reported by the leave event: nothing waits for the peer to be idle, and nothing is redirected for it.
    ctx.redirects.delete(peer.id);
    ctx.idleWaiters.delete(peer.id);
    ctx.streams.suspend(peer.id);
    // What was never acknowledged is told to the listeners: `lost` is a message the outbox gave up on just before, which it no longer holds.
    const unacked = lost + ctx.outbox.forgetPeer(peer.id);
    if (bye) sendBye(ctx, peer);
    for (const handler of ctx.leaveHandlers) handler(peer.id, unacked);
    ctx.onPeersChanged();
};

/**
 * Marks the sender of an accepted frame as present — a new peer, or one with a new epoch (a leave,
 * then a join) — and says whether it is new. A frame of another epoch than the live peer's counts
 * only if it is newer than anything accepted from that peer, so a replayed older one changes nothing
 * (null).
 */
export const admitPeer = (
    ctx: LinkContext,
    header: Pick<FrameHeader, 'from' | 'epoch' | 'ts'>,
): { peer: Peer; isNew: boolean } | null => {
    const known = ctx.peers.get(header.from);
    if (known?.epoch === header.epoch) {
        known.lastSeen = ctx.now();
        known.newestTs = Math.max(known.newestTs, header.ts);
        return { peer: known, isNew: false };
    }
    if (known && header.ts <= known.newestTs) return null;
    if (known) removePeer(ctx, known, false);
    const peer = createPeer(ctx, header.from, header.epoch, header.ts);
    ctx.peers.set(peer.id, peer);
    ctx.streams.admit(peer.id, peer.epoch);
    for (const handler of ctx.joinHandlers) handler(peer.id);
    ctx.onPeersChanged();
    return { peer, isNew: true };
};
