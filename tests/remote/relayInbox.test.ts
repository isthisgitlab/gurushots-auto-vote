/** The receiving half of a relay stream: parts joined into messages, messages delivered in sequence order. */

import {
    GAP_HOLD_MS,
    MAX_HELD_MESSAGES,
    MAX_PARTIAL_MESSAGES,
    createOrderedInbox,
    createReassembler,
} from '../../src/ts/core/remote/relayInbox';

import type { FrameHeader } from '../../src/ts/core/remote/relayCodec';

const id = (n: number): string => n.toString(16).padStart(32, '0');

const header = (msgId: string, part: number, parts: number, seq = 0): FrameHeader => ({
    v: 1,
    from: 'a',
    to: 'b',
    toEpoch: id(1),
    epoch: id(2),
    msgId,
    stream: '7'.repeat(32),
    seq,
    part,
    parts,
    ts: 0,
    kind: 'data',
});

describe('createReassembler', () => {
    test('joins the parts of a message in part order whatever order they arrive in', () => {
        const reassembler = createReassembler();
        const m = id(10);
        expect(reassembler.add(header(m, 2, 3, 4), Uint8Array.from([5, 6]))).toBeNull();
        expect(reassembler.add(header(m, 0, 3, 4), Uint8Array.from([1, 2]))).toBeNull();
        const done = reassembler.add(header(m, 1, 3, 4), Uint8Array.from([3, 4]));
        expect(done?.seq).toBe(4);
        expect(done?.stream).toBe('7'.repeat(32));
        expect([...(done?.bytes ?? [])]).toEqual([1, 2, 3, 4, 5, 6]);
    });

    test('a one-part message finishes at once', () => {
        const done = createReassembler().add(header(id(1), 0, 1), Uint8Array.from([9]));
        expect([...(done?.bytes ?? [])]).toEqual([9]);
    });

    test('a part seen twice, or one that contradicts the first part of its message, adds nothing', () => {
        const reassembler = createReassembler();
        const m = id(10);
        expect(reassembler.add(header(m, 0, 2, 0), Uint8Array.from([1]))).toBeNull();
        expect(reassembler.add(header(m, 0, 2, 0), Uint8Array.from([1]))).toBeNull(); // twice
        expect(reassembler.add(header(m, 1, 3, 0), Uint8Array.from([2]))).toBeNull(); // another part count
        expect(reassembler.add(header(m, 1, 2, 9), Uint8Array.from([2]))).toBeNull(); // another seq
        expect(reassembler.add({ ...header(m, 1, 2, 0), stream: '8'.repeat(32) }, Uint8Array.from([2]))).toBeNull(); // another stream
        expect(reassembler.add(header(m, 1, 2, 0), Uint8Array.from([2]))?.bytes).toHaveLength(2);
    });

    test(`keeps at most ${MAX_PARTIAL_MESSAGES} unfinished messages: the oldest is dropped`, () => {
        const reassembler = createReassembler();
        for (let n = 0; n < MAX_PARTIAL_MESSAGES; n++) reassembler.add(header(id(n), 0, 2), Uint8Array.from([n]));
        reassembler.add(header(id(100), 0, 2), Uint8Array.from([100])); // evicts message 0
        // Message 1 still finishes; message 0 starts over and does not.
        expect(reassembler.add(header(id(1), 1, 2), Uint8Array.from([7]))?.bytes).toHaveLength(2);
        expect(reassembler.add(header(id(0), 1, 2), Uint8Array.from([7]))).toBeNull();
    });
});

