import { schnorr } from '@noble/secp256k1';

import { toHex } from './relayWire';

const NOSTR_EVENT_KIND_BASE = 20_000;
const NOSTR_EVENT_KIND_MODULUS = 10_000;
const NOSTR_EVENT_TAG = 'x';

const topicKind = (topic: string): number => {
    let sum = 0;
    for (let index = 0; index < topic.length; index++) sum = (sum + topic.charCodeAt(index)) % NOSTR_EVENT_KIND_MODULUS;
    return NOSTR_EVENT_KIND_BASE + sum;
};

const currentSecond = (): number => Math.floor(Date.now() / 1_000);

/** Builds the ephemeral Nostr frames for one relay transport. */
export const createNostrFrames = (): {
    createEvent: (topic: string, content: string) => Promise<string>;
    subscribeFrame: (subId: string, topic: string) => string;
} => {
    const { secretKey, publicKey } = schnorr.keygen();
    const pubkey = toHex(publicKey);

    return {
        createEvent: async (topic, content) => {
            const kind = topicKind(topic);
            const created_at = currentSecond();
            const tags = [[NOSTR_EVENT_TAG, topic]];
            const digest = new Uint8Array(
                await crypto.subtle.digest(
                    'SHA-256',
                    new TextEncoder().encode(JSON.stringify([0, pubkey, created_at, kind, tags, content])),
                ),
            );
            return JSON.stringify([
                'EVENT',
                {
                    kind,
                    tags,
                    created_at,
                    content,
                    pubkey,
                    id: toHex(digest),
                    sig: toHex(await schnorr.signAsync(digest, secretKey)),
                },
            ]);
        },
        subscribeFrame: (subId, topic) =>
            JSON.stringify([
                'REQ',
                subId,
                { kinds: [topicKind(topic)], since: currentSecond(), [`#${NOSTR_EVENT_TAG}`]: [topic] },
            ]),
    };
};
