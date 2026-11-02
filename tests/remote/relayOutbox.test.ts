/**
 * The relay link's sending half: the 8-events-a-second budget, control frames first, the
 * sequence number taken when a message first leaves, the resend timer that starts after the
 * last part left, give-up after three resends, and log lines dropped first under backlog.
 */

import {
    ACK_LINGER_MS,
    BACKLOG_FRAMES,
    MAX_OWED_ACKS,
    MAX_RELEASED_ACKS,
    MAX_QUEUED_FRAMES,
    MAX_RESENDS,
    RESEND_MS,
    createOutbox,
} from '../../src/ts/core/remote/relayOutbox';

import {
    RELAY_BATCH_ACK_BYTES,
    RELAY_BATCH_FRAME_BYTES,
    RELAY_BATCH_MAX_FRAMES,
    batchBudgetBytes,
} from '../../src/ts/core/remote/relayBatchCodec';
import { RELAY_PART_BYTES } from '../../src/ts/core/remote/relayWire';

import type { EmitBatch, EmitFrame, OutFrame } from '../../src/ts/core/remote/relayOutbox';

const id = (n: number): string => n.toString(16).padStart(32, '0');

const frame = (msgId: string, part: number, parts: number, to = 'peer'): OutFrame => ({
    draft: { to, toEpoch: id(1), msgId, part, parts, kind: 'data' },
    part: Uint8Array.from([part]),
});

const frames = (msgId: string, parts: number, to = 'peer'): OutFrame[] =>
    Array.from({ length: parts }, (_v, part) => frame(msgId, part, parts, to));

const control = (kind: 'presence' | 'ack' | 'bye', msgId: string): OutFrame => ({
    draft: { to: 'peer', toEpoch: id(1), msgId, part: 0, parts: 1, kind },
    part: new Uint8Array(0),
});

