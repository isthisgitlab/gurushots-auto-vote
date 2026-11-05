/**
 * The receiving side's inboxes, one per (sender, stream): a stream starts at 0, a re-admitted sender
 * continues where its stream was, a new stream replaces the live one only when it is of the sender's
 * current epoch and newer, a stray older stream is born retired, and the table is bounded by sender (32)
 * and by age (600 s).
 */

import { GAP_HOLD_MS } from '../../src/ts/core/remote/relayInbox';
import { MAX_STREAMS_PER_SENDER, STREAM_MEMORY_MS, createStreamTable } from '../../src/ts/core/remote/relayStreams';

/** No message is dropped while parked in most of these tests, so nothing needs to be forgotten. */
const noop = (): void => undefined;

describe('createStreamTable', () => {
    let at: number;
    /** The timestamp of the next frame: a sender's frames get newer. */
    let ts: number;
    let delivered: Array<[string, unknown]>;
    let table: ReturnType<typeof createStreamTable>;

    /** The inbox of a stream, for a message whose completing frame is newer than the last one. */
    const inbox = (from: string, stream: string, epoch = 'e1', frameTs = ++ts) =>
        table.inboxFor(from, stream, epoch, frameTs);

    beforeEach(() => {
        jest.useFakeTimers();
        at = 0;
        ts = 1_000;
        delivered = [];
        table = createStreamTable(
            (from, message) => delivered.push([from, message]),
            () => at,
        );
        table.admit('a', 'e1');
        table.admit('b', 'e1');
    });
    afterEach(() => {
        table.close();
        jest.useRealTimers();
    });

    describe('the bytes held behind gaps', () => {
        test('they are counted over every stream and sender of the table, and counted out when delivered, retired, dropped or closed', () => {
            const a1 = inbox('a', 's1');
            a1.accept(0, null, 0, noop);
            a1.accept(2, { message: 'a1' }, 100, noop);
            expect(table.heldBytes()).toBe(100);
            const a2 = inbox('a', 's2', 'e1', 5_000); // a second stream of a: it retires s1 (its frame is newer)
            expect(table.heldBytes()).toBe(0); // what the retired stream held is let go
            const b1 = inbox('b', 's1');
            a2.accept(0, null, 0, noop);
            a2.accept(2, { message: 'a2' }, 300, noop);
            b1.accept(0, null, 0, noop);
            b1.accept(2, { message: 'b1' }, 200, noop);
            expect(table.heldBytes()).toBe(500);
            a2.accept(1, { message: 'gap filled' }, 10, noop); // delivered: 1 and 2 leave, nothing is held
            expect(table.heldBytes()).toBe(200);
            // A stream that was retired for a newer one holds nothing any more.
            a1.accept(5, { message: 'late' }, 999, noop); // its inbox is closed
            expect(table.heldBytes()).toBe(200);
            table.suspend('b');
            expect(table.heldBytes()).toBe(200); // what a suspended stream holds stays held
            table.close();
            expect(table.heldBytes()).toBe(0);
        });

        test('a stream that is dropped as unused holds nothing any more', () => {
            const first = inbox('a', 's-first');
            first.accept(0, null, 0, noop);
            first.accept(2, { message: 'held' }, 400, noop);
            expect(table.heldBytes()).toBe(400);
            at += STREAM_MEMORY_MS + 1;
            inbox('b', 'other'); // prunes the unused stream
            expect(table.heldBytes()).toBe(0);
        });

        test('the live stream dropped for the 33rd stream of a sender holds nothing any more', () => {
            const live = inbox('a', 'live', 'e1', 100_000);
            live.accept(0, null, 0, noop);
            live.accept(2, { message: 'held' }, 400, noop);
            expect(table.heldBytes()).toBe(400);
            // Older streams of the same sender are born retired (they are not newer than the live one), and the
            // live one is the least recently used: the sender's 33rd entry drops it.
            for (let n = 1; n < MAX_STREAMS_PER_SENDER; n++) inbox('a', `old${n}`, 'e1', n);
            expect(table.heldBytes()).toBe(400); // 32 entries: the live one is still there
            inbox('a', 'one-more', 'e1', 99);
            expect(table.heldBytes()).toBe(0);
        });
    });

    test('a stream is ordered from 0 and delivers to its sender', () => {
        const stream = inbox('a', 's1');
        stream.accept(1, { message: 'one' }, 0, noop);
        expect(delivered).toEqual([]);
        stream.accept(0, { message: 'zero' }, 0, noop);
        expect(delivered).toEqual([
            ['a', 'zero'],
            ['a', 'one'],
        ]);
    });

    test('the same (sender, stream) is the same inbox: it continues where it was', () => {
        inbox('a', 's1').accept(0, { message: 'zero' }, 0, noop);
        inbox('a', 's1').accept(1, { message: 'one' }, 0, noop);
        expect(inbox('a', 's1')).toBe(inbox('a', 's1'));
        expect(delivered.map(([, message]) => message)).toEqual(['zero', 'one']);
    });

    test('a sender that was away and comes back on its stream is delivered at once, with no gap to wait out', () => {
        const stream = inbox('a', 's1');
        for (let seq = 0; seq < 41; seq++) stream.accept(seq, null, 0, noop);
        table.suspend('a'); // dropped for silence
        table.admit('a', 'e1'); // admitted again, same epoch
        inbox('a', 's1').accept(41, { message: 'next' }, 0, noop);
        expect(delivered).toEqual([['a', 'next']]);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('senders are separate: the same stream id from two senders is two inboxes', () => {
        expect(inbox('a', 's')).not.toBe(inbox('b', 's'));
    });

    test('suspend and admit touch only the named sender', () => {
        inbox('a', 's').accept(1, { message: 'a1' }, 0, noop);
        inbox('b', 's').accept(1, { message: 'b1' }, 0, noop);
        table.suspend('a');
        jest.advanceTimersByTime(GAP_HOLD_MS);
        expect(delivered).toEqual([['b', 'b1']]); // b's gap was skipped, a's was paused
        table.admit('a', 'e1');
        jest.advanceTimersByTime(GAP_HOLD_MS);
        expect(delivered).toEqual([
            ['b', 'b1'],
            ['a', 'a1'],
        ]);
    });

    describe('which stream is the live one', () => {
        test('the first stream of an admitted sender is live', () => {
            expect(table.isRetired('a', 's1')).toBe(false); // not known to the table yet
            inbox('a', 's1');
            expect(table.isRetired('a', 's1')).toBe(false);
        });

        test('a genuinely newer stream of the current epoch retires the old one: what it held is never delivered, and a late frame of it cannot start it over', () => {
            const old = inbox('a', 's1');
            old.accept(5, { message: 'held on s1' }, 0, noop); // waiting for 0 to 4
            const fresh = inbox('a', 's2'); // newer than anything on s1
            fresh.accept(0, { message: 's2 zero' }, 0, noop);
            jest.advanceTimersByTime(GAP_HOLD_MS * 3);
            expect(delivered).toEqual([['a', 's2 zero']]);
            expect(jest.getTimerCount()).toBe(0);
            expect(table.isRetired('a', 's1')).toBe(true);
            expect(table.isRetired('a', 's2')).toBe(false);
            // A late frame of the retired stream is ignored: it neither delivers nor retires the live stream.
            inbox('a', 's1').accept(0, { message: 'late s1' }, 0, noop);
            fresh.accept(1, { message: 's2 one' }, 0, noop);
            expect(delivered).toEqual([
                ['a', 's2 zero'],
                ['a', 's2 one'],
            ]);
        });

        test("a new stream whose frame is older than the live stream's newest — a replay, a straggler — is born retired and leaves the live one alone", () => {
            const live = inbox('a', 's1', 'e1', 5_000);
            live.accept(0, { message: 'zero' }, 0, noop);
            const stray = inbox('a', 'stray', 'e1', 4_000);
            expect(table.isRetired('a', 'stray')).toBe(true);
            expect(table.isRetired('a', 's1')).toBe(false);
            stray.accept(0, { message: 'stray' }, 0, noop);
            live.accept(1, { message: 'one' }, 0, noop);
            expect(delivered).toEqual([
                ['a', 'zero'],
                ['a', 'one'],
            ]);
        });

        test("a frame as new as the live stream's newest is not newer: it is born retired", () => {
            inbox('a', 's1', 'e1', 5_000);
            inbox('a', 'same-time', 'e1', 5_000);
            expect(table.isRetired('a', 'same-time')).toBe(true);
            expect(table.isRetired('a', 's1')).toBe(false);
        });

        test("the live stream's newest timestamp moves with each message it accepts", () => {
            inbox('a', 's1', 'e1', 5_000);
            inbox('a', 's1', 'e1', 9_000); // a later message of the same stream
            inbox('a', 's2', 'e1', 8_000); // newer than the first frame, older than the latest
            expect(table.isRetired('a', 's2')).toBe(true);
            expect(table.isRetired('a', 's1')).toBe(false);
            inbox('a', 's1', 'e1', 4_000); // an older frame of the live stream does not move it back
            inbox('a', 's3', 'e1', 9_500);
            expect(table.isRetired('a', 's3')).toBe(false);
            expect(table.isRetired('a', 's1')).toBe(true);
        });

        test('a new stream of another epoch than the one the sender was admitted with is born retired, however new', () => {
            const live = inbox('a', 's1');
            live.accept(0, { message: 'zero' }, 0, noop);
            const other = inbox('a', 'old-instance', 'e0', 99_999);
            expect(table.isRetired('a', 'old-instance')).toBe(true);
            other.accept(0, { message: 'from the old instance' }, 0, noop);
            live.accept(1, { message: 'one' }, 0, noop);
            expect(delivered.map(([, message]) => message)).toEqual(['zero', 'one']);
        });

        test('a stream of a sender the table never admitted is born retired', () => {
            inbox('never-admitted', 's1').accept(0, { message: 'x' }, 0, noop);
            expect(table.isRetired('never-admitted', 's1')).toBe(true);
            expect(delivered).toEqual([]);
        });

        test('a retired stream is not resumed when the sender is admitted again', () => {
            const old = inbox('a', 's1');
            old.accept(5, { message: 'held on s1' }, 0, noop);
            inbox('a', 's2').accept(0, { message: 's2 zero' }, 0, noop);
            table.suspend('a');
            table.admit('a', 'e1');
            jest.advanceTimersByTime(GAP_HOLD_MS * 3);
            expect(delivered).toEqual([['a', 's2 zero']]);
        });

        test("a sender admitted with a new epoch loses its old streams, and its new epoch's stream is live", () => {
            const old = inbox('a', 's1', 'e1');
            old.accept(3, { message: 'held under e1' }, 0, noop);
            table.admit('a', 'e2');
            jest.advanceTimersByTime(GAP_HOLD_MS * 3);
            expect(delivered).toEqual([]);
            expect(jest.getTimerCount()).toBe(0);
            inbox('a', 's1', 'e1').accept(0, { message: 'late' }, 0, noop); // retired: ignored
            expect(delivered).toEqual([]);
            const current = inbox('a', 's2', 'e2');
            expect(table.isRetired('a', 's2')).toBe(false);
            current.accept(1, { message: 'held under e2' }, 0, noop);
            table.admit('a', 'e2'); // the same epoch again: nothing retired, the live stream runs its timer
            jest.advanceTimersByTime(GAP_HOLD_MS);
            expect(delivered).toEqual([['a', 'held under e2']]);
        });

        test("another sender's streams are not retired", () => {
            inbox('b', 's1').accept(1, { message: 'b held' }, 0, noop);
            inbox('a', 's9');
            table.admit('a', 'e9');
            jest.advanceTimersByTime(GAP_HOLD_MS);
            expect(delivered).toEqual([['b', 'b held']]);
        });
    });

    describe('after close', () => {
        test('inboxFor answers an inert inbox: it delivers nothing and arms no timer', () => {
            table.close();
            const stream = inbox('a', 's1');
            stream.accept(0, { message: 'zero' }, 0, noop);
            stream.accept(3, { message: 'three' }, 0, noop);
            expect(delivered).toEqual([]);
            expect(jest.getTimerCount()).toBe(0);
            jest.advanceTimersByTime(GAP_HOLD_MS * 3);
            expect(delivered).toEqual([]);
            expect(table.isRetired('a', 's1')).toBe(false);
        });
    });

    describe('bounds', () => {
        test(`a sender keeps at most ${MAX_STREAMS_PER_SENDER} streams; the least recently used is dropped, other senders are not touched`, () => {
            const first = inbox('a', 'stream-0');
            const other = inbox('b', 'only');
            for (let n = 1; n < MAX_STREAMS_PER_SENDER; n++) inbox('a', `stream-${n}`);
            inbox('a', 'stream-0'); // used again: now the newest
            inbox('a', 'one-too-many'); // drops stream-1, the least recently used
            expect(inbox('a', 'stream-0')).toBe(first);
            expect(inbox('b', 'only')).toBe(other);
            const reborn = inbox('a', 'stream-1'); // was dropped: a new entry
            reborn.accept(0, { message: 'zero' }, 0, noop);
            expect(delivered.map(([from]) => from)).toEqual(['a']);
        });

        test('an inbox unused for 600 s is dropped; one used inside that time is kept', () => {
            const idle = inbox('a', 'idle');
            const busy = inbox('a', 'busy');
            at = STREAM_MEMORY_MS - 1;
            expect(inbox('a', 'busy')).toBe(busy); // refreshes busy
            at = STREAM_MEMORY_MS + 1;
            expect(inbox('a', 'busy')).toBe(busy);
            expect(inbox('a', 'idle')).not.toBe(idle);
        });

        test('close drops every inbox and their timers', () => {
            inbox('a', 's').accept(1, { message: 'held' }, 0, noop);
            table.close();
            expect(jest.getTimerCount()).toBe(0);
            jest.advanceTimersByTime(GAP_HOLD_MS * 2);
            expect(delivered).toEqual([]);
        });
    });
});
