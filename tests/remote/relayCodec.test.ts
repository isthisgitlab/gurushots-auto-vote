/**
 * The relay link's wire format: the pipeline round trip, the size a sealed frame never exceeds,
 * and everything a receiver drops — a wrong key, damage, a malformed header, an inflate bomb.
 */

import {
    RELAY_CONTENT_MAX_BYTES,
    RELAY_EVENT_MAX_BYTES,
    RELAY_EVENT_OVERHEAD_BYTES,
    RELAY_HEADER_MAX_BYTES,
    RELAY_MAX_PARTS,
    RELAY_PART_BYTES,
    base64UrlToBytes,
    bytesToBase64Url,
    createRelayCodec,
    cryptoRandom,
    joinBytes,
    parseHeader,
    splitBytes,
    toHex,
} from '../../src/ts/core/remote/relayCodec';
import { MAX_PEER_MESSAGE_BYTES } from '../../src/ts/core/remote/protocol';
import { invalid } from '../helpers/invalid';

import type { FrameHeader } from '../../src/ts/core/remote/relayCodec';

const KEY = 'k'.repeat(43);
const HEX_A = 'a'.repeat(32);
const HEX_B = 'b'.repeat(32);
const HEX_C = 'c'.repeat(32);

const header = (overrides: Partial<FrameHeader> = {}): FrameHeader => ({
    v: 1,
    from: 'peer-a',
    to: 'peer-b',
    toEpoch: HEX_B,
    epoch: HEX_A,
    msgId: HEX_C,
    stream: HEX_A,
    seq: 0,
    part: 0,
    parts: 1,
    ts: 1_700_000_000_000,
    kind: 'data',
    ...overrides,
});

/** Seals raw plaintext the way the codec does, so a test can forge a frame the codec itself would never make. */
const sealRaw = async (pairingKey: string, plain: Uint8Array): Promise<string> => {
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pairingKey), 'HKDF', false, [
        'deriveKey',
    ]);
    const key = await crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode('gs-relay-v1') },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt'],
    );
    const iv = new Uint8Array(12).fill(7);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(plain)));
    return bytesToBase64Url(Uint8Array.from([...iv, ...sealed]));
};

/** Random bytes of any size (one `getRandomValues` call takes at most 64 KiB). */
const randomBytes = (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    for (let at = 0; at < length; at += 65_536) crypto.getRandomValues(out.subarray(at, at + 65_536));
    return out;
};

const withHeaderLength = (length: number, headerJson: string, part: Uint8Array = new Uint8Array(0)): Uint8Array => {
    const headerBytes = new TextEncoder().encode(headerJson);
    const plain = new Uint8Array(2 + headerBytes.length + part.length);
    new DataView(plain.buffer).setUint16(0, length);
    plain.set(headerBytes, 2);
    plain.set(part, 2 + headerBytes.length);
    return plain;
};

describe('sizes', () => {
    test('the part size is derived so the worst-case sealed event fits the pinned maximum', async () => {
        expect(RELAY_EVENT_MAX_BYTES).toBe(48_000);
        expect(RELAY_CONTENT_MAX_BYTES).toBe(RELAY_EVENT_MAX_BYTES - RELAY_EVENT_OVERHEAD_BYTES);
        const worst = header({
            from: 'f'.repeat(64),
            to: 't'.repeat(64),
            seq: 0xffffffff,
            part: RELAY_MAX_PARTS - 1,
            parts: RELAY_MAX_PARTS,
            ts: 9_999_999_999_999,
        });
        expect(new TextEncoder().encode(JSON.stringify(worst)).length).toBeLessThanOrEqual(RELAY_HEADER_MAX_BYTES);
        const content = await createRelayCodec(KEY).seal(worst, new Uint8Array(RELAY_PART_BYTES).fill(255));
        expect(content.length).toBeLessThanOrEqual(RELAY_CONTENT_MAX_BYTES);
        // The frame a relay receives is the content plus trystero's fixed overhead.
        expect(content.length + RELAY_EVENT_OVERHEAD_BYTES).toBeLessThanOrEqual(RELAY_EVENT_MAX_BYTES);
    });

    test('the largest message fits in the part limit, even incompressible', async () => {
        const codec = createRelayCodec(KEY);
        // 2 MiB of random bytes as a base64 string: JSON text that gzip cannot shrink much.
        const noise = bytesToBase64Url(randomBytes(1_500_000)).slice(0, 2 * 1024 * 1024 - 64);
        const bytes = await codec.pack({ t: 'result', payload: noise });
        expect(splitBytes(bytes, RELAY_PART_BYTES).length).toBeLessThanOrEqual(RELAY_MAX_PARTS);
    });
});

