/**
 * The receiving half of one peer's relay stream: parts are joined into messages
 * (`createReassembler`), and messages are handed over in the order the sender numbered them
 * (`createOrderedInbox`). Neither touches crypto or the network. Dependency-light: only the
 * byte join of the codec.
 */

import { joinBytes } from './relayWire';

import type { FrameHeader } from './relayCodec';

/** The most unfinished messages kept per sender; the oldest is dropped for a new one. */
export const MAX_PARTIAL_MESSAGES = 8;

/** How long a missing message is waited for before the later ones are delivered without it. */
export const GAP_HOLD_MS = 10_000;

/**
 * The most finished messages held back behind a gap; past it the gap is skipped at once. A batch event carries up
 * to 64 messages, so 128 is two full batches: a lost batch leaves room for the batch after it and one more to wait
 * for its resend, instead of the later messages being delivered out of order. The limit is also a memory bound. A
 * held message is already unzipped and parsed and can be as large as MAX_PEER_MESSAGE_BYTES (2 MiB), so a stream
 * holds at most 128 × MAX_PEER_MESSAGE_BYTES (256 MiB), and only a paired key holder can send messages that large.
 * A larger limit multiplies that bound (512 would be about 1 GiB a stream).
 */
export const MAX_HELD_MESSAGES = 128;

export type Reassembler = {
    /** Adds one part; answers the message's stream, sequence number and gzipped bytes when that was its last missing part. */
    add: (header: FrameHeader, part: Uint8Array) => { stream: string; seq: number; bytes: Uint8Array } | null;
};

type PartialMessage = {
    stream: string;
    seq: number;
    parts: number;
    pieces: Array<Uint8Array | undefined>;
    have: number;
};

export const createReassembler = (): Reassembler => {
    const partials = new Map<string, PartialMessage>();
    return {
        add: (header, part) => {
            let partial = partials.get(header.msgId);
            if (partial === undefined) {
                if (partials.size >= MAX_PARTIAL_MESSAGES) partials.delete(partials.keys().next().value as string);
                partial = {
                    stream: header.stream,
                    seq: header.seq,
                    parts: header.parts,
                    pieces: Array.from<Uint8Array | undefined>({ length: header.parts }),
                    have: 0,
                };
                partials.set(header.msgId, partial);
            }
            // A part that contradicts the first one seen for this message, or one seen twice, adds nothing.
            if (
                partial.parts !== header.parts ||
                partial.seq !== header.seq ||
                partial.stream !== header.stream ||
                partial.pieces[header.part]
            )
                return null;
            partial.pieces[header.part] = part;
            partial.have += 1;
            if (partial.have < partial.parts) return null;
            partials.delete(header.msgId);
            return { stream: partial.stream, seq: partial.seq, bytes: joinBytes(partial.pieces as Uint8Array[]) };
        },
    };
};

/**
 * The most bytes all the inboxes of one link hold together, counted as the inflated size of each message (what gunzip
 * produced), not its gzipped size: the messages held behind gaps, and the messages parked for a sender that is away.
 * The count limit above bounds one inbox; this bounds the link, across every stream and sender. When a message brings
 * the total over it, parked messages go first: the suspended inbox with the most parked bytes loses its oldest parked
 * messages, until the total is under the cap. If it is still over, the inbox that holds the most bytes behind a gap
 * skips its gap (the missing messages are not waited for, and its held ones are delivered ahead of them, as the count
 * limit does), and so on. A parked message was never acknowledged: the ack goes only to a sender that is still joined,
 * and a message parks only while its sender is away. So a dropped one is not lost for good when the sender comes back
 * with the same epoch: it sends the message again (for as long as it keeps resending, MAX_RESENDS tries, about 12 s),
 * and the replay key was forgotten, so that copy is delivered once. A sender that comes back with a new epoch has its
 * old streams retired anyway, and one that never comes back (or gave up resending) loses the message; that loss is
 * accepted for a sender that left. Parsed objects take more memory than their serialized size.
 */
export const MAX_HELD_BYTES = 64 * 1024 * 1024;

/** What an inbox tells the budget about itself: the bytes it could give up now, and how to give them up. */
type HeldOwner = {
    /** The bytes it holds that skipping its gap would deliver: none while it is suspended or closed. */
    skippable: () => number;
    /** Skips its gap: delivers its held messages from the earliest one. */
    skip: () => void;
    /** The bytes parked for it while its sender is away: none once it is back or closed. */
    droppable: () => number;
    /** Drops its oldest parked message. */
    dropParked: () => void;
};

