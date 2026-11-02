/**
 * The relay link between two real links over an in-memory relay: joining by presence, delivery
 * in order and in parts, acknowledgement and resend, the lost-ack and give-up paths, silence,
 * bye, replay into a restarted link, the per-stream sequence and the send budget under backlog.
 * The frame-level checks (a crafted peer) are in relayLinkFrames.test.ts.
 */

import { sha256Hex } from '../helpers/sha256';
import { PEER_SILENCE_MS, PRESENCE_MS, createRelayLink, relayTopic } from '../../src/ts/core/remote/relayLink';
import { RELAY_MAX_PARTS, RELAY_PART_BYTES } from '../../src/ts/core/remote/relayWire';
import { RESEND_MS } from '../../src/ts/core/remote/relayOutbox';
import { TRYSTERO_APP_ID } from '../../src/ts/core/remote/relays';
import { TOPIC, createBus, flush, publishedMessages, stubCodec } from '../helpers/relayBus';

import type { Bus, Published } from '../helpers/relayBus';
import type { LinkRole } from '../../src/ts/core/remote/relayLink';

type Side = {
    transport: ReturnType<typeof createRelayLink>;
    codec: ReturnType<typeof stubCodec>;
    io: ReturnType<Bus['endpoint']>;
    joins: string[];
    leaves: string[];
    /** What each leave said about the messages it had sent the peer that were never acknowledged. */
    unacked: Array<number | undefined>;
    messages: Array<[string, unknown]>;
    index: number;
};

let endpointCount = 0;

/** Whether the links under test batch; the shared-behaviour cases run in both modes. */
let batching = false;

/** Every event published, frames and batches alike. */
const events = (bus: Bus): number => bus.published.length + bus.batches.length;

const side = (bus: Bus, role: LinkRole, selfId: string): Side => {
    const io = bus.endpoint();
    const codec = stubCodec();
    const transport = createRelayLink({ io, codec, topic: TOPIC, selfId, role, batching });
    const recorded: Side = {
        transport,
        codec,
        io,
        joins: [],
        leaves: [],
        unacked: [],
        messages: [],
        index: endpointCount++,
    };
    transport.onPeerJoin((peerId) => recorded.joins.push(peerId));
    transport.onPeerLeave((peerId, unacked) => {
        recorded.leaves.push(peerId);
        recorded.unacked.push(unacked);
    });
    transport.onMessage((peerId, message) => recorded.messages.push([peerId, message]));
    return recorded;
};

/** Advances fake time in small steps, letting the promise chains settle between them. */
const run = async (ms: number, step = 100): Promise<void> => {
    for (let at = 0; at < ms; at += step) {
        jest.advanceTimersByTime(step);
        await flush();
    }
};

/** The frames of a kind an endpoint published, whether each travelled alone or inside a batch event. */
const ofKind = (bus: Bus, endpoint: number, kind: string): Published[] =>
    bus.items.filter((frame) => frame.endpoint === endpoint && frame.header.kind === kind);

describe('relayTopic', () => {
    test('is the SHA-256 hex of the app id, relay and the room id', async () => {
        await expect(relayTopic('room-1')).resolves.toBe(await sha256Hex(`${TRYSTERO_APP_ID}:relay:room-1`));
        await expect(relayTopic('room-1')).resolves.not.toBe('room-1');
    });
});

