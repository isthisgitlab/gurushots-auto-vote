/**
 * The sending half of the relay link: every frame leaves through one token bucket (the send
 * budget), control frames (presence, ack, bye) before data, and a data message is sent again
 * until the receiver acknowledges it. Under backlog the messages that carry log lines go
 * first. To a peer that reads batch events, one budget token pays for a whole event: the data
 * parts queued for the peer and the acks owed to it leave together, and an ack waits a moment
 * for data to ride with. It seals and publishes nothing itself — `emit` and `emitBatch` do — so
 * tests drive it with a clock and fake timers alone.
 */

import { RELAY_BATCH_ACK_BYTES, RELAY_BATCH_FRAME_BYTES, RELAY_BATCH_MAX_FRAMES } from './relayBatchCodec';
import { toHex } from './relayWire';
import { createTokenBucket } from './relayGuards';

import type { FrameHeader } from './relayCodec';
import type { BatchFrame } from './relayBatchCodec';
import type { TokenBucket } from './relayGuards';

/** At most this many events leave the link per second (it stays well under the per-pubkey rate limits public relays apply). */
export const SEND_EVENTS_PER_SECOND = 8;

/** How long a message waits for its ack after its last part left, before it is sent again. */
export const RESEND_MS = 4_000;

/** How many times a message is sent again before the peer is given up on. */
export const MAX_RESENDS = 3;

/** How long an ack waits for data to ride with before it leaves alone. */
export const ACK_LINGER_MS = 50;

/** At most this many acks are owed to one peer at a time; past it the oldest is dropped (its sender sends the message again, and the duplicate is acknowledged again). */
export const MAX_OWED_ACKS = 512;

/** At most this many owed acks of a peer that stopped reading batches are sent as frames; the rest are dropped. */
export const MAX_RELEASED_ACKS = 8;

/** Past this many queued frames the link is backlogged: queued log messages are dropped and new ones refused. */
export const BACKLOG_FRAMES = 16;

/** Past this many queued frames a send is refused outright. */
export const MAX_QUEUED_FRAMES = 400;

/** A header as the link drafts it: the outbox adds `seq` and `stream`, and `emit` adds `v`, `from`, `epoch` and `ts` when the frame leaves. */
type FrameDraft = Omit<FrameHeader, 'v' | 'from' | 'epoch' | 'ts' | 'seq' | 'stream'>;

export type OutFrame = { draft: FrameDraft; part: Uint8Array };

/** A frame as it leaves the budget: its draft with the stream and sequence number the outbox gave it. */
export type EmitFrame = { draft: FrameDraft & { seq: number; stream: string }; part: Uint8Array };

/** A batch as it leaves the budget: the receiver it is for, the ids it acknowledges and the data parts with their stream and sequence numbers. */
export type EmitBatch = { to: string; toEpoch: string; acks: string[]; frames: BatchFrame[] };

type OutMessage = {
    readonly msgId: string;
    readonly peerId: string;
    readonly frames: OutFrame[];
    /** The message as the caller gave it: its frames hold packed gzip parts, so a message that moves to another path is sent from this. */
    readonly original: unknown;
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
    /** Seals and publishes one batch event; the outbox does not wait for it. */
    emitBatch: (batch: EmitBatch) => void;
    /** Whether the peer is sent batch events. */
    canBatch: (peerId: string) => boolean;
    /** The bytes a batch to the peer may hold besides its base (see `batchBudgetBytes`). */
    batchBudgetBytes: (peerId: string) => number;
    /** A message was never acknowledged: the peer is given up on. */
    giveUp: (peerId: string) => void;
    /** A message of the peer was acknowledged and is no longer waited for. */
    onAcked: (peerId: string) => void;
};

export type Outbox = {
    /** Queues a presence, ack or bye frame ahead of all data. */
    sendControl: (frame: OutFrame) => void;
    /** Queues a message's frames; `droppable` marks one that carries log lines; `original` is the message they were made from. Throws when the queue is full. */
    sendMessage: (peerId: string, msgId: string, frames: OutFrame[], droppable: boolean, original: unknown) => void;
    /** Owes the peer an ack for the message, in a batch: it leaves with the next data for the peer, or alone after ACK_LINGER_MS. */
    sendBatchedAck: (peerId: string, toEpoch: string, msgId: string) => void;
    /** The peer acknowledged the message. */
    ack: (peerId: string, msgId: string) => void;
    /** Forgets everything still queued or unacknowledged for the peer; answers how many messages that was. */
    forgetPeer: (peerId: string) => number;
    /** Takes back the peer's messages none of whose frames has left, in the order they were queued; they are no longer queued here. */
    takeUnstarted: (peerId: string) => unknown[];
    /** The peer's messages that have started leaving and are not acknowledged yet, as the caller gave them, in the order they were queued; they stay queued and are sent again. */
    startedMessages: (peerId: string) => unknown[];
    close: () => void;
};

