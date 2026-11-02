/**
 * The sending half of the relay link: every frame leaves through one token bucket (the send
 * budget), control frames (presence, ack, bye) before data, and a data message is sent again
 * until the receiver acknowledges it. Under backlog the messages that carry log lines go
 * first. It seals and publishes nothing itself — `emit` does — so tests drive it with a clock
 * and fake timers alone.
 */

import { toHex } from './relayCodec';
import { createTokenBucket } from './relayGuards';

import type { FrameHeader } from './relayCodec';
import type { TokenBucket } from './relayGuards';

/** At most this many events leave the link per second (it stays well under the per-pubkey rate limits public relays apply). */
export const SEND_EVENTS_PER_SECOND = 8;

/** How long a message waits for its ack after its last part left, before it is sent again. */
export const RESEND_MS = 4_000;

/** How many times a message is sent again before the peer is given up on. */
export const MAX_RESENDS = 3;

/** Past this many queued frames the link is backlogged: queued log messages are dropped and new ones refused. */
export const BACKLOG_FRAMES = 16;

/** Past this many queued frames a send is refused outright. */
export const MAX_QUEUED_FRAMES = 400;

/** A header as the link drafts it: the outbox adds `seq` and `stream`, and `emit` adds `v`, `from`, `epoch` and `ts` when the frame leaves. */
type FrameDraft = Omit<FrameHeader, 'v' | 'from' | 'epoch' | 'ts' | 'seq' | 'stream'>;

export type OutFrame = { draft: FrameDraft; part: Uint8Array };

/** A frame as it leaves the budget: its draft with the stream and sequence number the outbox gave it. */
export type EmitFrame = { draft: FrameDraft & { seq: number; stream: string }; part: Uint8Array };

type OutMessage = {
    readonly msgId: string;
    readonly peerId: string;
    readonly frames: OutFrame[];
    readonly droppable: boolean;
    /** The message's stream and sequence number, taken when its first frame leaves: a message dropped before that never uses one, so the receiver sees no gap. */
    place: { seq: number; stream: string } | null;
    /** Frames of the current pass still to leave; the resend timer starts when it reaches zero. */
    remaining: number;
    /** Whether any frame of the message has left: a started message is never dropped. */
    started: boolean;
    resends: number;
    timer: ReturnType<typeof setTimeout> | null;
};

type Job = { out: OutFrame; message: OutMessage | null };

export type OutboxDeps = {
    now: () => number;
    /** Random bytes for stream ids. */
    random: (length: number) => Uint8Array;
    /** Seals and publishes one frame; the outbox does not wait for it. */
    emit: (frame: EmitFrame) => void;
    /** A message was never acknowledged: the peer is given up on. */
    giveUp: (peerId: string) => void;
};

export type Outbox = {
    /** Queues a presence, ack or bye frame ahead of all data. */
    sendControl: (frame: OutFrame) => void;
    /** Queues a message's frames; `droppable` marks one that carries log lines. Throws when the queue is full. */
    sendMessage: (peerId: string, msgId: string, frames: OutFrame[], droppable: boolean) => void;
    /** The peer acknowledged the message. */
    ack: (peerId: string, msgId: string) => void;
    /** Forgets everything still queued or unacknowledged for the peer. */
    forgetPeer: (peerId: string) => void;
    close: () => void;
};

/** What the outbox's functions share: the budget, the queues, the unacknowledged messages and each peer's stream. */
type OutboxState = {
    readonly deps: OutboxDeps;
    readonly bucket: TokenBucket;
    readonly messages: Map<string, OutMessage>;
    /** Each peer's current stream: its id and the next sequence number. A peer that is forgotten gets a new stream, starting at 0. */
    readonly streams: Map<string, { id: string; next: number }>;
    control: Job[];
    data: Job[];
    pumpTimer: ReturnType<typeof setTimeout> | null;
};

const removeMessage = (state: OutboxState, message: OutMessage): void => {
    state.messages.delete(message.msgId);
    if (message.timer !== null) globalThis.clearTimeout(message.timer);
    message.timer = null;
    state.data = state.data.filter((job) => job.message !== message);
};

