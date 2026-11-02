/**
 * The relay link's sending half: the 8-events-a-second budget, control frames first, the
 * sequence number taken when a message first leaves, the resend timer that starts after the
 * last part left, give-up after three resends, and log lines dropped first under backlog.
 */

import {
    BACKLOG_FRAMES,
    MAX_QUEUED_FRAMES,
    MAX_RESENDS,
    RESEND_MS,
    createOutbox,
} from '../../src/ts/core/remote/relayOutbox';

import type { EmitFrame, OutFrame } from '../../src/ts/core/remote/relayOutbox';

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
    let outbox: ReturnType<typeof createOutbox>;

    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(0);
        emitted = [];
        givenUp = [];
        let drawn = 0;
        outbox = createOutbox({
            now: () => Date.now(),
            // Each stream id is the next counter value, so a test can tell the streams apart.
            random: (length) => new Uint8Array(length).fill(++drawn),
            emit: (out) => emitted.push(out),
            giveUp: (peerId) => givenUp.push(peerId),
        });
    });
    afterEach(() => {
        outbox.close();
        jest.useRealTimers();
    });

    const ids = (): string[] =>
        emitted.map((out) => `${out.draft.kind}:${out.draft.msgId.slice(-2)}:${out.draft.part}`);

    test('at most 8 events leave a second; the rest wait for the budget', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 20), false);
        expect(emitted).toHaveLength(1);
        jest.advanceTimersByTime(999);
        expect(emitted.length).toBeLessThanOrEqual(9);
        jest.advanceTimersByTime(1);
        expect(emitted).toHaveLength(9);
        jest.advanceTimersByTime(1_500);
        expect(emitted).toHaveLength(20);
    });

    test('control frames go before queued data, and carry sequence 0', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 3), false);
        outbox.sendControl(control('presence', id(2)));
        outbox.sendControl(control('ack', id(3)));
        jest.advanceTimersByTime(1_000);
        expect(ids()).toEqual(['data:01:0', 'presence:02:0', 'ack:03:0', 'data:01:1', 'data:01:2']);
        expect(emitted.filter((out) => out.draft.kind !== 'data').map((out) => out.draft.seq)).toEqual([0, 0]);
    });

    test('a message takes its sequence number when its first frame leaves, one stream per peer', () => {
        outbox.sendMessage('a', id(1), frames(id(1), 2, 'a'), false);
        outbox.sendMessage('a', id(2), frames(id(2), 1, 'a'), false);
        outbox.sendMessage('b', id(3), frames(id(3), 1, 'b'), false);
        jest.advanceTimersByTime(1_000);
        const seqOf = (msg: number): number[] =>
            emitted.filter((out) => out.draft.msgId === id(msg)).map((out) => out.draft.seq);
        expect(seqOf(1)).toEqual([0, 0]);
        expect(seqOf(2)).toEqual([1]);
        expect(seqOf(3)).toEqual([0]);
    });

    test('a stream has an id of its own per peer, drawn at the first send, and a forgotten peer gets a new stream at 0', () => {
        outbox.sendMessage('a', id(1), frames(id(1), 1, 'a'), false);
        outbox.sendMessage('a', id(2), frames(id(2), 1, 'a'), false);
        outbox.sendMessage('b', id(3), frames(id(3), 1, 'b'), false);
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
        outbox.sendMessage('a', id(4), frames(id(4), 1, 'a'), false);
        jest.advanceTimersByTime(1_000);
        expect(place(4)[1]).toBe(0);
        expect(place(4)[0]).not.toBe(streamA);
    });

    test('a resend carries the stream and sequence number of the first send', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 1), false);
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
        outbox.sendMessage('peer', id(1), frames(id(1), 20), false);
        outbox.sendMessage('peer', id(2), frames(id(2), 1), true); // queued behind a backlog: dropped at once
        outbox.sendMessage('peer', id(3), frames(id(3), 1), false);
        jest.advanceTimersByTime(5_000);
        const seqs = emitted.map((out) => [out.draft.msgId, out.draft.seq]);
        expect(seqs.filter(([msg]) => msg === id(3))).toEqual([[id(3), 1]]);
        expect(emitted.some((out) => out.draft.msgId === id(2))).toBe(false);
    });

    test('the resend timer starts after the last part left, and the message is sent again until acknowledged', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 2), false);
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
        outbox.sendMessage('peer', id(1), frames(id(1), 30), false); // takes ~3.6 s to leave
        jest.advanceTimersByTime(RESEND_MS);
        expect(emitted.length).toBeLessThan(40); // no resend yet: the last part left at ~3.6 s, the timer ends at ~7.6 s
        expect(emitted.filter((out) => out.draft.part === 0)).toHaveLength(1);
    });

    test(`after ${MAX_RESENDS} resends and a last wait, the peer is given up on`, () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 1), false);
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
        outbox.sendMessage('peer', id(1), frames(id(1), 1), false);
        outbox.ack('stranger', id(1));
        outbox.ack('peer', id(9));
        jest.advanceTimersByTime(RESEND_MS);
        expect(emitted).toHaveLength(2);
    });

    test('forgetting a peer drops its queued and unacknowledged messages and restarts its sequence', () => {
        outbox.sendMessage('a', id(1), frames(id(1), 10, 'a'), false);
        outbox.sendMessage('b', id(2), frames(id(2), 1, 'b'), false);
        jest.advanceTimersByTime(250); // a's first three frames left
        outbox.forgetPeer('a');
        jest.advanceTimersByTime(RESEND_MS * 5);
        expect(emitted.filter((out) => out.draft.to === 'a')).toHaveLength(3);
        expect(givenUp).toEqual(['b']); // only b, which nobody acknowledged, is given up on
        outbox.sendMessage('a', id(3), frames(id(3), 1, 'a'), false);
        jest.advanceTimersByTime(1_000);
        expect(emitted.find((out) => out.draft.msgId === id(3))?.draft.seq).toBe(0);
    });

    test('under backlog queued log messages are dropped, started ones and everything else are kept', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 2), true); // a log message, started at once
        outbox.sendMessage('peer', id(2), frames(id(2), 3), true); // a second log message, queued behind it
        outbox.sendMessage('peer', id(3), frames(id(3), BACKLOG_FRAMES), false); // pushes the queue past the backlog
        jest.advanceTimersByTime(10_000);
        const left = (msg: number): number => emitted.filter((out) => out.draft.msgId === id(msg)).length;
        expect(left(1)).toBeGreaterThanOrEqual(2); // the started log message completes
        expect(left(2)).toBe(0); // the queued one was dropped
        expect(left(3)).toBeGreaterThanOrEqual(BACKLOG_FRAMES);
    });

    test('a log message arriving at a backlog is dropped; other messages are never dropped', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), BACKLOG_FRAMES + 4), false);
        outbox.sendMessage('peer', id(2), frames(id(2), 1), true);
        outbox.sendMessage('peer', id(3), frames(id(3), 1), false);
        jest.advanceTimersByTime(10_000);
        expect(emitted.some((out) => out.draft.msgId === id(2))).toBe(false);
        expect(emitted.some((out) => out.draft.msgId === id(3))).toBe(true);
    });

    test('a send that would pass the queue cap throws and queues nothing', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), MAX_QUEUED_FRAMES - 1), false);
        expect(() => outbox.sendMessage('peer', id(2), frames(id(2), 5), false)).toThrow('relay send queue is full');
        jest.advanceTimersByTime(60_000);
        expect(emitted.some((out) => out.draft.msgId === id(2))).toBe(false);
    });

    test('close stops everything: timers, the queue and the resend', () => {
        outbox.sendMessage('peer', id(1), frames(id(1), 5), false);
        outbox.close();
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(RESEND_MS * 5);
        expect(emitted).toHaveLength(1);
    });
});