describe.each([false, true])('the relay link (batching %s)', (mode) => {
    let bus: Bus;
    beforeEach(() => {
        batching = mode;
        jest.useFakeTimers();
        jest.setSystemTime(1_700_000_000_000);
        bus = createBus();
        endpointCount = 0;
    });
    afterEach(() => jest.useRealTimers());

    const pair = async (): Promise<{ host: Side; phone: Side }> => {
        const host = side(bus, 'host', 'host-id');
        const phone = side(bus, 'phone', 'phone-id');
        await run(600);
        return { host, phone };
    };

    describe('joining', () => {
        test('the phone announces itself and both sides join within a moment', async () => {
            const { host, phone } = await pair();
            expect(host.joins).toEqual(['phone-id']);
            expect(phone.joins).toEqual(['host-id']);
            expect(host.io.subscribed).toEqual([TOPIC]);
        });

        test('the phone repeats presence every 8 s; an idle host sends nothing at all', async () => {
            const lonelyHost = side(bus, 'host', 'host-id');
            await run(60_000, 1_000);
            expect(events(bus)).toBe(0);
            const phone = side(bus, 'phone', 'phone-id');
            await run(PRESENCE_MS * 3, 500);
            const phonePresence = ofKind(bus, phone.index, 'presence').filter((frame) => frame.header.to === '');
            expect(phonePresence.length).toBeGreaterThanOrEqual(3);
            expect(lonelyHost.joins).toEqual(['phone-id']);
        });

        test('the host answers a new peer at once, then announces every 8 s only while a phone is joined', async () => {
            const { host, phone } = await pair();
            const answers = ofKind(bus, host.index, 'presence').filter((frame) => frame.header.to === 'phone-id');
            expect(answers).toHaveLength(1);
            const before = ofKind(bus, host.index, 'presence').length;
            await run(PRESENCE_MS * 3, 500);
            expect(ofKind(bus, host.index, 'presence').length - before).toBeGreaterThanOrEqual(3);
            await phone.transport.leave();
            await run(1_000);
            expect(host.leaves).toEqual(['phone-id']);
            const after = ofKind(bus, host.index, 'presence').length;
            await run(PRESENCE_MS * 4, 500);
            expect(ofKind(bus, host.index, 'presence')).toHaveLength(after);
        });
    });

    describe('presence that found no relay open', () => {
        const presenceFrom = async (from: string): Promise<string> =>
            stubCodec().seal(
                {
                    v: 1,
                    from,
                    to: '',
                    toEpoch: '',
                    epoch: 'e'.repeat(32),
                    msgId: 'a'.repeat(32),
                    stream: '',
                    seq: 0,
                    part: 0,
                    parts: 1,
                    ts: Date.now(),
                    kind: 'presence',
                },
                new Uint8Array(0),
            );
        const presenceTo = (endpoint: number, to: string): Published[] =>
            ofKind(bus, endpoint, 'presence').filter((frame) => frame.header.to === to);

        test('a link started before any socket opens sends its presence on the first open, not at the 8 s tick', async () => {
            const host = side(bus, 'host', 'host-id');
            bus.failPublish = true;
            const phone = side(bus, 'phone', 'phone-id');
            await run(300);
            expect(events(bus)).toBe(0);
            bus.failPublish = false;
            phone.io.open();
            await run(600);
            expect(ofKind(bus, phone.index, 'presence').length).toBeGreaterThanOrEqual(1);
            expect(host.joins).toEqual(['phone-id']);
            expect(phone.joins).toEqual(['host-id']);
            expect(Date.now() - 1_700_000_000_000).toBeLessThan(PRESENCE_MS);
        });

        test('a phone that knows no desktop announces itself on every relay that opens, so the host cannot miss it', async () => {
            const host = side(bus, 'host', 'host-id');
            // The phone's first presence goes out on a relay the host does not hear: it is lost.
            bus.filter = (frame) => frame.header.kind !== 'presence' || frame.endpoint !== 1;
            const phone = side(bus, 'phone', 'phone-id');
            await run(300);
            const announcements = (): number =>
                ofKind(bus, phone.index, 'presence').filter((frame) => frame.header.to === '').length;
            expect(announcements()).toBe(1);
            expect(host.joins).toEqual([]);
            // Another relay opens, one the host listens on: the phone announces itself at once, not at the 8 s tick.
            bus.filter = () => true;
            phone.io.open();
            await run(600);
            expect(announcements()).toBe(2);
            expect(host.joins).toEqual(['phone-id']);
            expect(phone.joins).toEqual(['host-id']);
            expect(Date.now() - 1_700_000_000_000).toBeLessThan(PRESENCE_MS);
        });

        test('a host does not announce itself on open: it only answers', async () => {
            const host = side(bus, 'host', 'host-id');
            host.io.open();
            host.io.open();
            await run(300);
            expect(events(bus)).toBe(0);
        });

        test('an answer presence that found no relay open is sent when one opens', async () => {
            const host = side(bus, 'host', 'host-id');
            bus.failPublish = true;
            bus.inject(await presenceFrom('raw-id'));
            await run(300);
            expect(host.joins).toEqual(['raw-id']);
            expect(presenceTo(host.index, 'raw-id')).toHaveLength(0);
            bus.failPublish = false;
            host.io.open();
            await run(300);
            expect(presenceTo(host.index, 'raw-id')).toHaveLength(1);
            host.io.open(); // nothing is owed any more
            await run(300);
            expect(presenceTo(host.index, 'raw-id')).toHaveLength(1);
        });

        test('presence owed to a peer that has left goes to everyone instead, once however many were lost', async () => {
            const host = side(bus, 'host', 'host-id');
            bus.failPublish = true;
            bus.inject(await presenceFrom('raw-id'));
            await run(300);
            // The peer says bye before any relay opened.
            const bye = await stubCodec().seal(
                {
                    v: 1,
                    from: 'raw-id',
                    to: '',
                    toEpoch: '',
                    epoch: 'e'.repeat(32),
                    msgId: 'b'.repeat(32),
                    stream: '',
                    seq: 0,
                    part: 0,
                    parts: 1,
                    ts: Date.now(),
                    kind: 'bye',
                },
                new Uint8Array(0),
            );
            bus.inject(bye);
            await run(300);
            expect(host.leaves).toEqual(['raw-id']);
            bus.failPublish = false;
            host.io.open();
            await run(300);
            expect(presenceTo(host.index, '')).toHaveLength(1);
            expect(presenceTo(host.index, 'raw-id')).toHaveLength(0);
        });

        test('a link whose presence reached a relay sends no extra presence when another socket opens', async () => {
            const { host, phone } = await pair();
            const before = ofKind(bus, host.index, 'presence').length + ofKind(bus, phone.index, 'presence').length;
            phone.io.open();
            host.io.open();
            await run(300);
            expect(ofKind(bus, host.index, 'presence').length + ofKind(bus, phone.index, 'presence').length).toBe(
                before,
            );
        });

        test('only presence is owed: a data frame that found no relay open waits for its resend, not for the open', async () => {
            const { host, phone } = await pair();
            const presences = ofKind(bus, host.index, 'presence').length;
            bus.failPublish = true;
            await host.transport.send({ t: 'lost' }, 'phone-id');
            await run(300);
            bus.failPublish = false;
            host.io.open();
            await run(300);
            expect(ofKind(bus, host.index, 'presence')).toHaveLength(presences);
            expect(phone.messages).toEqual([]);
            await run(RESEND_MS, 100); // the resend delivers it
            expect(phone.messages).toEqual([['host-id', { t: 'lost' }]]);
        });

        test('a link that was left sends nothing when a socket opens', async () => {
            bus.failPublish = true;
            const phone = side(bus, 'phone', 'phone-id');
            await run(300);
            await phone.transport.leave();
            bus.failPublish = false;
            phone.io.open();
            await run(300);
            expect(events(bus)).toBe(0);
        });
    });

    describe('messages', () => {
        test('data and acks travel inside batch events when the links batch, and as frames when they do not', async () => {
            const { host, phone } = await pair();
            await host.transport.send({ t: 'one' }, 'phone-id');
            await run(1_000);
            expect(phone.messages).toEqual([['host-id', { t: 'one' }]]);
            expect(bus.batches.length > 0).toBe(mode);
            expect(bus.published.some((frame) => frame.header.kind === 'data' || frame.header.kind === 'ack')).toBe(
                !mode,
            );
            expect(ofKind(bus, host.index, 'data')).toHaveLength(1);
            expect(ofKind(bus, phone.index, 'ack')).toHaveLength(1);
        });

        test('a message goes each way, is acknowledged and is not sent again', async () => {
            const { host, phone } = await pair();
            await host.transport.send({ t: 'hello', n: 1 }, 'phone-id');
            await phone.transport.send({ t: 'invoke', n: 2 }, 'host-id');
            await run(RESEND_MS * 5, 250);
            expect(phone.messages).toEqual([['host-id', { t: 'hello', n: 1 }]]);
            expect(host.messages).toEqual([['phone-id', { t: 'invoke', n: 2 }]]);
            expect(ofKind(bus, host.index, 'data')).toHaveLength(1);
            expect(ofKind(bus, phone.index, 'data')).toHaveLength(1);
            expect(ofKind(bus, phone.index, 'ack')).toHaveLength(1);
            expect(host.leaves).toEqual([]);
        });

        test('messages arrive in the order they were sent', async () => {
            const { host, phone } = await pair();
            for (let n = 0; n < 5; n++) void host.transport.send({ n }, 'phone-id');
            await run(1_500, 100);
            expect(phone.messages.map(([, message]) => message)).toEqual([0, 1, 2, 3, 4].map((n) => ({ n })));
        });

        test('a message of many parts is delivered whole', async () => {
            const { host, phone } = await pair();
            const payload = 'x'.repeat(RELAY_PART_BYTES * 2 + 5_000);
            await host.transport.send({ payload }, 'phone-id');
            await run(2_000, 100);
            expect(phone.messages).toEqual([['host-id', { payload }]]);
            expect(ofKind(bus, host.index, 'data').length).toBeGreaterThanOrEqual(3);
        });

        test(`a message of more than ${RELAY_MAX_PARTS} parts is refused, nothing of it is sent, and the peer is given up`, async () => {
            const { host, phone } = await pair();
            const dataBefore = ofKind(bus, host.index, 'data').length;
            await expect(
                host.transport.send({ payload: 'x'.repeat(RELAY_PART_BYTES * RELAY_MAX_PARTS) }, 'phone-id'),
            ).rejects.toThrow('too large');
            await run(1_000);
            expect(ofKind(bus, host.index, 'data')).toHaveLength(dataBefore);
            // A message lost without a trace would leave a result nobody answers: the peer is told and settles.
            expect(host.leaves).toEqual(['phone-id']);
            expect(ofKind(bus, host.index, 'bye').filter((frame) => frame.header.to === 'phone-id')).toHaveLength(1);
            expect(phone.leaves).toEqual(['host-id']);
        });

        test('a send needs a target the link has joined, and an open link', async () => {
            const { host } = await pair();
            await expect(host.transport.send({ t: 'x' })).rejects.toThrow('one peer at a time');
            await expect(host.transport.send({ t: 'x' }, 'stranger')).rejects.toThrow('does not reach');
            await host.transport.leave();
            await expect(host.transport.send({ t: 'x' }, 'phone-id')).rejects.toThrow('does not reach');
        });

        test('a peer that leaves while its message is being prepared fails the send', async () => {
            const { host, phone } = await pair();
            let finishPacking = (): void => undefined;
            const slowPack = host.codec.pack;
            host.codec.pack = async (message) => {
                await new Promise<void>((resolve) => (finishPacking = resolve));
                return slowPack(message);
            };
            const sending = host.transport.send({ t: 'x' }, 'phone-id');
            await flush();
            await phone.transport.leave();
            await run(300);
            expect(host.leaves).toEqual(['phone-id']);
            finishPacking();
            await expect(sending).rejects.toThrow('left while');
        });
    });

    describe('delivery', () => {
        test('a lost data frame is sent again after 4 s and delivered once', async () => {
            const { host, phone } = await pair();
            let dropped = false;
            bus.filter = (frame) => {
                if (frame.header.kind === 'data' && !dropped) {
                    dropped = true;
                    return false;
                }
                return true;
            };
            await host.transport.send({ t: 'once' }, 'phone-id');
            await run(RESEND_MS - 500, 100);
            expect(phone.messages).toEqual([]);
            await run(1_500, 100);
            expect(phone.messages).toEqual([['host-id', { t: 'once' }]]);
            await run(RESEND_MS * 5, 250);
            expect(phone.messages).toHaveLength(1);
            expect(ofKind(bus, host.index, 'data')).toHaveLength(2);
        });

        // What stops the second copy differs by mode: a frame is stopped by the seen-set (its data key), a batch event
        // by the batch key, before any of its messages is looked at.
        test(`an event handed back twice is delivered once (${mode ? 'the batch key' : 'the seen-set'})`, async () => {
            const { host, phone } = await pair();
            await host.transport.send({ t: 'once' }, 'phone-id');
            await run(300);
            const original = ofKind(bus, host.index, 'data')[0];
            bus.inject(original.content);
            bus.inject(original.content);
            await run(500);
            expect(phone.messages).toHaveLength(1);
        });

        test('a lost ack: the duplicate is acknowledged again and the peer stays joined', async () => {
            const { host, phone } = await pair();
            let lost = false;
            bus.filter = (frame) => {
                if (frame.header.kind === 'ack' && !lost) {
                    lost = true;
                    return false;
                }
                return true;
            };
            await phone.transport.send({ t: 'spend' }, 'host-id');
            await run(RESEND_MS * 3, 250);
            expect(host.messages).toEqual([['phone-id', { t: 'spend' }]]); // the resend ran at most once
            expect(ofKind(bus, host.index, 'ack')).toHaveLength(2);
            expect(ofKind(bus, phone.index, 'data')).toHaveLength(2);
            expect(phone.leaves).toEqual([]);
            expect(host.leaves).toEqual([]);
            expect(ofKind(bus, phone.index, 'bye')).toHaveLength(0);
        });

        test('a message nobody acknowledges ends the peer after the last try, and the peer is told', async () => {
            const { host, phone } = await pair();
            bus.filter = (frame) => frame.header.kind !== 'ack';
            await host.transport.send({ t: 'hello' }, 'phone-id');
            await run(RESEND_MS * 4 + 1_000, 250);
            expect(ofKind(bus, host.index, 'data')).toHaveLength(4); // the send and three resends
            expect(host.leaves).toContain('phone-id');
            expect(ofKind(bus, host.index, 'bye').filter((frame) => frame.header.to === 'phone-id')).toHaveLength(1);
            expect(phone.leaves).toContain('host-id'); // it heard the bye
            // The leave says what was lost: the message it gave up on.
            expect(host.unacked).toEqual([1]);
        });

        test('a leave says how many messages it had sent the peer that were never acknowledged', async () => {
            const { host, phone } = await pair();
            bus.filter = (frame) => frame.header.kind !== 'ack';
            for (const n of [1, 2, 3]) await host.transport.send({ n }, 'phone-id');
            await run(1_000, 250);
            await phone.transport.leave(); // the peer says bye with all three still unacknowledged
            await run(500, 250);
            expect(host.leaves).toEqual(['phone-id']);
            expect(host.unacked).toEqual([3]);
        });

        test('a leave with nothing outstanding says none', async () => {
            const { host, phone } = await pair();
            await host.transport.send({ t: 'one' }, 'phone-id');
            await run(1_000, 250);
            await phone.transport.leave();
            await run(500, 250);
            expect(host.unacked).toEqual([0]);
        });
    });

    describe('taking back what has not started', () => {
        test('the messages queued for a peer that have not started leaving come back, in order, and are never sent here', async () => {
            const { host, phone } = await pair();
            // The send budget lets a few leave at once; the rest wait behind it.
            const sends = Array.from({ length: 20 }, (_v, n) => host.transport.send({ n }, 'phone-id'));
            await Promise.all(sends);
            await flush();
            const back = host.transport.takeUnsent?.('phone-id') ?? [];
            expect(back.length).toBeGreaterThan(0);
            await run(RESEND_MS * 2, 250);
            const delivered = phone.messages.map(([, message]) => message);
            // What came back was never delivered here; what did arrive is the front of the order, and nothing is in both.
            expect(delivered.length + back.length).toBe(20);
            expect([...delivered, ...back]).toEqual(Array.from({ length: 20 }, (_v, n) => ({ n })));
            expect(host.transport.takeUnsent?.('phone-id')).toEqual([]);
        });
    });

    describe('what is in flight to a peer', () => {
        /** Makes the host's next pack wait; answers the call that lets it finish. */
        const holdPacking = (host: Side): (() => void) => {
            let finish = (): void => undefined;
            const pack = host.codec.pack;
            host.codec.pack = async (message) => {
                await new Promise<void>((resolve) => (finish = resolve));
                return pack(message);
            };
            return () => finish();
        };

        test('a message counts from packing until its ack, and a callback waiting for none in flight is called by the ack', async () => {
            const { host } = await pair();
            expect(host.transport.inFlight?.('phone-id')).toBe(0);
            const idle = jest.fn();
            const cancelIdle = host.transport.whenIdle?.('phone-id', idle);
            cancelIdle?.(); // nothing to cancel: it was called at once
            expect(idle).toHaveBeenCalledTimes(1);
            const finishPacking = holdPacking(host);
            const sending = host.transport.send({ t: 'x' }, 'phone-id');
            await flush();
            expect(host.transport.inFlight?.('phone-id')).toBe(1); // being packed
            bus.filter = (frame) => frame.header.kind !== 'ack';
            finishPacking();
            await sending;
            await run(500, 250);
            expect(host.transport.inFlight?.('phone-id')).toBe(1); // started, not acknowledged
            const waiting = jest.fn();
            host.transport.whenIdle?.('phone-id', waiting);
            bus.filter = () => true;
            await run(RESEND_MS + 1_000, 250); // the resend is acknowledged
            expect(waiting).toHaveBeenCalledTimes(1);
            expect(host.transport.inFlight?.('phone-id')).toBe(0);
        });

        test('a callback waits through the packing: it is called when the packed message is acknowledged, not when packing ends', async () => {
            const { host } = await pair();
            const finishPacking = holdPacking(host);
            const sending = host.transport.send({ t: 'x' }, 'phone-id');
            await flush();
            const idle = jest.fn();
            host.transport.whenIdle?.('phone-id', idle);
            bus.filter = (frame) => frame.header.kind !== 'ack';
            finishPacking();
            await sending;
            await run(500, 250);
            expect(idle).not.toHaveBeenCalled(); // packed and started, not acknowledged
            bus.filter = () => true;
            await run(RESEND_MS + 1_000, 250);
            expect(idle).toHaveBeenCalledTimes(1);
        });

        test('two callbacks waiting for the same peer are both called once it is idle, and a cancel after the call is harmless', async () => {
            const { host } = await pair();
            const finishPacking = holdPacking(host);
            const sending = host.transport.send({ n: 1 }, 'phone-id');
            await flush();
            const first = jest.fn();
            const second = jest.fn();
            const stopFirst = host.transport.whenIdle?.('phone-id', first);
            host.transport.whenIdle?.('phone-id', second);
            finishPacking();
            await sending;
            await run(1_000, 250); // the message leaves and is acknowledged
            expect(first).toHaveBeenCalledTimes(1);
            expect(second).toHaveBeenCalledTimes(1);
            stopFirst?.();
            expect(host.transport.inFlight?.('phone-id')).toBe(0);
        });

        test('a cancelled callback is not called', async () => {
            const { host } = await pair();
            bus.filter = (frame) => frame.header.kind !== 'ack';
            await host.transport.send({ t: 'x' }, 'phone-id');
            await run(500, 250);
            const idle = jest.fn();
            const cancel = host.transport.whenIdle?.('phone-id', idle);
            cancel?.();
            bus.filter = () => true;
            await run(RESEND_MS + 1_000, 250);
            expect(idle).not.toHaveBeenCalled();
        });

        test('a peer that leaves drops the callback unheard: the leave reports the loss', async () => {
            const { host, phone } = await pair();
            bus.filter = (frame) => frame.header.kind !== 'ack';
            await host.transport.send({ t: 'x' }, 'phone-id');
            await run(500, 250);
            const idle = jest.fn();
            host.transport.whenIdle?.('phone-id', idle);
            await phone.transport.leave();
            await run(RESEND_MS + 1_000, 250);
            expect(host.leaves).toEqual(['phone-id']);
            expect(idle).not.toHaveBeenCalled();
        });

        test('a peer given up on says it lost the message the outbox no longer held', async () => {
            const { host } = await pair();
            bus.filter = (frame) => frame.header.kind !== 'ack';
            await host.transport.send({ t: 'x' }, 'phone-id');
            await run(RESEND_MS * 4 + 1_000, 250);
            expect(host.unacked).toEqual([1]);
        });
    });

    describe('started messages and the redirect', () => {
        test('the started messages are answered in order and stay: they are resent until acknowledged, and delivered once', async () => {
            const { host, phone } = await pair();
            bus.filter = (frame) => frame.header.kind !== 'ack';
            for (const n of [1, 2, 3]) await host.transport.send({ n }, 'phone-id');
            await run(500, 250);
            expect(host.transport.startedMessages?.('phone-id')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
            expect(host.transport.inFlight?.('phone-id')).toBe(3);
            bus.filter = () => true;
            await run(RESEND_MS + 1_000, 250); // the resends are acknowledged
            expect(host.transport.startedMessages?.('phone-id')).toEqual([]);
            expect(phone.messages.map(([, message]) => message)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
            expect(host.leaves).toEqual([]);
        });

        test('a message that finishes packing after a redirect goes to it instead of the queue, until the redirect stops', async () => {
            const { host, phone } = await pair();
            let finish = (): void => undefined;
            const pack = host.codec.pack;
            host.codec.pack = async (message) => {
                await new Promise<void>((resolve) => (finish = resolve));
                return pack(message);
            };
            const sending = host.transport.send({ t: 'slow' }, 'phone-id');
            await flush();
            const late: unknown[] = [];
            host.transport.redirect?.('phone-id', (message) => late.push(message));
            finish();
            await sending;
            expect(late).toEqual([{ t: 'slow' }]);
            host.codec.pack = pack;
            host.transport.stopRedirect?.('phone-id');
            await host.transport.send({ t: 'queued again' }, 'phone-id');
            await run(1_000, 250);
            expect(late).toEqual([{ t: 'slow' }]);
            expect(phone.messages.map(([, message]) => message)).toEqual([{ t: 'queued again' }]);
        });

        test('a peer that leaves ends the redirect: its next join queues messages again', async () => {
            const { host, phone } = await pair();
            const late: unknown[] = [];
            host.transport.redirect?.('phone-id', (message) => late.push(message));
            await phone.transport.leave();
            await run(500, 250);
            expect(host.leaves).toEqual(['phone-id']);
            const again = side(bus, 'phone', 'phone-id');
            await run(1_000, 250);
            await host.transport.send({ t: 'after the rejoin' }, 'phone-id');
            await run(1_000, 250);
            expect(late).toEqual([]);
            expect(again.messages.map(([, message]) => message)).toEqual([{ t: 'after the rejoin' }]);
        });

        test('a send waiting in the send chain counts as in flight, and a callback waits for it', async () => {
            const { host } = await pair();
            let finish: Array<() => void> = [];
            const pack = host.codec.pack;
            host.codec.pack = async (message) => {
                await new Promise<void>((resolve) => finish.push(resolve));
                return pack(message);
            };
            const first = host.transport.send({ n: 1 }, 'phone-id'); // being packed
            const second = host.transport.send({ n: 2 }, 'phone-id'); // waiting behind it
            await flush();
            expect(host.transport.inFlight?.('phone-id')).toBe(2);
            const idle = jest.fn();
            host.transport.whenIdle?.('phone-id', idle);
            finish.shift()?.();
            await first;
            await flush();
            expect(host.transport.inFlight?.('phone-id')).toBeGreaterThanOrEqual(1);
            expect(idle).not.toHaveBeenCalled();
            finish.shift()?.();
            finish = [];
            await second;
            await run(1_000, 250); // both leave and are acknowledged
            expect(idle).toHaveBeenCalledTimes(1);
            expect(host.transport.inFlight?.('phone-id')).toBe(0);
        });

        test('a send that fails still leaves the count right', async () => {
            const { host } = await pair();
            await expect(host.transport.send({ t: 'x' }, 'stranger')).rejects.toThrow('does not reach');
            expect(host.transport.inFlight?.('stranger')).toBe(0);
        });

        test('leave clears the waiting callbacks and the redirects at once, before the bye is out', async () => {
            const { host, phone } = await pair();
            // The phone's ack is sealed late, and the host's bye too.
            const gates: Array<() => void> = [];
            const gated =
                <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
                async (...args: A): Promise<R> => {
                    await new Promise<void>((resolve) => gates.push(resolve));
                    return fn(...args);
                };
            const phoneSeal = phone.codec.seal;
            const phoneSealBatch = phone.codec.sealBatch;
            phone.codec.seal = gated(phoneSeal);
            phone.codec.sealBatch = gated(phoneSealBatch);
            await host.transport.send({ t: 'x' }, 'phone-id');
            await run(500, 250);
            const idle = jest.fn();
            host.transport.whenIdle?.('phone-id', idle);
            host.transport.redirect?.('phone-id', () => undefined);
            const hostSeal = host.codec.seal;
            host.codec.seal = gated(hostSeal);
            const leaving = host.transport.leave(); // the bye waits to be sealed
            await flush();
            phone.codec.seal = phoneSeal;
            phone.codec.sealBatch = phoneSealBatch;
            for (const open of gates.splice(0)) open(); // the ack and the bye go out now
            await leaving;
            await run(500, 250);
            expect(idle).not.toHaveBeenCalled();
        });
    });

    describe('leaving', () => {
        test('a peer that stays silent for 25 s is left, and the host tells it', async () => {
            const { host, phone } = await pair();
            bus.filter = (frame) => frame.endpoint !== phone.index; // nothing from the phone gets through
            await run(PEER_SILENCE_MS - 2_000, 500);
            expect(host.leaves).toEqual([]);
            await run(4_000, 500);
            expect(host.leaves).toEqual(['phone-id']);
            const byes = ofKind(bus, host.index, 'bye');
            expect(byes).toHaveLength(1);
            expect(byes[0].header.to).toBe('phone-id');
            expect(phone.leaves).toEqual(['host-id']);
        });

        test('a phone that hears nothing from the host leaves it quietly: no bye', async () => {
            const { phone } = await pair();
            bus.filter = (frame) => frame.endpoint !== 0; // nothing from the host gets through
            await run(PEER_SILENCE_MS + 2_000, 500);
            expect(phone.leaves).toEqual(['host-id']);
            expect(ofKind(bus, phone.index, 'bye')).toHaveLength(0);
        });

        test('leave sends one bye to everyone, ends the peer at once and stops every timer', async () => {
            const { host, phone } = await pair();
            await phone.transport.leave();
            await run(300);
            expect(host.leaves).toEqual(['phone-id']);
            const byes = ofKind(bus, phone.index, 'bye');
            expect(byes).toHaveLength(1);
            expect(byes[0].header.to).toBe('');
            expect(phone.io.closed).toBe(true);
            await phone.transport.leave(); // a second leave does nothing
            expect(ofKind(bus, phone.index, 'bye')).toHaveLength(1);
            await host.transport.leave();
            expect(jest.getTimerCount()).toBe(0);
        });

        test('a link with no peers leaves without a bye', async () => {
            const lonely = side(bus, 'host', 'host-id');
            await lonely.transport.leave();
            expect(events(bus)).toBe(0);
            expect(lonely.io.closed).toBe(true);
        });

        test('frames arriving after leave are ignored', async () => {
            const { host, phone } = await pair();
            await host.transport.leave();
            const before = host.joins.length;
            await phone.transport.send({ t: 'late' }, 'host-id').catch(() => undefined);
            await run(1_000);
            expect(host.messages).toEqual([]);
            expect(host.joins).toHaveLength(before);
        });
    });

    describe('replay', () => {
        test('a bye recorded from an earlier run cannot end the restarted peer', async () => {
            const { host, phone } = await pair();
            await phone.transport.leave();
            await run(300);
            const oldBye = ofKind(bus, phone.index, 'bye')[0];
            const restarted = side(bus, 'phone', 'phone-id'); // same id, new epoch
            await run(600);
            expect(host.joins).toEqual(['phone-id', 'phone-id']);
            const leavesBefore = host.leaves.length;
            bus.inject(oldBye.content);
            await run(300);
            expect(host.leaves).toHaveLength(leavesBefore);
            await restarted.transport.send({ t: 'still here' }, 'host-id');
            await run(300);
            expect(host.messages.at(-1)).toEqual(['phone-id', { t: 'still here' }]);
        });

        test('a peer that restarts without a bye is left and joined again, with a fresh stream', async () => {
            const { host, phone } = await pair();
            await phone.transport.send({ n: 1 }, 'host-id');
            await run(300);
            const restarted = side(bus, 'phone', 'phone-id');
            await run(600);
            expect(host.leaves).toEqual(['phone-id']);
            expect(host.joins).toEqual(['phone-id', 'phone-id']);
            await restarted.transport.send({ n: 2 }, 'host-id'); // sequence 0 again: delivered at once, not held for a gap
            await run(300);
            expect(host.messages.map(([, message]) => message)).toEqual([{ n: 1 }, { n: 2 }]);
        });

        test('a data frame recorded before the host restarted is not delivered to the new host', async () => {
            const { host, phone } = await pair();
            await phone.transport.send({ t: 'old' }, 'host-id');
            await run(300);
            const recorded = ofKind(bus, phone.index, 'data')[0];
            await host.transport.leave();
            const restarted = side(bus, 'host', 'host-id');
            bus.inject(recorded.content);
            await run(300);
            expect(restarted.messages).toEqual([]);
            expect(restarted.joins).toEqual([]);
        });

        test('a past-dated frame is rejected, a frame within five minutes is accepted, a future-dated one is rejected', async () => {
            const host = side(bus, 'host', 'host-id');
            const codec = stubCodec();
            const epoch = 'e'.repeat(32);
            const presence = async (from: string, ts: number, msgId: string): Promise<string> =>
                codec.seal(
                    {
                        v: 1,
                        from,
                        to: '',
                        toEpoch: '',
                        epoch,
                        msgId,
                        stream: '',
                        seq: 0,
                        part: 0,
                        parts: 1,
                        ts,
                        kind: 'presence',
                    },
                    new Uint8Array(0),
                );
            const now = Date.now();
            bus.inject(await presence('old', now - 301_000, 'a'.repeat(32)));
            bus.inject(await presence('future', now + 301_000, 'b'.repeat(32)));
            await run(300);
            expect(host.joins).toEqual([]);
            bus.inject(await presence('fresh', now - 299_000, 'c'.repeat(32)));
            bus.inject(await presence('ahead', now + 299_000, 'd'.repeat(32)));
            await run(600);
            expect(host.joins).toEqual(['fresh', 'ahead']);
        });

        test('a recorded frame replayed after more than five minutes is rejected by its timestamp', async () => {
            const { host, phone } = await pair();
            bus.filter = (frame) => frame.header.kind !== 'data'; // the data frame is recorded but never delivered
            await phone.transport.send({ t: 'recorded' }, 'host-id');
            await run(300);
            const recorded = ofKind(bus, phone.index, 'data')[0];
            bus.filter = () => true;
            await run(301_000, 5_000);
            host.messages.length = 0;
            bus.inject(recorded.content);
            await run(500);
            expect(host.messages).toEqual([]);
        });
    });

    describe('what the link drops', () => {
        test('frames the codec refuses (another pairing key) are dropped: nobody joins', async () => {
            const host = side(bus, 'host', 'host-id');
            host.codec.refuse = true;
            side(bus, 'phone', 'phone-id');
            await run(1_000);
            expect(host.joins).toEqual([]);
            expect(host.codec.opened).toBeGreaterThan(0);
        });

        test('at most 50 events are decrypted a second; the rest are dropped unread', async () => {
            const host = side(bus, 'host', 'host-id');
            for (let n = 0; n < 80; n++) bus.inject(`junk-${n}`);
            host.codec.refuse = true; // nothing opens; only the count matters
            await run(100);
            expect(host.codec.opened).toBe(50);
            bus.inject('more junk');
            await run(1_000);
            expect(host.codec.opened).toBeGreaterThan(50);
        });

        test('a frame the link sent itself, echoed back by the relay, is ignored', async () => {
            const { host } = await pair();
            expect(host.joins).toEqual(['phone-id']);
            expect(host.joins).not.toContain('host-id');
        });

        test('a frame addressed to another peer is dropped by the others', async () => {
            const { host, phone } = await pair();
            const third = side(bus, 'phone', 'third-id');
            third.joins.length = 0;
            await host.transport.send({ t: 'private' }, 'phone-id');
            await run(500);
            expect(phone.messages).toEqual([['host-id', { t: 'private' }]]);
            expect(third.messages).toEqual([]);
        });
    });

    describe('streams and the budget', () => {
        test('the sequence is per stream: traffic to another phone leaves no gap', async () => {
            const host = side(bus, 'host', 'host-id');
            const one = side(bus, 'phone', 'one-id');
            const two = side(bus, 'phone', 'two-id');
            await run(1_500);
            for (const [to, n] of [
                ['one-id', 1],
                ['two-id', 1],
                ['one-id', 2],
                ['two-id', 2],
                ['one-id', 3],
            ] as const) {
                void host.transport.send({ n }, to);
            }
            await run(2_000, 100); // far under the 10 s a gap would be held
            expect(one.messages.map(([, message]) => message)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
            expect(two.messages.map(([, message]) => message)).toEqual([{ n: 1 }, { n: 2 }]);
            const seqs = (to: string): number[] =>
                ofKind(bus, host.index, 'data')
                    .filter((frame) => frame.header.to === to)
                    .map((frame) => frame.header.seq);
            expect(seqs('one-id')).toEqual([0, 1, 2]);
            expect(seqs('two-id')).toEqual([0, 1]);
        });

        test('the receiver drops the sender for silence and takes it back while the sender keeps its stream: delivery goes on at once', async () => {
            const { host, phone } = await pair();
            await host.transport.send({ n: 0 }, 'phone-id');
            await host.transport.send({ n: 1 }, 'phone-id');
            await run(1_000);
            expect(phone.messages.map(([, message]) => message)).toEqual([{ n: 0 }, { n: 1 }]);
            // Nothing from the host gets through for a while: the phone forgets it; the host still has the phone.
            bus.filter = (frame) => frame.endpoint !== host.index;
            await run(PEER_SILENCE_MS + 2_000, 500);
            expect(phone.leaves).toEqual(['host-id']);
            expect(host.leaves).toEqual([]);
            bus.filter = () => true;
            await host.transport.send({ n: 2 }, 'phone-id'); // sequence 2 of the stream the phone still remembers
            await run(1_000, 100); // far under the 10 s a gap would be held
            expect(phone.joins).toEqual(['host-id', 'host-id']);
            expect(phone.messages.map(([, message]) => message)).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
        });

        test('the sender drops the receiver and starts a new stream at 0: it is delivered in order, though the old inbox expected more', async () => {
            const { host, phone } = await pair();
            for (let n = 0; n < 3; n++) await host.transport.send({ old: n }, 'phone-id');
            await run(1_000);
            // Nothing from the phone gets through: the host forgets it (and tells it), and forgets its stream.
            bus.filter = (frame) => frame.endpoint !== phone.index;
            await run(PEER_SILENCE_MS + 2_000, 500);
            expect(host.leaves).toEqual(['phone-id']);
            bus.filter = () => true;
            await run(PRESENCE_MS + 1_000, 500); // the phone's next presence brings it back
            expect(host.joins).toEqual(['phone-id', 'phone-id']);
            for (let n = 0; n < 2; n++) await host.transport.send({ fresh: n }, 'phone-id');
            await run(1_000, 100);
            const received = phone.messages.map(([, message]) => message);
            expect(received.slice(-2)).toEqual([{ fresh: 0 }, { fresh: 1 }]);
            const streams = new Set(ofKind(bus, host.index, 'data').map((frame) => frame.header.stream));
            expect(streams.size).toBe(2); // a stream of its own after the host forgot the phone
        });

        test('under backlog log events are dropped first; results and state are never dropped', async () => {
            const { host, phone } = await pair();
            void host.transport.send(
                { t: 'result', id: 1, ok: true, result: 'x'.repeat(RELAY_PART_BYTES * 30) },
                'phone-id',
            );
            await run(300);
            void host.transport.send({ t: 'event', channel: 'log-message', payload: 'a line' }, 'phone-id');
            void host.transport.send({ t: 'result', id: 2, ok: true, result: 'small' }, 'phone-id');
            void host.transport.send({ t: 'autovote-state', state: {} }, 'phone-id');
            await run(8_000, 100);
            const sent = publishedMessages(bus, host.index, 'phone-id') as Array<{ t: string; id?: number }>;
            expect(sent.map((message) => message.t)).toEqual(['result', 'result', 'autovote-state']);
            expect(phone.messages.map(([, message]) => (message as { t: string }).t)).toEqual([
                'result',
                'result',
                'autovote-state',
            ]);
        });

        test('a full send queue fails the send', async () => {
            const { host, phone } = await pair();
            const big = { payload: 'x'.repeat(RELAY_PART_BYTES * 90) };
            for (let n = 0; n < 4; n++) void host.transport.send(big, 'phone-id').catch(() => undefined);
            await run(300);
            await expect(host.transport.send(big, 'phone-id')).rejects.toThrow('queue is full');
            // The message that did not fit is lost: the peer is given up on, so the phone settles what it has in flight.
            expect(host.leaves).toEqual(['phone-id']);
            await run(500); // the bye leaves ahead of any data
            expect(phone.leaves).toEqual(['host-id']);
        });
    });

    describe('plumbing', () => {
        test('a handler is removed by its unsubscribe, and the link has no join errors to report', async () => {
            const host = side(bus, 'host', 'host-id');
            const seen: string[] = [];
            const off = host.transport.onPeerJoin((peerId) => seen.push(peerId));
            off();
            const unsubscribe = host.transport.onJoinError(() => seen.push('error'));
            expect(typeof unsubscribe).toBe('function');
            unsubscribe();
            side(bus, 'phone', 'phone-id');
            await run(600);
            expect(seen).toEqual([]);
            expect(host.joins).toEqual(['phone-id']);
        });

        test('a relay that refuses to publish, or a codec that fails to seal, loses a frame but breaks nothing', async () => {
            const host = side(bus, 'host', 'host-id');
            bus.failPublish = true;
            side(bus, 'phone', 'phone-id');
            await run(1_000);
            expect(host.joins).toEqual([]);
            bus.failPublish = false;
            host.codec.seal = async () => {
                throw new Error('cannot seal');
            };
            const phone = side(bus, 'phone', 'phone2-id');
            await run(1_000);
            expect(host.joins).toEqual(['phone2-id']);
            expect(phone.joins).not.toContain('host-id'); // the host's answer could not be sealed
        });
    });
});
