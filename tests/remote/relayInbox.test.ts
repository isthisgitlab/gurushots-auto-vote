/** The receiving half of a relay stream: parts joined into messages, messages delivered in sequence order. */

import {
    GAP_HOLD_MS,
    MAX_HELD_BYTES,
    MAX_HELD_MESSAGES,
    MAX_PARTIAL_MESSAGES,
    createHeldBudget,
    createOrderedInbox,
    createReassembler,
} from '../../src/ts/core/remote/relayInbox';

import type { FrameHeader } from '../../src/ts/core/remote/relayCodec';

/** No message is dropped while parked in most of these tests, so nothing needs to be forgotten. */
const noop = (): void => undefined;

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
        const inbox = createOrderedInbox((message) => delivered.push(message), createHeldBudget());
        inbox.accept(0, null, 0, noop);
        return { inbox, delivered };
    };

    test('delivers in sequence order, holding a later message until the earlier one arrives', () => {
        const { inbox, delivered } = harness();
        inbox.accept(2, { message: 'two' }, 0, noop);
        inbox.accept(3, { message: 'three' }, 0, noop);
        expect(delivered).toEqual([]);
        inbox.accept(1, { message: 'one' }, 0, noop);
        expect(delivered).toEqual(['one', 'two', 'three']);
    });

    test('a fresh stream starts at 0: a message numbered 1 waits for 0, and both are delivered in order', () => {
        const delivered: unknown[] = [];
        const inbox = createOrderedInbox((message) => delivered.push(message), createHeldBudget());
        inbox.accept(1, { message: 'one' }, 0, noop);
        expect(delivered).toEqual([]);
        inbox.accept(0, { message: 'zero' }, 0, noop);
        expect(delivered).toEqual(['zero', 'one']);
    });

    test('suspending pauses the gap timer and keeps what is held; resuming starts the wait again', () => {
        const { inbox, delivered } = harness();
        inbox.accept(2, { message: 'two' }, 0, noop); // sequence 1 is missing
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
        }, createHeldBudget());
        inbox.accept(0, null, 0, noop);
        inbox.accept(3, { message: 'three' }, 0, noop); // waits behind a gap
        inbox.accept(2, { message: 'two' }, 0, noop); // waits for 1
        inbox.accept(1, { message: 'one' }, 0, noop); // delivering it suspends the inbox, with 2 and 3 now in order behind it
        expect(delivered).toEqual(['one']);
        expect(jest.getTimerCount()).toBe(0);
        inbox.resume();
        expect(delivered).toEqual(['one', 'two', 'three']);
    });

    test('suspension is sticky: a suspended inbox parks what it is given, delivers nothing and arms no timer until it resumes', () => {
        const { inbox, delivered } = harness();
        inbox.suspend();
        inbox.accept(1, { message: 'in order' }, 0, noop); // would be delivered at once if not suspended
        inbox.accept(3, { message: 'behind a gap' }, 0, noop); // would arm the gap timer if not suspended
        inbox.accept(0, { message: 'late' }, 0, noop);
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
        inbox.accept(1, { message: 'parked' }, 0, noop);
        inbox.close();
        inbox.resume();
        expect(delivered).toEqual([]);
        expect(jest.getTimerCount()).toBe(0);
    });

    test('resuming with nothing held, or after close, starts no timer', () => {
        const { inbox } = harness();
        inbox.resume();
        expect(jest.getTimerCount()).toBe(0);
        inbox.accept(2, { message: 'two' }, 0, noop);
        inbox.suspend();
        inbox.close();
        inbox.resume();
        expect(jest.getTimerCount()).toBe(0);
    });

    test('a gap is held for 10 s and then skipped; the skipped message arriving later is still delivered once', () => {
        const { inbox, delivered } = harness();
        inbox.accept(1, { message: 'a' }, 0, noop);
        inbox.accept(3, { message: 'c' }, 0, noop);
        jest.advanceTimersByTime(GAP_HOLD_MS - 1);
        expect(delivered).toEqual(['a']);
        jest.advanceTimersByTime(1);
        expect(delivered).toEqual(['a', 'c']);
        inbox.accept(2, { message: 'b' }, 0, noop); // its resend, late
        expect(delivered).toEqual(['a', 'c', 'b']);
    });

    test('a message whose bytes could not be read uses up its slot and delivers nothing', () => {
        const { inbox, delivered } = harness();
        inbox.accept(2, { message: 'b' }, 0, noop);
        inbox.accept(1, null, 0, noop);
        expect(delivered).toEqual(['b']);
        inbox.accept(1, null, 0, noop); // late and unreadable: nothing either
        expect(delivered).toEqual(['b']);
    });

    test('a second gap behind the first starts its own hold', () => {
        const { inbox, delivered } = harness();
        inbox.accept(3, { message: 'c' }, 0, noop);
        inbox.accept(5, { message: 'e' }, 0, noop);
        jest.advanceTimersByTime(GAP_HOLD_MS); // skips to 3, then waits on 4 for 5
        expect(delivered).toEqual(['c']);
        jest.advanceTimersByTime(GAP_HOLD_MS);
        expect(delivered).toEqual(['c', 'e']);
    });

    test('a filled gap stops the hold timer', () => {
        const { inbox, delivered } = harness();
        inbox.accept(2, { message: 'b' }, 0, noop);
        inbox.accept(1, { message: 'a' }, 0, noop);
        expect(jest.getTimerCount()).toBe(0);
        jest.advanceTimersByTime(GAP_HOLD_MS * 2);
        expect(delivered).toEqual(['a', 'b']);
    });

    test(`more than ${MAX_HELD_MESSAGES} held messages skip the gap at once`, () => {
        const { inbox, delivered } = harness();
        for (let seq = 2; seq <= MAX_HELD_MESSAGES + 2; seq++) inbox.accept(seq, { message: seq }, 0, noop);
        expect(delivered).toHaveLength(MAX_HELD_MESSAGES + 1);
    });

    test('a lost batch: the messages behind its gap wait for its resend and are delivered in order', () => {
        const { inbox, delivered } = harness();
        for (let seq = 0; seq < 10; seq++) inbox.accept(seq, { message: seq }, 0, noop);
        // A batch of 64 messages (10-73) is lost; the two batches after it, the most the inbox holds, arrive.
        for (let seq = 74; seq < 74 + MAX_HELD_MESSAGES; seq++) inbox.accept(seq, { message: seq }, 0, noop);
        expect(delivered).toHaveLength(10);
        // The resend of the lost batch fills the gap, and everything is delivered in sequence order.
        for (let seq = 10; seq < 74; seq++) inbox.accept(seq, { message: seq }, 0, noop);
        expect(delivered).toEqual(Array.from({ length: 74 + MAX_HELD_MESSAGES }, (_v, seq) => seq));
    });

    test('a lost batch with more than the limit behind it: the gap is skipped, and the late resend is still delivered once', () => {
        expect(MAX_HELD_MESSAGES).toBe(128);
        const { inbox, delivered } = harness();
        for (let seq = 0; seq < 10; seq++) inbox.accept(seq, { message: seq }, 0, noop);
        // One message more than the inbox holds arrives behind the lost batch (10-73): the gap is skipped at once.
        for (let seq = 74; seq <= 74 + MAX_HELD_MESSAGES; seq++) inbox.accept(seq, { message: seq }, 0, noop);
        expect(delivered).toHaveLength(10 + MAX_HELD_MESSAGES + 1);
        // The resend arrives late: delivered, once, after the others.
        for (let seq = 10; seq < 74; seq++) inbox.accept(seq, { message: seq }, 0, noop);
        expect(delivered).toHaveLength(74 + MAX_HELD_MESSAGES + 1);
        expect(new Set(delivered).size).toBe(delivered.length);
    });

    test('close stops delivery and the timer', () => {
        const { inbox, delivered } = harness();
        inbox.accept(2, { message: 'b' }, 0, noop);
        inbox.close();
        expect(jest.getTimerCount()).toBe(0);
        inbox.accept(1, { message: 'a' }, 0, noop);
        jest.advanceTimersByTime(GAP_HOLD_MS * 2);
        expect(delivered).toEqual([]);
    });

    test('a handler that closes the inbox while draining ends the drain', () => {
        const delivered: unknown[] = [];
        const inbox: ReturnType<typeof createOrderedInbox> = createOrderedInbox((message) => {
            delivered.push(message);
            inbox.close();
        }, createHeldBudget());
        inbox.accept(0, null, 0, noop);
        inbox.accept(2, { message: 'b' }, 0, noop);
        inbox.accept(1, { message: 'a' }, 0, noop);
        expect(delivered).toEqual(['a']);
        expect(jest.getTimerCount()).toBe(0);
    });
});

