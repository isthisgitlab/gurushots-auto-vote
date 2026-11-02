/**
 * The receiving side's ordered inboxes, one per (sender, stream). A stream is what a sender numbers
 * from 0: it draws a fresh id when it starts sending to a peer and again after it forgets the peer
 * (`relayOutbox.ts`). The inboxes live here, not on the peer record, so they outlive the peer's
 * removal and re-admission: a receiver that dropped the sender for silence picks the same stream
 * up where it was, with no stall and no reset.
 *
 * A sender has one live stream, and a stream id that is new to the table does not simply replace it:
 * a replayed or straggling frame of an older stream (a relay can hand one over for five minutes, and
 * two instances of a restarted sender can finish unpacking in either order) would otherwise retire
 * the live stream, and every later message of it would be acknowledged and dropped. A new stream
 * retires the live one only when both hold — it comes from the epoch the sender was last admitted
 * with, and its frame is newer than anything accepted on the live stream; a sender draws a new stream
 * only after its older frames, so a replay of an older stream always carries an older timestamp.
 * Otherwise the new stream is born retired. Retired streams stay in the table as closed entries, so
 * a late frame of one is ignored and the link does not acknowledge it: its sender gives up through
 * its normal resend path and the session heals instead of black-holing.
 *
 * Memory is bounded, not exact. An entry is dropped once it has been unused for 600 s, but that is
 * checked lazily, on the next `inboxFor` call, so an idle table keeps what it has. A sender has at
 * most 32 entries (the least recently used goes first), and an inbox holds at most 32 finished
 * messages behind a gap and a few parked while the sender is away: about 32 × 33 messages a sender.
 */

import { createOrderedInbox } from './relayInbox';

import type { OrderedInbox } from './relayInbox';

/** An inbox nobody has used for this long is dropped (lazily, on the next call). */
export const STREAM_MEMORY_MS = 600_000;

/** The most streams kept per sender, retired ones included; the least recently used is dropped for a new one. */
export const MAX_STREAMS_PER_SENDER = 32;

type Entry = {
    readonly from: string;
    /** The epoch of the sender instance that started the stream. */
    readonly epoch: string;
    readonly inbox: OrderedInbox;
    usedAt: number;
    /** The newest timestamp of any message accepted on the stream: a new stream must be newer than this to replace it. */
    newestTs: number;
    /** A retired stream: its inbox is closed and stays in the table, so a late frame of it cannot start it over. */
    retired: boolean;
};

export type StreamTable = {
    /**
     * The inbox of one sender's stream, for a message whose completing frame came from `epoch` with
     * timestamp `ts`. A stream that is new to the table starts at sequence 0; it retires the sender's live
     * stream only if `epoch` is the one the sender was last admitted with and `ts` is newer than anything
     * accepted on the live stream, and is born retired (a closed inbox) otherwise. After `close` it is an
     * inert inbox that delivers nothing and arms no timer.
     */
    inboxFor: (from: string, stream: string, epoch: string, ts: number) => OrderedInbox;
    /** Whether the stream is one the table has retired: its frames are not acknowledged. */
    isRetired: (from: string, stream: string) => boolean;
    /** The sender is admitted (again) with `epoch`: streams of another epoch are retired, and the sender's live stream runs its gap timer again. */
    admit: (from: string, epoch: string) => void;
    /** The sender left: its live stream pauses, what it holds stays held. */
    suspend: (from: string) => void;
    close: () => void;
};

export const createStreamTable = (
    deliver: (from: string, message: unknown) => void,
    now: () => number,
): StreamTable => {
    /** Insertion order is least-recently-used first: a use moves its entry to the end. */
    const entries = new Map<string, Entry>();
    /**
     * The epoch each sender was last admitted with. The stream rule depends on it equalling the epoch of
     * the sender's frames at completion (`relayLinkFrames.ts` admits the peer first), and it is never
     * dropped while the table lives: a sender removed and admitted again with a new epoch overwrites it. If
     * peer removal ever starts to forget the entry, a sender's own streams would be born retired.
     */
    const epochs = new Map<string, string>();
    const keyOf = (from: string, stream: string): string => `${from}|${stream}`;
    let closed = false;
    /** What `inboxFor` answers after `close`: closed from the start, so nothing reaches `deliver`. */
    const inert = createOrderedInbox(deliver.bind(null, ''));
    inert.close();

    const drop = (key: string, entry: Entry): void => {
        entry.inbox.close();
        entries.delete(key);
    };

    const prune = (): void => {
        for (const [key, entry] of entries) {
            if (now() - entry.usedAt <= STREAM_MEMORY_MS) return;
            drop(key, entry);
        }
    };

    const retire = (entry: Entry): void => {
        entry.inbox.close();
        entry.retired = true;
    };

    const liveOf = (from: string): Entry | undefined => {
        for (const entry of entries.values()) if (entry.from === from && !entry.retired) return entry;
        return undefined;
    };

    return {
        inboxFor: (from, stream, epoch, ts) => {
            if (closed) return inert;
            prune();
            const key = keyOf(from, stream);
            let entry = entries.get(key);
            if (entry === undefined) {
                const live = liveOf(from);
                // A stream replaces the live one only if it is of the sender's current epoch and newer than it.
                const replaces = epochs.get(from) === epoch && (live === undefined || ts > live.newestTs);
                if (replaces && live !== undefined) retire(live);
                const own = [...entries].filter(([, old]) => old.from === from);
                if (own.length >= MAX_STREAMS_PER_SENDER) drop(own[0][0], own[0][1]);
                entry = {
                    from,
                    epoch,
                    inbox: createOrderedInbox((message) => deliver(from, message)),
                    usedAt: now(),
                    newestTs: ts,
                    retired: false,
                };
                if (!replaces) retire(entry);
            } else entries.delete(key);
            entry.usedAt = now();
            if (!entry.retired) entry.newestTs = Math.max(entry.newestTs, ts);
            entries.set(key, entry);
            return entry.inbox;
        },
        isRetired: (from, stream) => entries.get(keyOf(from, stream))?.retired ?? false,
        admit: (from, epoch) => {
            epochs.set(from, epoch);
            for (const entry of entries.values()) {
                if (entry.from !== from || entry.retired) continue;
                if (entry.epoch === epoch) entry.inbox.resume();
                else retire(entry);
            }
        },
        suspend: (from) => {
            for (const entry of entries.values()) if (entry.from === from && !entry.retired) entry.inbox.suspend();
        },
        close: () => {
            closed = true;
            epochs.clear();
            for (const [key, entry] of [...entries]) drop(key, entry);
        },
    };
};
