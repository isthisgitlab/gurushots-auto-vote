/**
 * An in-memory relay for the relay-link tests: every endpoint's publish reaches every
 * endpoint's listeners (the publisher's own included, as a relay echoes to the publisher's
 * subscription), a test can drop frames by predicate, and a stub codec keeps the frames
 * readable and synchronous-ish (the real codec has its own tests). No timers, only promises, so
 * it runs under Jest's fake timers.
 */

import { parseHeader } from '../../src/ts/core/remote/relayCodec';
import { joinBytes } from '../../src/ts/core/remote/relayWire';
import { isPlainObject } from '../../src/ts/core/plainObject';
import { isArrayOf, isNumber, isShape, isString, parseJson, parseJsonAs } from './parseJson';

import type { FrameHeader, RelayCodec } from '../../src/ts/core/remote/relayCodec';
import type { Batch, BatchFrame, BatchHeader } from '../../src/ts/core/remote/relayBatchCodec';
import type { RelayIo } from '../../src/ts/core/remote/relayLink';

export const TOPIC = 'topic-under-test';

/** The stub codec's wire format: the header and the part's bytes as JSON. */
const isStubFrame = isShape<{ header: FrameHeader; part: number[] }>({
    header: (value): value is FrameHeader => parseHeader(value) !== null,
    part: isArrayOf(isNumber),
});

/** The stub codec's batch format: the batch with its part bytes as number arrays. */
type StubBatchFrame = Omit<BatchFrame, 'bytes'> & { bytes: number[] };
type StubBatch = { batch: { header: BatchHeader; acks: string[]; frames: StubBatchFrame[] } };
const isStubBatch = isShape<StubBatch>({
    batch: isShape<StubBatch['batch']>({
        header: (value): value is BatchHeader => isPlainObject(value) && value.v === 2,
        acks: isArrayOf(isString),
        frames: isArrayOf(
            isShape<StubBatchFrame>({
                msgId: isString,
                stream: isString,
                seq: isNumber,
                part: isNumber,
                parts: isNumber,
                bytes: isArrayOf(isNumber),
            }),
        ),
    }),
});

const readStubBatch = ({ batch }: StubBatch): Batch => ({
    ...batch,
    frames: batch.frames.map((frame) => ({ ...frame, bytes: Uint8Array.from(frame.bytes) })),
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
        sealBatch: async (batch) =>
            JSON.stringify({ batch: { ...batch, frames: batch.frames.map((f) => ({ ...f, bytes: [...f.bytes] })) } }),
        open: async (content) => {
            codec.opened += 1;
            if (codec.refuse) return null;
            const raw = parseJson(content);
            if (isStubBatch(raw)) return { batch: readStubBatch(raw) };
            const parsed = parseJsonAs(content, isStubFrame);
            return { header: parsed.header, part: Uint8Array.from(parsed.part) };
        },
        pack: async (message) => new TextEncoder().encode(JSON.stringify(message)),
        unpack: async (bytes) => {
            try {
                return { message: parseJson(new TextDecoder().decode(bytes)), size: bytes.length };
            } catch {
                return null;
            }
        },
    };
    return codec;
};

/** A frame as the bus saw it published. */
export type Published = {
    content: string;
    header: FrameHeader;
    part: Uint8Array;
    endpoint: number;
    /** Set on the frame-shaped view of an item inside a batch event (see `Bus.items`). */
    viaBatch?: true;
};

/** A batch event as the bus saw it published. */
export type PublishedBatch = { content: string; batch: Batch; endpoint: number };

export type Bus = {
    /** Every frame published, in order, including the ones the filter dropped. */
    readonly published: Published[];
    /** Every batch event published, in order, including the ones the batch filter dropped. */
    readonly batches: PublishedBatch[];
    /**
     * Every data part and every ack that was published, in order, whether it travelled as a frame or inside a batch
     * event (an item of a batch is shown as the frame it stands for, marked `viaBatch`), so a test of what the link
     * does can ask the same question in both modes. `filter` drops items of either kind; a batch with no item left is lost.
     */
    readonly items: Published[];
    /** Returns false for a batch event that should be lost. */
    batchFilter: (batch: PublishedBatch) => boolean;
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

/** The frames a batch event stands for: one ack frame for each acknowledged id, one data frame for each part. */
const batchItems = ({ content, batch, endpoint }: PublishedBatch): Published[] => {
    const { header } = batch;
    const common = {
        v: 1 as const,
        from: header.from,
        to: header.to,
        toEpoch: header.toEpoch,
        epoch: header.epoch,
        ts: header.ts,
    };
    const acks = batch.acks.map(
        (msgId): Published => ({
            content,
            endpoint,
            viaBatch: true,
            part: new Uint8Array(0),
            header: { ...common, msgId, stream: '', seq: 0, part: 0, parts: 1, kind: 'ack' },
        }),
    );
    const frames = batch.frames.map(
        ({ bytes, ...frame }): Published => ({
            content,
            endpoint,
            viaBatch: true,
            part: bytes,
            header: { ...common, ...frame, kind: 'data' },
        }),
    );
    return [...acks, ...frames];
};

/** The event of a batch without the items the filter dropped (the stub codec's JSON, rebuilt). */
const keepOnly = (raw: StubBatch, kept: Published[]): string => {
    const ackIds = new Set(kept.filter((item) => item.header.kind === 'ack').map((item) => item.header.msgId));
    const partKeys = new Set(
        kept.filter((item) => item.header.kind === 'data').map((item) => `${item.header.msgId}|${item.header.part}`),
    );
    return JSON.stringify({
        batch: {
            ...raw.batch,
            acks: raw.batch.acks.filter((msgId) => ackIds.has(msgId)),
            frames: raw.batch.frames.filter((frame) => partKeys.has(`${frame.msgId}|${frame.part}`)),
        },
    });
};

export const createBus = (): Bus => {
    const listeners: Array<Set<(content: string) => void>> = [];
    const bus: Bus = {
        published: [],
        batches: [],
        items: [],
        batchFilter: () => true,
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
                    const raw = parseJson(content);
                    if (isStubBatch(raw)) {
                        const published: PublishedBatch = { content, batch: readStubBatch(raw), endpoint: index };
                        bus.batches.push(published);
                        const items = batchItems(published);
                        bus.items.push(...items);
                        if (!bus.batchFilter(published)) return;
                        const kept = items.filter((item) => bus.filter(item));
                        if (kept.length === 0) return;
                        bus.inject(kept.length === items.length ? content : keepOnly(raw, kept));
                        return;
                    }
                    const parsed = parseJsonAs(content, isStubFrame);
                    const frame: Published = {
                        content,
                        header: parsed.header,
                        part: Uint8Array.from(parsed.part),
                        endpoint: index,
                    };
                    bus.published.push(frame);
                    bus.items.push(frame);
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
    for (const frame of bus.items) {
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
