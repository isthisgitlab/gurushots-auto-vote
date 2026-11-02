/**
 * The relay link's wire format: what one Nostr event's `content` carries. A protocol message
 * becomes JSON, is gzipped once, split into parts, and each part is sealed on its own with
 * AES-GCM (a key derived from the pairing key, a fresh random IV per part) and written as
 * base64url. The plaintext of a part is binary — a 2-byte header length, a JSON header, the raw
 * part bytes — so nothing is base64-encoded twice. A second event shape, the batch (`v: 2`), carries
 * many data parts and message acks in one sealed event; it goes only to a peer that advertised it
 * (the `batch` flag on its presence), so a peer of the first shape never sees one. It depends on WebCrypto,
 * `CompressionStream` and `DecompressionStream`; the link takes them through `RelayCodec`, so its
 * own tests run on a stub.
 */

import { isPlainObject } from '../plainObject';
import { isInteger } from '../numbers';
import { decodeBatchBody, encodeBatch, parseBatchHeader } from './relayBatchCodec';
import { MAX_PEER_MESSAGE_BYTES } from './protocol';
import {
    AES_IV_BYTES,
    AES_TAG_BYTES,
    HEADER_LENGTH_BYTES,
    MAX_HEADER_ID_LENGTH,
    RELAY_HEADER_MAX_BYTES,
    RELAY_MAX_PARTS,
    RELAY_PART_BYTES,
    isBoundedId,
    isCount,
    isEpoch,
    joinBytes,
} from './relayWire';

import type { Batch } from './relayBatchCodec';

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const KEY_INFO = 'gs-relay-v1';

type FrameKind = 'data' | 'presence' | 'ack' | 'bye';

const FRAME_KINDS: ReadonlySet<string> = new Set<FrameKind>(['data', 'presence', 'ack', 'bye']);

/**
 * The header every sealed frame carries inside its ciphertext. `to` is '' for a broadcast
 * (presence, bye). `toEpoch` is the epoch of the receiver the frame was made for ('' when the
 * sender does not know it yet); `epoch` is the sender's own. `msgId` is 128 random bits in hex.
 * `stream` names the ordered stream a data frame belongs to — 128 random bits the sender draws when it
 * starts sending to a peer, and again after it forgets the peer — so a receiver keeps one ordered inbox
 * per (sender, stream); it is '' on every other kind. `batch` is the capability flag a presence frame
 * carries when its sender reads batch events (`v: 2`); no other kind has it.
 */
export type FrameHeader = {
    v: 1;
    from: string;
    to: string;
    toEpoch: string;
    epoch: string;
    msgId: string;
    stream: string;
    seq: number;
    part: number;
    parts: number;
    ts: number;
    kind: FrameKind;
    batch?: true;
};

/** What opening an event content yields: one v1 frame, or a v2 batch. */
type Opened = { header: FrameHeader; part: Uint8Array } | { batch: Batch };

/** What the link needs of the wire format: seal/open one frame, pack/unpack one message. */
export type RelayCodec = {
    /** Seals one part under its header into an event `content`. Rejects a header over RELAY_HEADER_MAX_BYTES. */
    seal: (header: FrameHeader, part: Uint8Array) => Promise<string>;
    /** Seals a batch into an event `content`. Rejects a header over RELAY_HEADER_MAX_BYTES, more than RELAY_BATCH_MAX_FRAMES items, or a plaintext over RELAY_PLAIN_MAX_BYTES. */
    sealBatch: (batch: Batch) => Promise<string>;
    /** Opens an event `content`; null when it is not ours (wrong key, damaged, malformed header or batch). */
    open: (content: string) => Promise<Opened | null>;
    /** A message as the gzipped bytes that get split into parts. */
    pack: (message: unknown) => Promise<Uint8Array>;
    /** The message the gzipped bytes hold and its inflated size in bytes (what gunzip produced); null when they are damaged or inflate past MAX_PEER_MESSAGE_BYTES. */
    unpack: (bytes: Uint8Array) => Promise<{ message: unknown; size: number } | null>;
};

/** Random bytes from the platform's CSPRNG; the link takes the source as an argument so tests can fix it. */
export const cryptoRandom = (length: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(length));

export const bytesToBase64Url = (bytes: Uint8Array): string => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

/** The bytes of a base64url string; null when it is not one. */
export const base64UrlToBytes = (text: string): Uint8Array | null => {
    if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

/** Splits bytes into parts of at most `size` bytes; empty input is one empty part. */
export const splitBytes = (bytes: Uint8Array, size: number): Uint8Array[] => {
    const parts: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += size) parts.push(bytes.subarray(at, at + size));
    return parts.length === 0 ? [new Uint8Array(0)] : parts;
};

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
};

/** Inflates gzip bytes, stopping at `limit` inflated bytes: null past it, and for damaged input. */
const gunzipBounded = async (bytes: Uint8Array, limit: number): Promise<Uint8Array | null> => {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > limit) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    } catch {
        return null; // damaged gzip data
    }
    return joinBytes(chunks);
};