describe('createOutbox', () => {
    let emitted: EmitFrame[];
    let givenUp: string[];
    let acked: string[];
    let outbox: ReturnType<typeof createOutbox>;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        emitted = [];
        givenUp = [];
        acked = [];
        let drawn = 0;
        outbox = createOutbox({
            now: () => Date.now(),
            // Each stream id is the next counter value, so a test can tell the streams apart.
            random: (length) => new Uint8Array(length).fill(++drawn),
            emit: (out) => emitted.push(out),
            emitBatch: () => undefined,
            canBatch: () => false,
            batchBudgetBytes: () => 0,
            giveUp: (peerId) => givenUp.push(peerId),
            onAcked: (peerId) => acked.push(peerId),
        });
    });
    afterEach(() => {
        outbox.close();
        jest.useRealTimers();
    });

    const ids = (): string[] =>
        emitted.map((out) => `${out.draft.kind}:${out.draft.msgId.slice(-2)}:${out.draft.part}`);

    test('at most 8 events leave a second; the rest wait for the budget', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 20), false, null);
        expect(emitted).toHaveLength(1);
        jest.advanceTimersByTime(999);
        expect(emitted.length).toBeLessThanOrEqual(9);
        jest.advanceTimersByTime(1);
        expect(emitted).toHaveLength(9);
        jest.advanceTimersByTime(1_500);
        expect(emitted).toHaveLength(20);
    });

    test('control frames go before queued data, and carry sequence 0', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 3), false, null);
        outbox.sendControl(control('presence', id(2)));
        outbox.sendControl(control('ack', id(3)));
        jest.advanceTimersByTime(1_000);
        expect(ids()).toEqual(['data:01:0', 'presence:02:0', 'ack:03:0', 'data:01:1', 'data:01:2']);
        expect(emitted.filter((out) => out.draft.kind !== 'data').map((out) => out.draft.seq)).toEqual([0, 0]);
    });

    test('a message takes its sequence number when its first frame leaves, one stream per peer', () => {
        outbox.sendMessage('a', id(1), frames(id(1), 2, 'a'), false, null);
        outbox.sendMessage('a', id(2), frames(id(2), 1, 'a'), false, null);
        outbox.sendMessage('b', id(3), frames(id(3), 1, 'b'), false, null);
        jest.advanceTimersByTime(1_000);
        const seqOf = (msg: number): number[] =>
            emitted.filter((out) => out.draft.msgId === id(msg)).map((out) => out.draft.seq);
        expect(seqOf(1)).toEqual([0, 0]);
        expect(seqOf(2)).toEqual([1]);
        expect(seqOf(3)).toEqual([0]);
    });

    test('a stream has an id of its own per peer, drawn at the first send, and a forgotten peer gets a new stream at 0', () => {
        outbox.sendMessage('a', id(1), frames(id(1), 1, 'a'), false, null);
        outbox.sendMessage('a', id(2), frames(id(2), 1, 'a'), false, null);
        outbox.sendMessage('b', id(3), frames(id(3), 1, 'b'), false, null);
        jest.advanceTimersByTime(1_000);
        const place = (msg: number): [string, number] => {
            const out = emitted.find((frame) => frame.draft.msgId === id(msg));
            return [out?.draft.stream ?? '', out?.draft.seq ?? -1];
        };
        const [streamA, seqA] = place(1);
        expect(streamA).toMatch(/^[0-9a-f]{32}$/);
        expect([seqA, place(2)[1]]).toEqual([0, 1]);
        expect(place(2)[0]).toBe(streamA); // one stream while the peer is remembered
        expect(place(3)[0]).not.toBe(streamA); // another peer, another stream
        outbox.forgetPeer('a');
        outbox.sendMessage('a', id(4), frames(id(4), 1, 'a'), false, null);
        jest.advanceTimersByTime(1_000);
        expect(place(4)[1]).toBe(0);
        expect(place(4)[0]).not.toBe(streamA);
    });

    test('a resend carries the stream and sequence number of the first send', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 1), false, null);
        jest.advanceTimersByTime(RESEND_MS + 125);
        const sent = emitted.filter((out) => out.draft.msgId === id(1));
        expect(sent).toHaveLength(2);
        expect(sent[1].draft.stream).toBe(sent[0].draft.stream);
        expect(sent[1].draft.seq).toBe(sent[0].draft.seq);
    });

    test('control frames name no stream', () => {
        outbox.sendControl(control('presence', id(1)));
        expect(emitted[0].draft.stream).toBe('');
    });

    test('a message dropped before it started never uses a sequence number', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 20), false, null);
        outbox.sendMessage('peer', id(2), frames(id(2), 1), true, null); // queued behind a backlog: dropped at once
        outbox.sendMessage('peer', id(3), frames(id(3), 1), false, null);
        jest.advanceTimersByTime(5_000);
        const seqs = emitted.map((out) => [out.draft.msgId, out.draft.seq]);
        expect(seqs.filter(([msg]) => msg === id(3))).toEqual([[id(3), 1]]);
        expect(emitted.some((out) => out.draft.msgId === id(2))).toBe(false);
    });

    test('the resend timer starts after the last part left, and the message is sent again until acknowledged', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 2), false, null);
        jest.advanceTimersByTime(125); // both parts have left
        expect(emitted).toHaveLength(2);
        jest.advanceTimersByTime(RESEND_MS - 1);
        expect(emitted).toHaveLength(2);
        jest.advanceTimersByTime(1);
        jest.advanceTimersByTime(125);
        expect(emitted).toHaveLength(4); // both parts again, same sequence number
        expect(new Set(emitted.map((out) => out.draft.seq))).toEqual(new Set([0]));
        outbox.ack('peer', id(1));
        jest.advanceTimersByTime(RESEND_MS * 5);
        expect(emitted).toHaveLength(4);
        expect(givenUp).toEqual([]);
    });

    test('a slow budget does not start the resend timer early', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 30), false, null); // takes ~3.6 s to leave
        jest.advanceTimersByTime(RESEND_MS);
        expect(emitted.length).toBeLessThan(40); // no resend yet: the last part left at ~3.6 s, the timer ends at ~7.6 s
        expect(emitted.filter((out) => out.draft.part === 0)).toHaveLength(1);
    });

    test(`after ${MAX_RESENDS} resends and a last wait, the peer is given up on`, () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 1), false, null);
        for (let resend = 1; resend <= MAX_RESENDS; resend++) {
            jest.advanceTimersByTime(RESEND_MS);
            expect(emitted).toHaveLength(1 + resend);
            expect(givenUp).toEqual([]);
        }
        jest.advanceTimersByTime(RESEND_MS);
        expect(givenUp).toEqual(['peer']);
        jest.advanceTimersByTime(RESEND_MS * 5);
        expect(emitted).toHaveLength(1 + MAX_RESENDS);
    });

    test('an ack from another peer does not retire the message; an ack for an unknown message does nothing', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 1), false, null);
        outbox.ack('stranger', id(1));
        outbox.ack('peer', id(9));
        jest.advanceTimersByTime(RESEND_MS);
        expect(emitted).toHaveLength(2);
    });

    test('forgetting a peer drops its queued and unacknowledged messages and restarts its sequence', () => {
        outbox.sendMessage('a', id(1), frames(id(1), 10, 'a'), false, null);
        outbox.sendMessage('b', id(2), frames(id(2), 1, 'b'), false, null);
        jest.advanceTimersByTime(250); // a's first three frames left
        outbox.forgetPeer('a');
        jest.advanceTimersByTime(RESEND_MS * 5);
        expect(emitted.filter((out) => out.draft.to === 'a')).toHaveLength(3);
        expect(givenUp).toEqual(['b']); // only b, which nobody acknowledged, is given up on
        outbox.sendMessage('a', id(3), frames(id(3), 1, 'a'), false, null);
        jest.advanceTimersByTime(1_000);
        expect(emitted.find((out) => out.draft.msgId === id(3))?.draft.seq).toBe(0);
    });

    test('under backlog queued log messages are dropped, started ones and everything else are kept', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 2), true, null); // a log message, started at once
        outbox.sendMessage('peer', id(2), frames(id(2), 3), true, null); // a second log message, queued behind it
        outbox.sendMessage('peer', id(3), frames(id(3), BACKLOG_FRAMES), false, null); // pushes the queue past the backlog
        jest.advanceTimersByTime(10_000);
        const left = (msg: number): number => emitted.filter((out) => out.draft.msgId === id(msg)).length;
        expect(left(1)).toBeGreaterThanOrEqual(2); // the started log message completes
        expect(left(2)).toBe(0); // the queued one was dropped
        expect(left(3)).toBeGreaterThanOrEqual(BACKLOG_FRAMES);
    });

    test('a log message arriving at a backlog is dropped; other messages are never dropped', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), BACKLOG_FRAMES + 4), false, null);
        outbox.sendMessage('peer', id(2), frames(id(2), 1), true, null);
        outbox.sendMessage('peer', id(3), frames(id(3), 1), false, null);
        jest.advanceTimersByTime(10_000);
        expect(emitted.some((out) => out.draft.msgId === id(2))).toBe(false);
        expect(emitted.some((out) => out.draft.msgId === id(3))).toBe(true);
    });

    test('a send that would pass the queue cap throws and queues nothing', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), MAX_QUEUED_FRAMES - 1), false, null);
        expect(() => outbox.sendMessage('peer', id(2), frames(id(2), 5), false, null)).toThrow(
            'relay send queue is full',
        );
        jest.advanceTimersByTime(60_000);
        expect(emitted.some((out) => out.draft.msgId === id(2))).toBe(false);
    });

    test('forgetting a peer answers how many of its messages that dropped (queued, started or waiting for an ack)', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 3), false, 'one'); // started: waits for its ack
        outbox.sendMessage('peer', id(2), frames(id(2), 1), false, 'two'); // queued behind the budget
        outbox.sendMessage('other', id(3), frames(id(3), 1, 'other'), false, 'three');
        expect(outbox.forgetPeer('peer')).toBe(2);
        expect(outbox.forgetPeer('peer')).toBe(0);
        expect(outbox.forgetPeer('nobody')).toBe(0);
        expect(outbox.forgetPeer('other')).toBe(1);
    });

    describe('taking back the messages that have not started', () => {
        test("answers the originals of the peer's unstarted messages in queue order, and they are not sent here any more", () => {
            outbox.sendMessage('peer', id(1), frames(id(1), 3), false, { t: 'started' }); // its first frame leaves at once
            outbox.sendMessage('peer', id(2), frames(id(2), 2), false, { t: 'second' });
            outbox.sendMessage('other', id(3), frames(id(3), 1, 'other'), false, { t: 'other peer' });
            outbox.sendMessage('peer', id(4), frames(id(4), 1), true, { t: 'log line' });
            outbox.sendControl(control('presence', id(9)));
            expect(outbox.takeUnstarted('peer')).toEqual([{ t: 'second' }, { t: 'log line' }]);
            expect(outbox.takeUnstarted('peer')).toEqual([]); // taken once
            jest.advanceTimersByTime(10_000);
            // The started one finished (its frames), the other peer's and the control frame went; the two taken did not.
            const sentMessages = new Set(emitted.map((out) => out.draft.msgId));
            expect(sentMessages).toEqual(new Set([id(1), id(3), id(9)]));
        });

        test('a message that has started is not taken, and goes on to be sent again until acknowledged', () => {
            outbox.sendMessage('peer', id(1), frames(id(1), 1), false, { t: 'started' });
            expect(outbox.takeUnstarted('peer')).toEqual([]);
            jest.advanceTimersByTime(RESEND_MS);
            expect(emitted.filter((out) => out.draft.msgId === id(1))).toHaveLength(2);
        });

        test('a peer with nothing queued answers an empty list', () => {
            expect(outbox.takeUnstarted('nobody')).toEqual([]);
        });
    });

    describe('the messages that started and are not acknowledged', () => {
        test('are answered in queue order, started ones only, and stay queued: they are resent until acknowledged', () => {
            outbox.sendMessage('peer', id(1), frames(id(1), 3), false, { t: 'started' }); // its first frame leaves at once
            outbox.sendMessage('other', id(3), frames(id(3), 1, 'other'), false, { t: 'other peer' });
            outbox.sendMessage('peer', id(2), frames(id(2), 2), false, { t: 'second' }); // queued behind the budget
            expect(outbox.startedMessages('peer')).toEqual([{ t: 'started' }]);
            expect(outbox.startedMessages('peer')).toEqual([{ t: 'started' }]); // asking takes nothing
            expect(outbox.startedMessages('nobody')).toEqual([]);
            jest.advanceTimersByTime(RESEND_MS * 2);
            expect(emitted.filter((out) => out.draft.msgId === id(1)).length).toBeGreaterThan(3); // sent again
        });

        test('a message counts until its ack, an unstarted one does not, and the ack tells onAcked', () => {
            outbox.sendMessage('peer', id(1), frames(id(1), 1), false, 'one');
            outbox.sendMessage('peer', id(2), frames(id(2), 1), false, 'two'); // queued behind the budget
            outbox.sendMessage('other', id(3), frames(id(3), 1, 'other'), false, 'three');
            expect(outbox.startedMessages('peer')).toEqual(['one']);
            expect(outbox.startedMessages('other')).toEqual([]);
            outbox.ack('peer', id(1));
            expect(acked).toEqual(['peer']);
            expect(outbox.startedMessages('peer')).toEqual([]);
        });

        test('an ack for a message the outbox does not hold tells nobody', () => {
            outbox.ack('peer', id(7));
            expect(acked).toEqual([]);
        });
    });

    test('close stops everything: timers, the queue and the resend', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 5), false, null);
        outbox.close();
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(RESEND_MS * 5);
        expect(emitted).toHaveLength(1);
    });
});

