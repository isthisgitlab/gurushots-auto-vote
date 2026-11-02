/**
 * The relay link's batch events (`v: 2`): two links that read them use them, a link that does not
 * (the first release of the link, here a link with batching switched off) is sent the frames it
 * knows, a peer is sent batches only while its latest presence advertised them, and a crafted
 * batch gets the same checks a frame gets, made once for the whole event.
 */

import { createRelayLink } from '../../src/ts/core/remote/relayLink';
import {
    DECRYPT_FRAMES_PER_SECOND,
    FINISHED_MESSAGES_BURST,
    FRAME_MAX_SKEW_MS,
    FINISHED_MESSAGES_PER_SECOND,
    RE_ACK_MIN_MS,
    REPLAY_MEMORY_MAX_ENTRIES,
    REPLAY_MEMORY_MS,
} from '../../src/ts/core/remote/relayLinkFrames';
import { RELAY_BATCH_MAX_FRAMES } from '../../src/ts/core/remote/relayBatchCodec';
import { RELAY_PART_BYTES } from '../../src/ts/core/remote/relayWire';
import { MAX_CONCURRENT_INFLATES, MAX_QUEUED_INFLATES } from '../../src/ts/core/remote/relayInflate';
import { ACK_LINGER_MS, MAX_OWED_ACKS, RESEND_MS } from '../../src/ts/core/remote/relayOutbox';
import { TOPIC, createBus, flush, stubCodec } from '../helpers/relayBus';

import type { FrameHeader } from '../../src/ts/core/remote/relayCodec';
import type { Batch, BatchFrame } from '../../src/ts/core/remote/relayBatchCodec';
import type { Bus, PublishedBatch } from '../helpers/relayBus';
import type { LinkRole } from '../../src/ts/core/remote/relayLink';

const EPOCH = 'e'.repeat(32);
const NEW_EPOCH = 'd'.repeat(32);
const STREAM = '5'.repeat(32);
const msgId = (n: number): string => n.toString(16).padStart(32, '0');

type Side = {
    transport: ReturnType<typeof createRelayLink>;
    codec: ReturnType<typeof stubCodec>;
    joins: string[];
    leaves: string[];
    messages: Array<[string, unknown]>;
    index: number;
};

