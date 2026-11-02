/**
 * The relay link's second event shape, the batch (`v: 2`): many data parts and message acks in one sealed event. Its
 * plaintext is a 2-byte header length, a JSON header, the two counts, the acks as raw ids, then each part as its
 * header and bytes. This module holds the format (its types, how big a batch may be, how it is written and read) and
 * nothing that seals or opens; `relayCodec.ts` does that. It imports only `relayWire.ts`, never the frame codec.
 */

import { isPlainObject } from '../plainObject';
import { isInteger } from '../numbers';
import {
    HEADER_LENGTH_BYTES,
    RELAY_HEADER_MAX_BYTES,
    RELAY_MAX_PARTS,
    RELAY_PART_BYTES,
    RELAY_PLAIN_MAX_BYTES,
    isBoundedId,
    isCount,
    isEpoch,
    joinBytes,
    toHex,
} from './relayWire';

/** The most data parts plus acks one batch carries; a receiver drops a batch with more. */
export const RELAY_BATCH_MAX_FRAMES = 64;

const ACK_ID_BYTES = 16;
const COUNT_BYTES = 2;
const BATCH_PART_LENGTH_BYTES = 2;

/**
 * The header of a batch event: the sender's identity and the receiver it was made for, carried once for every
 * item in it. `id` is 128 random bits in hex, new for every batch the sender makes: a receiver remembers it, so
 * a recorded batch cannot be handed back (a resend of a message travels in a batch with an id of its own).
 */
export type BatchHeader = { v: 2; id: string; from: string; to: string; toEpoch: string; epoch: string; ts: number };

/** One data part inside a batch: v1's per-frame fields without the sender's, plus the part's bytes. */
export type BatchFrame = { msgId: string; stream: string; seq: number; part: number; parts: number; bytes: Uint8Array };

/** A batch event: data parts, and the ids of the messages it acknowledges. */
export type Batch = { header: BatchHeader; acks: string[]; frames: BatchFrame[] };

const HEX_ZERO = '0'.repeat(32);

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The JSON header of a batch from `from` to `to` at its largest: counted in the UTF-8 bytes it is sent in, escapes included, with the largest other fields. */
const batchHeaderBytes = (from: string, to: string): number =>
    utf8(
        JSON.stringify({
            v: 2,
            id: HEX_ZERO,
            from,
            to,
            toEpoch: HEX_ZERO,
            epoch: HEX_ZERO,
            ts: Number.MAX_SAFE_INTEGER,
        }),
    ).length;

/**
 * What a batch from `from` to `to` may hold besides its base (the length prefix, the header and the two counts):
 * the sum of its acks and its parts' costs and bytes. A sender fills no more.
 */
export const batchBudgetBytes = (from: string, to: string): number =>
    RELAY_PLAIN_MAX_BYTES - (HEADER_LENGTH_BYTES + batchHeaderBytes(from, to) + COUNT_BYTES);

/** The bytes one data part costs around its raw bytes at the worst: two length prefixes and a header at the largest counts. */
export const RELAY_BATCH_FRAME_BYTES =
    HEADER_LENGTH_BYTES +
    JSON.stringify({
        msgId: HEX_ZERO,
        stream: HEX_ZERO,
        seq: 0xffffffff,
        part: RELAY_MAX_PARTS,
        parts: RELAY_MAX_PARTS,
    }).length +
    BATCH_PART_LENGTH_BYTES;

/**
 * Whether a batch from `from` to `to` can be made: it has room for one full part (RELAY_PART_BYTES) with that part's
 * own header. That also keeps its header within RELAY_HEADER_MAX_BYTES (a header that fits the room is far under the
 * limit), so it is the only rule. Ids of many multi-byte or escaped characters may fail it, and a peer that does is
 * sent single frames, whose rule is only the header limit.
 */
export const batchFits = (from: string, to: string): boolean =>
    batchBudgetBytes(from, to) >= RELAY_BATCH_FRAME_BYTES + RELAY_PART_BYTES;