/** The budget of a batch between two ordinary ids, and a peer whose id leaves room for one small part per event. */
const BUDGET = batchBudgetBytes('host-id', 'peer');
const TIGHT_BUDGET = 2 * (RELAY_BATCH_FRAME_BYTES + 1) - 1;

describe('createOutbox to a peer that reads batch events', () => {
    let emitted: EmitFrame[];
    let batches: EmitBatch[];
    let givenUp: string[];
    let acked: string[];
    let batchPeers: Set<string>;
    let outbox: ReturnType<typeof createOutbox>;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        emitted = [];
        batches = [];
        givenUp = [];
        acked = [];
        batchPeers = new Set(['peer', 'a', 'b', 'tight']);
        let drawn = 0;
        outbox = createOutbox({
            now: () => Date.now(),
            random: (length) => new Uint8Array(length).fill(++drawn),
            emit: (out) => emitted.push(out),
            emitBatch: (batch) => batches.push(batch),
            canBatch: (peerId) => batchPeers.has(peerId),
            batchBudgetBytes: (peerId) => (peerId === 'tight' ? TIGHT_BUDGET : peerId === 'narrow' ? 0 : BUDGET),
            giveUp: (peerId) => givenUp.push(peerId),
            onAcked: (peerId) => acked.push(peerId),
        });
    });
    afterEach(() => {
        outbox.close();
        jest.useRealTimers();
    });

    /** Spends the one token the budget starts with, so what is queued next waits and leaves together at the next token. */
    const spendToken = (): void => {
        outbox.sendControl(control('presence', id(99)));
        emitted.length = 0;
    };
    const msgIds = (batch: EmitBatch): string[] => batch.frames.map((f) => f.msgId.slice(-2));
    const bigFrame = (msgId: string, to = 'peer'): OutFrame => ({
        draft: { to, toEpoch: id(1), msgId, part: 0, parts: 1, kind: 'data' },
        part: new Uint8Array(RELAY_PART_BYTES),
    });

    test('everything queued for the peer leaves in one event that costs one token', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 20), false, null);
        expect(batches).toHaveLength(1);
        expect(batches[0].frames).toHaveLength(20);
        expect(emitted).toHaveLength(0);
        expect(batches[0]).toMatchObject({ to: 'peer', toEpoch: id(1), acks: [] });
        jest.advanceTimersByTime(1_000);
        expect(batches).toHaveLength(1); // nothing left to send
    });

    test('messages queued while the budget is spent leave together at the next token', () => {
        spendToken();
        outbox.sendMessage('peer', id(1), frames(id(1), 20), false, null);
        outbox.sendMessage('peer', id(2), frames(id(2), 2), false, null);
        expect(batches).toHaveLength(0);
        jest.advanceTimersByTime(125);
        expect(batches).toHaveLength(1);
        expect(batches[0].frames).toHaveLength(22);
    });

    test('a batch carries each part with the stream and sequence number its message took', () => {
        spendToken();
        outbox.sendMessage('peer', id(1), frames(id(1), 2), false, null);
        outbox.sendMessage('peer', id(2), frames(id(2), 1), false, null);
        jest.advanceTimersByTime(125);
        expect(
            batches[0].frames.map(({ msgId, part, parts, seq, stream, bytes }) => [
                msgId.slice(-2),
                part,
                parts,
                seq,
                stream,
                [...bytes],
            ]),
        ).toEqual([
            ['01', 0, 2, 0, expect.stringMatching(/^[0-9a-f]{32}$/), [0]],
            ['01', 1, 2, 0, batches[0].frames[0].stream, [1]],
            ['02', 0, 1, 1, batches[0].frames[0].stream, [0]],
        ]);
    });

    test('a batch holds one peer: the frames of another wait for the next event', () => {
        spendToken();
        outbox.sendMessage('a', id(1), frames(id(1), 2, 'a'), false, null);
        outbox.sendMessage('b', id(2), frames(id(2), 2, 'b'), false, null);
        outbox.sendMessage('a', id(3), frames(id(3), 1, 'a'), false, null);
        jest.advanceTimersByTime(125);
        expect(batches.map((batch) => [batch.to, msgIds(batch)])).toEqual([['a', ['01', '01', '03']]]);
        jest.advanceTimersByTime(125);
        expect(batches.map((batch) => [batch.to, msgIds(batch)])).toEqual([
            ['a', ['01', '01', '03']],
            ['b', ['02', '02']],
        ]);
    });

    test('a batch holds at most the frame cap; the rest leaves with the next token', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), RELAY_BATCH_MAX_FRAMES + 36), false, null);
        expect(batches.map((batch) => batch.frames.length)).toEqual([RELAY_BATCH_MAX_FRAMES]);
        jest.advanceTimersByTime(125);
        expect(batches.map((batch) => batch.frames.length)).toEqual([RELAY_BATCH_MAX_FRAMES, 36]);
    });

    test('one full part fits an event alone; two do not fit one', () => {
        outbox.sendMessage('peer', id(1), [bigFrame(id(1))], false, null);
        expect(batches.map(msgIds)).toEqual([['01']]);
        outbox.sendMessage('peer', id(2), [bigFrame(id(2))], false, null);
        outbox.sendMessage('peer', id(3), [bigFrame(id(3))], false, null);
        jest.advanceTimersByTime(125);
        expect(batches.map(msgIds)).toEqual([['01'], ['02']]);
        jest.advanceTimersByTime(125);
        expect(batches.map(msgIds)).toEqual([['01'], ['02'], ['03']]);
    });

    test('a peer that does not read batches gets one frame an event, and does not hold a batch back', () => {
        outbox.sendMessage('old', id(1), frames(id(1), 3, 'old'), false, null);
        expect(emitted).toHaveLength(1);
        outbox.sendMessage('a', id(2), frames(id(2), 2, 'a'), false, null);
        jest.advanceTimersByTime(125);
        expect(emitted).toHaveLength(2);
        expect(batches).toHaveLength(0);
        jest.advanceTimersByTime(125);
        expect(emitted).toHaveLength(3);
        jest.advanceTimersByTime(125);
        expect(batches.map(msgIds)).toEqual([['02', '02']]);
    });

    test('presence and the other control frames leave as frames, before a batch', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 2), false, null);
        outbox.sendControl(control('presence', id(2)));
        // The batch took the first token before the presence was queued; the presence is next.
        expect(batches).toHaveLength(1);
        expect(emitted).toHaveLength(0);
        jest.advanceTimersByTime(125);
        expect(emitted.map((out) => out.draft.kind)).toEqual(['presence']);
    });

    test('control frames queued with data go before the batch', () => {
        outbox.sendMessage('other', id(9), frames(id(9), 1, 'other'), false, null); // takes the only token
        outbox.sendMessage('peer', id(1), frames(id(1), 2), false, null);
        outbox.sendControl(control('bye', id(2)));
        jest.advanceTimersByTime(125);
        expect(emitted.map((out) => out.draft.kind)).toEqual(['data', 'bye']);
        expect(batches).toHaveLength(0);
        jest.advanceTimersByTime(125);
        expect(batches).toHaveLength(1);
    });

    describe('acks', () => {
        test('an ack with nothing to ride with leaves alone after the linger', () => {
            outbox.sendBatchedAck('peer', id(5), id(7));
            jest.advanceTimersByTime(ACK_LINGER_MS - 1);
            expect(batches).toHaveLength(0);
            jest.advanceTimersByTime(1);
            expect(batches).toEqual([{ to: 'peer', toEpoch: id(5), acks: [id(7)], frames: [] }]);
            jest.advanceTimersByTime(60_000);
            expect(batches).toHaveLength(1);
        });

        test('data queued within the linger leaves at once with the ack, in one event', () => {
            outbox.sendBatchedAck('peer', id(1), id(7));
            jest.advanceTimersByTime(6);
            outbox.sendMessage('peer', id(2), frames(id(2), 1), false, null);
            expect(batches).toEqual([
                { to: 'peer', toEpoch: id(1), acks: [id(7)], frames: [expect.objectContaining({ part: 0 })] },
            ]);
            jest.advanceTimersByTime(1_000);
            expect(batches).toHaveLength(1);
        });

        test('acks queued while the budget is spent ride in the next data event', () => {
            spendToken();
            outbox.sendBatchedAck('peer', id(1), id(7));
            outbox.sendBatchedAck('peer', id(1), id(8));
            outbox.sendMessage('peer', id(2), frames(id(2), 2), false, null);
            outbox.sendBatchedAck('peer', id(1), id(9));
            expect(batches).toHaveLength(0);
            jest.advanceTimersByTime(125);
            expect(batches).toHaveLength(1);
            expect(batches[0].acks).toEqual([id(7), id(8), id(9)]);
            expect(msgIds(batches[0])).toEqual(['02', '02']);
        });

        test('at most the frame cap of acks leave in an event, and acks and parts share the cap', () => {
            for (let n = 0; n < RELAY_BATCH_MAX_FRAMES + 6; n++) outbox.sendBatchedAck('peer', id(1), id(100 + n));
            jest.advanceTimersByTime(ACK_LINGER_MS);
            expect(batches.map((batch) => batch.acks.length)).toEqual([RELAY_BATCH_MAX_FRAMES]);
            jest.advanceTimersByTime(125);
            expect(batches.map((batch) => batch.acks.length)).toEqual([RELAY_BATCH_MAX_FRAMES, 6]);
            // 62 acks leave room for two parts of the five queued.
            for (let n = 0; n < 62; n++) outbox.sendBatchedAck('peer', id(1), id(300 + n));
            outbox.sendMessage('peer', id(1), frames(id(1), 5), false, null);
            jest.advanceTimersByTime(125);
            const last = batches[batches.length - 1];
            expect([last.acks.length, last.frames.length]).toEqual([62, 2]);
        });

        test('acks take the byte room first: a part that no longer fits waits for the next event', () => {
            const spare = BUDGET - RELAY_BATCH_FRAME_BYTES - RELAY_PART_BYTES;
            const acks = Math.floor(spare / RELAY_BATCH_ACK_BYTES) + 1;
            for (let n = 0; n < acks; n++) outbox.sendBatchedAck('peer', id(1), id(100 + n));
            outbox.sendMessage('peer', id(1), [bigFrame(id(1))], false, null);
            expect(batches.map((batch) => [batch.acks.length, batch.frames.length])).toEqual([[acks, 0]]);
            jest.advanceTimersByTime(125);
            expect(batches.map((batch) => [batch.acks.length, batch.frames.length])).toEqual([
                [acks, 0],
                [0, 1],
            ]);
        });

        test('an ack that has waited its linger goes before data for another peer', () => {
            spendToken();
            outbox.sendMessage('b', id(2), frames(id(2), 1, 'b'), false, null);
            outbox.sendBatchedAck('a', id(1), id(7));
            jest.advanceTimersByTime(125);
            expect(batches.map((batch) => batch.to)).toEqual(['a']);
            jest.advanceTimersByTime(125);
            expect(batches.map((batch) => batch.to)).toEqual(['a', 'b']);
        });

        test('the timer waits for the oldest owed ack, and a later ack does not restart it', () => {
            outbox.sendBatchedAck('a', id(1), id(7));
            jest.advanceTimersByTime(30);
            outbox.sendBatchedAck('b', id(1), id(8));
            outbox.sendBatchedAck('a', id(1), id(9));
            jest.advanceTimersByTime(ACK_LINGER_MS - 30);
            expect(batches.map((batch) => [batch.to, batch.acks])).toEqual([['a', [id(7), id(9)]]]);
            jest.advanceTimersByTime(125);
            expect(batches.map((batch) => batch.to)).toEqual(['a', 'b']);
        });

        test('forgetting a peer drops the acks owed to it', () => {
            outbox.sendBatchedAck('peer', id(1), id(7));
            outbox.forgetPeer('peer');
            jest.advanceTimersByTime(60_000);
            expect(batches).toHaveLength(0);
            expect(jest.getTimerCount()).toBe(0);
        });

        test('close drops the acks owed: data queued afterwards leaves without them', () => {
            outbox.sendBatchedAck('peer', id(1), id(7));
            outbox.close();
            jest.advanceTimersByTime(60_000);
            expect(batches).toHaveLength(0);
            outbox.sendMessage('peer', id(1), frames(id(1), 1), false, null);
            expect(batches).toEqual([{ to: 'peer', toEpoch: id(1), acks: [], frames: [expect.anything()] }]);
        });

        test('past the owed-ack cap the oldest ids are dropped, and data still leaves in later batches', () => {
            spendToken();
            for (let n = 0; n < MAX_OWED_ACKS + 10; n++) outbox.sendBatchedAck('peer', id(1), id(1000 + n));
            outbox.sendMessage('peer', id(1), frames(id(1), 1), false, null);
            // Acks take batch slots ahead of data: RELAY_BATCH_MAX_FRAMES acks ride per batch, one batch every 125 ms,
            // so the owed acks take MAX_OWED_ACKS / RELAY_BATCH_MAX_FRAMES batches, and the data leaves after them.
            jest.advanceTimersByTime(125 * (MAX_OWED_ACKS / RELAY_BATCH_MAX_FRAMES + 2));
            const acked = batches.flatMap((batch) => batch.acks);
            expect(acked).toHaveLength(MAX_OWED_ACKS);
            expect(acked[0]).toBe(id(1010)); // the ten oldest were dropped
            expect(acked[acked.length - 1]).toBe(id(1000 + MAX_OWED_ACKS + 9));
            expect(batches.flatMap((batch) => batch.frames).map((f) => f.msgId)).toEqual([id(1)]);
        });
    });

    test('a part that does not fit an empty batch for the peer is sent as a frame, not as a batch (and nothing throws)', () => {
        batchPeers.add('narrow');
        spendToken();
        outbox.sendMessage('narrow', id(1), [bigFrame(id(1), 'narrow')], false, null); // its budget is below one full part
        jest.advanceTimersByTime(125);
        expect(batches).toEqual([]);
        expect(emitted.map((out) => [out.draft.to, out.draft.msgId])).toEqual([['narrow', id(1)]]);
        // Another peer's batch is not held up behind it, and the link goes on.
        outbox.sendMessage('a', id(2), frames(id(2), 1, 'a'), false, null);
        jest.advanceTimersByTime(125);
        expect(batches.map(msgIds)).toEqual([['02']]);
    });

    test('acks owed to a peer that no longer reads batches leave as ack frames, at once', () => {
        spendToken();
        outbox.sendBatchedAck('a', id(5), id(7));
        outbox.sendBatchedAck('a', id(5), id(8));
        outbox.sendBatchedAck('b', id(6), id(9));
        batchPeers.delete('a');
        jest.advanceTimersByTime(125);
        expect(emitted.map((out) => [out.draft.kind, out.draft.to, out.draft.toEpoch, out.draft.msgId])).toEqual([
            ['ack', 'a', id(5), id(7)],
        ]);
        jest.advanceTimersByTime(125);
        expect(emitted.map((out) => out.draft.msgId)).toEqual([id(7), id(8)]);
        expect(batches).toEqual([]); // b's ack waits for the next token
        jest.advanceTimersByTime(125);
        expect(batches).toEqual([{ to: 'b', toEpoch: id(6), acks: [id(9)], frames: [] }]);
    });

    test('at most 8 owed acks of a peer that stopped reading batches leave as frames, the newest ones; the rest are dropped', () => {
        spendToken();
        for (let n = 0; n < 40; n++) outbox.sendBatchedAck('a', id(5), id(1000 + n));
        outbox.sendMessage('a', id(2), frames(id(2), 1, 'a'), false, null);
        batchPeers.delete('a');
        jest.advanceTimersByTime(125 * (MAX_RELEASED_ACKS + 2));
        const acksSent = emitted.filter((out) => out.draft.kind === 'ack').map((out) => out.draft.msgId);
        expect(acksSent).toEqual(
            Array.from({ length: MAX_RELEASED_ACKS }, (_v, i) => id(1000 + 40 - MAX_RELEASED_ACKS + i)),
        );
        // The data goes after them, as a frame (the peer no longer reads batches), and nothing else is held up.
        expect(emitted.at(-1)?.draft).toMatchObject({ kind: 'data', msgId: id(2) });
        expect(MAX_RELEASED_ACKS).toBe(8);
    });

    test('the budget is asked for the peer the batch is for', () => {
        spendToken();
        outbox.sendMessage('tight', id(1), frames(id(1), 3, 'tight'), false, null);
        jest.advanceTimersByTime(125 * 3);
        expect(batches.map((batch) => batch.frames.length)).toEqual([1, 1, 1]);
    });

    test('a log message that has started in a batch is never dropped under backlog', () => {
        spendToken();
        // The tight budget lets one part leave an event, so the log message is started with parts still queued.
        outbox.sendMessage('tight', id(1), frames(id(1), 3, 'tight'), true, null);
        jest.advanceTimersByTime(125);
        expect(batches.map((batch) => batch.frames.map((f) => f.msgId))).toEqual([[id(1)]]);
        outbox.sendMessage('tight', id(2), frames(id(2), BACKLOG_FRAMES + 4, 'tight'), false, null); // the queue passes the backlog
        jest.advanceTimersByTime(125 * 30);
        const sent = batches.flatMap((batch) => batch.frames).map((f) => f.msgId);
        expect(sent.filter((msgId) => msgId === id(1))).toHaveLength(3);
        expect(sent.filter((msgId) => msgId === id(2))).toHaveLength(BACKLOG_FRAMES + 4);
    });

    test('a log message that has not started is dropped when the queue passes the backlog', () => {
        spendToken();
        outbox.sendMessage('tight', id(1), frames(id(1), 3, 'tight'), true, null);
        outbox.sendMessage('tight', id(2), frames(id(2), BACKLOG_FRAMES + 4, 'tight'), false, null);
        jest.advanceTimersByTime(125 * 30);
        const sent = batches.flatMap((batch) => batch.frames).map((f) => f.msgId);
        expect(sent).not.toContain(id(1));
        expect(sent.filter((msgId) => msgId === id(2))).toHaveLength(BACKLOG_FRAMES + 4);
    });

    describe('resends', () => {
        test('a message acknowledged in no time is not sent again; one that is not is sent again in a batch', () => {
            spendToken();
            outbox.sendMessage('peer', id(1), frames(id(1), 2), false, null);
            outbox.sendMessage('peer', id(2), frames(id(2), 1), false, null);
            jest.advanceTimersByTime(125);
            expect(batches.map(msgIds)).toEqual([['01', '01', '02']]);
            outbox.ack('peer', id(1));
            jest.advanceTimersByTime(RESEND_MS);
            expect(batches.map(msgIds)).toEqual([['01', '01', '02'], ['02']]);
        });

        test('a lost middle message is sent again alone; the stream and sequence stay', () => {
            spendToken();
            for (const n of [1, 2, 3]) outbox.sendMessage('peer', id(n), frames(id(n), 1), false, null);
            jest.advanceTimersByTime(125);
            expect(batches.map(msgIds)).toEqual([['01', '02', '03']]);
            outbox.ack('peer', id(1));
            outbox.ack('peer', id(3));
            jest.advanceTimersByTime(RESEND_MS);
            expect(batches).toHaveLength(2);
            expect(batches[1].frames).toEqual([
                expect.objectContaining({ msgId: id(2), seq: 1, stream: batches[0].frames[0].stream }),
            ]);
        });

        test('a lost batch is sent again: its messages go out as their timers fire, and each gives up after the last resend', () => {
            spendToken();
            outbox.sendMessage('peer', id(1), frames(id(1), 2), false, null);
            outbox.sendMessage('peer', id(2), frames(id(2), 1), false, null);
            jest.advanceTimersByTime(125);
            expect(batches.map(msgIds)).toEqual([['01', '01', '02']]);
            // Both messages left at once, so both resend after the same wait; the budget spaces them.
            jest.advanceTimersByTime(RESEND_MS + 125);
            expect(batches.map(msgIds)).toEqual([['01', '01', '02'], ['01', '01'], ['02']]);
            expect(givenUp).toEqual([]);
            jest.advanceTimersByTime(RESEND_MS * 10);
            expect(givenUp).toEqual(['peer', 'peer']);
            expect(batches).toHaveLength(1 + 2 * MAX_RESENDS);
        });
    });
});