describe('relay link batches', () => {
    let bus: Bus;
    let endpoints: number;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(1_700_000_000_000);
        bus = createBus();
        endpoints = 0;
    });
    afterEach(() => jest.useRealTimers());

    const run = async (ms: number, step = 25): Promise<void> => {
        for (let at = 0; at < ms; at += step) {
            jest.advanceTimersByTime(step);
            await flush();
        }
    };

    const side = (role: LinkRole, selfId: string, batching = true): Side => {
        const codec = stubCodec();
        const transport = createRelayLink({
            io: bus.endpoint(),
            codec,
            topic: TOPIC,
            selfId,
            role,
            batching,
        });
        const recorded: Side = { transport, codec, joins: [], leaves: [], messages: [], index: endpoints++ };
        transport.onPeerJoin((peerId) => recorded.joins.push(peerId));
        transport.onPeerLeave((peerId) => recorded.leaves.push(peerId));
        transport.onMessage((peerId, message) => recorded.messages.push([peerId, message]));
        return recorded;
    };

    const pair = async (hostBatching = true, phoneBatching = true): Promise<{ host: Side; phone: Side }> => {
        const host = side('host', 'host-id', hostBatching);
        const phone = side('phone', 'phone-id', phoneBatching);
        await run(600);
        return { host, phone };
    };

    /** The desktop answers every invoke at once, as the host does. */
    const answerInvokes = (host: Side): void => {
        host.transport.onMessage((peerId, message) => {
            if (typeof message === 'object' && message !== null && 't' in message && message.t === 'invoke') {
                void host.transport.send({ t: 'result', ok: true }, peerId);
            }
        });
    };

    const shape = (batch: PublishedBatch): [number, number, number] => [
        batch.endpoint,
        batch.batch.acks.length,
        batch.batch.frames.length,
    ];

    describe('two links that read batches', () => {
        test('each says in its presence that it reads them', async () => {
            await pair();
            const presences = bus.published.filter((frame) => frame.header.kind === 'presence');
            expect(presences.length).toBeGreaterThanOrEqual(2);
            expect(presences.every((frame) => frame.header.batch === true)).toBe(true);
        });

        test('an invoke, its result and the acks take three events, not four, and nothing is sent twice', async () => {
            const { host, phone } = await pair();
            answerInvokes(host);
            const dataFramesBefore = bus.published.filter((frame) => frame.header.kind !== 'presence').length;
            await phone.transport.send({ t: 'invoke', id: 1 }, 'host-id');
            await run(RESEND_MS * 2);
            expect(host.messages).toEqual([['phone-id', { t: 'invoke', id: 1 }]]);
            expect(phone.messages).toEqual([['host-id', { t: 'result', ok: true }]]);
            // The invoke; the host's ack with its result; the phone's ack of the result.
            expect(bus.batches.map(shape)).toEqual([
                [phone.index, 0, 1],
                [host.index, 1, 1],
                [phone.index, 1, 0],
            ]);
            expect(bus.published.filter((frame) => frame.header.kind !== 'presence')).toHaveLength(dataFramesBefore);
        });

        test('messages sent while the budget is spent leave together, and arrive in order', async () => {
            const { host, phone } = await pair();
            for (let n = 1; n <= 30; n++) await phone.transport.send({ n }, 'host-id');
            await run(RESEND_MS * 2);
            expect(host.messages.map(([, message]) => message)).toEqual(
                Array.from({ length: 30 }, (_v, i) => ({ n: i + 1 })),
            );
            expect(
                bus.batches.filter((batch) => batch.endpoint === phone.index && batch.batch.frames.length > 0),
            ).toHaveLength(2);
            expect(host.leaves).toEqual([]);
        });

        test('a lost batch is sent again and delivered once', async () => {
            const { host, phone } = await pair();
            let dropped = false;
            bus.batchFilter = (batch) => {
                if (batch.endpoint !== phone.index || batch.batch.frames.length === 0 || dropped) return true;
                dropped = true;
                return false;
            };
            await phone.transport.send({ t: 'one' }, 'host-id');
            await run(RESEND_MS - 500);
            expect(host.messages).toEqual([]);
            await run(1_000);
            expect(host.messages).toEqual([['phone-id', { t: 'one' }]]);
            await run(RESEND_MS * 2);
            expect(host.messages).toHaveLength(1);
            expect(phone.leaves).toEqual([]);
        });

        test('a batch that cannot be published is not an error: the parts are sent again', async () => {
            const { host, phone } = await pair();
            bus.failPublish = true;
            await phone.transport.send({ t: 'one' }, 'host-id');
            await run(200);
            bus.failPublish = false;
            await run(RESEND_MS + 500);
            expect(host.messages).toEqual([['phone-id', { t: 'one' }]]);
        });
    });

    describe('a link that predates batches', () => {
        test('a new host and an old phone join, say hello and run an invoke both ways with frames', async () => {
            const { host, phone } = await pair(true, false);
            expect(host.joins).toEqual(['phone-id']);
            expect(phone.joins).toEqual(['host-id']);
            answerInvokes(host);
            await phone.transport.send({ t: 'invoke', id: 1 }, 'host-id');
            await host.transport.send({ t: 'hello' }, 'phone-id');
            await run(RESEND_MS * 2);
            expect(host.messages).toEqual([['phone-id', { t: 'invoke', id: 1 }]]);
            expect(phone.messages).toEqual([
                ['host-id', { t: 'hello' }],
                ['host-id', { t: 'result', ok: true }],
            ]);
            expect(bus.batches).toEqual([]);
            expect(bus.published.some((frame) => frame.header.kind === 'ack')).toBe(true);
            expect(host.leaves).toEqual([]);
            expect(phone.leaves).toEqual([]);
        });

        test('an old host and a new phone do the same', async () => {
            const { host, phone } = await pair(false, true);
            answerInvokes(host);
            await phone.transport.send({ t: 'invoke', id: 1 }, 'host-id');
            await host.transport.send({ t: 'hello' }, 'phone-id');
            await run(RESEND_MS * 2);
            expect(host.messages).toEqual([['phone-id', { t: 'invoke', id: 1 }]]);
            expect(phone.messages).toEqual([
                ['host-id', { t: 'hello' }],
                ['host-id', { t: 'result', ok: true }],
            ]);
            expect(bus.batches).toEqual([]);
            expect(host.leaves).toEqual([]);
            expect(phone.leaves).toEqual([]);
        });

        test('presence of a link with batching off carries no flag', async () => {
            await pair(false, false);
            const presences = bus.published.filter((frame) => frame.header.kind === 'presence');
            expect(presences.length).toBeGreaterThan(0);
            expect(presences.some((frame) => 'batch' in frame.header)).toBe(false);
        });

        test('a link with batching off does not read a batch event: the sender is not joined', async () => {
            const old = side('host', 'host-id', false);
            const craftedCodec = stubCodec();
            const batch: Batch = {
                header: {
                    v: 2,
                    id: msgId(1),
                    from: 'raw-id',
                    to: 'host-id',
                    toEpoch: EPOCH,
                    epoch: NEW_EPOCH,
                    ts: Date.now(),
                },
                acks: [msgId(1)],
                frames: [],
            };
            bus.inject(await craftedCodec.sealBatch(batch));
            await run(100);
            expect(old.joins).toEqual([]);
            expect(bus.published).toHaveLength(0);
        });
    });

    describe('what a peer is sent', () => {
        let host: Side;
        let hostEpoch: string;
        const codec = stubCodec();

        beforeEach(async () => {
            host = side('host', 'host-id');
        });

        const presence = async (overrides: Partial<FrameHeader> = {}): Promise<void> => {
            const header: FrameHeader = {
                v: 1,
                from: 'raw-id',
                to: '',
                toEpoch: '',
                epoch: EPOCH,
                msgId: msgId(Math.floor(Math.random() * 1e9)),
                stream: '',
                seq: 0,
                part: 0,
                parts: 1,
                ts: Date.now(),
                kind: 'presence',
                ...overrides,
            };
            bus.inject(await codec.seal(header, new Uint8Array(0)));
            await run(100);
            hostEpoch = bus.published.find((frame) => frame.header.kind === 'presence')?.header.epoch ?? '';
        };

        const dataTo = (peer: string) =>
            bus.published.filter((frame) => frame.header.kind === 'data' && frame.header.to === peer);
        const batchesTo = (peer: string) => bus.batches.filter((published) => published.batch.header.to === peer);

        test('a peer whose presence advertised batches is sent batches', async () => {
            await presence({ batch: true });
            await host.transport.send({ t: 'one' }, 'raw-id');
            await run(100);
            expect(batchesTo('raw-id')).toHaveLength(1);
            expect(dataTo('raw-id')).toHaveLength(0);
            expect(batchesTo('raw-id')[0].batch.header).toMatchObject({ v: 2, from: 'host-id', toEpoch: EPOCH });
        });

        test('a peer whose presence did not is sent frames', async () => {
            await presence();
            await host.transport.send({ t: 'one' }, 'raw-id');
            await run(100);
            expect(batchesTo('raw-id')).toHaveLength(0);
            expect(dataTo('raw-id')).toHaveLength(1);
        });

        test('a peer that rejoins with a new epoch and no flag is sent frames again', async () => {
            await presence({ batch: true });
            await host.transport.send({ t: 'one' }, 'raw-id');
            await run(100);
            expect(batchesTo('raw-id')).toHaveLength(1);
            jest.advanceTimersByTime(1_000);
            await presence({ epoch: NEW_EPOCH, ts: Date.now() });
            expect(host.joins).toEqual(['raw-id', 'raw-id']);
            await host.transport.send({ t: 'two' }, 'raw-id');
            await run(100);
            expect(batchesTo('raw-id')).toHaveLength(1);
            expect(dataTo('raw-id')).toHaveLength(1);
        });

        test('the latest presence decides: a flag withdrawn in the same epoch ends the batches', async () => {
            await presence({ batch: true });
            await presence();
            await host.transport.send({ t: 'one' }, 'raw-id');
            await run(100);
            expect(batchesTo('raw-id')).toHaveLength(0);
            expect(dataTo('raw-id')).toHaveLength(1);
        });

        test('a peer whose id would not fit a batch header is sent frames', async () => {
            const odd = String.fromCharCode(1).repeat(64); // six bytes each once JSON-escaped
            await presence({ batch: true, from: odd });
            await host.transport.send({ t: 'one' }, odd);
            await run(100);
            expect(batchesTo(odd)).toHaveLength(0);
            expect(dataTo(odd)).toHaveLength(1);
        });

        test('acks owed to a peer that withdrew the batch flag leave as frames', async () => {
            await presence({ batch: true });
            const header: FrameHeader = {
                v: 1,
                from: 'raw-id',
                to: 'host-id',
                toEpoch: hostEpoch,
                epoch: EPOCH,
                msgId: msgId(1),
                stream: STREAM,
                seq: 0,
                part: 0,
                parts: 1,
                ts: Date.now(),
                kind: 'data',
            };
            bus.inject(await codec.seal(header, new TextEncoder().encode('{"t":"one"}')));
            await flush();
            // The ack is owed in a batch; before it leaves, the peer's presence says it no longer reads them.
            bus.inject(
                await codec.seal(
                    { ...header, to: '', toEpoch: '', stream: '', kind: 'presence', msgId: msgId(2) },
                    new Uint8Array(0),
                ),
            );
            await run(ACK_LINGER_MS + 200);
            expect(bus.batches).toHaveLength(0);
            expect(
                bus.published.filter((frame) => frame.header.kind === 'ack').map((frame) => frame.header.msgId),
            ).toEqual([msgId(1)]);
        });

        test('a peer that never said anything about batches is acknowledged with a frame', async () => {
            await presence();
            const header: FrameHeader = {
                v: 1,
                from: 'raw-id',
                to: 'host-id',
                toEpoch: hostEpoch,
                epoch: EPOCH,
                msgId: msgId(1),
                stream: STREAM,
                seq: 0,
                part: 0,
                parts: 1,
                ts: Date.now(),
                kind: 'data',
            };
            bus.inject(await codec.seal(header, new TextEncoder().encode('{"t":"one"}')));
            await run(100);
            expect(bus.published.filter((frame) => frame.header.kind === 'ack')).toHaveLength(1);
            expect(bus.batches).toHaveLength(0);
        });
    });

    describe('a peer whose ids are heavy in bytes', () => {
        const control = (count: number): string => String.fromCharCode(1).repeat(count); // six bytes each once JSON-escaped
        const codec = stubCodec();

        test.each([
            ['64 euro signs to 40 euro signs', '€'.repeat(64), '€'.repeat(40)],
            ['64 euro signs to 64 letters', '€'.repeat(64), 'b'.repeat(64)],
            ['40 control characters to a short id', control(40), 'peer-b'],
            ['50 control characters to a short id', control(50), 'peer-b'],
        ])(
            '%s: a message whose first part is a full part is sent as frames, and a normal peer still gets batches',
            async (_name, from, to) => {
                const host = side('host', from);
                const advertise = async (peer: string): Promise<void> => {
                    const header: FrameHeader = {
                        v: 1,
                        from: peer,
                        to: '',
                        toEpoch: '',
                        epoch: EPOCH,
                        msgId: msgId(Math.floor(Math.random() * 1e9)),
                        stream: '',
                        seq: 0,
                        part: 0,
                        parts: 1,
                        ts: Date.now(),
                        kind: 'presence',
                        batch: true,
                    };
                    bus.inject(await codec.seal(header, new Uint8Array(0)));
                    await run(100);
                };
                await advertise(to);
                await advertise('normal-id');
                const big = { pad: 'x'.repeat(RELAY_PART_BYTES + 200) };
                await expect(host.transport.send(big, to)).resolves.toBeUndefined();
                await host.transport.send({ t: 'small' }, 'normal-id');
                await run(500);
                expect(bus.batches.filter((published) => published.batch.header.to === to)).toEqual([]);
                const frames = bus.published.filter(
                    (published) => published.header.kind === 'data' && published.header.to === to,
                );
                expect(frames).toHaveLength(2);
                expect(frames[0].part).toHaveLength(RELAY_PART_BYTES);
                // The other peer is unaffected, and so is the link: nothing threw, nothing is stuck. (When the link's
                // own id is the heavy one, no peer has room for a batch, and the other peer is sent a frame as well.)
                const forNormal = [
                    ...bus.batches.filter((published) => published.batch.header.to === 'normal-id'),
                    ...bus.published.filter(
                        (published) => published.header.kind === 'data' && published.header.to === 'normal-id',
                    ),
                ];
                expect(forNormal).toHaveLength(1);
                expect(host.leaves).toEqual([]);
            },
        );
    });

    describe('a crafted batch', () => {
        const codec = stubCodec();
        let host: Side;
        let hostEpoch: string;
        let ts: number;
        let batchNumber: number;

        beforeEach(async () => {
            batchNumber = 0;
            host = side('host', 'host-id');
            // Learn the host's epoch the way a peer does: from the presence it answers a new peer with.
            const header: FrameHeader = {
                v: 1,
                from: 'raw-id',
                to: '',
                toEpoch: '',
                epoch: EPOCH,
                msgId: msgId(900),
                stream: '',
                seq: 0,
                part: 0,
                parts: 1,
                ts: Date.now(),
                kind: 'presence',
            };
            bus.inject(await codec.seal(header, new Uint8Array(0)));
            await run(200);
            hostEpoch = bus.published[0].header.epoch;
            host.joins.length = 0;
            ts = Date.now();
        });

        const message = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
        const frame = (n: number, value: unknown, overrides: Partial<BatchFrame> = {}): BatchFrame => ({
            msgId: msgId(n),
            stream: STREAM,
            seq: n - 1,
            part: 0,
            parts: 1,
            bytes: message(value),
            ...overrides,
        });
        /** The event of a batch from the crafted peer; every call is a batch of its own (a new id) unless `header` names one. */
        const sealed = (items: { acks?: string[]; frames?: BatchFrame[] }, header: Partial<Batch['header']> = {}) =>
            codec.sealBatch({
                header: {
                    v: 2,
                    id: msgId(100_000 + batchNumber++),
                    from: 'raw-id',
                    to: 'host-id',
                    toEpoch: hostEpoch,
                    epoch: EPOCH,
                    ts,
                    ...header,
                },
                acks: items.acks ?? [],
                frames: items.frames ?? [],
            });
        const send = async (
            items: { acks?: string[]; frames?: BatchFrame[] },
            header: Partial<Batch['header']> = {},
        ): Promise<void> => {
            bus.inject(await sealed(items, header));
            await run(100);
        };
        /** Delivers an event without letting any time pass (the budgets refill with time). */
        const sendNow = async (items: { acks?: string[]; frames?: BatchFrame[] }): Promise<void> => {
            bus.inject(await sealed(items));
            await flush();
        };
        const leavesOf = (peerId: string): string[] => host.leaves.filter((left) => left === peerId);
        const byeFrom = async (from: string, epoch = EPOCH): Promise<void> => {
            const header: FrameHeader = {
                v: 1,
                from,
                to: '',
                toEpoch: '',
                epoch,
                msgId: msgId(777),
                stream: '',
                seq: 0,
                part: 0,
                parts: 1,
                ts,
                kind: 'bye',
            };
            bus.inject(await codec.seal(header, new Uint8Array(0)));
            await run(100);
        };
        const hostBatches = (): PublishedBatch[] => bus.batches.filter((published) => published.endpoint === 0);

        test('its parts are delivered, and acknowledged in a batch', async () => {
            await send({ frames: [frame(1, { t: 'one' }), frame(2, { t: 'two' })] });
            expect(host.messages).toEqual([
                ['raw-id', { t: 'one' }],
                ['raw-id', { t: 'two' }],
            ]);
            await run(ACK_LINGER_MS + 100);
            expect(hostBatches().map((published) => published.batch.acks)).toEqual([[msgId(1), msgId(2)]]);
        });

        test('a batch from a peer not yet known joins it and is answered with presence', async () => {
            await send({ acks: [msgId(1)] }, { from: 'other-id' });
            expect(host.joins).toEqual(['other-id']);
            expect(
                bus.published.filter(
                    (published) => published.header.kind === 'presence' && published.header.to === 'other-id',
                ),
            ).toHaveLength(1);
        });

        test('a part of several is joined when its parts arrive in different batches', async () => {
            const whole = message({ t: 'big' });
            const halves = [whole.subarray(0, 4), whole.subarray(4)];
            await send({ frames: [frame(1, null, { part: 0, parts: 2, bytes: halves[0] })] });
            expect(host.messages).toEqual([]);
            await send({ frames: [frame(1, null, { part: 1, parts: 2, bytes: halves[1] })] });
            expect(host.messages).toEqual([['raw-id', { t: 'big' }]]);
        });

        test("acks end the resend of the host's messages; the same ack again changes nothing", async () => {
            await host.transport.send({ t: 'to-peer' }, 'raw-id');
            await run(100);
            const sentMsgId = bus.published.find((published) => published.header.kind === 'data')?.header.msgId;
            expect(sentMsgId).toBeDefined();
            await send({ acks: [sentMsgId ?? ''] });
            await send({ acks: [sentMsgId ?? ''] });
            await run(RESEND_MS * 5);
            expect(bus.published.filter((published) => published.header.kind === 'data')).toHaveLength(1);
            expect(host.leaves).toEqual([]);
        });

        test('without the acks the host sends again and gives the peer up', async () => {
            await host.transport.send({ t: 'to-peer' }, 'raw-id');
            await run(RESEND_MS * 5);
            expect(host.leaves).toEqual(['raw-id']);
        });

        test('a batch delivered again (the same id) is dropped whole: nothing is delivered or acknowledged twice', async () => {
            const items = { frames: [frame(1, { t: 'one' })] };
            await send(items, { id: msgId(5) });
            await run(ACK_LINGER_MS + 100);
            expect(hostBatches()).toHaveLength(1);
            await run(RE_ACK_MIN_MS);
            await send(items, { id: msgId(5) });
            await run(ACK_LINGER_MS + 100);
            expect(hostBatches()).toHaveLength(1);
            expect(host.messages).toHaveLength(1);
        });

        test('a message sent again in a batch of its own is delivered once and acknowledged again after the minimum wait', async () => {
            const items = { frames: [frame(1, { t: 'one' })] };
            await send(items);
            await run(ACK_LINGER_MS + 100);
            expect(hostBatches()).toHaveLength(1);
            await send(items); // too soon to be acknowledged again
            await run(ACK_LINGER_MS + 100);
            expect(hostBatches()).toHaveLength(1);
            await run(RE_ACK_MIN_MS);
            await send(items);
            await run(ACK_LINGER_MS + 100);
            expect(hostBatches().map((published) => published.batch.acks)).toEqual([[msgId(1)], [msgId(1)]]);
            expect(host.messages).toHaveLength(1);
        });

        test('a message the host never saw, sent in a batch of its own after another was dropped, is delivered', async () => {
            await send({ frames: [frame(1, { t: 'one' })] }, { id: msgId(5) });
            await send({ frames: [frame(1, { t: 'one' })] }, { id: msgId(5) }); // the same event again: dropped
            await send({ frames: [frame(2, { t: 'two' })] });
            expect(host.messages.map(([, value]) => value)).toEqual([{ t: 'one' }, { t: 'two' }]);
        });

        test('a batch delivered again after the peer said bye does not join it again', async () => {
            const items = { acks: [msgId(1)] };
            await send(items, { from: 'other-id', id: msgId(5) });
            expect(host.joins).toEqual(['other-id']);
            await byeFrom('other-id');
            expect(leavesOf('other-id')).toEqual(['other-id']);
            await send(items, { from: 'other-id', id: msgId(5) });
            expect(host.joins).toEqual(['other-id']);
            expect(leavesOf('other-id')).toEqual(['other-id']);
            // A batch with an id of its own is a new event: the peer joins again.
            await send(items, { from: 'other-id' });
            expect(host.joins).toEqual(['other-id', 'other-id']);
        });

        test('a batch delivered again after the silence sweep removed the peer does not join it again', async () => {
            await send({ acks: [msgId(1)] }, { from: 'other-id', id: msgId(5) });
            await run(30_000, 1_000);
            expect(leavesOf('other-id')).toEqual(['other-id']);
            ts = Date.now(); // the replayed event keeps its own timestamp, still inside the window
            await send({ acks: [msgId(1)] }, { from: 'other-id', id: msgId(5), ts: ts - 30_000 });
            expect(host.joins).toEqual(['other-id']);
        });

        test('a replayed ack-only batch does not refresh the peer: it is still removed on schedule', async () => {
            await send({ acks: [msgId(1)] }, { from: 'other-id', id: msgId(5) });
            await run(20_000, 1_000);
            await send({ acks: [msgId(1)] }, { from: 'other-id', id: msgId(5), ts: ts });
            expect(leavesOf('other-id')).toEqual([]);
            await run(6_000, 1_000);
            expect(leavesOf('other-id')).toEqual(['other-id']);
        });

        test('a batch that is not accepted (older than the peer) is not remembered', async () => {
            await send({ frames: [frame(1, { t: 'one' })] });
            await send({ frames: [frame(2, { t: 'stale' })] }, { epoch: NEW_EPOCH, ts: ts - 10, id: msgId(5) });
            expect(host.messages).toHaveLength(1);
            // Once the peer is gone the same event is a new peer's first word: it would have been accepted had it been remembered wrongly or not.
            await byeFrom('raw-id');
            await send({ frames: [frame(2, { t: 'stale' })] }, { epoch: NEW_EPOCH, ts: ts - 10, id: msgId(5) });
            expect(host.joins).toEqual(['raw-id']);
        });

        test('a lost middle batch: the messages behind its gap wait for the resend and are delivered in order', async () => {
            const make = (from: number, count: number): BatchFrame[] =>
                Array.from({ length: count }, (_v, i) => frame(from + i, { n: from + i }));
            await send({ frames: make(1, 64) });
            // The batch of messages 65-128 is lost; the two after it, 128 messages behind the gap (all the inbox
            // holds), arrive.
            const lost = { frames: make(65, 64) };
            for (const from of [129, 193]) await send({ frames: make(from, 64) });
            await run(2_000);
            expect(host.messages.map(([, value]) => value)).toEqual(make(1, 64).map((_f, i) => ({ n: i + 1 })));
            // The sender sends the lost batch again, in a batch of its own; everything is delivered, in order.
            await send(lost);
            await run(ACK_LINGER_MS + 200);
            expect(host.messages.map(([, value]) => value)).toEqual(
                Array.from({ length: 256 }, (_v, i) => ({ n: i + 1 })),
            );
        });

        test('a lost batch with more than 128 messages behind it: the gap is skipped, and the late resend is delivered once', async () => {
            const make = (from: number, count: number): BatchFrame[] =>
                Array.from({ length: count }, (_v, i) => frame(from + i, { n: from + i }));
            await send({ frames: make(1, 64) });
            const lost = { frames: make(65, 64) };
            for (const from of [129, 193, 257]) await send({ frames: make(from, 64) }); // 192 behind the gap
            await run(ACK_LINGER_MS + 200);
            expect(host.messages).toHaveLength(64 + 192); // delivered without waiting for the lost batch
            await send(lost);
            await run(ACK_LINGER_MS + 200);
            expect(host.messages).toHaveLength(320);
            expect(new Set(host.messages.map(([, value]) => JSON.stringify(value))).size).toBe(320);
        });

        test('the link holds at most 64 MiB of inflated bytes behind gaps: past it the largest stream skips its gap', async () => {
            const MiB = 1024 * 1024;
            const realUnpack = host.codec.unpack;
            host.codec.unpack = async (bytes) => {
                const unpacked = await realUnpack(bytes);
                return unpacked === null ? null : { ...unpacked, size: 2 * MiB };
            };
            const make = (from: number, count: number): BatchFrame[] =>
                Array.from({ length: count }, (_v, i) => frame(from + i, { n: from + i }));
            await send({ frames: make(1, 1) }); // sequence 0 is delivered; message 2 (sequence 1) is lost
            await send({ frames: make(3, 32) }); // 32 × 2 MiB = 64 MiB held: at the cap, not over it
            await run(ACK_LINGER_MS + 200);
            expect(host.messages.map(([, value]) => value)).toEqual([{ n: 1 }]);
            await send({ frames: make(35, 1) }); // one more message: over the cap, the gap is skipped
            await run(ACK_LINGER_MS + 200);
            expect(host.messages).toHaveLength(1 + 32 + 1);
            expect(host.messages.at(-1)).toEqual(['raw-id', { n: 35 }]);
        });

        describe('a message dropped for the budget or the queue', () => {
            test('touches no stream state: a stray frame of another stream that is dropped does not retire the live one', async () => {
                const next = (n: number) => frame(n, { n });
                // The live stream carries a burst that spends the whole finished-message budget.
                for (let from = 1; from <= FINISHED_MESSAGES_BURST; from += 64) {
                    bus.inject(
                        await sealed({
                            frames: Array.from({ length: Math.min(64, FINISHED_MESSAGES_BURST - from + 1) }, (_v, i) =>
                                next(from + i),
                            ),
                        }),
                    );
                    await flush();
                }
                // A frame of a newer stream of the same sender, from its epoch, would replace the live stream if it were let in.
                const strayStream = '6'.repeat(32);
                const header: FrameHeader = {
                    v: 1,
                    from: 'raw-id',
                    to: 'host-id',
                    toEpoch: hostEpoch,
                    epoch: EPOCH,
                    msgId: msgId(900),
                    stream: strayStream,
                    seq: 0,
                    part: 0,
                    parts: 1,
                    ts: ts + 1_000,
                    kind: 'data',
                };
                bus.inject(await codec.seal(header, message({ n: 900 })));
                await flush();
                // The budget refills, and the live stream goes on: its next message is delivered, not ignored as retired.
                await run(1_000);
                await send({ frames: [next(FINISHED_MESSAGES_BURST + 1)] });
                expect(delivered()).toContainEqual({ n: FINISHED_MESSAGES_BURST + 1 });
                expect(delivered()).not.toContainEqual({ n: 900 });
            });

            const delivered = (): unknown[] => host.messages.map(([, value]) => value);
        });

        describe('the finished-message budget', () => {
            const frames = (from: number, count: number): BatchFrame[] =>
                Array.from({ length: count }, (_v, i) => frame(from + i, { n: from + i }));
            const ackedIds = (): string[] => hostBatches().flatMap((published) => published.batch.acks);
            const delivered = (): unknown[] => host.messages.map(([, value]) => value);
            const inOrder = (count: number): unknown[] => Array.from({ length: count }, (_v, i) => ({ n: i + 1 }));
            /** Batches of 60 messages, delivered with no time passing, until `count` messages have arrived. */
            const flood = async (count: number): Promise<void> => {
                for (let from = 1; from <= count; from += 60) {
                    await sendNow({ frames: frames(from, Math.min(60, count - from + 1)) });
                }
            };

            test('a full startup fits the burst: nothing is dropped', async () => {
                await flood(FINISHED_MESSAGES_BURST);
                await run(1_000);
                expect(delivered()).toEqual(inOrder(FINISHED_MESSAGES_BURST));
                // Every message was accepted. The acks owed all at once past the owed-ack cap lose their oldest
                // ids; those senders would resend, and the duplicates are acknowledged again.
                expect(ackedIds()).toHaveLength(MAX_OWED_ACKS);
            });

            test('messages past the burst are dropped unread, and delivered when sent again', async () => {
                await flood(FINISHED_MESSAGES_BURST + 60);
                await run(1_000);
                expect(delivered()).toEqual(inOrder(FINISHED_MESSAGES_BURST));
                expect(ackedIds()).toHaveLength(MAX_OWED_ACKS);
                expect(ackedIds()).not.toContain(msgId(FINISHED_MESSAGES_BURST + 1)); // not acknowledged: its sender sends it again
                // The sender sends the 60 again, in a batch of its own, once the budget has refilled.
                await run(1_000);
                await send({ frames: frames(FINISHED_MESSAGES_BURST + 1, 60) });
                await run(ACK_LINGER_MS + 200);
                expect(delivered()).toEqual(inOrder(FINISHED_MESSAGES_BURST + 60));
                expect(ackedIds()).toHaveLength(MAX_OWED_ACKS + 60);
                expect(ackedIds()).toContain(msgId(FINISHED_MESSAGES_BURST + 60));
            });

            test('a frame that finishes a message is charged too', async () => {
                await flood(FINISHED_MESSAGES_BURST);
                const header: FrameHeader = {
                    v: 1,
                    from: 'raw-id',
                    to: 'host-id',
                    toEpoch: hostEpoch,
                    epoch: EPOCH,
                    msgId: msgId(FINISHED_MESSAGES_BURST + 1),
                    stream: STREAM,
                    seq: FINISHED_MESSAGES_BURST,
                    part: 0,
                    parts: 1,
                    ts,
                    kind: 'data',
                };
                const next = { n: FINISHED_MESSAGES_BURST + 1 };
                bus.inject(await codec.seal(header, message(next)));
                await flush();
                expect(delivered()).toHaveLength(FINISHED_MESSAGES_BURST);
                expect(bus.published.filter((published) => published.header.kind === 'ack')).toHaveLength(0);
                await run(1_000);
                bus.inject(await codec.seal({ ...header, ts: Date.now() }, message(next)));
                await run(100);
                expect(delivered()).toHaveLength(FINISHED_MESSAGES_BURST + 1);
                await run(ACK_LINGER_MS + 100);
                expect(ackedIds()).toContain(msgId(FINISHED_MESSAGES_BURST + 1));
            });
        });

        describe('the inflation queue', () => {
            const frames = (from: number, count: number): BatchFrame[] =>
                Array.from({ length: count }, (_v, i) => frame(from + i, { n: from + i }));
            const ackedIds = (): string[] => hostBatches().flatMap((published) => published.batch.acks);
            const delivered = (): unknown[] => host.messages.map(([, value]) => value);

            /** Holds every unpack until the test lets them go, and counts how many run at once. */
            const gateUnpack = () => {
                const realUnpack = host.codec.unpack;
                const state = { calls: 0, running: 0, mostAtOnce: 0, waiting: [] as Array<() => void> };
                host.codec.unpack = async (bytes) => {
                    state.calls += 1;
                    state.running += 1;
                    state.mostAtOnce = Math.max(state.mostAtOnce, state.running);
                    await new Promise<void>((resolve) => state.waiting.push(resolve));
                    state.running -= 1;
                    return realUnpack(bytes);
                };
                const releaseAll = async (): Promise<void> => {
                    for (let rounds = 0; rounds < 1_000 && state.waiting.length > 0; rounds++) {
                        state.waiting.splice(0).forEach((release) => release());
                        await flush();
                    }
                };
                return { state, releaseAll };
            };

            test('at most four messages are unzipped at once; the others wait and are all delivered, in order', async () => {
                const { state, releaseAll } = gateUnpack();
                await sendNow({ frames: frames(1, 30) });
                expect(state.calls).toBe(MAX_CONCURRENT_INFLATES);
                await releaseAll();
                expect(state.calls).toBe(30);
                expect(state.mostAtOnce).toBe(MAX_CONCURRENT_INFLATES);
                expect(delivered()).toEqual(Array.from({ length: 30 }, (_v, i) => ({ n: i + 1 })));
            });

            test('an ack follows the unzip and parse of its message, never comes before', async () => {
                const { state, releaseAll } = gateUnpack();
                await sendNow({ frames: frames(1, 6) });
                await run(ACK_LINGER_MS + 200);
                expect(ackedIds()).toEqual([]);
                expect(delivered()).toEqual([]);
                state.waiting.splice(0, 2).forEach((release) => release()); // two of the four running end
                await flush();
                await run(ACK_LINGER_MS + 200);
                expect(ackedIds()).toEqual([msgId(1), msgId(2)]);
                await releaseAll();
                await run(ACK_LINGER_MS + 200);
                expect(ackedIds()).toEqual([1, 2, 3, 4, 5, 6].map(msgId));
            });

            test('a message sent again while it is queued or running is not queued twice and is delivered once', async () => {
                const { state, releaseAll } = gateUnpack();
                await sendNow({ frames: frames(1, 6) }); // messages 1-4 run, 5-6 wait
                await sendNow({ frames: frames(1, 6) }); // sent again, in a batch of its own
                expect(state.calls).toBe(MAX_CONCURRENT_INFLATES);
                await releaseAll();
                expect(state.calls).toBe(6);
                expect(delivered()).toEqual(Array.from({ length: 6 }, (_v, i) => ({ n: i + 1 })));
                await run(ACK_LINGER_MS + 200);
                expect(ackedIds()).toEqual([1, 2, 3, 4, 5, 6].map(msgId));
                // Once finished, a copy is the replay memory's: acknowledged again, not delivered again.
                await run(RE_ACK_MIN_MS);
                await send({ frames: frames(1, 1) });
                await run(ACK_LINGER_MS + 200);
                expect(delivered()).toHaveLength(6);
                expect(ackedIds()).toHaveLength(7);
            });

            test('a full queue drops the next message unread and unacknowledged; it is delivered when sent again', async () => {
                const { state, releaseAll } = gateUnpack();
                const capacity = MAX_CONCURRENT_INFLATES + MAX_QUEUED_INFLATES;
                // 512 fit the burst; the budget refills 100 a second, and the rest find the queue full.
                for (let from = 1; from <= FINISHED_MESSAGES_BURST; from += 56) {
                    await sendNow({ frames: frames(from, Math.min(56, FINISHED_MESSAGES_BURST - from + 1)) });
                }
                await run(1_000);
                await sendNow({ frames: frames(FINISHED_MESSAGES_BURST + 1, 60) });
                expect(state.calls).toBe(MAX_CONCURRENT_INFLATES);
                await releaseAll();
                expect(state.calls).toBe(capacity);
                expect(delivered()).toEqual(Array.from({ length: capacity }, (_v, i) => ({ n: i + 1 })));
                await run(ACK_LINGER_MS + 1_500);
                expect(ackedIds()).not.toContain(msgId(capacity + 1));
                await run(1_000);
                await send({ frames: frames(capacity + 1, 8) });
                await releaseAll();
                await run(ACK_LINGER_MS + 200);
                expect(delivered()).toHaveLength(capacity + 8);
                expect(ackedIds()).toContain(msgId(capacity + 8));
            });

            test('leaving the link drops the queue, and the unzips already running deliver, remember and acknowledge nothing', async () => {
                const { state, releaseAll } = gateUnpack();
                await sendNow({ frames: frames(1, 10) });
                expect(state.calls).toBe(MAX_CONCURRENT_INFLATES);
                const published = bus.published.length + bus.batches.length;
                await host.transport.leave();
                await releaseAll();
                await run(ACK_LINGER_MS + 200);
                expect(state.calls).toBe(MAX_CONCURRENT_INFLATES); // the queued six never started
                expect(delivered()).toEqual([]);
                expect(ackedIds()).toEqual([]);
                expect(bus.published.length + bus.batches.length).toBe(published + 1); // the bye the link sends as it leaves
            });

            test('a peer that left and came back in the same epoch while its message was being unzipped is sent the ack, and the message is remembered', async () => {
                const { releaseAll } = gateUnpack();
                await sendNow({ frames: frames(1, 1) });
                await byeFrom('raw-id');
                expect(leavesOf('raw-id')).toEqual(['raw-id']);
                const presence: FrameHeader = {
                    v: 1,
                    from: 'raw-id',
                    to: '',
                    toEpoch: '',
                    epoch: EPOCH,
                    msgId: msgId(901),
                    stream: '',
                    seq: 0,
                    part: 0,
                    parts: 1,
                    ts,
                    kind: 'presence',
                };
                bus.inject(await codec.seal(presence, new Uint8Array(0)));
                await run(100);
                expect(host.joins).toEqual(['raw-id']);
                await releaseAll();
                await run(ACK_LINGER_MS + 200);
                const acks = bus.published.filter((published) => published.header.kind === 'ack');
                expect(acks.map((published) => published.header.msgId)).toEqual([msgId(1)]);
                // It was recorded on the peer that is joined now: a copy sent again is acknowledged again (the peer
                // wrote a batch, so this ack rides in one).
                await run(RE_ACK_MIN_MS);
                await send({ frames: frames(1, 1) });
                await run(ACK_LINGER_MS + 200);
                expect(hostBatches().flatMap((published) => published.batch.acks)).toEqual([msgId(1)]);
                expect(delivered()).toHaveLength(1);
            });

            test('messages parked for a sender that left count in the link cap: the oldest are dropped and forgotten, and their resend after the sender returns is delivered', async () => {
                const MiB = 1024 * 1024;
                const { releaseAll, state } = gateUnpack();
                const gated = host.codec.unpack;
                host.codec.unpack = async (bytes) => {
                    const unpacked = await gated(bytes);
                    return unpacked === null ? null : { ...unpacked, size: 2 * MiB };
                };
                await sendNow({ frames: frames(1, 40) });
                expect(state.calls).toBe(MAX_CONCURRENT_INFLATES);
                await byeFrom('raw-id'); // the sender leaves with its messages still being unzipped
                await releaseAll();
                // 40 × 2 MiB = 80 MiB would be parked; the cap is 64 MiB: the 8 oldest are dropped.
                expect(delivered()).toEqual([]);
                // The sender returns (the same epoch), and what was kept is held behind the gap of the dropped ones.
                const presence: FrameHeader = {
                    v: 1,
                    from: 'raw-id',
                    to: '',
                    toEpoch: '',
                    epoch: EPOCH,
                    msgId: msgId(902),
                    stream: '',
                    seq: 0,
                    part: 0,
                    parts: 1,
                    ts,
                    kind: 'presence',
                };
                bus.inject(await codec.seal(presence, new Uint8Array(0)));
                await run(100);
                expect(delivered()).toEqual([]);
                // Their keys were forgotten: the resend of the 8 is not taken for a replay, and everything is delivered in order.
                await send({ frames: frames(1, 8) });
                await releaseAll();
                await run(ACK_LINGER_MS + 200);
                expect(delivered()).toEqual(Array.from({ length: 40 }, (_v, i) => ({ n: i + 1 })));
                expect(state.calls).toBe(40 + 8);
                // The 8 that were resent are acknowledged now that their sender is joined. The others were never acknowledged:
                // they finished while their sender was away.
                expect(ackedIds()).toEqual(Array.from({ length: 8 }, (_v, i) => msgId(i + 1)));
            });

            test('a peer that left while its message was being unzipped is not sent the ack, and the message is kept for its return', async () => {
                const { releaseAll } = gateUnpack();
                await sendNow({ frames: frames(1, 2) });
                await byeFrom('raw-id');
                expect(leavesOf('raw-id')).toEqual(['raw-id']);
                await releaseAll();
                await run(ACK_LINGER_MS + 200);
                expect(ackedIds()).toEqual([]);
                expect(bus.published.filter((published) => published.header.kind === 'ack')).toEqual([]);
            });
        });

        describe('the replay memory under load', () => {
            const messages = (from: number, count: number): BatchFrame[] =>
                Array.from({ length: count }, (_v, i) => frame(from + i, { n: from + i }));

            test('live entries are never evicted: the most keys the budgets allow in the memory window fit under the cap', () => {
                // Each decrypted event adds at most one key (a batch key, or one frame key), each finished data
                // message adds one, and a batch's acks add none. Both rates are budgeted.
                const mostKeys =
                    ((DECRYPT_FRAMES_PER_SECOND + FINISHED_MESSAGES_PER_SECOND) * REPLAY_MEMORY_MS) / 1000 +
                    DECRYPT_FRAMES_PER_SECOND +
                    FINISHED_MESSAGES_BURST;
                expect(mostKeys).toBeLessThanOrEqual(REPLAY_MEMORY_MAX_ENTRIES);
            });

            test('a batch handed back after the heaviest traffic the budgets allow is still dropped, and its message is not delivered twice', async () => {
                const firstAt = Date.now();
                const firstBatch = { frames: [frame(1, { n: 1 })] };
                await send(firstBatch, { from: 'other-id', id: msgId(500_000), ts: firstAt });
                // Thirty seconds at the limit of the finished-message budget: 40 batches a second (under the 50 events
                // a second the link decrypts), 5 messages each (200 a second).
                let next = 2;
                for (let second = 0; second < 30; second++) {
                    for (let batch = 0; batch < 40; batch++) {
                        const items = { frames: messages(next, 5) };
                        next += 5;
                        bus.inject(
                            await sealed(items, {
                                from: 'other-id',
                                id: msgId(500_001 + second * 40 + batch),
                                ts: Date.now(),
                            }),
                        );
                    }
                    jest.advanceTimersByTime(1_000);
                    await flush();
                    await flush();
                }
                await run(1_000);
                const total = next - 1;
                const seenFrom = (): unknown[] =>
                    host.messages.filter(([from]) => from === 'other-id').map(([, v]) => v);
                expect(seenFrom()).toEqual(Array.from({ length: total }, (_v, i) => ({ n: i + 1 })));
                // The recorded first batch is handed back, as is its message in a batch with an id of its own.
                bus.inject(await sealed(firstBatch, { from: 'other-id', id: msgId(500_000), ts: firstAt }));
                bus.inject(await sealed(firstBatch, { from: 'other-id', id: msgId(900_000) }));
                await run(ACK_LINGER_MS + 200);
                expect(seenFrom()).toHaveLength(total);
            });

            test('batched acks add no replay keys: after enough batches of distinct acks to fill the memory if each ack had a key, the first batch handed back is still dropped', async () => {
                // With a key for every ack, each batch would add RELAY_BATCH_MAX_FRAMES + 1 keys (its acks and its own),
                // so ceil(cap / (RELAY_BATCH_MAX_FRAMES + 1)) batches fill the memory to its cap and a hundred more push
                // the oldest batch key out. Without ack keys each batch adds one key, and the first is still there.
                const firstAt = Date.now();
                const firstEvent = await sealed(
                    { acks: Array.from({ length: RELAY_BATCH_MAX_FRAMES }, (_v, i) => msgId(2_000_000 + i)) },
                    { from: 'other-id', id: msgId(700_000), ts: firstAt },
                );
                bus.inject(firstEvent);
                await run(100);
                expect(host.joins).toEqual(['other-id']);
                const batches = Math.ceil(REPLAY_MEMORY_MAX_ENTRIES / (RELAY_BATCH_MAX_FRAMES + 1)) + 100;
                const perSecond = 40; // under the 50 events a second the link decrypts
                // All of it inside the window the first batch is still accepted in, and inside the memory's lifetime.
                expect(batches / perSecond).toBeLessThan(FRAME_MAX_SKEW_MS / 1000);
                expect(batches / perSecond).toBeLessThan(REPLAY_MEMORY_MS / 1000);
                for (let n = 1; n <= batches; n++) {
                    const acks = Array.from({ length: RELAY_BATCH_MAX_FRAMES }, (_v, i) =>
                        msgId(2_000_000 + n * RELAY_BATCH_MAX_FRAMES + i),
                    );
                    bus.inject(await sealed({ acks }, { from: 'other-id', id: msgId(700_000 + n), ts: Date.now() }));
                    if (n % perSecond === 0) {
                        jest.advanceTimersByTime(1_000);
                        await flush();
                    }
                }
                jest.advanceTimersByTime(1_000);
                await flush();
                await byeFrom('other-id');
                expect(leavesOf('other-id')).toEqual(['other-id']);
                bus.inject(firstEvent);
                await run(100);
                expect(host.joins).toEqual(['other-id']); // dropped by its batch key: the peer did not join again
            });

            // The flood is short: 600 messages, the burst of 512 plus 88, all sent in one instant. It ends long before
            // the senders of the dropped messages give up (MAX_RESENDS resends, about 12 s), so it only delays them;
            // a flood that went on past that would make the peers' links give up and reconnect (see the docs).
            test('a short flood (600 messages in one instant, ended before the resend limit) delays another peer: its messages are delivered after a resend', async () => {
                const flooded = FINISHED_MESSAGES_BURST + 88;
                for (let from = 1; from <= flooded; from += 60) {
                    bus.inject(await sealed({ frames: messages(from, Math.min(60, flooded - from + 1)) }));
                    await flush();
                }
                // The budget is spent; another peer's message is dropped unread and unacknowledged.
                const honest = { frames: [frame(5_000, { t: 'honest' }, { seq: 0 })] };
                bus.inject(await sealed(honest, { from: 'other-id' }));
                await flush();
                expect(host.messages.filter(([from]) => from === 'other-id')).toEqual([]);
                await run(ACK_LINGER_MS + 200);
                expect(hostBatches().flatMap((published) => published.batch.acks)).not.toContain(msgId(5_000));
                // It resends once the budget has refilled, and is delivered.
                await run(1_000);
                await send(honest, { from: 'other-id' });
                expect(host.messages.filter(([from]) => from === 'other-id')).toEqual([['other-id', { t: 'honest' }]]);
            });
        });

        test('a batch that is not for us is dropped whole', async () => {
            const items = { acks: [msgId(1)], frames: [frame(2, { t: 'two' })] };
            await send(items, { to: 'another-id' });
            await send(items, { toEpoch: EPOCH }); // made for an earlier instance of this link
            await send(items, { ts: ts - 301_000 });
            await send(items, { ts: ts + 301_000 });
            await send(items, { from: 'host-id' }); // our own echo
            expect(host.messages).toEqual([]);
            expect(host.joins).toEqual([]);
            expect(hostBatches()).toHaveLength(0);
        });

        test('a batch of an older epoch than the one the peer is known by changes nothing', async () => {
            await send({ frames: [frame(1, { t: 'one' })] });
            await send({ frames: [frame(2, { t: 'stale' })] }, { epoch: NEW_EPOCH, ts: ts - 10 });
            expect(host.messages).toEqual([['raw-id', { t: 'one' }]]);
            expect(host.leaves).toEqual([]);
        });
    });
});