describe('the held-bytes budget of a link', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const CAP = 1_000;

    /** An inbox on a shared budget whose stream has started (sequence 0 delivered), so the next one expected is 1. */
    const streamOn = (budget: ReturnType<typeof createHeldBudget>) => {
        const delivered: unknown[] = [];
        const inbox = createOrderedInbox((message) => delivered.push(message), budget);
        inbox.accept(0, null, 0, noop);
        return { inbox, delivered };
    };

    test('the cap is 64 MiB of inflated bytes for the link', () => {
        expect(MAX_HELD_BYTES).toBe(64 * 1024 * 1024);
    });

    test('a held set just under the cap stays held', () => {
        const budget = createHeldBudget(CAP);
        const { inbox, delivered } = streamOn(budget);
        for (let seq = 2; seq <= 6; seq++) inbox.accept(seq, { message: seq }, 200, noop); // 5 × 200 = the cap exactly
        expect(budget.held()).toBe(CAP);
        expect(delivered).toEqual([]);
    });

    test('a held set just over the cap makes the largest inbox skip its gap', () => {
        const budget = createHeldBudget(CAP);
        const { inbox, delivered } = streamOn(budget);
        for (let seq = 2; seq <= 6; seq++) inbox.accept(seq, { message: seq }, 200, noop);
        inbox.accept(7, { message: 7 }, 1, noop); // one byte over
        expect(delivered).toEqual([2, 3, 4, 5, 6, 7]); // delivered ahead of the missing message 1
        expect(budget.held()).toBe(0);
    });

    test('two streams that each stay under the cap but together go over it make the larger one skip', () => {
        const budget = createHeldBudget(CAP);
        const big = streamOn(budget);
        const small = streamOn(budget);
        big.inbox.accept(2, { message: 'big' }, 600, noop);
        small.inbox.accept(2, { message: 'small' }, 300, noop);
        expect(budget.held()).toBe(900);
        small.inbox.accept(3, { message: 'small 3' }, 200, noop); // 1 100 together
        expect(big.delivered).toEqual(['big']);
        expect(small.delivered).toEqual([]);
        expect(budget.held()).toBe(500);
    });

    test('it skips more than one inbox when one is not enough, largest first, and stops once under the cap', () => {
        const budget = createHeldBudget(CAP);
        const a = streamOn(budget);
        const b = streamOn(budget);
        const c = streamOn(budget);
        a.inbox.accept(2, { message: 'a' }, 400, noop);
        b.inbox.accept(2, { message: 'b' }, 300, noop);
        c.inbox.accept(2, { message: 'c' }, 250, noop); // 950
        c.inbox.accept(3, { message: 'c3' }, 400, noop); // 1 350: c (650) skips, leaving 700
        expect(c.delivered).toEqual(['c', 'c3']);
        expect(a.delivered).toEqual([]);
        expect(budget.held()).toBe(700);
        a.inbox.accept(3, { message: 'a3' }, 400, noop); // 1 100: a (800) skips
        expect(a.delivered).toEqual(['a', 'a3']);
        expect(b.delivered).toEqual([]);
        expect(budget.held()).toBe(300);
    });

    test('a skip delivers up to the next gap only, and the budget skips again until the link is under the cap', () => {
        const budget = createHeldBudget(CAP);
        const { inbox, delivered } = streamOn(budget);
        inbox.accept(2, { message: 2 }, 100, noop);
        inbox.accept(4, { message: 4 }, 400, noop);
        inbox.accept(6, { message: 6 }, 400, noop);
        expect(budget.held()).toBe(900);
        inbox.accept(8, { message: 8 }, 400, noop); // 1 300: skipping to 2 frees 100, not enough; skipping to 4 frees 400 more
        expect(delivered).toEqual([2, 4]);
        expect(budget.held()).toBe(800); // 6 and 8 are still behind gaps
    });

    test('the count stays right after delivery, a skip, a close and a message held twice', () => {
        const budget = createHeldBudget(CAP);
        const { inbox, delivered } = streamOn(budget);
        inbox.accept(3, { message: 3 }, 100, noop);
        inbox.accept(3, { message: 3 }, 100, noop); // the same message again: counted once
        expect(budget.held()).toBe(100);
        inbox.accept(2, { message: 2 }, 50, noop); // still waiting for 1
        expect(budget.held()).toBe(150);
        inbox.accept(1, { message: 1 }, 20, noop); // delivery: 1, 2 and 3 go, nothing is held
        expect(delivered).toEqual([1, 2, 3]);
        expect(budget.held()).toBe(0);
        jest.advanceTimersByTime(GAP_HOLD_MS);
        inbox.accept(6, { message: 6 }, 70, noop);
        jest.advanceTimersByTime(GAP_HOLD_MS); // the gap timer skips
        expect(delivered).toEqual([1, 2, 3, 6]);
        expect(budget.held()).toBe(0);
        inbox.accept(9, { message: 9 }, 80, noop);
        expect(budget.held()).toBe(80);
        inbox.close();
        expect(budget.held()).toBe(0);
    });

    test('when nothing can skip, the budget stays over the cap and the loop ends', () => {
        const budget = createHeldBudget(CAP);
        // `gone` holds 700 bytes behind a gap and is then suspended: its bytes cannot be delivered.
        const gone = streamOn(budget);
        gone.inbox.accept(2, { message: 'held' }, 700, noop);
        gone.inbox.suspend();
        // `live` delivers its first skipped message to a handler that suspends it, mid-skip.
        const delivered: unknown[] = [];
        const live: ReturnType<typeof createOrderedInbox> = createOrderedInbox((message) => {
            delivered.push(message);
            live.suspend();
        }, budget);
        live.accept(0, null, 0, noop);
        live.accept(2, { message: 'small' }, 50, noop);
        live.accept(3, { message: 'held behind the suspension' }, 400, noop); // 1 150: live skips to 2 and is suspended by it
        expect(delivered).toEqual(['small']);
        // 700 + 400 = 1 100 is over the cap, nothing is skippable any more, and accept returned: the loop ended.
        expect(budget.held()).toBe(1_100);
        // `live` is back: its gap was skipped before it was suspended, so the message it held is next in line and is
        // delivered at once. The link falls to what `gone` holds, which is under the cap.
        live.resume();
        expect(delivered).toEqual(['small', 'held behind the suspension']);
        expect(budget.held()).toBe(700);
        // `gone` is back: the message before its held one is still missing, so it waits for its gap timer.
        gone.inbox.resume();
        expect(gone.delivered).toEqual([]);
        jest.advanceTimersByTime(GAP_HOLD_MS);
        expect(gone.delivered).toEqual(['held']);
        expect(budget.held()).toBe(0);
    });

    test('a suspended inbox is passed over: the bytes it holds are not given up, while a live inbox skips', () => {
        const budget = createHeldBudget(CAP);
        const gone = streamOn(budget);
        gone.inbox.accept(2, { message: 'held' }, 900, noop);
        gone.inbox.suspend();
        const live = streamOn(budget);
        live.inbox.accept(2, { message: 'live' }, 200, noop); // 1 100 over the cap: only the live inbox can skip
        expect(live.delivered).toEqual(['live']);
        expect(gone.delivered).toEqual([]);
        expect(budget.held()).toBe(900);
    });

    describe('messages parked for a sender that is away', () => {
        const parkedOn = (budget: ReturnType<typeof createHeldBudget>) => {
            const stream = streamOn(budget);
            stream.inbox.suspend();
            return stream;
        };

        test('parked bytes count in the link total, and are let go when the inbox resumes (counted as held or delivered then)', () => {
            const budget = createHeldBudget(CAP);
            const { inbox, delivered } = parkedOn(budget);
            inbox.accept(3, { message: 3 }, 400, noop);
            inbox.accept(1, { message: 1 }, 100, noop);
            expect(budget.held()).toBe(500);
            inbox.resume(); // 1 is next: delivered; 3 waits behind the missing 2
            expect(delivered).toEqual([1]);
            expect(budget.held()).toBe(400);
            inbox.close();
            expect(budget.held()).toBe(0);
        });

        test('closing an inbox with parked messages lets their bytes go', () => {
            const budget = createHeldBudget(CAP);
            const { inbox } = parkedOn(budget);
            inbox.accept(1, { message: 1 }, 300, noop);
            expect(budget.held()).toBe(300);
            inbox.close();
            expect(budget.held()).toBe(0);
        });

        test('over the cap the largest suspended inbox loses its oldest parked messages first, and the rest are kept', () => {
            const budget = createHeldBudget(600);
            const dropped: string[] = [];
            const small = parkedOn(budget);
            const large = parkedOn(budget);
            small.inbox.accept(1, { message: 's1' }, 100, () => dropped.push('s1'));
            small.inbox.accept(2, { message: 's2' }, 100, () => dropped.push('s2'));
            large.inbox.accept(1, { message: 'l1' }, 200, () => dropped.push('l1'));
            large.inbox.accept(2, { message: 'l2' }, 200, () => dropped.push('l2')); // 600: at the cap
            expect(dropped).toEqual([]);
            small.inbox.accept(3, { message: 's3' }, 100, () => dropped.push('s3')); // 700: large (400) loses its oldest
            expect(dropped).toEqual(['l1']);
            expect(budget.held()).toBe(500);
            large.inbox.resume();
            small.inbox.resume();
            // What was kept is delivered in order when its sender returns; the dropped message's slot is a gap.
            expect(small.delivered).toEqual(['s1', 's2', 's3']);
            expect(large.delivered).toEqual([]);
            jest.advanceTimersByTime(GAP_HOLD_MS);
            expect(large.delivered).toEqual(['l2']);
        });

        test('it keeps dropping from the largest inbox while the link is over the cap, and leaves the others alone once it is under', () => {
            const budget = createHeldBudget(500);
            const dropped: string[] = [];
            const a = parkedOn(budget);
            const b = parkedOn(budget);
            for (let n = 1; n <= 3; n++) a.inbox.accept(n, { message: n }, 100, () => dropped.push(`a${n}`)); // 300
            b.inbox.accept(1, { message: 1 }, 160, () => dropped.push('b1')); // 460
            expect(dropped).toEqual([]);
            b.inbox.accept(2, { message: 2 }, 160, () => dropped.push('b2')); // 620: b (320) is the larger; its oldest goes
            expect(dropped).toEqual(['b1']);
            expect(budget.held()).toBe(460);
            b.inbox.accept(3, { message: 3 }, 300, () => dropped.push('b3')); // 760: b loses b2 (600), then b3 (300)
            expect(dropped).toEqual(['b1', 'b2', 'b3']);
            expect(budget.held()).toBe(300); // a, the smaller, kept all of its three
        });

        test('bytes held behind a gap by a suspended inbox leave less room: what is parked after is dropped first, oldest first', () => {
            const budget = createHeldBudget(500);
            const dropped: string[] = [];
            const gone = streamOn(budget);
            gone.inbox.accept(2, { message: 'held' }, 450, noop);
            gone.inbox.suspend(); // 450 held behind a gap, and nothing of it can be given up
            const a = parkedOn(budget);
            a.inbox.accept(1, { message: 1 }, 100, () => dropped.push('a1')); // 550: over, and only parked messages can go
            expect(dropped).toEqual(['a1']);
            const b = parkedOn(budget);
            b.inbox.accept(1, { message: 1 }, 30, () => dropped.push('b1')); // 480
            b.inbox.accept(2, { message: 2 }, 30, () => dropped.push('b2')); // 510: b's oldest goes
            expect(dropped).toEqual(['a1', 'b1']);
            expect(budget.held()).toBe(480);
        });

        test('rotating senders cannot park more than the cap: each new one is trimmed to what is left', () => {
            const budget = createHeldBudget(CAP);
            const forgotten: number[] = [];
            for (let sender = 0; sender < 20; sender++) {
                const { inbox } = parkedOn(budget);
                for (let n = 1; n <= 4; n++)
                    inbox.accept(n, { message: n }, 150, () => forgotten.push(sender * 10 + n));
                expect(budget.held()).toBeLessThanOrEqual(CAP);
            }
            expect(forgotten.length).toBeGreaterThan(0);
        });

        test('with nothing parked and nothing to skip, a parked message that is itself over the cap is dropped', () => {
            const budget = createHeldBudget(CAP);
            const forgotten: string[] = [];
            const { inbox } = parkedOn(budget);
            inbox.accept(1, { message: 'huge' }, CAP + 1, () => forgotten.push('huge'));
            expect(forgotten).toEqual(['huge']);
            expect(budget.held()).toBe(0);
        });
    });

    describe('the gap timer', () => {
        test('after a cap skip the old timer is gone: later out-of-order messages are held and delivered in order', () => {
            const budget = createHeldBudget(CAP);
            const { inbox, delivered } = streamOn(budget);
            inbox.accept(3, { message: 3 }, 600, noop); // arms the gap timer
            inbox.accept(4, { message: 4 }, 600, noop); // 1 200: the cap skips the gap, 3 and 4 are delivered
            expect(delivered).toEqual([3, 4]);
            expect(jest.getTimerCount()).toBe(0);
            jest.advanceTimersByTime(GAP_HOLD_MS * 2);
            // A stale timer would have set `expected` to Infinity; these arrive out of order and must wait for 5.
            inbox.accept(7, { message: 7 }, 10, noop);
            inbox.accept(6, { message: 6 }, 10, noop);
            expect(delivered).toEqual([3, 4]);
            inbox.accept(5, { message: 5 }, 10, noop);
            expect(delivered).toEqual([3, 4, 5, 6, 7]);
        });

        test('after a count skip (more than the held limit) the old timer is gone too', () => {
            const budget = createHeldBudget(MAX_HELD_BYTES);
            const { inbox, delivered } = streamOn(budget);
            for (let seq = 2; seq <= MAX_HELD_MESSAGES + 2; seq++) inbox.accept(seq, { message: seq }, 1, noop);
            expect(delivered).toHaveLength(MAX_HELD_MESSAGES + 1);
            expect(jest.getTimerCount()).toBe(0);
            jest.advanceTimersByTime(GAP_HOLD_MS * 2);
            const next = MAX_HELD_MESSAGES + 4;
            inbox.accept(next + 1, { message: next + 1 }, 1, noop);
            inbox.accept(next, { message: next }, 1, noop);
            expect(delivered).toHaveLength(MAX_HELD_MESSAGES + 1);
            inbox.accept(MAX_HELD_MESSAGES + 3, { message: MAX_HELD_MESSAGES + 3 }, 1, noop);
            expect(delivered.slice(-3)).toEqual([MAX_HELD_MESSAGES + 3, next, next + 1]);
        });

        test('a timer armed for an older gap never skips a newer gap early', () => {
            const budget = createHeldBudget(CAP);
            const { inbox, delivered } = streamOn(budget);
            inbox.accept(3, { message: 3 }, 600, noop); // timer armed at 0 s
            jest.advanceTimersByTime(GAP_HOLD_MS - 1_000);
            inbox.accept(4, { message: 4 }, 600, noop); // the cap skips: 3 and 4 delivered, the armed timer cleared
            expect(delivered).toEqual([3, 4]);
            inbox.accept(6, { message: 6 }, 10, noop); // a new gap (5): a new timer, 10 s from now
            jest.advanceTimersByTime(2_000); // the old timer would fire in this stretch
            expect(delivered).toEqual([3, 4]);
            jest.advanceTimersByTime(GAP_HOLD_MS - 2_000);
            expect(delivered).toEqual([3, 4, 6]);
        });
    });
});