describe('createOrderedInbox', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    /** An inbox whose stream has started: sequence 0 has arrived and delivered nothing, so the next one expected is 1. */
    const harness = () => {
        const delivered: unknown[] = [];
        const inbox = createOrderedInbox((message) => delivered.push(message));
        inbox.accept(0, null);
        return { inbox, delivered };
    };

    test('delivers in sequence order, holding a later message until the earlier one arrives', () => {
        const { inbox, delivered } = harness();
        inbox.accept(2, { message: 'two' });
        inbox.accept(3, { message: 'three' });
        expect(delivered).toEqual([]);
        inbox.accept(1, { message: 'one' });
        expect(delivered).toEqual(['one', 'two', 'three']);
    });

    test('a fresh stream starts at 0: a message numbered 1 waits for 0, and both are delivered in order', () => {
        const delivered: unknown[] = [];
        const inbox = createOrderedInbox((message) => delivered.push(message));
        inbox.accept(1, { message: 'one' });
        expect(delivered).toEqual([]);
        inbox.accept(0, { message: 'zero' });
        expect(delivered).toEqual(['zero', 'one']);
    });

    test('suspending pauses the gap timer and keeps what is held; resuming starts the wait again', () => {
        const { inbox, delivered } = harness();
        inbox.accept(2, { message: 'two' }); // sequence 1 is missing
        inbox.suspend();
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(GAP_HOLD_MS * 3);
        expect(delivered).toEqual([]); // held, not skipped, while the sender is away
        inbox.resume();
        inbox.resume(); // a second resume starts no second timer
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(GAP_HOLD_MS);
        expect(delivered).toEqual(['two']);
    });

    test('a delivery that suspends the inbox (its handler removes the sender) ends the drain: the rest waits for the resume', () => {
        const delivered: unknown[] = [];
        const inbox: ReturnType<typeof createOrderedInbox> = createOrderedInbox((message) => {
            delivered.push(message);
            if (message === 'one') inbox.suspend();
        });
        inbox.accept(0, null);
        inbox.accept(3, { message: 'three' }); // waits behind a gap
        inbox.accept(2, { message: 'two' }); // waits for 1
        inbox.accept(1, { message: 'one' }); // delivering it suspends the inbox, with 2 and 3 now in order behind it
        expect(delivered).toEqual(['one']);
        expect(jest.getTimerCount()).toBe(0);
        inbox.resume();
        expect(delivered).toEqual(['one', 'two', 'three']);
    });

    test('suspension is sticky: a suspended inbox parks what it is given, delivers nothing and arms no timer until it resumes', () => {
        const { inbox, delivered } = harness();
        inbox.suspend();
        inbox.accept(1, { message: 'in order' }); // would be delivered at once if not suspended
        inbox.accept(3, { message: 'behind a gap' }); // would arm the gap timer if not suspended
        inbox.accept(0, { message: 'late' });
        expect(delivered).toEqual([]);
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(GAP_HOLD_MS * 3);
        expect(delivered).toEqual([]);
        inbox.resume();
        // Accepted again in the order they finished: 1 is delivered, 3 waits for 2 under a timer, 0 is a late one.
        expect(delivered).toEqual(['in order', 'late']);
        expect(jest.getTimerCount()).toBe(1);
        jest.advanceTimersByTime(GAP_HOLD_MS);
        expect(delivered).toEqual(['in order', 'late', 'behind a gap']);
    });

    test('closing a suspended inbox drops what was parked', () => {
        const { inbox, delivered } = harness();
        inbox.suspend();
        inbox.accept(1, { message: 'parked' });
        inbox.close();
        inbox.resume();
        expect(delivered).toEqual([]);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('resuming with nothing held, or after close, starts no timer', () => {
        const { inbox } = harness();
        inbox.resume();
        expect(jest.getTimerCount()).toBe(0);
        inbox.accept(2, { message: 'two' });
        inbox.suspend();
        inbox.close();
        inbox.resume();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a gap is held for 10 s and then skipped; the skipped message arriving later is still delivered once', () => {
        const { inbox, delivered } = harness();
        inbox.accept(1, { message: 'a' });
        inbox.accept(3, { message: 'c' });
        jest.advanceTimersByTime(GAP_HOLD_MS - 1);
        expect(delivered).toEqual(['a']);
        jest.advanceTimersByTime(1);
        expect(delivered).toEqual(['a', 'c']);
        inbox.accept(2, { message: 'b' }); // its resend, late
        expect(delivered).toEqual(['a', 'c', 'b']);
    });

    test('a message whose bytes could not be read uses up its slot and delivers nothing', () => {
        const { inbox, delivered } = harness();
        inbox.accept(2, { message: 'b' });
        inbox.accept(1, null);
        expect(delivered).toEqual(['b']);
        inbox.accept(1, null); // late and unreadable: nothing either
        expect(delivered).toEqual(['b']);
    });

    test('a second gap behind the first starts its own hold', () => {
        const { inbox, delivered } = harness();
        inbox.accept(3, { message: 'c' });
        inbox.accept(5, { message: 'e' });
        jest.advanceTimersByTime(GAP_HOLD_MS); // skips to 3, then waits on 4 for 5
        expect(delivered).toEqual(['c']);
        jest.advanceTimersByTime(GAP_HOLD_MS);
        expect(delivered).toEqual(['c', 'e']);
    });

    test('a filled gap stops the hold timer', () => {
        const { inbox, delivered } = harness();
        inbox.accept(2, { message: 'b' });
        inbox.accept(1, { message: 'a' });
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(GAP_HOLD_MS * 2);
        expect(delivered).toEqual(['a', 'b']);
    });

    test(`more than ${MAX_HELD_MESSAGES} held messages skip the gap at once`, () => {
        const { inbox, delivered } = harness();
        for (let seq = 2; seq <= MAX_HELD_MESSAGES + 2; seq++) inbox.accept(seq, { message: seq });
        expect(delivered).toHaveLength(MAX_HELD_MESSAGES + 1);
    });

    test('close stops delivery and the timer', () => {
        const { inbox, delivered } = harness();
        inbox.accept(2, { message: 'b' });
        inbox.close();
        expect(jest.getTimerCount()).toBe(0);
        inbox.accept(1, { message: 'a' });
        jest.advanceTimersByTime(GAP_HOLD_MS * 2);
        expect(delivered).toEqual([]);
    });

    test('a handler that closes the inbox while draining ends the drain', () => {
        const delivered: unknown[] = [];
        const inbox: ReturnType<typeof createOrderedInbox> = createOrderedInbox((message) => {
            delivered.push(message);
            inbox.close();
        });
        inbox.accept(0, null);
        inbox.accept(2, { message: 'b' });
        inbox.accept(1, { message: 'a' });
        expect(delivered).toEqual(['a']);
        expect(jest.getTimerCount()).toBe(0);
    });
});