/** The header a parsed JSON value is, or null: every field checked, nothing trusted. */
export const parseHeader = (value: unknown): FrameHeader | null => {
    if (!isPlainObject(value) || value.v !== 1) return null;
    const { from, to, toEpoch, epoch, msgId, stream, seq, part, parts, ts, kind } = value;
    const valid =
        isBoundedId(from) &&
        typeof to === 'string' &&
        to.length <= MAX_HEADER_ID_LENGTH &&
        (toEpoch === '' || isEpoch(toEpoch)) &&
        isEpoch(epoch) &&
        isEpoch(msgId) &&
        isCount(seq) &&
        isCount(part) &&
        isCount(parts) &&
        parts >= 1 &&
        parts <= RELAY_MAX_PARTS &&
        part < parts &&
        isInteger(ts) &&
        typeof kind === 'string' &&
        FRAME_KINDS.has(kind) &&
        typeof stream === 'string' &&
        (kind === 'data' ? isEpoch(stream) : stream === '');
    if (!valid) return null;
    const header: FrameHeader = {
        v: 1,
        from,
        to,
        toEpoch,
        epoch,
        msgId,
        stream,
        seq,
        part,
        parts,
        ts,
        kind: kind as FrameKind,
    };
    // The capability flag counts on a presence frame only; on any other kind it is not read.
    return kind === 'presence' && value.batch === true ? { ...header, batch: true } : header;
};

const deriveKey = async (pairingKey: string): Promise<CryptoKey> => {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pairingKey), 'HKDF', false, [
        'deriveKey',
    ]);
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(KEY_INFO) },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
};

/** The codec over one pairing key. It derives a non-extractable AES key from it and seals and opens with that key alone. */
export const createRelayCodec = (
    pairingKey: string,
    random: (length: number) => Uint8Array = cryptoRandom,
): RelayCodec => {
    const key = deriveKey(pairingKey);
    const sealPlain = async (plain: Uint8Array): Promise<string> => {
        const iv = random(AES_IV_BYTES);
        const sealed = new Uint8Array(
            await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await key, plain as BufferSource),
        );
        return bytesToBase64Url(joinBytes([iv, sealed]));
    };
    return {
        seal: async (header, part) => {
            const headerBytes = new TextEncoder().encode(JSON.stringify(header));
            if (headerBytes.length > RELAY_HEADER_MAX_BYTES) throw new Error('relay frame header too long');
            const plain = new Uint8Array(HEADER_LENGTH_BYTES + headerBytes.length + part.length);
            new DataView(plain.buffer).setUint16(0, headerBytes.length);
            plain.set(headerBytes, HEADER_LENGTH_BYTES);
            plain.set(part, HEADER_LENGTH_BYTES + headerBytes.length);
            return sealPlain(plain);
        },
        sealBatch: async (batch) => sealPlain(encodeBatch(batch)),
        open: async (content) => {
            const bytes = base64UrlToBytes(content);
            if (bytes === null || bytes.length < AES_IV_BYTES + AES_TAG_BYTES + HEADER_LENGTH_BYTES) return null;
            let plain: Uint8Array;
            try {
                plain = new Uint8Array(
                    await crypto.subtle.decrypt(
                        { name: 'AES-GCM', iv: new Uint8Array(bytes.subarray(0, AES_IV_BYTES)) },
                        await key,
                        new Uint8Array(bytes.subarray(AES_IV_BYTES)),
                    ),
                );
            } catch {
                return null; // not sealed under this pairing key, or damaged
            }
            const headerLength = new DataView(plain.buffer).getUint16(0);
            if (headerLength > RELAY_HEADER_MAX_BYTES || HEADER_LENGTH_BYTES + headerLength > plain.length) return null;
            let parsed: unknown;
            try {
                parsed = JSON.parse(
                    new TextDecoder().decode(plain.subarray(HEADER_LENGTH_BYTES, HEADER_LENGTH_BYTES + headerLength)),
                );
            } catch {
                return null;
            }
            const rest = plain.subarray(HEADER_LENGTH_BYTES + headerLength);
            if (isPlainObject(parsed) && parsed.v === 2) {
                const header = parseBatchHeader(parsed);
                const items = header === null ? null : decodeBatchBody(rest);
                return header === null || items === null ? null : { batch: { header, ...items } };
            }
            const header = parseHeader(parsed);
            return header === null || rest.length > RELAY_PART_BYTES ? null : { header, part: rest };
        },
        pack: (message) => gzip(new TextEncoder().encode(JSON.stringify(message))),
        unpack: async (bytes) => {
            const inflated = await gunzipBounded(bytes, MAX_PEER_MESSAGE_BYTES);
            if (inflated === null) return null;
            try {
                return { message: JSON.parse(new TextDecoder().decode(inflated)) as unknown, size: inflated.length };
            } catch {
                return null;
            }
        },
    };
};
