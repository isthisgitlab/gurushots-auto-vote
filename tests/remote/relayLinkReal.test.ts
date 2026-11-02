/**
 * The relay link over the real codec — AES-GCM, gzip, HKDF — on an in-memory relay, in real
 * time: two links with the pairing key find each other and exchange a message that spans several
 * events; a link with another key hears nothing of them.
 */

import { createRelayCodec, cryptoRandom, bytesToBase64Url } from '../../src/ts/core/remote/relayCodec';
import { createRelayLink } from '../../src/ts/core/remote/relayLink';

import type { RelayIo } from '../../src/ts/core/remote/relayLink';

const KEY = 'real-pairing-key-'.padEnd(43, 'x');

/** A relay that hands every event to every endpoint, the publisher's own included. */
const createPlainBus = (): { endpoint: () => RelayIo; contents: string[] } => {
    const listeners: Array<Set<(content: string) => void>> = [];
    const contents: string[] = [];
    return {
        contents,
        endpoint: () => {
            const mine = new Set<(content: string) => void>();
            listeners.push(mine);
            return {
                publish: async (_topic, content) => {
                    contents.push(content);
                    setTimeout(() => {
                        for (const set of listeners) for (const handler of set) handler(content);
                    }, 1);
                },
                onEvent: (handler) => {
                    mine.add(handler);
                    return () => mine.delete(handler);
                },
                onOpen: () => () => undefined,
                subscribe: () => undefined,
                close: () => undefined,
            };
        },
    };
};

const until = async (condition: () => boolean, ms = 4_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

describe('the relay link over the real codec', () => {
    test('two links with the pairing key join and exchange a multi-event message; another key hears nothing', async () => {
        const bus = createPlainBus();
        const host = createRelayLink({
            io: bus.endpoint(),
            codec: createRelayCodec(KEY),
            topic: 't',
            selfId: 'host-id',
            role: 'host',
        });
        const stranger = createRelayLink({
            io: bus.endpoint(),
            codec: createRelayCodec('another-key'.padEnd(43, 'y')),
            topic: 't',
            selfId: 'stranger-id',
            role: 'host',
        });
        const strangerSaw: string[] = [];
        stranger.onPeerJoin((peerId) => strangerSaw.push(peerId));
        const hostJoins: string[] = [];
        host.onPeerJoin((peerId) => hostJoins.push(peerId));
        const phone = createRelayLink({
            io: bus.endpoint(),
            codec: createRelayCodec(KEY),
            topic: 't',
            selfId: 'phone-id',
            role: 'phone',
        });
        const received: unknown[] = [];
        phone.onMessage((_peerId, message) => received.push(message));
        const phoneJoins: string[] = [];
        phone.onPeerJoin((peerId) => phoneJoins.push(peerId));

        await until(() => hostJoins.length > 0 && phoneJoins.length > 0);
        expect(hostJoins).toEqual(['phone-id']);
        expect(phoneJoins).toEqual(['host-id']);

        // Random text does not compress: the message needs several events.
        const payload = bytesToBase64Url(Uint8Array.from({ length: 90_000 }, () => cryptoRandom(1)[0]));
        await host.send({ t: 'result', id: 1, ok: true, result: payload }, 'phone-id');
        await until(() => received.length > 0);
        expect(received).toEqual([{ t: 'result', id: 1, ok: true, result: payload }]);

        expect(strangerSaw).toEqual([]);
        expect(bus.contents.length).toBeGreaterThan(4);
        expect(bus.contents.every((content) => !content.includes(KEY))).toBe(true);
        await Promise.all([host.leave(), phone.leave(), stranger.leave()]);
    });
});
