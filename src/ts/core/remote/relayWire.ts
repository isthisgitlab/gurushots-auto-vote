/**
 * What the relay link's two wire formats share: the event size limits and the sizes they derive (the part size, the
 * plaintext size), the byte helpers that join and print bytes, and the checks a header's ids and counts pass. The
 * frame format (`relayCodec.ts`) and the batch format (`relayBatchCodec.ts`) both import it, and it imports neither,
 * so the constants they compute at load never depend on a module that imports them back.
 */

import { isInteger } from '../numbers';

/**
 * The most bytes one event frame (`["EVENT",{…}]`, the string a relay receives) may take. Pinned by
 * the live gate (2026-11-01): every relay in `NOSTR_RELAY_URLS` answered `OK true` to a signed
 * ephemeral event of exactly this size.
 */
export const RELAY_EVENT_MAX_BYTES = 48_000;

/**
 * The bytes of an event frame around its `content` (our Nostr event helper: a 5-digit kind, one
 * `x` tag holding the 64-hex topic, a 10-digit `created_at`, the pubkey, the id and the signature).
 * Measured on the event helper: 428 for an empty content.
 */
export const RELAY_EVENT_OVERHEAD_BYTES = 428;

/** The longest `content` an event may carry: base64url is ASCII, so characters are bytes. */
export const RELAY_CONTENT_MAX_BYTES = RELAY_EVENT_MAX_BYTES - RELAY_EVENT_OVERHEAD_BYTES;

/** The longest JSON header a frame may carry; a sender refuses a longer one, a receiver drops it. */
export const RELAY_HEADER_MAX_BYTES = 512;

export const AES_IV_BYTES = 12;
export const AES_TAG_BYTES = 16;

/** The bytes of the length that precedes a header, and any other length the formats write. */
export const HEADER_LENGTH_BYTES = 2;

/** The most plaintext bytes one sealed event carries: the content's raw bytes less the IV and the tag. */
export const RELAY_PLAIN_MAX_BYTES = Math.floor((RELAY_CONTENT_MAX_BYTES * 3) / 4) - AES_IV_BYTES - AES_TAG_BYTES;

/** The most raw part bytes one event carries, derived so the worst-case sealed frame fits `RELAY_EVENT_MAX_BYTES`. */
export const RELAY_PART_BYTES = RELAY_PLAIN_MAX_BYTES - HEADER_LENGTH_BYTES - RELAY_HEADER_MAX_BYTES;

/** The most parts one message may take; a sender refuses more, a receiver accepts no more. */
export const RELAY_MAX_PARTS = 100;

/** The longest peer id a header may carry (trystero's are 20 characters). */
export const MAX_HEADER_ID_LENGTH = 64;

const HEX_128 = /^[0-9a-f]{32}$/;

export const toHex = (bytes: Uint8Array): string =>
    [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** Joins chunks of bytes into one array. */
export const joinBytes = (chunks: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
};

export const isBoundedId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= MAX_HEADER_ID_LENGTH;

/** 128 random bits in hex: an epoch, a message id, a stream id or a batch id. */
export const isEpoch = (value: unknown): value is string => typeof value === 'string' && HEX_128.test(value);

export const isCount = (value: unknown): value is number => isInteger(value) && value >= 0 && value <= 0xffffffff;
