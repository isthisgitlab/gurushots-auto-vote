/**
 * What the link does with frames a crafted peer sends: who it admits, what it answers, when a
 * duplicate is acknowledged again, and the bounds on what it remembers.
 */

import { createRelayLink } from '../../src/ts/core/remote/relayLink';
import { RE_ACK_MIN_MS } from '../../src/ts/core/remote/relayLinkFrames';
import { GAP_HOLD_MS } from '../../src/ts/core/remote/relayInbox';
import { MAX_COMPLETED_PER_PEER } from '../../src/ts/core/remote/relayLinkState';
import { TOPIC, createBus, flush, stubCodec } from '../helpers/relayBus';

import type { FrameHeader } from '../../src/ts/core/remote/relayCodec';
import type { Bus } from '../helpers/relayBus';

const EPOCH = 'e'.repeat(32);
const STREAM = '5'.repeat(32);
const msgId = (n: number): string => n.toString(16).padStart(32, '0');

describe('the frames a peer sends the relay link', () => {
    let bus: Bus;
    let host: ReturnType<typeof createRelayLink>;
    let hostCodec: ReturnType<typeof stubCodec>;
    let hostEpoch: string;
    const joins: string[] = [];
    const leaves: string[] = [];
    const messages: unknown[] = [];
    const codec = stubCodec();

    const settle = async (ms = 0): Promise<void> => {
        jest.advanceTimersByTime(ms);
        await flush();
    };

    /** Hands the host a frame from the crafted peer `from`. */
    const send = async (header: Partial<FrameHeader>, part: Uint8Array = new Uint8Array(0)): Promise<void> => {
        const merged = {
            v: 1 as const,
            from: 'raw-id',
            to: 'host-id',
            toEpoch: hostEpoch,
            epoch: EPOCH,
            msgId: msgId(1),
            seq: 0,
            part: 0,
            parts: 1,
            ts: Date.now(),
            kind: 'data' as const,
            ...header,
        };
        // A data frame names its stream, every other kind names none.
        const full: FrameHeader = { ...merged, stream: header.stream ?? (merged.kind === 'data' ? STREAM : '') };
        bus.inject(await codec.seal(full, part));
        await settle(0);
    };

    const hostFrames = (kind: string) =>
        bus.published.filter((frame) => frame.endpoint === 0 && frame.header.kind === kind);

    const message = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

    beforeEach(async () => {
        jest.useFakeTimers();
        jest.setSystemTime(1_700_000_000_000);
        bus = createBus();
        joins.length = 0;
        leaves.length = 0;
        messages.length = 0;
        hostCodec = stubCodec();
        host = createRelayLink({ io: bus.endpoint(), codec: hostCodec, topic: TOPIC, selfId: 'host-id', role: 'host' });
        host.onPeerJoin((peerId) => joins.push(peerId));
        host.onPeerLeave((peerId) => leaves.push(peerId));
        host.onMessage((_peerId, value) => messages.push(value));
        hostEpoch = ''; // not known yet: a presence frame needs none
        await send({ kind: 'presence', to: '', toEpoch: '', msgId: msgId(900) });
        await settle(200);
        hostEpoch = hostFrames('presence')[0].header.epoch; // the host answered the new peer with its epoch
        joins.length = 0;
    });
    afterEach(async () => {
        await host.leave();
        jest.useRealTimers();
    });

    test('presence from a new peer joins it and is answered at once; from a known peer it only keeps it alive', async () => {
        await send({ from: 'other-id', kind: 'presence', to: '', toEpoch: '', msgId: msgId(2) });
        expect(joins).toEqual(['other-id']);
        await settle(200);
        const answers = hostFrames('presence').filter((frame) => frame.header.to === 'other-id');
        expect(answers).toHaveLength(1);
        await send({ from: 'other-id', kind: 'presence', to: '', toEpoch: '', msgId: msgId(3) });
        await settle(200);
        expect(joins).toEqual(['other-id']);
        expect(hostFrames('presence').filter((frame) => frame.header.to === 'other-id')).toHaveLength(1);
    });

    test('a data frame from a peer the link has not met joins it, is answered with presence and delivered', async () => {
        await send({ from: 'late-id', msgId: msgId(5) }, message({ t: 'hello' }));
        expect(joins).toEqual(['late-id']);
        expect(messages).toEqual([{ t: 'hello' }]);
        await settle(200);
        expect(hostFrames('presence').some((frame) => frame.header.to === 'late-id')).toBe(true);
    });

    test('an ack from a peer the link has not met joins it and retires nothing', async () => {
        await send({ from: 'acker-id', kind: 'ack', msgId: msgId(6) });
        expect(joins).toEqual(['acker-id']);
    });

    test('a bye from a peer the link does not know ends nothing and joins nobody', async () => {
        await send({ from: 'ghost-id', kind: 'bye', to: '', toEpoch: '', msgId: msgId(7) });
        expect(joins).toEqual([]);
        await send({ kind: 'bye', to: 'host-id', epoch: 'f'.repeat(32), msgId: msgId(8) }); // known peer, another epoch
        await send({ msgId: msgId(9) }, message({ still: 'joined' }));
        expect(messages).toEqual([{ still: 'joined' }]);
    });

    test('a data frame with the wrong toEpoch, or addressed to nobody here, is dropped before it admits anyone', async () => {
        await send({ from: 'x-id', toEpoch: 'f'.repeat(32), msgId: msgId(10) }, message({ n: 1 }));
        await send({ from: 'y-id', toEpoch: '', msgId: msgId(11) }, message({ n: 2 }));
        await send({ from: 'z-id', to: '', msgId: msgId(12) }, message({ n: 3 })); // data is never a broadcast
        await send({ from: 'w-id', to: 'someone-else', msgId: msgId(13) }, message({ n: 4 }));
        expect(joins).toEqual([]);
        expect(messages).toEqual([]);
    });

    test('a frame this link sent itself is not accepted', async () => {
        await send({ from: 'host-id', kind: 'presence', to: '', toEpoch: '', msgId: msgId(14) });
        expect(joins).toEqual([]);
    });

    describe('a duplicate of a finished message', () => {
        const deliverOnce = async (): Promise<void> => {
            await send({ msgId: msgId(20) }, message({ t: 'once' }));
            await settle(200);
        };

        test('is acknowledged again, but not more than once a second', async () => {
            await deliverOnce();
            expect(hostFrames('ack')).toHaveLength(1);
            await send({ msgId: msgId(20) }, message({ t: 'once' }));
            await settle(500);
            expect(hostFrames('ack')).toHaveLength(1); // a second relay's copy: no new ack
            await settle(RE_ACK_MIN_MS);
            await send({ msgId: msgId(20) }, message({ t: 'once' }));
            await settle(500);
            expect(hostFrames('ack')).toHaveLength(2);
            expect(messages).toEqual([{ t: 'once' }]); // delivered exactly once
        });

        test('from a peer with another epoch, or one the link no longer has, is not acknowledged', async () => {
            await deliverOnce();
            await settle(RE_ACK_MIN_MS * 2);
            await send({ msgId: msgId(20), epoch: 'f'.repeat(32) }, message({ t: 'once' }));
            await send({ kind: 'bye', to: '', toEpoch: '', msgId: msgId(23) }); // the peer leaves
            await send({ msgId: msgId(20) }, message({ t: 'once' }));
            await settle(500);
            expect(hostFrames('ack')).toHaveLength(1);
        });

        test('of a message that is not finished yet, or of another kind, is not acknowledged', async () => {
            await send({ msgId: msgId(21), part: 0, parts: 2 }, message({ half: true }));
            await send({ msgId: msgId(21), part: 0, parts: 2 }, message({ half: true }));
            await send({ kind: 'presence', to: '', toEpoch: '', msgId: msgId(22) });
            await settle(RE_ACK_MIN_MS * 2);
            await send({ kind: 'presence', to: '', toEpoch: '', msgId: msgId(22) });
            await settle(500);
            expect(hostFrames('ack')).toHaveLength(0);
        });
    });

    test(`remembers at most ${MAX_COMPLETED_PER_PEER} finished messages per peer: an older duplicate is no longer acknowledged`, async () => {
        let keepAlive = 5_000;
        /** Lets the 8-a-second ack budget empty its queue; the crafted peer says it is still there meanwhile. */
        const drain = async (): Promise<void> => {
            for (let i = 0; i < 10; i++) {
                await settle(4_000);
                await send({ kind: 'presence', to: '', toEpoch: '', msgId: msgId(keepAlive++) });
            }
        };
        const acksFor = (n: number): number =>
            hostFrames('ack').filter((frame) => frame.header.msgId === msgId(1_000 + n)).length;
        for (let n = 0; n <= MAX_COMPLETED_PER_PEER; n++) {
            await settle(25); // stay under the 50 events a second the link decrypts
            await send({ msgId: msgId(1_000 + n), seq: n }, message({ n }));
        }
        expect(messages).toHaveLength(MAX_COMPLETED_PER_PEER + 1);
        await drain();
        await send({ msgId: msgId(1_000), seq: 0 }, message({ n: 0 })); // the oldest: forgotten
        await send({ msgId: msgId(1_000 + MAX_COMPLETED_PER_PEER), seq: MAX_COMPLETED_PER_PEER }, message({ n: 1 })); // the newest: kept
        await drain();
        expect(acksFor(0)).toBe(1);
        expect(acksFor(MAX_COMPLETED_PER_PEER)).toBe(2);
        expect(messages).toHaveLength(MAX_COMPLETED_PER_PEER + 1);
    });

    test('a message that cannot be read uses up its slot: the next one is delivered at once, not after the gap', async () => {
        await send({ msgId: msgId(30), seq: 0 }, new TextEncoder().encode('not json'));
        await send({ msgId: msgId(31), seq: 1 }, message({ next: true }));
        expect(messages).toEqual([{ next: true }]);
    });

    test('a link that is left while a frame is being opened ignores the frame', async () => {
        let finish = (): void => undefined;
        const open = hostCodec.open;
        hostCodec.open = async (content) => {
            await new Promise<void>((resolve) => (finish = resolve));
            return open(content);
        };
        await send({ from: 'slow-id', kind: 'presence', to: '', toEpoch: '', msgId: msgId(40) });
        await host.leave();
        finish();
        await settle(0);
        expect(joins).toEqual([]);
    });

    describe('a message being unpacked while the link changes', () => {
        const deferUnpack = (): { finish: (item: { message: unknown; size: number } | null) => void } => {
            const handle = { finish: (_item: { message: unknown; size: number } | null): void => undefined };
            hostCodec.unpack = () =>
                new Promise((resolve) => {
                    handle.finish = resolve;
                });
            return handle;
        };

        test('a link that is left meanwhile delivers nothing and arms no timer', async () => {
            const unpacking = deferUnpack();
            await send({ msgId: msgId(50), seq: 3 }, message({ n: 3 })); // behind a gap: a live inbox would arm a timer
            await host.leave();
            unpacking.finish({ message: { n: 3 }, size: 0 });
            await settle(0);
            expect(messages).toEqual([]);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('a sender removed meanwhile has the message parked: nothing is delivered until the sender is admitted again', async () => {
            const unpacking = deferUnpack();
            await send({ msgId: msgId(60), seq: 0 }, message({ n: 0 }));
            await send({ kind: 'bye', to: '', toEpoch: '', msgId: msgId(61) }); // the link removes the sender
            expect(leaves).toEqual(['raw-id']);
            unpacking.finish({ message: { n: 0 }, size: 0 });
            await settle(0);
            await settle(GAP_HOLD_MS * 3);
            expect(messages).toEqual([]);
            await send({ kind: 'presence', to: '', toEpoch: '', msgId: msgId(62) }); // admitted again
            expect(messages).toEqual([{ n: 0 }]);
        });
    });

    describe('a stray frame of an older stream', () => {
        const OLD_STREAM = '9'.repeat(32);

        test('one never seen before, arriving after the live stream is established, does not retire it: later live messages are still delivered', async () => {
            await send({ msgId: msgId(400), seq: 0 }, message({ n: 0 }));
            await send({ msgId: msgId(401), seq: 1 }, message({ n: 1 }));
            await settle(1_000);
            // A replay (or a straggler) of a message of an older stream: it carries an older timestamp.
            await send(
                { msgId: msgId(402), seq: 0, stream: OLD_STREAM, ts: Date.now() - 5_000 },
                message({ stray: true }),
            );
            await send({ msgId: msgId(403), seq: 2 }, message({ n: 2 })); // the live stream goes on
            expect(messages).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
        });

        test('a frame of a retired stream gets no acknowledgement, however often it is sent again; the live stream is acknowledged', async () => {
            await send({ msgId: msgId(410), seq: 0 }, message({ n: 0 }));
            await settle(1_000);
            const stray = { msgId: msgId(411), seq: 0, stream: OLD_STREAM, ts: Date.now() - 5_000 };
            for (let resend = 0; resend < 3; resend++) {
                await send(stray, message({ stray: true }));
                await settle(2_000);
            }
            const ackedIds = hostFrames('ack').map((frame) => frame.header.msgId);
            expect(ackedIds).toContain(msgId(410));
            expect(ackedIds).not.toContain(msgId(411));
            expect(messages).toEqual([{ n: 0 }]);
        });

        test('a genuinely newer stream of the current epoch still retires the old one', async () => {
            await send({ msgId: msgId(420), seq: 0 }, message({ old: 0 }));
            await send({ msgId: msgId(421), seq: 5 }, message({ old: 5 })); // held behind a gap
            await settle(1_000);
            const NEWER = '7'.repeat(32);
            await send({ msgId: msgId(422), seq: 0, stream: NEWER, ts: Date.now() }, message({ fresh: 0 }));
            await settle(GAP_HOLD_MS * 3);
            expect(messages).toEqual([{ old: 0 }, { fresh: 0 }]); // what the old stream held is never delivered
            await send({ msgId: msgId(423), seq: 1, stream: NEWER, ts: Date.now() }, message({ fresh: 1 }));
            await send({ msgId: msgId(424), seq: 1, ts: Date.now() }, message({ old: 1 })); // the old stream is over
            expect(messages).toEqual([{ old: 0 }, { fresh: 0 }, { fresh: 1 }]);
            expect(hostFrames('ack').map((frame) => frame.header.msgId)).not.toContain(msgId(424));
        });

        test('a sender whose clock stepped back is ignored until its clock has caught up with the live stream, and then goes on', async () => {
            await send({ msgId: msgId(440), seq: 0 }, message({ before: true })); // the live stream, newest timestamp now
            await settle(10_000);
            const BEHIND = 100_000; // the sender's clock now runs 100 s behind
            const NEW_STREAM = '4'.repeat(32);
            const stepped = (n: number, seq: number, stream: string) => ({
                msgId: msgId(n),
                seq,
                stream,
                ts: Date.now() - BEHIND,
            });
            await send(stepped(441, 0, NEW_STREAM), message({ after: 0 }));
            expect(messages).toEqual([{ before: true }]); // a stray: older than the live stream's newest
            expect(hostFrames('ack').map((frame) => frame.header.msgId)).not.toContain(msgId(441));
            await settle(91_000); // the clock catches up: its frames must be newer than the live stream's, which takes a little more than the 100 s of the step
            // The sender gave up on the unacknowledged stream long ago and drew another one (a retired id stays retired).
            await send(stepped(442, 0, '3'.repeat(32)), message({ after: 0 }));
            expect(messages).toEqual([{ before: true }, { after: 0 }]);
            await settle(500); // the ack waits its turn behind the presence that answers the re-admitted sender
            expect(hostFrames('ack').map((frame) => frame.header.msgId)).toContain(msgId(442));
        });

        test("the epoch race: an old instance's message that finishes unpacking after the restarted instance's first one cannot retire the live stream", async () => {
            const unpacks: Array<(item: { message: unknown; size: number } | null) => void> = [];
            hostCodec.unpack = () =>
                new Promise((resolve) => {
                    unpacks.push(resolve);
                });
            const NEW_EPOCH = 'f'.repeat(32);
            const NEW_STREAM = '8'.repeat(32);
            await send({ msgId: msgId(430), seq: 0 }, message({ old: 0 })); // the old instance's first message: unpacking
            await settle(1_000);
            await send({ epoch: NEW_EPOCH, kind: 'presence', to: '', toEpoch: '', msgId: msgId(431) }); // the sender restarted
            const restarted = (n: number) => ({ epoch: NEW_EPOCH, stream: NEW_STREAM, msgId: msgId(432 + n), seq: n });
            await send(restarted(0), message({ fresh: 0 })); // its first message: unpacking too
            unpacks[1]({ message: { fresh: 0 }, size: 0 });
            await settle(0);
            unpacks[0]({ message: { old: 0 }, size: 0 }); // the old one finishes last
            await settle(0);
            expect(messages).toEqual([{ fresh: 0 }]);
            await send(restarted(1), message({ fresh: 1 }));
            unpacks[2]({ message: { fresh: 1 }, size: 0 });
            await settle(0);
            expect(messages).toEqual([{ fresh: 0 }, { fresh: 1 }]); // the live stream survived
        });
    });

    describe('a peer that shows up with another epoch', () => {
        const OLD = 'c'.repeat(32);
        const NEW = 'd'.repeat(32);
        const presence = (epoch: string, ts: number, n: number): Promise<void> =>
            send({ from: 'moving-id', kind: 'presence', to: '', toEpoch: '', epoch, ts, msgId: msgId(n) });

        test('replaces the live peer only if it is newer than anything accepted from it', async () => {
            const start = Date.now();
            await presence(OLD, start, 100);
            expect(joins).toEqual(['moving-id']);
            await settle(1_000);
            await presence(NEW, start + 1_000, 101); // a restart: newer, so it replaces the peer
            expect(leaves).toEqual(['moving-id']);
            expect(joins).toEqual(['moving-id', 'moving-id']);
            await settle(1_000);
            await presence(OLD, start + 500, 102); // an older recorded presence of the first epoch: ignored
            expect(leaves).toEqual(['moving-id']);
            expect(joins).toEqual(['moving-id', 'moving-id']);
            // The live peer still works.
            await send({ from: 'moving-id', epoch: NEW, msgId: msgId(103) }, message({ still: 'live' }));
            expect(messages).toEqual([{ still: 'live' }]);
        });

        test('an older data or ack frame of another epoch changes nothing either', async () => {
            const start = Date.now();
            await presence(NEW, start, 110);
            await settle(1_000);
            await send({ from: 'moving-id', epoch: OLD, ts: start - 500, msgId: msgId(111) }, message({ n: 1 }));
            await send({ from: 'moving-id', epoch: OLD, kind: 'ack', ts: start - 400, msgId: msgId(112) });
            expect(messages).toEqual([]);
            expect(leaves).toEqual([]);
            expect(joins).toEqual(['moving-id']);
        });

        test('a frame as new as the live peer is not enough: it has to be newer', async () => {
            const start = Date.now();
            await presence(OLD, start, 120);
            await presence(NEW, start, 121);
            expect(leaves).toEqual([]);
        });
    });

    describe('parts and replays', () => {
        const half = (n: number, part: number, seq = 0) => ({ msgId: msgId(n), part, parts: 2, seq });

        test('a partial message that was evicted completes when its sender sends the parts again', async () => {
            await send(half(200, 0), message({ big: 'message' }).subarray(0, 8));
            for (let n = 201; n <= 208; n++) await send(half(n, 0, n)); // eight more partials: the first is evicted
            // The first message's part 0 was seen before, yet it is accepted again, and the message completes.
            await send(half(200, 0), message({ big: 'message' }).subarray(0, 8));
            await send(half(200, 1), message({ big: 'message' }).subarray(8));
            expect(messages).toEqual([{ big: 'message' }]);
        });

        test('a finished message that is replayed — whole, or part by part — is not delivered twice', async () => {
            const bytes = message({ once: true });
            await send(half(210, 0), bytes.subarray(0, 4));
            await send(half(210, 1), bytes.subarray(4));
            expect(messages).toEqual([{ once: true }]);
            await settle(RE_ACK_MIN_MS * 2);
            await send(half(210, 0), bytes.subarray(0, 4));
            await send(half(210, 1), bytes.subarray(4));
            await send(half(210, 1), bytes.subarray(4));
            expect(messages).toEqual([{ once: true }]);
            expect(
                hostFrames('ack').filter((frame) => frame.header.msgId === msgId(210)).length,
            ).toBeGreaterThanOrEqual(1);
        });

        test('a fresh stream is ordered from 0: a message numbered 1 waits for 0, and both are delivered in order', async () => {
            await send({ msgId: msgId(220), seq: 1 }, message({ n: 1 }));
            expect(messages).toEqual([]);
            await send({ msgId: msgId(221), seq: 0 }, message({ n: 0 }));
            expect(messages).toEqual([{ n: 0 }, { n: 1 }]);
        });

        test('a sender the link dropped and admits again continues its stream where it was: no stall, no reset', async () => {
            await send({ msgId: msgId(230), seq: 0 }, message({ n: 0 }));
            await send({ msgId: msgId(231), seq: 1 }, message({ n: 1 }));
            await send({ kind: 'bye', to: '', toEpoch: '', msgId: msgId(232) }); // the link forgets the sender
            expect(leaves).toEqual(['raw-id']);
            await send({ kind: 'presence', to: '', toEpoch: '', msgId: msgId(233) }); // and admits it again
            expect(joins).toEqual(['raw-id']);
            await send({ msgId: msgId(234), seq: 2 }, message({ n: 2 })); // the sender kept going
            expect(messages).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]); // delivered at once, no gap of 10 s
        });

        test('a sender that forgot the link and starts a new stream is delivered in order from 0, whatever the old stream expected', async () => {
            for (let seq = 0; seq < 40; seq++)
                await send({ msgId: msgId(240 + seq), seq, ts: Date.now() }, message({ old: seq }));
            const delivered = messages.length;
            await settle(1_000); // the sender starts its new stream later than anything of the old one
            const other = '6'.repeat(32);
            await send({ msgId: msgId(300), seq: 1, stream: other }, message({ fresh: 1 })); // not taken for a late message of the old stream
            expect(messages).toHaveLength(delivered);
            await send({ msgId: msgId(301), seq: 0, stream: other }, message({ fresh: 0 }));
            expect(messages.slice(delivered)).toEqual([{ fresh: 0 }, { fresh: 1 }]);
        });
    });
});
