/**
 * The relay link's wire format: the pipeline round trip, the size a sealed frame never exceeds,
 * and everything a receiver drops — a wrong key, damage, a malformed header, an inflate bomb.
 */

import {
    base64UrlToBytes,
    bytesToBase64Url,
    createRelayCodec,
    cryptoRandom,
    parseHeader,
    splitBytes,
} from '../../src/ts/core/remote/relayCodec';
import {
    RELAY_BATCH_ACK_BYTES,
    RELAY_BATCH_FRAME_BYTES,
    RELAY_BATCH_MAX_FRAMES,
    batchBudgetBytes,
    batchFits,
} from '../../src/ts/core/remote/relayBatchCodec';
import {
    RELAY_CONTENT_MAX_BYTES,
    RELAY_EVENT_MAX_BYTES,
    RELAY_EVENT_OVERHEAD_BYTES,
    RELAY_HEADER_MAX_BYTES,
    RELAY_MAX_PARTS,
    RELAY_PART_BYTES,
    RELAY_PLAIN_MAX_BYTES,
    joinBytes,
    toHex,
} from '../../src/ts/core/remote/relayWire';
import { MAX_PEER_MESSAGE_BYTES } from '../../src/ts/core/remote/protocol';
import { isInteger } from '../../src/ts/core/numbers';
import { isPlainObject } from '../../src/ts/core/plainObject';
import { invalid } from '../helpers/invalid';

import type { FrameHeader } from '../../src/ts/core/remote/relayCodec';
import type { Batch, BatchFrame } from '../../src/ts/core/remote/relayBatchCodec';

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
        expect(opened).toEqual({ header: header(), part: Uint8Array.from([1, 2, 3, 250]) });
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
        expect(opened).toEqual({ header: header(), part: Uint8Array.from([5]) });
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
        // The size is what gunzip produced (the serialized message), not the gzipped length.
        const inflated = new TextEncoder().encode(JSON.stringify(message)).length;
        expect(inflated).toBeGreaterThan(bytes.length);
        await expect(codec.unpack(bytes)).resolves.toEqual({ message, size: inflated });
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

describe('presence and the batch capability flag', () => {
    const presence = (overrides: Partial<FrameHeader> = {}): FrameHeader =>
        header({ kind: 'presence', to: '', toEpoch: '', stream: '', ...overrides });

    test('a presence frame keeps its batch flag through the codec', async () => {
        const codec = createRelayCodec(KEY);
        const opened = await codec.open(await codec.seal(presence({ batch: true }), new Uint8Array(0)));
        expect(opened).toEqual({ header: presence({ batch: true }), part: new Uint8Array(0) });
    });

    test('a presence frame without the flag has none, and anything but true is no flag', () => {
        expect(parseHeader(presence())).toEqual(presence());
        expect(parseHeader(presence())).not.toHaveProperty('batch');
        expect(parseHeader(invalid<unknown>({ ...presence(), batch: 'yes' }))).not.toHaveProperty('batch');
    });

    test('the flag counts on a presence frame only', () => {
        expect(parseHeader(invalid<unknown>({ ...header(), batch: true }))).not.toHaveProperty('batch');
        expect(parseHeader(invalid<unknown>({ ...presence(), kind: 'bye', batch: true }))).not.toHaveProperty('batch');
    });

    /** The header check of the first release of the link (beta.3), copied from it: it reads the fields it names and nothing else. */
    const betaThreeParseHeader = (value: unknown): boolean => {
        if (!isPlainObject(value)) return false;
        const bounded = (x: unknown): boolean => typeof x === 'string' && x.length > 0 && x.length <= 64;
        const epoch = (x: unknown): boolean => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x);
        const count = (x: unknown): x is number => isInteger(x) && x >= 0 && x <= 0xffffffff;
        const { v, from, to, toEpoch, epoch: senderEpoch, msgId, stream, seq, part, parts, ts, kind } = value;
        return (
            v === 1 &&
            bounded(from) &&
            typeof to === 'string' &&
            to.length <= 64 &&
            (toEpoch === '' || epoch(toEpoch)) &&
            epoch(senderEpoch) &&
            epoch(msgId) &&
            count(seq) &&
            count(part) &&
            count(parts) &&
            parts >= 1 &&
            parts <= RELAY_MAX_PARTS &&
            part < parts &&
            isInteger(ts) &&
            typeof kind === 'string' &&
            ['data', 'presence', 'ack', 'bye'].includes(kind) &&
            typeof stream === 'string' &&
            (kind === 'data' ? epoch(stream) : stream === '')
        );
    };

    test('the new presence passes the first release header rules', async () => {
        const wire: unknown = JSON.parse(JSON.stringify(presence({ batch: true })));
        expect(betaThreeParseHeader(wire)).toBe(true);
        expect(betaThreeParseHeader({ ...presence(), kind: 'data', stream: '' })).toBe(false); // the fixture does check
    });
});