/** An inbox's side of the budget. */
type HeldMeter = {
    /** The inbox holds `delta` more bytes, held or parked (or fewer, when negative). */
    adjust: (delta: number) => void;
    /** Brings the link under the cap: drops parked messages, then skips gaps. Called when a message has been held or parked. */
    enforce: () => void;
    /** The inbox is closed. */
    leave: () => void;
};

/** What the inboxes of one link share: the total of the bytes they hold, held behind gaps and parked, and the cap on it. */
export type HeldBudget = {
    /** The inflated bytes held behind gaps and parked now, over every inbox of the link. */
    held: () => number;
    join: (owner: HeldOwner) => HeldMeter;
};

export const createHeldBudget = (cap: number = MAX_HELD_BYTES): HeldBudget => {
    const owners = new Set<HeldOwner>();
    let total = 0;
    return {
        held: () => total,
        join: (owner) => {
            owners.add(owner);
            return {
                adjust: (delta) => {
                    total += delta;
                },
                enforce: () => {
                    // The inbox with the most of what `score` counts, if it counts anything.
                    const largest = (score: (candidate: HeldOwner) => number): HeldOwner | undefined => {
                        let best: HeldOwner | undefined;
                        for (const candidate of owners)
                            if (score(candidate) > (best ? score(best) : 0)) best = candidate;
                        return best;
                    };
                    // First the messages parked for senders that are away: the largest such inbox loses its oldest first.
                    while (total > cap) {
                        const parked = largest((candidate) => candidate.droppable());
                        if (parked === undefined) break;
                        while (total > cap && parked.droppable() > 0) parked.dropParked();
                    }
                    // Then the gaps: the inbox that holds the most skips its gap. One that cannot deliver now (a
                    // suspended one, or one whose delivery just suspended it) is passed over; when none can, the
                    // link stays over the cap until something is released, and the loop ends.
                    while (total > cap) {
                        const held = largest((candidate) => candidate.skippable());
                        if (held === undefined) break;
                        held.skip();
                    }
                },
                leave: () => {
                    owners.delete(owner);
                },
            };
        },
    };
};

export type OrderedInbox = {
    /**
     * A finished message and its inflated size in bytes; null when its bytes could not be read — the slot is used up
     * and nothing is delivered. `forget` is called if the message is dropped while parked (the link's byte cap): the
     * caller then lets go of what it remembered about the message.
     */
    accept: (seq: number, item: { message: unknown } | null, size: number, forget: () => void) => void;
    /** The sender is not joined: no gap timer runs, and a message that finishes meanwhile is parked, not delivered. What is held stays held. */
    suspend: () => void;
    /** The sender is back: the parked messages are accepted in the order they finished, and the gap timer runs if anything is still held. */
    resume: () => void;
    /** Stops the gap timer; nothing more is delivered. */
    close: () => void;
};

type Item = { message: unknown };

/** A finished message waiting behind a gap, with its inflated size. */
type HeldMessage = { item: Item | null; size: number };

/** A finished message waiting for its sender to come back, with the callback that lets go of what the caller remembered about it. */
type ParkedMessage = { seq: number; item: Item | null; size: number; forget: () => void };

/** What the inbox's functions share: where it is in its stream, what it holds, and its side of the link's budget. */
type InboxState = {
    readonly deliver: (message: unknown) => void;
    /** The next sequence number to deliver. A stream starts at 0: a message numbered higher waits for the ones before it, or for the gap skip. */
    expected: number;
    closed: boolean;
    /** While suspended nothing is delivered and no timer runs. */
    suspended: boolean;
    /** The messages that finished while suspended, in the order they finished. */
    readonly parked: ParkedMessage[];
    /** The inflated bytes parked, reported to the link's budget too. */
    parkedBytes: number;
    readonly held: Map<number, HeldMessage>;
    /** The inflated bytes this inbox holds behind gaps, reported to the link's budget. */
    heldBytes: number;
    timer: ReturnType<typeof setTimeout> | null;
    readonly meter: HeldMeter;
};

const release = (state: InboxState, size: number): void => {
    state.heldBytes -= size;
    state.meter.adjust(-size);
};

/** Lets go of a message that was parked (it is delivered, accepted again or dropped): its bytes leave the parked count. */
const unpark = (state: InboxState, size: number): void => {
    state.parkedBytes -= size;
    state.meter.adjust(-size);
};

const stopTimer = (state: InboxState): void => {
    if (state.timer !== null) globalThis.clearTimeout(state.timer);
    state.timer = null;
};