const resendOrGiveUp = (state: OutboxState, message: OutMessage): void => {
    message.timer = null;
    if (message.resends >= MAX_RESENDS) {
        removeMessage(state, message);
        state.deps.giveUp(message.peerId);
        return;
    }
    message.resends += 1;
    message.remaining = message.frames.length;
    for (const out of message.frames) state.data.push({ out, message });
    kick(state);
};

const takePlace = (state: OutboxState, peerId: string): { seq: number; stream: string } => {
    let stream = state.streams.get(peerId);
    if (stream === undefined) {
        stream = { id: toHex(state.deps.random(16)), next: 0 };
        state.streams.set(peerId, stream);
    }
    return { seq: stream.next++, stream: stream.id };
};

function pump(state: OutboxState): void {
    state.pumpTimer = null;
    for (;;) {
        const job = state.control[0] ?? state.data[0];
        if (job === undefined) return;
        if (!state.bucket.tryTake()) {
            state.pumpTimer = globalThis.setTimeout(() => pump(state), state.bucket.msUntilToken());
            return;
        }
        if (state.control[0] === job) state.control.shift();
        else state.data.shift();
        const { message } = job;
        const place = message === null ? { seq: 0, stream: '' } : (message.place ??= takePlace(state, message.peerId));
        state.deps.emit({ draft: { ...job.out.draft, ...place }, part: job.out.part });
        if (message === null) continue;
        message.started = true;
        message.remaining -= 1;
        // The resend timer starts only once the last part has left the budget.
        if (message.remaining === 0)
            message.timer = globalThis.setTimeout(() => resendOrGiveUp(state, message), RESEND_MS);
    }
}

function kick(state: OutboxState): void {
    if (state.pumpTimer === null) pump(state);
}

const queued = (state: OutboxState): number => state.control.length + state.data.length;

const sendMessage = (
    state: OutboxState,
    peerId: string,
    msgId: string,
    frames: OutFrame[],
    droppable: boolean,
): void => {
    if (droppable && queued(state) >= BACKLOG_FRAMES) return; // backlog: log lines go first
    if (queued(state) + frames.length > MAX_QUEUED_FRAMES) throw new Error('relay send queue is full');
    const message: OutMessage = {
        msgId,
        peerId,
        frames,
        droppable,
        place: null,
        remaining: frames.length,
        started: false,
        resends: 0,
        timer: null,
    };
    state.messages.set(msgId, message);
    for (const out of frames) state.data.push({ out, message });
    if (queued(state) > BACKLOG_FRAMES) {
        for (const queuedMessage of state.messages.values()) {
            if (queuedMessage.droppable && !queuedMessage.started) removeMessage(state, queuedMessage);
        }
    }
    kick(state);
};

const closeOutbox = (state: OutboxState): void => {
    for (const message of state.messages.values()) removeMessage(state, message);
    state.streams.clear();
    state.control = [];
    state.data = [];
    if (state.pumpTimer !== null) globalThis.clearTimeout(state.pumpTimer);
    state.pumpTimer = null;
};

export const createOutbox = (deps: OutboxDeps): Outbox => {
    const state: OutboxState = {
        deps,
        bucket: createTokenBucket(SEND_EVENTS_PER_SECOND, 1, deps.now),
        messages: new Map(),
        streams: new Map(),
        control: [],
        data: [],
        pumpTimer: null,
    };

    return {
        sendControl: (frame) => {
            state.control.push({ out: frame, message: null });
            kick(state);
        },
        sendMessage: (peerId, msgId, frames, droppable) => sendMessage(state, peerId, msgId, frames, droppable),
        ack: (peerId, msgId) => {
            const message = state.messages.get(msgId);
            if (message?.peerId === peerId) removeMessage(state, message);
        },
        forgetPeer: (peerId) => {
            state.streams.delete(peerId);
            for (const message of state.messages.values()) {
                if (message.peerId === peerId) removeMessage(state, message);
            }
        },
        close: () => closeOutbox(state),
    };
};