describe('batches', () => {
    const batchHeader = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        v: 2,
        id: HEX_C,
        from: 'peer-a',
        to: 'peer-b',
        toEpoch: HEX_B,
        epoch: HEX_A,
        ts: 1_700_000_000_000,
        ...overrides,
    });
    const frame = (overrides: Partial<BatchFrame> = {}): BatchFrame => ({
        msgId: HEX_C,
        stream: HEX_A,
        seq: 7,
        part: 0,
        parts: 1,
        bytes: Uint8Array.from([1, 2, 3]),
        ...overrides,
    });
    const batch = (overrides: Partial<Batch> = {}): Batch => ({
        header: { v: 2, id: HEX_C, from: 'peer-a', to: 'peer-b', toEpoch: HEX_B, epoch: HEX_A, ts: 1_700_000_000_000 },
        acks: [],
        frames: [frame()],
        ...overrides,
    });

    // Raw plaintext, to forge what the codec itself never writes.
    const u16 = (n: number): number[] => [n >> 8, n & 255];
    const text = (value: string): number[] => [...new TextEncoder().encode(value)];
    const innerFrame = (headerJson: string, part: number[], headerLength = headerJson.length): number[] => [
        ...u16(headerLength),
        ...text(headerJson),
        ...u16(part.length),
        ...part,
    ];
    const goodInner = (): string => JSON.stringify({ msgId: HEX_C, stream: HEX_A, seq: 0, part: 0, parts: 1 });
    const forged = (counts: [number, number], body: number[], headerJson = JSON.stringify(batchHeader())): Uint8Array =>
        Uint8Array.from([...u16(headerJson.length), ...text(headerJson), ...counts, ...body]);
    const openForged = async (plain: Uint8Array) => createRelayCodec(KEY).open(await sealRaw(KEY, plain));
    const ackBytes = (n: number): number[] => Array.from({ length: n * 16 }, (_v, i) => i % 256);

    describe('sizes', () => {
        const worstIds = { from: 'f'.repeat(64), to: 't'.repeat(64) };
        const worstHeader = (ids: { from: string; to: string }): Batch['header'] => ({
            v: 2,
            id: HEX_C,
            ...ids,
            toEpoch: HEX_B,
            epoch: HEX_A,
            ts: 9_999_999_999_999,
        });

        test('one full part with the largest headers fits a batch event', async () => {
            expect(RELAY_BATCH_FRAME_BYTES + RELAY_PART_BYTES).toBeLessThanOrEqual(
                batchBudgetBytes(worstIds.from, worstIds.to),
            );
            const content = await createRelayCodec(KEY).sealBatch({
                header: worstHeader(worstIds),
                acks: [],
                frames: [
                    frame({
                        seq: 0xffffffff,
                        part: RELAY_MAX_PARTS - 1,
                        parts: RELAY_MAX_PARTS,
                        bytes: new Uint8Array(RELAY_PART_BYTES).fill(255),
                    }),
                ],
            });
            expect(content.length).toBeLessThanOrEqual(RELAY_CONTENT_MAX_BYTES);
            expect(content.length + RELAY_EVENT_OVERHEAD_BYTES).toBeLessThanOrEqual(RELAY_EVENT_MAX_BYTES);
        });

        test('a batch filled to its byte budget with the most items still fits', async () => {
            const budget = batchBudgetBytes(worstIds.from, worstIds.to);
            expect(budget).toBeLessThan(RELAY_PLAIN_MAX_BYTES);
            const frames = RELAY_BATCH_MAX_FRAMES - 1;
            const partBytes = Math.floor((budget - RELAY_BATCH_ACK_BYTES) / frames) - RELAY_BATCH_FRAME_BYTES;
            const content = await createRelayCodec(KEY).sealBatch(
                batch({
                    header: worstHeader(worstIds),
                    acks: [HEX_A],
                    frames: Array.from({ length: frames }, () =>
                        frame({ seq: 0xffffffff, parts: RELAY_MAX_PARTS, bytes: new Uint8Array(partBytes).fill(255) }),
                    ),
                }),
            );
            expect(content.length + RELAY_EVENT_OVERHEAD_BYTES).toBeLessThanOrEqual(RELAY_EVENT_MAX_BYTES);
        });

        test.each([
            ['multi-byte characters', '€'.repeat(64)],
            ['control characters, which JSON escapes to six bytes', String.fromCharCode(1).repeat(30)],
            ['quotes, which JSON escapes', '"'.repeat(64)],
        ])('a batch from an id of %s is budgeted by its real header bytes and still seals', async (_name, from) => {
            const ids = { from, to: 'peer-b' };
            const asciiBudget = batchBudgetBytes('x'.repeat(from.length), ids.to);
            const budget = batchBudgetBytes(from, ids.to);
            expect(batchFits(from, ids.to)).toBe(true);
            expect(budget).toBeLessThan(asciiBudget); // the characters cost more than one byte each
            // A part sized to the budget fills the event to the byte; one sized to the ASCII budget would not fit.
            const content = await createRelayCodec(KEY).sealBatch({
                header: worstHeader(ids),
                acks: [],
                frames: [frame({ bytes: new Uint8Array(budget - RELAY_BATCH_FRAME_BYTES).fill(255) })],
            });
            expect(content.length + RELAY_EVENT_OVERHEAD_BYTES).toBeLessThanOrEqual(RELAY_EVENT_MAX_BYTES);
            await expect(
                createRelayCodec(KEY).sealBatch({
                    header: worstHeader(ids),
                    acks: [],
                    frames: [frame({ bytes: new Uint8Array(asciiBudget - RELAY_BATCH_FRAME_BYTES).fill(255) })],
                }),
            ).rejects.toThrow('relay batch too large');
        });

        test.each([
            ['ids of ordinary length', 'host-id', 'peer-id', true],
            ['the largest ASCII ids', 'f'.repeat(64), 't'.repeat(64), true],
            [
                'a header over the header limit',
                String.fromCharCode(1).repeat(64),
                String.fromCharCode(1).repeat(64),
                false,
            ],
            ['a header within the limit but too big for a full part', '€'.repeat(64), '€'.repeat(40), false],
            ['a header within the limit but too big, ASCII on one side', '€'.repeat(64), 'b'.repeat(64), false],
            ['40 control characters to a short id', String.fromCharCode(1).repeat(40), 'peer-b', false],
            ['50 control characters to a short id', String.fromCharCode(1).repeat(50), 'peer-b', false],
        ])('a batch between %s: batchFits is %s', async (_name, from, to, fits) => {
            expect(batchFits(from, to)).toBe(fits);
            // The rule is the one the sender needs: a full part with its own header fits when, and only when, it is true.
            const room = batchBudgetBytes(from, to) >= RELAY_BATCH_FRAME_BYTES + RELAY_PART_BYTES;
            expect(room).toBe(fits);
            // And it keeps the header within the header limit: where it holds, a batch with a full part seals.
            if (fits) {
                const full = frame({ bytes: new Uint8Array(RELAY_PART_BYTES).fill(255) });
                await expect(
                    createRelayCodec(KEY).sealBatch({ header: worstHeader({ from, to }), acks: [], frames: [full] }),
                ).resolves.toEqual(expect.any(String));
            }
        });
    });

    describe('seal and open', () => {
        test('acks and parts round-trip with the header', async () => {
            const codec = createRelayCodec(KEY);
            const sent = batch({
                acks: [HEX_A, HEX_B],
                frames: [frame(), frame({ msgId: HEX_A, seq: 8, part: 1, parts: 2, bytes: new Uint8Array(0) })],
            });
            const content = await codec.sealBatch(sent);
            expect(content).toMatch(/^[A-Za-z0-9_-]+$/);
            await expect(codec.open(content)).resolves.toEqual({ batch: sent });
        });

        test('a batch of acks alone, and one of parts alone', async () => {
            const codec = createRelayCodec(KEY);
            const acksOnly = batch({ acks: [HEX_C], frames: [] });
            await expect(codec.open(await codec.sealBatch(acksOnly))).resolves.toEqual({ batch: acksOnly });
            const partsOnly = batch();
            await expect(codec.open(await codec.sealBatch(partsOnly))).resolves.toEqual({ batch: partsOnly });
        });

        test('a batch sealed under another pairing key is not opened', async () => {
            const content = await createRelayCodec(KEY).sealBatch(batch());
            await expect(createRelayCodec('z'.repeat(43)).open(content)).resolves.toBeNull();
        });

        test('a header over the limit is refused when sealing', async () => {
            await expect(
                createRelayCodec(KEY).sealBatch(
                    batch({ header: { ...batch().header, from: '€'.repeat(64), to: '€'.repeat(64) } }),
                ),
            ).rejects.toThrow('relay batch header too long');
        });

        test('more than the frame cap of items is refused when sealing', async () => {
            const codec = createRelayCodec(KEY);
            const acks = Array.from({ length: RELAY_BATCH_MAX_FRAMES }, () => HEX_A);
            await expect(codec.sealBatch(batch({ acks, frames: [] }))).resolves.toEqual(expect.any(String));
            await expect(codec.sealBatch(batch({ acks, frames: [frame()] }))).rejects.toThrow('too many items');
        });

        test('a plaintext over the event limit is refused when sealing', async () => {
            const big = frame({ bytes: new Uint8Array(RELAY_PART_BYTES) });
            await expect(createRelayCodec(KEY).sealBatch(batch({ frames: [big, big] }))).rejects.toThrow(
                'relay batch too large',
            );
        });
    });

    describe('what a receiver drops', () => {
        test('a forged batch with the layout of the codec is opened (the forge helper itself is sound)', async () => {
            const opened = await openForged(forged([1, 1], [...ackBytes(1), ...innerFrame(goodInner(), [9])]));
            expect(opened).toEqual({
                batch: {
                    header: batch().header,
                    acks: ['000102030405060708090a0b0c0d0e0f'],
                    frames: [{ msgId: HEX_C, stream: HEX_A, seq: 0, part: 0, parts: 1, bytes: Uint8Array.from([9]) }],
                },
            });
        });

        test.each([
            ['an id that is not 128 bits of hex', { id: 'abc' }],
            ['a numeric id', { id: 5 }],
            ['an empty from', { from: '' }],
            ['a long to', { to: 'x'.repeat(65) }],
            ['an empty to (a batch is never a broadcast)', { to: '' }],
            ['a toEpoch that is not an epoch', { toEpoch: '' }],
            ['a bad epoch', { epoch: 'abc' }],
            ['a text ts', { ts: 'now' }],
        ])('a batch header with %s', async (_name, overrides) => {
            await expect(
                openForged(forged([0, 1], innerFrame(goodInner(), []), JSON.stringify(batchHeader(overrides)))),
            ).resolves.toBeNull();
        });

        test('a header that is not JSON, and one that names no version', async () => {
            await expect(openForged(forged([0, 1], innerFrame(goodInner(), []), 'not json'))).resolves.toBeNull();
            await expect(
                openForged(forged([0, 1], innerFrame(goodInner(), []), JSON.stringify({ ...batchHeader(), v: 3 }))),
            ).resolves.toBeNull();
        });

        test.each([
            ['no items', [0, 0]],
            ['more items than the cap (acks and parts together)', [RELAY_BATCH_MAX_FRAMES, 1]],
            ['more parts than the cap', [0, RELAY_BATCH_MAX_FRAMES + 1]],
        ] as const)('a batch with %s', async (_name, counts) => {
            await expect(openForged(forged([counts[0], counts[1]], []))).resolves.toBeNull();
        });

        test('a batch exactly at the cap is opened', async () => {
            const opened = await openForged(forged([RELAY_BATCH_MAX_FRAMES, 0], ackBytes(RELAY_BATCH_MAX_FRAMES)));
            expect(opened).toEqual({ batch: expect.objectContaining({ acks: expect.any(Array) }) });
        });

        test('a batch cut short anywhere', async () => {
            const good = innerFrame(goodInner(), [1, 2, 3]);
            await expect(openForged(forged([1, 0], ackBytes(1).slice(0, 8)))).resolves.toBeNull(); // ack id cut
            await expect(openForged(forged([0, 1], []))).resolves.toBeNull(); // no frame header length
            await expect(openForged(forged([0, 1], good.slice(0, 10)))).resolves.toBeNull(); // header cut
            await expect(openForged(forged([0, 1], good.slice(0, good.length - 4)))).resolves.toBeNull(); // part length cut
            await expect(openForged(forged([0, 1], good.slice(0, good.length - 1)))).resolves.toBeNull(); // part cut
            await expect(openForged(forged([0, 2], good))).resolves.toBeNull(); // a second frame is missing
        });

        test('a batch with bytes after its last item', async () => {
            await expect(openForged(forged([0, 1], [...innerFrame(goodInner(), [1]), 0]))).resolves.toBeNull();
        });

        test('an inner header over the v1 header limit', async () => {
            const padded = JSON.stringify({
                msgId: HEX_C,
                stream: HEX_A,
                seq: 0,
                part: 0,
                parts: 1,
                pad: 'p'.repeat(600),
            });
            await expect(openForged(forged([0, 1], innerFrame(padded, [1])))).resolves.toBeNull();
            // The limit is on the header's length, whatever bytes follow it.
            await expect(
                openForged(forged([0, 1], innerFrame(goodInner(), [1], RELAY_HEADER_MAX_BYTES + 1))),
            ).resolves.toBeNull();
        });

        test('an inner header at the limit is opened', async () => {
            const base = JSON.stringify({ msgId: HEX_C, stream: HEX_A, seq: 0, part: 0, parts: 1, pad: '' });
            const padded = JSON.stringify({
                msgId: HEX_C,
                stream: HEX_A,
                seq: 0,
                part: 0,
                parts: 1,
                pad: 'p'.repeat(RELAY_HEADER_MAX_BYTES - base.length),
            });
            expect(padded).toHaveLength(RELAY_HEADER_MAX_BYTES);
            await expect(openForged(forged([0, 1], innerFrame(padded, [1])))).resolves.not.toBeNull();
        });

        test('an inner header that is not JSON', async () => {
            await expect(openForged(forged([0, 1], innerFrame('{nope', [1])))).resolves.toBeNull();
        });

        test.each([
            ['a msgId that is not 128 bits of hex', { msgId: 'abc' }],
            ['a stream that is not an epoch', { stream: '' }],
            ['a negative seq', { seq: -1 }],
            ['a fractional part', { part: 0.5 }],
            ['zero parts', { part: 0, parts: 0 }],
            ['too many parts', { parts: RELAY_MAX_PARTS + 1 }],
            ['a part past the count', { part: 1, parts: 1 }],
        ])('an inner header with %s', async (_name, overrides) => {
            const inner = JSON.stringify({ msgId: HEX_C, stream: HEX_A, seq: 0, part: 0, parts: 1, ...overrides });
            await expect(openForged(forged([0, 1], innerFrame(inner, [1])))).resolves.toBeNull();
        });

        test('an inner header that is not an object', async () => {
            await expect(openForged(forged([0, 1], innerFrame('[1,2]', [1])))).resolves.toBeNull();
        });

        test('a part over the v1 part limit, and one at it', async () => {
            const over = Array.from({ length: RELAY_PART_BYTES + 1 }, () => 7);
            await expect(openForged(forged([0, 1], innerFrame(goodInner(), over)))).resolves.toBeNull();
            const at = over.slice(1);
            await expect(openForged(forged([0, 1], innerFrame(goodInner(), at)))).resolves.not.toBeNull();
        });
    });
});
