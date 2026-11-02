/**
 * An in-memory relay for the relay-link tests: every endpoint's publish reaches every
 * endpoint's listeners (the publisher's own included, as a relay echoes to the publisher's
 * subscription), a test can drop frames by predicate, and a stub codec keeps the frames
 * readable and synchronous-ish (the real codec has its own tests). No timers, only promises, so
 * it runs under Jest's fake timers.
 */

import { joinBytes, parseHeader } from '../../src/ts/core/remote/relayCodec';
import { isArrayOf, isNumber, isShape, parseJson, parseJsonAs } from './parseJson';

import type { FrameHeader, RelayCodec } from '../../src/ts/core/remote/relayCodec';
import type { RelayIo } from '../../src/ts/core/remote/relayLink';

export const TOPIC = 'topic-under-test';

/** The stub codec's wire format: the header and the part's bytes as JSON. */
const isStubFrame = isShape<{ header: FrameHeader; part: number[] }>({
    header: (value): value is FrameHeader => parseHeader(value) !== null,
    part: isArrayOf(isNumber),
});

/** Waits for every promise chain the link starts (the stub codec and the bus are all microtasks). */
export const flush = async (): Promise<void> => {
    for (let i = 0; i < 300; i++) await Promise.resolve();
};

export type StubCodec = RelayCodec & {
    /** How many contents `open` has been asked to open. */
    opened: number;
    /** Makes `open` answer null (a frame sealed under another key). */
    refuse: boolean;
};

export const stubCodec = (): StubCodec => {
    const codec: StubCodec = {
        opened: 0,
        refuse: false,
        seal: async (header, part) => JSON.stringify({ header, part: [...part] }),
        open: async (content) => {
            codec.opened += 1;
            if (codec.refuse) return null;
            const parsed = parseJsonAs(content, isStubFrame);
            return { header: parsed.header, part: Uint8Array.from(parsed.part) };
        },
        pack: async (message) => new TextEncoder().encode(JSON.stringify(message)),
        unpack: async (bytes) => {
            try {
                return { message: parseJson(new TextDecoder().decode(bytes)) };
            } catch {
                return null;
            }
        },
    };
    return codec;
};

/** A frame as the bus saw it published. */
export type Published = { content: string; header: FrameHeader; part: Uint8Array; endpoint: number };

export type Bus = {
    /** Every frame published, in order, including the ones the filter dropped. */
    readonly published: Published[];
    /** The frames that reached the listeners. */
    readonly delivered: Published[];
    /** Returns false for a frame that should be lost. */
    filter: (frame: Published) => boolean;
    /** Makes the next publishes fail. */
    failPublish: boolean;
    endpoint: () => RelayIo & {
        readonly subscribed: string[];
        closed: boolean;
        /** A relay socket opens. */ open: () => void;
    };
    /** Hands `content` to every listener, as a relay would. */
    inject: (content: string) => void;
};

export const createBus = (): Bus => {
    const listeners: Array<Set<(content: string) => void>> = [];
    const bus: Bus = {
        published: [],
        delivered: [],
        filter: () => true,
        failPublish: false,
        endpoint: () => {
            const mine = new Set<(content: string) => void>();
            const openHandlers = new Set<() => void>();
            const index = listeners.push(mine) - 1;
            const endpoint = {
                subscribed: [] as string[],
                closed: false,
                publish: async (_topic: string, content: string): Promise<void> => {
                    if (bus.failPublish) throw new Error('no relay is connected');
                    const parsed = parseJsonAs(content, isStubFrame);
                    const frame: Published = {
                        content,
                        header: parsed.header,
                        part: Uint8Array.from(parsed.part),
                        endpoint: index,
                    };
                    bus.published.push(frame);
                    if (!bus.filter(frame)) return;
                    bus.delivered.push(frame);
                    bus.inject(content);
                },
                onEvent: (handler: (content: string) => void) => {
                    mine.add(handler);
                    return () => mine.delete(handler);
                },
                onOpen: (handler: () => void) => {
                    openHandlers.add(handler);
                    return () => openHandlers.delete(handler);
                },
                open: () => {
                    for (const handler of openHandlers) handler();
                },
                subscribe: (topic: string) => {
                    endpoint.subscribed.push(topic);
                },
                close: () => {
                    endpoint.closed = true;
                },
            };
            return endpoint;
        },
        inject: (content) => {
            void Promise.resolve().then(() => {
                for (const set of listeners) for (const handler of set) handler(content);
            });
        },
    };
    return bus;
};

/** The messages published by one endpoint to one peer, reassembled from their data frames, in sequence order. */
export const publishedMessages = (bus: Bus, endpoint: number, to: string): unknown[] => {
    const byMessage = new Map<string, Published[]>();
    for (const frame of bus.published) {
        if (frame.endpoint !== endpoint || frame.header.kind !== 'data' || frame.header.to !== to) continue;
        byMessage.set(frame.header.msgId, [...(byMessage.get(frame.header.msgId) ?? []), frame]);
    }
    return [...byMessage.values()]
        .filter((frames) => new Set(frames.map((frame) => frame.header.part)).size === frames[0].header.parts)
        .sort((a, b) => a[0].header.seq - b[0].header.seq)
        .map((frames) => {
            const parts = new Map<number, Uint8Array>();
            for (const frame of frames) parts.set(frame.header.part, frame.part);
            const ordered = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part);
            return parseJson(new TextDecoder().decode(joinBytes(ordered)));
        });
};