function drain(state: InboxState): void {
    // A delivery can end the sender (its handler removes the peer), which suspends this inbox mid-drain.
    while (!state.closed && !state.suspended && state.held.has(state.expected)) {
        const { item, size } = state.held.get(state.expected) as HeldMessage;
        state.held.delete(state.expected);
        release(state, size);
        state.expected += 1;
        if (item) state.deliver(item.message);
    }
    stopTimer(state);
    if (state.held.size > 0 && !state.closed && !state.suspended) {
        state.timer = globalThis.setTimeout(() => skipGap(state), GAP_HOLD_MS);
    }
}

/**
 * The missing message did not come in time (or too many are held, or the link holds too many bytes): go on with the
 * earliest one held. The armed timer is stopped first: one that outlived the skip would fire later, with nothing
 * held or at a newer gap, and skip it early.
 */
function skipGap(state: InboxState): void {
    stopTimer(state);
    /* istanbul ignore if -- nothing held means the gap is gone: the timer is stopped whenever the last held message leaves, so no caller reaches this; it keeps a late call from setting `expected` to Infinity */
    if (state.held.size === 0) return;
    state.expected = Math.min(...state.held.keys());
    drain(state);
}

/** The bytes held behind gaps that skipping the gap would deliver: none while the inbox is suspended or closed. */
const skippableBytes = (state: InboxState): number => (state.closed || state.suspended ? 0 : state.heldBytes);

/** The bytes parked for a sender that is away: none once it is back or the inbox is closed. */
const droppableBytes = (state: InboxState): number => (state.closed || !state.suspended ? 0 : state.parkedBytes);

/** Drops the oldest parked message (the link's byte cap) and lets the caller forget it. */
const dropOldestParked = (state: InboxState): void => {
    const [dropped] = state.parked.splice(0, 1);
    unpark(state, dropped.size);
    dropped.forget();
};

const acceptMessage = (state: InboxState, seq: number, item: Item | null, size: number, forget: () => void): void => {
    if (state.closed) return;
    if (state.suspended) {
        state.parked.push({ seq, item, size, forget });
        state.parkedBytes += size;
        state.meter.adjust(size);
        state.meter.enforce(); // the link's cap may drop parked messages, this one included
        return;
    }
    if (seq < state.expected) {
        // A message that was skipped over arrives after all (its resend): late, but still delivered once.
        if (item) state.deliver(item.message);
        return;
    }
    const same = state.held.get(seq);
    if (same !== undefined) release(state, same.size); // the same message held twice counts once
    state.held.set(seq, { item, size });
    state.heldBytes += size;
    state.meter.adjust(size);
    if (seq === state.expected) drain(state);
    else if (state.held.size > MAX_HELD_MESSAGES) skipGap(state);
    else if (state.timer === null) state.timer = globalThis.setTimeout(() => skipGap(state), GAP_HOLD_MS);
    // The link's cap may make this inbox, or a larger one, skip its gap.
    state.meter.enforce();
};

const resumeInbox = (state: InboxState): void => {
    state.suspended = false;
    if (state.closed) return;
    drain(state);
    // Parked messages leave the parked count and are accepted again, which counts them as held (or delivers them).
    state.meter.adjust(-state.parkedBytes);
    state.parkedBytes = 0;
    for (const { seq, item, size, forget } of state.parked.splice(0)) acceptMessage(state, seq, item, size, forget);
};

const closeInbox = (state: InboxState): void => {
    state.closed = true;
    stopTimer(state);
    release(state, state.heldBytes);
    state.meter.adjust(-state.parkedBytes);
    state.parkedBytes = 0;
    state.meter.leave();
    state.held.clear();
    state.parked.length = 0;
};

export const createOrderedInbox = (deliver: (message: unknown) => void, budget: HeldBudget): OrderedInbox => {
    // The budget calls back into the inbox only after it is built, so the owner reads `state` lazily.
    const state: InboxState = {
        deliver,
        expected: 0,
        closed: false,
        suspended: false,
        parked: [],
        parkedBytes: 0,
        held: new Map(),
        heldBytes: 0,
        timer: null,
        meter: budget.join({
            skippable: () => skippableBytes(state),
            skip: () => skipGap(state),
            droppable: () => droppableBytes(state),
            dropParked: () => dropOldestParked(state),
        }),
    };
    return {
        accept: (seq, item, size, forget) => acceptMessage(state, seq, item, size, forget),
        suspend: () => {
            state.suspended = true;
            stopTimer(state);
        },
        resume: () => resumeInbox(state),
        close: () => closeInbox(state),
    };
};