describe('seal and open', () => {
    test('a part round-trips with its header', async () => {
        const codec = createRelayCodec(KEY);
        const part = Uint8Array.from([1, 2, 3, 250]);
        const content = await codec.seal(header(), part);
        expect(content).toMatch(/^[A-Za-z0-9_-]+$/);
        const opened = await codec.open(content);
        expect(opened?.header).toEqual(header());
        expect([...(opened?.part ?? [])]).toEqual([1, 2, 3, 250]);
    });

    test('two seals of one part differ: the IV is fresh', async () => {
        const codec = createRelayCodec(KEY);
        const [a, b] = [await codec.seal(header(), new Uint8Array(8)), await codec.seal(header(), new Uint8Array(8))];
        expect(a).not.toBe(b);
    });

    test('a fixed random source fixes the IV (the injected source is used)', async () => {
        const codec = createRelayCodec(KEY, (length) => new Uint8Array(length).fill(9));
        expect(await codec.seal(header(), new Uint8Array(4))).toBe(await codec.seal(header(), new Uint8Array(4)));
    });

    test('the key text never appears in the content', async () => {
        const content = await createRelayCodec(KEY).seal(header(), new TextEncoder().encode(KEY));
        expect(content).not.toContain(KEY);
        expect(atob(content.replaceAll('-', '+').replaceAll('_', '/'))).not.toContain(KEY);
    });

    test('a frame sealed under another pairing key is not opened', async () => {
        const content = await createRelayCodec(KEY).seal(header(), new Uint8Array(4));
        await expect(createRelayCodec('z'.repeat(43)).open(content)).resolves.toBeNull();
    });

    test('a damaged frame is not opened', async () => {
        const codec = createRelayCodec(KEY);
        const content = await codec.seal(header(), new Uint8Array(32));
        const flipped = content.slice(0, 40) + (content[40] === 'A' ? 'B' : 'A') + content.slice(41);
        await expect(codec.open(flipped)).resolves.toBeNull();
    });

    test('text that is not base64url, and text that is too short, are not opened', async () => {
        const codec = createRelayCodec(KEY);
        await expect(codec.open('not base64url!')).resolves.toBeNull();
        await expect(codec.open('A')).resolves.toBeNull(); // length % 4 === 1
        await expect(codec.open('AAAA')).resolves.toBeNull(); // shorter than IV + tag + length
    });

    test('a header over the limit is refused when sealing', async () => {
        const codec = createRelayCodec(KEY);
        await expect(
            codec.seal(header({ from: '€'.repeat(64), to: '€'.repeat(64) }), new Uint8Array(0)),
        ).rejects.toThrow('relay frame header too long');
    });

    test.each([
        ['a header length over the limit', withHeaderLength(RELAY_HEADER_MAX_BYTES + 1, '{}')],
        ['a header length past the plaintext', withHeaderLength(200, '{}')],
        ['a header that is not JSON', withHeaderLength(4, 'nope')],
        ['a header of the wrong shape', withHeaderLength(2, '{}')],
        [
            'a part over the limit',
            withHeaderLength(
                JSON.stringify(header()).length,
                JSON.stringify(header()),
                new Uint8Array(RELAY_PART_BYTES + 1),
            ),
        ],
    ])('a frame with %s is not opened', async (_name, plain) => {
        const content = await sealRaw(KEY, plain);
        await expect(createRelayCodec(KEY).open(content)).resolves.toBeNull();
    });

    test('a forged frame with a right-shaped header and part is opened (the forge helper itself is sound)', async () => {
        const json = JSON.stringify(header());
        const content = await sealRaw(KEY, withHeaderLength(json.length, json, Uint8Array.from([5])));
        const opened = await createRelayCodec(KEY).open(content);
        expect(opened?.header.kind).toBe('data');
        expect([...(opened?.part ?? [])]).toEqual([5]);
    });
});