/** What the outbox's functions share: the budget, the queues, the unacknowledged messages and each peer's stream. */
type OutboxState = {
    readonly deps: OutboxDeps;
    readonly bucket: TokenBucket;
    readonly messages: Map<string, OutMessage>;
    /** Each peer's current stream: its id and the next sequence number. A peer that is forgotten gets a new stream, starting at 0. */
    readonly streams: Map<string, { id: string; next: number }>;
    /** The acks owed to each peer in a batch, with the epoch they are for and when the oldest was owed. */
    readonly acks: Map<string, { toEpoch: string; ids: string[]; since: number }>;
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

/** What the next event is: a control frame, a batch for one peer, one data frame alone, or nothing until `ms` have passed. */
type Pick = { kind: 'control' | 'single' } | { kind: 'batch'; peerId: string } | { kind: 'wait'; ms: number } | null;

/**
 * Acks owed to a peer that no longer reads batches (its latest presence withdrew the flag) leave as single ack frames,
 * at most MAX_RELEASED_ACKS of them (the newest): the control queue goes ahead of all data, so a long list of owed
 * acks must not fill it. The rest are dropped; a lost ack only makes its sender send the message again.
 */
const releaseOwedAcks = (state: OutboxState): void => {
    for (const [peerId, owed] of state.acks) {
        if (state.deps.canBatch(peerId)) continue;
        for (const msgId of owed.ids.slice(-MAX_RELEASED_ACKS)) {
            const draft = { to: peerId, toEpoch: owed.toEpoch, msgId, part: 0, parts: 1, kind: 'ack' as const };
            state.control.push({ out: { draft, part: new Uint8Array(0) }, message: null });
        }
        state.acks.delete(peerId);
    }
};

const pickNext = (state: OutboxState): Pick => {
    releaseOwedAcks(state);
    if (state.control.length > 0) return { kind: 'control' };
    let wait = Infinity;
    for (const [peerId, owed] of state.acks) {
        const age = state.deps.now() - owed.since;
        if (age >= ACK_LINGER_MS) return { kind: 'batch', peerId };
        wait = Math.min(wait, ACK_LINGER_MS - age);
    }
    const head = state.data[0];
    if (head !== undefined) {
        const peerId = head.out.draft.to;
        return state.deps.canBatch(peerId) ? { kind: 'batch', peerId } : { kind: 'single' };
    }
    return wait === Infinity ? null : { kind: 'wait', ms: wait };
};

/** A frame of a message leaves: it takes its place on the first, and the resend timer starts when the last has left. */
const sentFrame = (state: OutboxState, job: Job): { seq: number; stream: string } => {
    const { message } = job;
    if (message === null) return { seq: 0, stream: '' };
    const place = (message.place ??= takePlace(state, message.peerId));
    message.started = true;
    message.remaining -= 1;
    if (message.remaining === 0) message.timer = globalThis.setTimeout(() => resendOrGiveUp(state, message), RESEND_MS);
    return place;
};

/**
 * Takes what one batch event for the peer holds: its owed acks first, then its queued data parts in order, while
 * the event has room. Null when nothing fits and no ack is owed: the caller then sends the head as a single frame.
 * The link never reaches this (`canBatch` requires `batchFits` over the same budget, which leaves room for a full
 * part); it is a guard for the contract of the injected `canBatch` and `batchBudgetBytes`, so one that disagrees
 * costs a frame, not a throw on every pump.
 */
const takeBatch = (state: OutboxState, peerId: string): EmitBatch | null => {
    const owed = state.acks.get(peerId);
    let slots = RELAY_BATCH_MAX_FRAMES;
    let budget = state.deps.batchBudgetBytes(peerId);
    const acks = owed?.ids.splice(0, slots) ?? [];
    if (owed?.ids.length === 0) state.acks.delete(peerId);
    slots -= acks.length;
    budget -= acks.length * RELAY_BATCH_ACK_BYTES;
    const taken: Job[] = [];
    for (const job of state.data) {
        if (job.out.draft.to !== peerId) continue;
        const cost = RELAY_BATCH_FRAME_BYTES + job.out.part.length;
        if (slots === 0 || cost > budget) break;
        taken.push(job);
        slots -= 1;
        budget -= cost;
    }
    if (owed === undefined && taken.length === 0) return null;
    const toEpoch = owed?.toEpoch ?? taken[0].out.draft.toEpoch;
    const leaving = new Set(taken);
    state.data = state.data.filter((job) => !leaving.has(job));
    const frames = taken.map((job): BatchFrame => {
        const { msgId, part, parts } = job.out.draft;
        return { msgId, part, parts, ...sentFrame(state, job), bytes: job.out.part };
    });
    return { to: peerId, toEpoch, acks, frames };
};

function pump(state: OutboxState): void {
    state.pumpTimer = null;
    for (;;) {
        const next = pickNext(state);
        if (next === null) return;
        if (next.kind === 'wait') {
            state.pumpTimer = globalThis.setTimeout(() => pump(state), next.ms);
            return;
        }
        if (!state.bucket.tryTake()) {
            state.pumpTimer = globalThis.setTimeout(() => pump(state), state.bucket.msUntilToken());
            return;
        }
        const batch = next.kind === 'batch' ? takeBatch(state, next.peerId) : null;
        if (batch !== null) {
            state.deps.emitBatch(batch);
            continue;
        }
        const job = (next.kind === 'control' ? state.control : state.data).shift() as Job; // a batch that took nothing sends the head alone
        state.deps.emit({ draft: { ...job.out.draft, ...sentFrame(state, job) }, part: job.out.part });
    }
}

/** Looks at the queues now: anything that is waiting on a timer is looked at again, since what arrived may change what leaves. */
function kick(state: OutboxState): void {
    if (state.pumpTimer !== null) globalThis.clearTimeout(state.pumpTimer);
    pump(state);
}

const queued = (state: OutboxState): number => state.control.length + state.data.length;

const sendMessage = (
    state: OutboxState,
    peerId: string,
    msgId: string,
    frames: OutFrame[],
    droppable: boolean,
    original: unknown,
): void => {
    if (droppable && queued(state) >= BACKLOG_FRAMES) return; // backlog: log lines go first
    if (queued(state) + frames.length > MAX_QUEUED_FRAMES) throw new Error('relay send queue is full');
    const message: OutMessage = {
        msgId,
        peerId,
        frames,
        original,
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
    state.acks.clear();
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
        acks: new Map(),
        control: [],
        data: [],
        pumpTimer: null,
    };

    return {
        sendControl: (frame) => {
            state.control.push({ out: frame, message: null });
            kick(state);
        },
        sendMessage: (peerId, msgId, frames, droppable, original) =>
            sendMessage(state, peerId, msgId, frames, droppable, original),
        sendBatchedAck: (peerId, toEpoch, msgId) => {
            const owed = state.acks.get(peerId);
            if (owed === undefined) state.acks.set(peerId, { toEpoch, ids: [msgId], since: deps.now() });
            else {
                owed.ids.push(msgId);
                if (owed.ids.length > MAX_OWED_ACKS) owed.ids.shift();
            }
            kick(state);
        },
        ack: (peerId, msgId) => {
            const message = state.messages.get(msgId);
            if (message?.peerId !== peerId) return;
            removeMessage(state, message);
            deps.onAcked(peerId);
        },
        forgetPeer: (peerId) => {
            state.streams.delete(peerId);
            state.acks.delete(peerId);
            let forgotten = 0;
            for (const message of state.messages.values()) {
                if (message.peerId !== peerId) continue;
                removeMessage(state, message);
                forgotten += 1;
            }
            return forgotten;
        },
        startedMessages: (peerId) => {
            const started: unknown[] = [];
            for (const message of state.messages.values())
                if (message.peerId === peerId && message.started) started.push(message.original);
            return started;
        },
        takeUnstarted: (peerId) => {
            const taken: unknown[] = [];
            for (const message of state.messages.values()) {
                if (message.peerId !== peerId || message.started) continue;
                removeMessage(state, message);
                taken.push(message.original);
            }
            return taken;
        },
        close: () => closeOutbox(state),
    };
};
