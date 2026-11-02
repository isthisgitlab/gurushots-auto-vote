/**
 * The receiving half of one peer's relay stream: parts are joined into messages
 * (`createReassembler`), and messages are handed over in the order the sender numbered them
 * (`createOrderedInbox`). Neither touches crypto or the network. Dependency-light: only the
 * byte join of the codec.
 */

import { joinBytes } from './relayCodec';

import type { FrameHeader } from './relayCodec';

/** The most unfinished messages kept per sender; the oldest is dropped for a new one. */
export const MAX_PARTIAL_MESSAGES = 8;

/** How long a missing message is waited for before the later ones are delivered without it. */
export const GAP_HOLD_MS = 10_000;

/** The most finished messages held back behind a gap; past it the gap is skipped at once. */
export const MAX_HELD_MESSAGES = 32;

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
                    pieces: new Array<Uint8Array | undefined>(header.parts),
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

export type OrderedInbox = {
    /** A finished message; null when its bytes could not be read — the slot is used up and nothing is delivered. */
    accept: (seq: number, item: { message: unknown } | null) => void;
    /** The sender is not joined: no gap timer runs, and a message that finishes meanwhile is parked, not delivered. What is held stays held. */
    suspend: () => void;
    /** The sender is back: the parked messages are accepted in the order they finished, and the gap timer runs if anything is still held. */
    resume: () => void;
    /** Stops the gap timer; nothing more is delivered. */
    close: () => void;
};

export const createOrderedInbox = (deliver: (message: unknown) => void): OrderedInbox => {
    /** The next sequence number to deliver. A stream starts at 0: a message numbered higher waits for the ones before it, or for the gap skip. */
    let expected = 0;
    let closed = false;
    /** While suspended nothing is delivered and no timer runs. */
    let suspended = false;
    /** The messages that finished while suspended, in the order they finished. */
    const parked: Array<[number, { message: unknown } | null]> = [];
    const held = new Map<number, { message: unknown } | null>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const stopTimer = (): void => {
        if (timer !== null) globalThis.clearTimeout(timer);
        timer = null;
    };

    const drain = (): void => {
        // A delivery can end the sender (its handler removes the peer), which suspends this inbox mid-drain.
        while (!closed && !suspended && held.has(expected)) {
            const item = held.get(expected);
            held.delete(expected);
            expected += 1;
            if (item) deliver(item.message);
        }
        stopTimer();
        if (held.size > 0 && !closed && !suspended) timer = globalThis.setTimeout(skipGap, GAP_HOLD_MS);
    };

    /** The missing message did not come in time (or too many are held): go on with the earliest one held. Only reached with a message held. */
    function skipGap(): void {
        timer = null;
        expected = Math.min(...held.keys());
        drain();
    }

    const accept = (seq: number, item: { message: unknown } | null): void => {
        if (closed) return;
        if (suspended) {
            parked.push([seq, item]);
            return;
        }
        if (seq < expected) {
            // A message that was skipped over arrives after all (its resend): late, but still delivered once.
            if (item) deliver(item.message);
            return;
        }
        held.set(seq, item);
        if (seq === expected) drain();
        else if (held.size > MAX_HELD_MESSAGES) skipGap();
        else if (timer === null) timer = globalThis.setTimeout(skipGap, GAP_HOLD_MS);
    };

    return {
        accept,
        suspend: () => {
            suspended = true;
            stopTimer();
        },
        resume: () => {
            suspended = false;
            if (closed) return;
            drain();
            for (const [seq, item] of parked.splice(0)) accept(seq, item);
        },
        close: () => {
            closed = true;
            stopTimer();
            held.clear();
            parked.length = 0;
        },
    };
};