describe('parseHeader', () => {
    test('a valid header is returned as a fresh object', () => {
        const parsed = parseHeader({ ...header(), extra: 'ignored' });
        expect(parsed).toEqual(header());
        expect(parsed).not.toHaveProperty('extra');
    });

    test('an empty toEpoch and an empty (broadcast) to are valid', () => {
        expect(parseHeader({ ...header(), toEpoch: '', to: '', stream: '', kind: 'presence' })).not.toBeNull();
    });

    test.each([
        ['not an object', 'text'],
        ['another version', { ...header(), v: 2 }],
        ['an empty from', { ...header(), from: '' }],
        ['a long from', { ...header(), from: 'x'.repeat(65) }],
        ['a numeric to', { ...header(), to: 5 }],
        ['a long to', { ...header(), to: 'x'.repeat(65) }],
        ['a bad toEpoch', { ...header(), toEpoch: 'abc' }],
        ['a bad epoch', { ...header(), epoch: 'g'.repeat(32) }],
        ['a bad msgId', { ...header(), msgId: HEX_A.toUpperCase() }],
        ['a negative seq', { ...header(), seq: -1 }],
        ['a fractional part', { ...header(), part: 0.5 }],
        ['zero parts', { ...header(), parts: 0 }],
        ['too many parts', { ...header(), parts: RELAY_MAX_PARTS + 1 }],
        ['a part past the count', { ...header(), part: 1, parts: 1 }],
        ['a text ts', { ...header(), ts: 'now' }],
        ['an unknown kind', { ...header(), kind: 'gossip' }],
        ['a data frame without a stream', { ...header(), stream: '' }],
        ['a data frame with a bad stream', { ...header(), stream: 'xyz' }],
        ['a numeric stream', { ...header(), stream: 5 }],
        ['a presence frame that names a stream', { ...header(), kind: 'presence' }],
        ['a numeric kind', { ...header(), kind: 5 }],
    ])('refuses %s', (_name, value) => {
        expect(parseHeader(invalid<unknown>(value))).toBeNull();
    });
});

describe('pack and unpack', () => {
    test('a message round-trips through gzip', async () => {
        const codec = createRelayCodec(KEY);
        const message = { t: 'event', channel: 'log-message', payload: { line: 'x'.repeat(10_000) } };
        const bytes = await codec.pack(message);
        expect(bytes.length).toBeLessThan(1_000);
        await expect(codec.unpack(bytes)).resolves.toEqual({ message });
    });

    test('damaged bytes are not a message', async () => {
        await expect(createRelayCodec(KEY).unpack(Uint8Array.from([1, 2, 3, 4, 5, 6]))).resolves.toBeNull();
    });

    test('bytes that inflate past the protocol limit are cut off, not inflated', async () => {
        const codec = createRelayCodec(KEY);
        const bomb = await codec.pack({ t: 'result', pad: 'a'.repeat(MAX_PEER_MESSAGE_BYTES + 1024) });
        expect(bomb.length).toBeLessThan(10_000);
        await expect(codec.unpack(bomb)).resolves.toBeNull();
    });

    test('gzip of text that is not JSON is not a message', async () => {
        const stream = new Blob([new TextEncoder().encode('not json')])
            .stream()
            .pipeThrough(new CompressionStream('gzip'));
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        await expect(createRelayCodec(KEY).unpack(bytes)).resolves.toBeNull();
    });
});

describe('byte helpers', () => {
    test('split and join are inverses; empty input is one empty part', () => {
        const bytes = Uint8Array.from({ length: 25 }, (_v, i) => i);
        const parts = splitBytes(bytes, 10);
        expect(parts.map((part) => part.length)).toEqual([10, 10, 5]);
        expect([...joinBytes(parts)]).toEqual([...bytes]);
        expect(splitBytes(new Uint8Array(0), 10)).toHaveLength(1);
        expect(splitBytes(new Uint8Array(0), 10)[0]).toHaveLength(0);
    });

    test('base64url round-trips across the chunk size and uses no padding or +/', () => {
        const bytes = randomBytes(100_000);
        const text = bytesToBase64Url(bytes);
        expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
        expect([...(base64UrlToBytes(text) ?? [])]).toEqual([...bytes]);
        expect(bytesToBase64Url(Uint8Array.from([251, 255, 254]))).toBe('-__-');
    });

    test('base64url refuses other characters and an impossible length', () => {
        expect(base64UrlToBytes('ab+/')).toBeNull();
        expect(base64UrlToBytes('abcde')).toBeNull();
        expect(base64UrlToBytes('')).toEqual(new Uint8Array(0));
    });

    test('hex and random', () => {
        expect(toHex(Uint8Array.from([0, 15, 255]))).toBe('000fff');
        expect(cryptoRandom(16)).toHaveLength(16);
        expect(toHex(cryptoRandom(16))).not.toBe(toHex(cryptoRandom(16)));
    });
});
