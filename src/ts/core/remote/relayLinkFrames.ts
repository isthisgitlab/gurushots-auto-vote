/**
 * What one inbound relay event does. The checks run cheapest first and in a fixed order: the
 * decrypt cap, the seal (a wrong key drops here), our own echo, the addressee, the timestamp
 * window, the epoch we were addressed at, then the replay memory. Only a frame that passes all
 * of them touches the peer table.
 *
 * A batch event takes the same checks once for the whole event, in the same order, and the replay
 * memory holds its id: a batch seen before is dropped whole, before it can touch the peer table.
 * Each part and ack in an accepted batch then takes the path its own frame would have taken, and a
 * data message that finishes (in a batch or a frame) is charged to the finished-message budget and
 * then queued for its unzip (at most a few run at once, `relayInflate.ts`); it is dropped unread, not
 * remembered and not acknowledged, when the budget is spent or the queue is full, and a copy of a
 * message that is already queued or being unzipped is dropped the same way. Only a message whose unzip
 * and parse have finished is remembered and acknowledged.
 */

import { MAX_COMPLETED_PER_PEER, admitPeer, removePeer, sendAck, sendPresence } from './relayLinkState';

import type { FrameHeader } from './relayCodec';
import type { Batch } from './relayBatchCodec';
import type { OrderedInbox } from './relayInbox';
import type { LinkContext, Peer } from './relayLinkState';

/** A frame is accepted only when its timestamp is within this of our clock; the replay memory lasts twice as long. */
export const FRAME_MAX_SKEW_MS = 300_000;

/** The replay memory: twice the acceptance span, so a frame accepted at the edge of the window is still remembered when it leaves it. */
export const REPLAY_MEMORY_MS = 2 * FRAME_MAX_SKEW_MS;

/** At most this many events are decrypted a second; the excess is dropped unread. */
export const DECRYPT_FRAMES_PER_SECOND = 50;

/** At most this many data messages finish a second (a batch event can finish many for one decrypt); the excess is dropped unread, and its sender sends it again. */
export const FINISHED_MESSAGES_PER_SECOND = 200;

/**
 * The burst of that budget, sized for one full startup of the phone's page: an account with 30 or more
 * challenges sends 330 or more invokes at once, and 512 is one second of full batches (8 events of 64).
 */
export const FINISHED_MESSAGES_BURST = 512;

/**
 * The replay memory holds at most this many entries; past it the oldest goes. Live entries are never evicted: an
 * entry lives REPLAY_MEMORY_MS, and every entry comes from a budgeted source. Each decrypted event adds at most one
 * key (a batch key or one frame key), and each finished data message adds one, so the memory never holds more than
 * (DECRYPT_FRAMES_PER_SECOND + FINISHED_MESSAGES_PER_SECOND) * REPLAY_MEMORY_MS / 1000, plus the two burst
 * allowances, which is 150 562 and under this cap. (The acks of a batch add no keys: an ack repeated is harmless.)
 */
export const REPLAY_MEMORY_MAX_ENTRIES = 262_144;

/** A duplicate of a finished message is acknowledged again at most this often (relays deliver one event up to three times). */
export const RE_ACK_MIN_MS = 1_000;

/** Whether a frame was made for this link instance at this moment. */
const isForUs = (ctx: LinkContext, header: Pick<FrameHeader, 'kind' | 'from' | 'to' | 'toEpoch' | 'ts'>): boolean => {
    if (header.from === ctx.selfId) return false; // our own echo
    const broadcast = header.kind === 'presence' || header.kind === 'bye';
    if (header.to !== ctx.selfId && !(broadcast && header.to === '')) return false;
    if (Math.abs(ctx.now() - header.ts) > FRAME_MAX_SKEW_MS) return false;
    // A data or ack frame is bound to the receiver's epoch: one recorded before a restart never matches.
    return broadcast || header.toEpoch === ctx.epoch;
};

/** A finished message that arrives again: its ack was lost, or a second relay delivered it. */
const acknowledgeAgain = (ctx: LinkContext, header: FrameHeader): void => {
    const peer = ctx.peers.get(header.from);
    if (header.kind !== 'data' || peer?.epoch !== header.epoch) return;
    const acknowledgedAt = peer.completed.get(header.msgId);
    if (acknowledgedAt === undefined || ctx.now() - acknowledgedAt < RE_ACK_MIN_MS) return;
    peer.completed.set(header.msgId, ctx.now());
    peer.lastSeen = ctx.now();
    sendAck(ctx, peer, header.msgId);
};

/**
 * Unzips and parses a finished message, then remembers it, acknowledges it and hands it to its inbox: the ack
 * follows the work, never comes before it. The link may have been left while the bytes were being unpacked:
 * nothing is remembered, acknowledged or delivered then. (The inbox is closed too; this also keeps a message
 * from being handed to it at all.) An ack goes only to the peer that is still joined: one that left meanwhile
 * has no use for it, and its message waits in the inbox for the peer to come back.
 */
