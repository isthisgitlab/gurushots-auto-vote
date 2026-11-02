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

export const createOutbox = (deps: OutboxDeps): Outbox => {
    const bucket = createTokenBucket(SEND_EVENTS_PER_SECOND, 1, deps.now);
    const messages = new Map<string, OutMessage>();
    /** Each peer's current stream: its id and the next sequence number. A peer that is forgotten gets a new stream, starting at 0. */
    const streams = new Map<string, { id: string; next: number }>();
    let control: Job[] = [];
    let data: Job[] = [];
    let pumpTimer: ReturnType<typeof setTimeout> | null = null;

    const removeMessage = (message: OutMessage): void => {
        messages.delete(message.msgId);
        if (message.timer !== null) globalThis.clearTimeout(message.timer);
        message.timer = null;
        data = data.filter((job) => job.message !== message);
    };

    const resendOrGiveUp = (message: OutMessage): void => {
        message.timer = null;
        if (message.resends >= MAX_RESENDS) {
            removeMessage(message);
            deps.giveUp(message.peerId);
            return;
        }
        message.resends += 1;
        message.remaining = message.frames.length;
        for (const out of message.frames) data.push({ out, message });
        kick();
    };

    function pump(): void {
        pumpTimer = null;
        for (;;) {
            const job = control[0] ?? data[0];
            if (job === undefined) return;
            if (!bucket.tryTake()) {
                pumpTimer = globalThis.setTimeout(pump, bucket.msUntilToken());
                return;
            }
            if (control[0] === job) control.shift();
            else data.shift();
            const { message } = job;
            const place = message === null ? { seq: 0, stream: '' } : (message.place ??= takePlace(message.peerId));
            deps.emit({ draft: { ...job.out.draft, ...place }, part: job.out.part });
            if (message === null) continue;
            message.started = true;
            message.remaining -= 1;
            // The resend timer starts only once the last part has left the budget.
            if (message.remaining === 0)
                message.timer = globalThis.setTimeout(() => resendOrGiveUp(message), RESEND_MS);
        }
    }

    const takePlace = (peerId: string): { seq: number; stream: string } => {
        let stream = streams.get(peerId);
        if (stream === undefined) {
            stream = { id: toHex(deps.random(16)), next: 0 };
            streams.set(peerId, stream);
        }
        return { seq: stream.next++, stream: stream.id };
    };

    function kick(): void {
        if (pumpTimer === null) pump();
    }

    const queued = (): number => control.length + data.length;

    return {
        sendControl: (frame) => {
            control.push({ out: frame, message: null });
            kick();
        },
        sendMessage: (peerId, msgId, frames, droppable) => {
            if (droppable && queued() >= BACKLOG_FRAMES) return; // backlog: log lines go first
            if (queued() + frames.length > MAX_QUEUED_FRAMES) throw new Error('relay send queue is full');
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
            messages.set(msgId, message);
            for (const out of frames) data.push({ out, message });
            if (queued() > BACKLOG_FRAMES) {
                for (const queuedMessage of [...messages.values()]) {
                    if (queuedMessage.droppable && !queuedMessage.started) removeMessage(queuedMessage);
                }
            }
            kick();
        },
        ack: (peerId, msgId) => {
            const message = messages.get(msgId);
            if (message?.peerId === peerId) removeMessage(message);
        },
        forgetPeer: (peerId) => {
            streams.delete(peerId);
            for (const message of [...messages.values()]) {
                if (message.peerId === peerId) removeMessage(message);
            }
        },
        close: () => {
            for (const message of [...messages.values()]) removeMessage(message);
            streams.clear();
            control = [];
            data = [];
            if (pumpTimer !== null) globalThis.clearTimeout(pumpTimer);
            pumpTimer = null;
        },
    };
};