/** The bytes one ack costs in a batch: the acknowledged id, raw. */
export const RELAY_BATCH_ACK_BYTES = ACK_ID_BYTES;

/** The header of a value the caller found to be an object that names version 2. */
export const parseBatchHeader = (value: Record<string, unknown>): BatchHeader | null => {
    const { id, from, to, toEpoch, epoch, ts } = value;
    return isEpoch(id) && isBoundedId(from) && isBoundedId(to) && isEpoch(toEpoch) && isEpoch(epoch) && isInteger(ts)
        ? { v: 2, id, from, to, toEpoch, epoch, ts }
        : null;
};

const parseBatchFrameHeader = (value: unknown): Omit<BatchFrame, 'bytes'> | null => {
    if (!isPlainObject(value)) return null;
    const { msgId, stream, seq, part, parts } = value;
    return isEpoch(msgId) &&
        isEpoch(stream) &&
        isCount(seq) &&
        isCount(part) &&
        isCount(parts) &&
        parts >= 1 &&
        parts <= RELAY_MAX_PARTS &&
        part < parts
        ? { msgId, stream, seq, part, parts }
        : null;
};

const lengthPrefix = (length: number): Uint8Array => Uint8Array.of(length >> 8, length & 0xff);

/** A batch as plaintext: header, the two counts, the acks as raw ids, then each part as its header and bytes. */
export const encodeBatch = ({ header, acks, frames }: Batch): Uint8Array => {
    const headerBytes = utf8(JSON.stringify(header));
    if (headerBytes.length > RELAY_HEADER_MAX_BYTES) throw new Error('relay batch header too long');
    if (acks.length + frames.length > RELAY_BATCH_MAX_FRAMES) throw new Error('relay batch has too many items');
    const chunks: Uint8Array[] = [
        lengthPrefix(headerBytes.length),
        headerBytes,
        Uint8Array.of(acks.length, frames.length),
        ...acks.map((id) =>
            Uint8Array.from({ length: ACK_ID_BYTES }, (_v, i) => parseInt(id.slice(2 * i, 2 * i + 2), 16)),
        ),
    ];
    for (const { bytes, ...frameHeader } of frames) {
        const frameHeaderBytes = utf8(JSON.stringify(frameHeader));
        chunks.push(lengthPrefix(frameHeaderBytes.length), frameHeaderBytes, lengthPrefix(bytes.length), bytes);
    }
    const plain = joinBytes(chunks);
    if (plain.length > RELAY_PLAIN_MAX_BYTES) throw new Error('relay batch too large');
    return plain;
};

/** Reads the items of a batch body; null for anything but exactly the layout `encodeBatch` writes within the limits. */
export const decodeBatchBody = (body: Uint8Array): Pick<Batch, 'acks' | 'frames'> | null => {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    let at = 0;
    const take = (length: number): Uint8Array => {
        if (at + length > body.length) throw new RangeError('batch body ends early');
        at += length;
        return body.subarray(at - length, at);
    };
    const takeLength = (): number => {
        take(2);
        return view.getUint16(at - 2);
    };
    try {
        const [ackCount, frameCount] = take(COUNT_BYTES);
        if (ackCount + frameCount === 0 || ackCount + frameCount > RELAY_BATCH_MAX_FRAMES) return null;
        const acks = Array.from({ length: ackCount }, () => toHex(take(ACK_ID_BYTES)));
        const frames: BatchFrame[] = [];
        for (let i = 0; i < frameCount; i++) {
            const headerLength = takeLength();
            if (headerLength > RELAY_HEADER_MAX_BYTES) return null;
            const frameHeader = parseBatchFrameHeader(JSON.parse(new TextDecoder().decode(take(headerLength))));
            const partLength = takeLength();
            if (frameHeader === null || partLength > RELAY_PART_BYTES) return null;
            frames.push({ ...frameHeader, bytes: take(partLength) });
        }
        return at === body.length ? { acks, frames } : null;
    } catch {
        return null; // cut short, or a header that is not JSON
    }
};
