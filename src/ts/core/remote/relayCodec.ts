/**
 * The relay link's wire format: what one Nostr event's `content` carries. A protocol message
 * becomes JSON, is gzipped once, split into parts, and each part is sealed on its own with
 * AES-GCM (a key derived from the pairing key, a fresh random IV per part) and written as
 * base64url. The plaintext of a part is binary — a 2-byte header length, a JSON header, the raw
 * part bytes — so nothing is base64-encoded twice. It depends on WebCrypto,
 * `CompressionStream` and `DecompressionStream`; the link takes them through `RelayCodec`, so its
 * own tests run on a stub.
 */

import { isPlainObject } from '../plainObject';
import { isInteger } from '../numbers';
import { MAX_PEER_MESSAGE_BYTES } from './protocol';

/**
 * The most bytes one event frame (`["EVENT",{…}]`, the string a relay receives) may take. Pinned by
 * the live gate (2026-11-01): every relay in `NOSTR_RELAY_URLS` answered `OK true` to a signed
 * ephemeral event of exactly this size.
 */
export const RELAY_EVENT_MAX_BYTES = 48_000;

/**
 * The bytes of an event frame around its `content` (trystero's `createEvent`: a 5-digit kind, one
 * `x` tag holding the 64-hex topic, a 10-digit `created_at`, the pubkey, the id and the signature).
 * Measured on the real `createEvent`: 428 for an empty content.
 */
export const RELAY_EVENT_OVERHEAD_BYTES = 428;

/** The longest `content` an event may carry: base64url is ASCII, so characters are bytes. */
export const RELAY_CONTENT_MAX_BYTES = RELAY_EVENT_MAX_BYTES - RELAY_EVENT_OVERHEAD_BYTES;

/** The longest JSON header a frame may carry; a sender refuses a longer one, a receiver drops it. */
export const RELAY_HEADER_MAX_BYTES = 512;

const AES_IV_BYTES = 12;
const AES_TAG_BYTES = 16;
const HEADER_LENGTH_BYTES = 2;

/** The most raw part bytes one event carries, derived so the worst-case sealed frame fits `RELAY_EVENT_MAX_BYTES`. */
export const RELAY_PART_BYTES =
    Math.floor((RELAY_CONTENT_MAX_BYTES * 3) / 4) -
    AES_IV_BYTES -
    AES_TAG_BYTES -
    HEADER_LENGTH_BYTES -
    RELAY_HEADER_MAX_BYTES;

/** The most parts one message may take; a sender refuses more, a receiver accepts no more. */
export const RELAY_MAX_PARTS = 100;

/** The longest peer id a header may carry (trystero's are 20 characters). */
const MAX_HEADER_ID_LENGTH = 64;

const HEX_128 = /^[0-9a-f]{32}$/;
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
 * per (sender, stream); it is '' on every other kind.
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
};

/** What the link needs of the wire format: seal/open one frame, pack/unpack one message. */
export type RelayCodec = {
    /** Seals one part under its header into an event `content`. Rejects a header over RELAY_HEADER_MAX_BYTES. */
    seal: (header: FrameHeader, part: Uint8Array) => Promise<string>;
    /** Opens an event `content`; null when it is not ours (wrong key, damaged, malformed header). */
    open: (content: string) => Promise<{ header: FrameHeader; part: Uint8Array } | null>;
    /** A message as the gzipped bytes that get split into parts. */
    pack: (message: unknown) => Promise<Uint8Array>;
    /** The message the gzipped bytes hold; null when they are damaged or inflate past MAX_PEER_MESSAGE_BYTES. */
    unpack: (bytes: Uint8Array) => Promise<{ message: unknown } | null>;
};

/** Random bytes from the platform's CSPRNG; the link takes the source as an argument so tests can fix it. */
export const cryptoRandom = (length: number): Uint8Array => globalThis.crypto.getRandomValues(new Uint8Array(length));

export const toHex = (bytes: Uint8Array): string =>
    [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

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

const concat = (chunks: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
};

/** Joins the parts of one message back into the gzipped bytes. */
export const joinBytes = concat;

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
    return concat(chunks);
};

const isBoundedId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= MAX_HEADER_ID_LENGTH;

const isEpoch = (value: unknown): value is string => typeof value === 'string' && HEX_128.test(value);

const isCount = (value: unknown): value is number => isInteger(value) && value >= 0 && value <= 0xffffffff;

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
    return { v: 1, from, to, toEpoch, epoch, msgId, stream, seq, part, parts, ts, kind: kind as FrameKind };
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
    return {
        seal: async (header, part) => {
            const headerBytes = new TextEncoder().encode(JSON.stringify(header));
            if (headerBytes.length > RELAY_HEADER_MAX_BYTES) throw new Error('relay frame header too long');
            const plain = new Uint8Array(HEADER_LENGTH_BYTES + headerBytes.length + part.length);
            new DataView(plain.buffer).setUint16(0, headerBytes.length);
            plain.set(headerBytes, HEADER_LENGTH_BYTES);
            plain.set(part, HEADER_LENGTH_BYTES + headerBytes.length);
            const iv = random(AES_IV_BYTES);
            const sealed = new Uint8Array(
                await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, await key, plain),
            );
            return bytesToBase64Url(concat([iv, sealed]));
        },
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
            const header = parseHeader(parsed);
            const part = plain.subarray(HEADER_LENGTH_BYTES + headerLength);
            return header === null || part.length > RELAY_PART_BYTES ? null : { header, part };
        },
        pack: (message) => gzip(new TextEncoder().encode(JSON.stringify(message))),
        unpack: async (bytes) => {
            const inflated = await gunzipBounded(bytes, MAX_PEER_MESSAGE_BYTES);
            if (inflated === null) return null;
            try {
                return { message: JSON.parse(new TextDecoder().decode(inflated)) as unknown };
            } catch {
                return null;
            }
        },
    };
};
