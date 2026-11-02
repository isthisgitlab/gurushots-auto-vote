/**
 * What one inbound relay event does. The checks run cheapest first and in a fixed order: the
 * decrypt cap, the seal (a wrong key drops here), our own echo, the addressee, the timestamp
 * window, the epoch we were addressed at, then the replay memory. Only a frame that passes all
 * of them touches the peer table.
 */

import { MAX_COMPLETED_PER_PEER, admitPeer, removePeer, sendAck, sendPresence } from './relayLinkState';

import type { FrameHeader } from './relayCodec';
import type { OrderedInbox } from './relayInbox';
import type { LinkContext } from './relayLinkState';

/** A frame is accepted only when its timestamp is within this of our clock; the replay memory lasts twice as long. */
export const FRAME_MAX_SKEW_MS = 300_000;

/** The replay memory: twice the acceptance span, so a frame accepted at the edge of the window is still remembered when it leaves it. */
export const REPLAY_MEMORY_MS = 2 * FRAME_MAX_SKEW_MS;

/** At most this many events are decrypted a second; the excess is dropped unread. */
export const DECRYPT_FRAMES_PER_SECOND = 50;

/** A duplicate of a finished message is acknowledged again at most this often (relays deliver one event up to three times). */
export const RE_ACK_MIN_MS = 1_000;

/** Whether a frame was made for this link instance at this moment. */
const isForUs = (ctx: LinkContext, header: FrameHeader): boolean => {
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

const finishMessage = async (
    ctx: LinkContext,
    inbox: OrderedInbox,
    finished: { seq: number; bytes: Uint8Array },
): Promise<void> => {
    const item = await ctx.codec.unpack(finished.bytes);
    // The link may have been left while the bytes were being unpacked: nothing is delivered. (The inbox is
    // closed then too; this also keeps a message from being handed to it at all.)
    if (ctx.closed) return;
    inbox.accept(finished.seq, item);
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
    // The inbox is found now, when the message is complete — not after its bytes are unpacked, when an
    // older instance's message and a restarted one's could arrive in either order. The stream rule
    // (relayStreams.ts) decides here whether this is the live stream: a stray frame of an older stream is
    // neither remembered nor acknowledged, so its sender gives up through its normal resend path.
    const inbox = ctx.streams.inboxFor(peer.id, finished.stream, header.epoch, header.ts);
    if (ctx.streams.isRetired(peer.id, finished.stream)) return;
    ctx.seen.add(replayKeyOf(header));
    peer.completed.set(header.msgId, ctx.now());
    if (peer.completed.size > MAX_COMPLETED_PER_PEER)
        peer.completed.delete(peer.completed.keys().next().value as string);
    sendAck(ctx, peer, header.msgId);
    void finishMessage(ctx, inbox, finished);
};

/** Handles one event `content`. Resolves when the frame has been dealt with; never rejects. */
export const handleContent = async (ctx: LinkContext, content: string): Promise<void> => {
    if (ctx.closed || !ctx.decryptBudget.tryTake()) return;
    const opened = await ctx.codec.open(content);
    if (opened === null || ctx.closed || !isForUs(ctx, opened.header)) return;
    const { header, part } = opened;
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
    if (isNew) sendPresence(ctx, peer);
    if (header.kind === 'ack') ctx.outbox.ack(peer.id, header.msgId);
};