const finishMessage = async (
    ctx: LinkContext,
    peer: Peer,
    inbox: OrderedInbox,
    replayKey: string,
    finished: { seq: number; msgId: string; bytes: Uint8Array },
): Promise<void> => {
    const item = await ctx.codec.unpack(finished.bytes);
    if (ctx.closed) return;
    ctx.seen.add(replayKey);
    // The peer that is joined now under this id, if it is the same sender instance (the same epoch): it may have
    // left and come back while the bytes were being unpacked, and then it is a new record that must hear the ack.
    const joined = ctx.peers.get(peer.id);
    if (joined?.epoch === peer.epoch) {
        joined.completed.set(finished.msgId, ctx.now());
        if (joined.completed.size > MAX_COMPLETED_PER_PEER)
            joined.completed.delete(joined.completed.keys().next().value as string);
        sendAck(ctx, joined, finished.msgId);
    }
    // A message dropped while parked (the link's byte cap) is forgotten: it was never acknowledged (its sender was away),
    // so the sender resends it when it returns, and that copy must be delivered, not dropped as a replay.
    inbox.accept(finished.seq, item, item?.size ?? 0, () => ctx.seen.delete(replayKey));
};

/**
 * The replay memory's key. A data message is remembered once it is finished, not per part: the
 * reassembler already ignores a part it holds, and a part of a message whose partial was evicted
 * must still be accepted when its sender sends it again.
 */
const replayKeyOf = (header: FrameHeader): string =>
    header.kind === 'data'
        ? `data|${header.from}|${header.msgId}`
        : `${header.kind}|${header.from}|${header.msgId}|${header.part}`;

const receiveData = (ctx: LinkContext, header: FrameHeader, part: Uint8Array): void => {
    const admitted = admitPeer(ctx, header);
    if (admitted === null) return;
    const { peer, isNew } = admitted;
    if (isNew) sendPresence(ctx, peer);
    const finished = peer.reassembler.add(header, part);
    if (finished === null) return;
    // A message that is queued or being unzipped is in progress: a copy that arrives meanwhile (its sender
    // sent it again) is not queued a second time, and is delivered once.
    const replayKey = replayKeyOf(header);
    if (ctx.inflater.has(replayKey)) return;
    // Over the finished-message budget, or with the inflation queue full: dropped unread, neither remembered
    // nor acknowledged, so its sender sends it again. The budget is asked first, and before any stream state is
    // touched: a message that is dropped here changes no stream or inbox.
    if (!ctx.finishedBudget.tryTake() || ctx.inflater.isFull()) return;
    // The inbox is found now, when the message is complete — not after its bytes are unpacked, when an
    // older instance's message and a restarted one's could arrive in either order. The stream rule
    // (relayStreams.ts) decides here whether this is the live stream: a stray frame of an older stream is
    // neither remembered nor acknowledged, so its sender gives up through its normal resend path.
    const inbox = ctx.streams.inboxFor(peer.id, finished.stream, header.epoch, header.ts);
    if (ctx.streams.isRetired(peer.id, finished.stream)) return;
    ctx.inflater.add(replayKey, () => finishMessage(ctx, peer, inbox, replayKey, { ...finished, msgId: header.msgId }));
};

/**
 * A batch event: the same checks as a frame's, made once for the whole event (a batch that is not for
 * us is dropped whole), then each ack and each data part takes the path its own frame would have taken.
 * A link with batching off reads none: it stands in for a link that predates them.
 */
const handleBatch = (ctx: LinkContext, { header, acks, frames }: Batch): void => {
    if (!ctx.batching || !isForUs(ctx, { ...header, kind: 'data' })) return;
    // A batch seen before is dropped whole, before it can admit a peer that has since left.
    const batchKey = `batch|${header.from}|${header.id}`;
    if (ctx.seen.has(batchKey)) return;
    const admitted = admitPeer(ctx, header);
    if (admitted === null) return;
    ctx.seen.add(batchKey);
    const { peer, isNew } = admitted;
    peer.batch = true; // it wrote a batch, so it reads them
    if (isNew) sendPresence(ctx, peer);
    // A batched ack adds no replay key: the batch key already blocks a batch handed back, and an ack repeated
    // is harmless (the outbox ignores an id it no longer holds), so these cannot crowd out a live key.
    for (const msgId of acks) ctx.outbox.ack(peer.id, msgId);
    for (const { bytes, ...frame } of frames) {
        const full: FrameHeader = { ...header, ...frame, v: 1, kind: 'data' };
        if (ctx.seen.has(replayKeyOf(full))) acknowledgeAgain(ctx, full);
        else receiveData(ctx, full, bytes);
    }
};

/** Handles one event `content`. Resolves when the frame has been dealt with; never rejects. */
export const handleContent = async (ctx: LinkContext, content: string): Promise<void> => {
    if (ctx.closed || !ctx.decryptBudget.tryTake()) return;
    const opened = await ctx.codec.open(content);
    if (opened === null || ctx.closed) return;
    if ('batch' in opened) {
        handleBatch(ctx, opened.batch);
        return;
    }
    const { header, part } = opened;
    if (!isForUs(ctx, header)) return;
    const replayKey = replayKeyOf(header);
    if (ctx.seen.has(replayKey)) {
        acknowledgeAgain(ctx, header);
        return;
    }
    if (header.kind !== 'data') ctx.seen.add(replayKey);
    if (header.kind === 'bye') {
        // A bye counts only for the epoch we know the peer by: a recorded one cannot end a restarted peer.
        const peer = ctx.peers.get(header.from);
        if (peer?.epoch === header.epoch) removePeer(ctx, peer, false);
        return;
    }
    if (header.kind === 'data') {
        receiveData(ctx, header, part);
        return;
    }
    const admitted = admitPeer(ctx, header);
    if (admitted === null) return;
    const { peer, isNew } = admitted;
    if (header.kind === 'presence') peer.batch = header.batch === true; // its latest word on what it reads
    if (isNew) sendPresence(ctx, peer);
    if (header.kind === 'ack') ctx.outbox.ack(peer.id, header.msgId);
};
