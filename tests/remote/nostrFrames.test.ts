import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { createNostrFrames } from '../../src/ts/core/remote/nostrFrames';
import { isPlainObject } from '../../src/ts/core/plainObject';
import { RELAY_EVENT_OVERHEAD_BYTES, toHex } from '../../src/ts/core/remote/relayWire';

import type { schnorr } from '@noble/secp256k1';

type SchnorrApi = typeof schnorr;

const secretKey = Uint8Array.from({ length: 32 }, (_value, index) => index + 1);
const publicKey = Uint8Array.from({ length: 32 }, (_value, index) => 255 - index);
const signature = Uint8Array.from({ length: 64 }, (_value, index) => index);

jest.mock('@noble/secp256k1', () => ({
    __esModule: true,
    schnorr: {
        keygen: jest.fn<ReturnType<SchnorrApi['keygen']>, []>(),
        signAsync: jest.fn<ReturnType<SchnorrApi['signAsync']>, Parameters<SchnorrApi['signAsync']>>(),
    },
}));

const mockSchnorr = jest.mocked(
    (require('@noble/secp256k1') as Pick<typeof import('@noble/secp256k1'), 'schnorr'>).schnorr,
);

type NostrEvent = {
    kind: number;
    tags: string[][];
    created_at: number;
    content: string;
    pubkey: string;
    id: string;
    sig: string;
};

const isNostrEvent = (value: unknown): value is NostrEvent => {
    if (!isPlainObject(value)) return false;
    const event = value;
    return (
        typeof event.kind === 'number' &&
        Array.isArray(event.tags) &&
        event.tags.every((tag) => Array.isArray(tag) && tag.every((item) => typeof item === 'string')) &&
        typeof event.created_at === 'number' &&
        typeof event.content === 'string' &&
        typeof event.pubkey === 'string' &&
        typeof event.id === 'string' &&
        typeof event.sig === 'string'
    );
};

const eventFrom = (frame: string): NostrEvent => {
    const parsed: unknown = JSON.parse(frame);
    if (!Array.isArray(parsed) || parsed[0] !== 'EVENT' || !isNostrEvent(parsed[1]))
        throw new Error('Invalid Nostr event');
    return parsed[1];
};

const sha256 = async (text: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

describe('createNostrFrames', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-11-12T13:14:15.000Z'));
        mockSchnorr.keygen.mockReturnValue({ secretKey, publicKey });
        mockSchnorr.signAsync.mockResolvedValue(signature);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    test('serializes the canonical NIP-01 event and signs its SHA-256 digest', async () => {
        const topic = 'x'.repeat(64);
        const content = 'encrypted payload';
        const event = eventFrom(await createNostrFrames().createEvent(topic, content));
        const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
        const digest = await sha256(canonical);

        expect(event).toEqual({
            kind: 27_680,
            tags: [['x', topic]],
            created_at: 1_794_489_255,
            content,
            pubkey: toHex(publicKey),
            id: toHex(digest),
            sig: toHex(signature),
        });
        expect(mockSchnorr.signAsync).toHaveBeenCalledWith(digest, secretKey);
    });

    test('keeps the old UTF-16 topic kind and whole-second subscription filter', () => {
        const topic = 'A😀';
        const frames = createNostrFrames();

        expect(frames.subscribeFrame('sub-1', topic)).toBe(
            JSON.stringify(['REQ', 'sub-1', { kinds: [22_254], since: 1_794_489_255, '#x': [topic] }]),
        );
    });

    test('uses one signer for every event from a transport and a new signer for the next transport', async () => {
        const frames = createNostrFrames();
        await frames.createEvent('one', 'first');
        await frames.createEvent('two', 'second');
        createNostrFrames();

        expect(mockSchnorr.keygen).toHaveBeenCalledTimes(2);
        expect(mockSchnorr.signAsync).toHaveBeenNthCalledWith(1, expect.any(Uint8Array), secretKey);
        expect(mockSchnorr.signAsync).toHaveBeenNthCalledWith(2, expect.any(Uint8Array), secretKey);
    });

    test('keeps the measured event overhead for a maximum-length topic and empty payload', async () => {
        const frame = await createNostrFrames().createEvent('x'.repeat(64), '');

        expect(new TextEncoder().encode(frame)).toHaveLength(RELAY_EVENT_OVERHEAD_BYTES);
    });

    test('generates a native Node event whose Schnorr signature verifies with the installed package', () => {
        const script = `
import { createNostrFrames } from './src/ts/core/remote/nostrFrames.ts';
import { schnorr } from '@noble/secp256k1';
const [, event] = JSON.parse(await createNostrFrames().createEvent('native-topic', 'payload'));
const canonical = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical)));
const bytes = (hex) => Uint8Array.from(Buffer.from(hex, 'hex'));
if (!(await schnorr.verifyAsync(bytes(event.sig), digest, bytes(event.pubkey)))) process.exit(1);
process.stdout.write('verified\\n');
`;
        const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
            cwd: resolve(__dirname, '..', '..'),
            encoding: 'utf8',
            stdio: 'pipe',
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toBe('verified\n');
    });
});
