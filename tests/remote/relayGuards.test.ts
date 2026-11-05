/** The token bucket (send budget, decrypt cap) and the expiring seen-set (replay memory). */

import { createSeenSet, createTokenBucket } from '../../src/ts/core/remote/relayGuards';

describe('createTokenBucket', () => {
    test('starts full, empties, and refills at the rate up to the burst', () => {
        let at = 0;
        const bucket = createTokenBucket(8, 2, () => at);
        expect(bucket.tryTake()).toBe(true);
        expect(bucket.tryTake()).toBe(true);
        expect(bucket.tryTake()).toBe(false);
        expect(bucket.msUntilToken()).toBe(125);
        at = 124;
        expect(bucket.tryTake()).toBe(false);
        at = 125;
        expect(bucket.msUntilToken()).toBe(0);
        expect(bucket.tryTake()).toBe(true);
        expect(bucket.tryTake()).toBe(false);
        at = 100_000; // a long idle never banks more than the burst
        expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([true, true, false]);
    });

    test('a burst of one allows at most `perSecond` takes in any second', () => {
        let at = 0;
        const bucket = createTokenBucket(8, 1, () => at);
        let taken = 0;
        for (at = 0; at < 1000; at += 10) if (bucket.tryTake()) taken += 1;
        expect(taken).toBe(8);
    });
});

describe('createSeenSet', () => {
    test('remembers a key for the ttl and then forgets it', () => {
        let at = 0;
        const seen = createSeenSet(600, () => at);
        expect(seen.has('a')).toBe(false);
        seen.add('a');
        at = 599;
        expect(seen.has('a')).toBe(true);
        at = 600;
        expect(seen.has('a')).toBe(false);
    });

    test('adding a key again starts its ttl over, and pruning stops at the first live entry', () => {
        let at = 0;
        const seen = createSeenSet(100, () => at);
        seen.add('a');
        at = 50;
        seen.add('b');
        at = 90;
        seen.add('a'); // a now lives until 190, after b (150)
        at = 120;
        expect(seen.has('a')).toBe(true);
        expect(seen.has('b')).toBe(true);
        at = 151;
        expect(seen.has('b')).toBe(false);
        expect(seen.has('a')).toBe(true);
    });

    test('delete forgets a key at once, ignores one that is not held, and leaves the others', () => {
        let at = 0;
        const seen = createSeenSet(1_000, () => at);
        seen.add('a');
        seen.add('b');
        seen.delete('a');
        seen.delete('never');
        expect(seen.has('a')).toBe(false);
        expect(seen.has('b')).toBe(true);
        seen.add('a'); // remembered again from now
        at = 999;
        expect(seen.has('a')).toBe(true);
    });
});
