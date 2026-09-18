/**
 * Tests for VotingLogic.shouldJoinChallenge — the pure auto-join decision.
 * Model: once enabled, the DEFAULT scope is join everything; a non-empty include
 * list narrows; the exclude list subtracts; a title profile bypasses both. Coin
 * caps gate paid joins (both 0 = free only).
 */

const { shouldJoinChallenge } = require('../../src/js/services/VotingLogic');

const base = {
    challenge: { id: 1, type: 'flash', join_coins: 0 },
    bankroll: { coins: 1000 },
    remainingBudget: 1000,
    includeTypes: [],
    excludeTypes: [],
    maxCoins: 0,
    hasProfileMatch: false,
};
const call = (over) => shouldJoinChallenge({ ...base, ...over });

describe('scope (default = all)', () => {
    test('joins by default when nothing narrows it', () => {
        expect(call({})).toMatchObject({ join: true, reason: 'free' });
    });
    test('a non-empty include list narrows to those types', () => {
        expect(call({ includeTypes: ['flash'] })).toMatchObject({ join: true, reason: 'free' });
        expect(call({ includeTypes: ['contest'] }).reason).toBe('out-of-scope');
    });
    test('include match is case-insensitive on the challenge type', () => {
        expect(call({ challenge: { id: 1, type: 'FLASH', join_coins: 0 }, includeTypes: ['flash'] }).join).toBe(true);
    });
    test('a title-profile match joins even outside the include list', () => {
        expect(call({ includeTypes: ['contest'], hasProfileMatch: true })).toMatchObject({
            join: true,
            reason: 'free',
        });
    });
    test('a typeless challenge is out of scope only when an include list is set', () => {
        expect(call({ challenge: { id: 9, type: '', join_coins: 0 } })).toMatchObject({ join: true, reason: 'free' });
        expect(call({ challenge: { id: 9, type: '', join_coins: 0 }, includeTypes: ['flash'] }).reason).toBe(
            'out-of-scope',
        );
    });
});

describe('exclude types (default-all minus excludes)', () => {
    test('excluded type is skipped', () => {
        expect(call({ excludeTypes: ['flash'] })).toMatchObject({ join: false, reason: 'excluded-type' });
    });
    test('a non-excluded type still joins ("all except X")', () => {
        expect(
            call({ challenge: { id: 1, type: 'contest', join_coins: 0 }, excludeTypes: ['flash', 'exhibition'] }),
        ).toMatchObject({ join: true, reason: 'free' });
    });
    test('a title-profile match bypasses the exclude veto', () => {
        expect(call({ hasProfileMatch: true, excludeTypes: ['flash'] })).toMatchObject({ join: true, reason: 'free' });
    });
    test('a title-profile match bypasses BOTH an exclude and a non-matching include list at once', () => {
        expect(call({ hasProfileMatch: true, includeTypes: ['contest'], excludeTypes: ['flash'] })).toMatchObject({
            join: true,
            reason: 'free',
        });
    });
    test('exclude overrides an explicit include of the same type', () => {
        expect(call({ includeTypes: ['flash'], excludeTypes: ['flash'] }).reason).toBe('excluded-type');
    });
    test('exclude match is case-insensitive on the challenge type', () => {
        expect(call({ challenge: { id: 1, type: 'FLASH', join_coins: 0 }, excludeTypes: ['flash'] }).reason).toBe(
            'excluded-type',
        );
    });
    test('exclusion short-circuits before the paid gate', () => {
        const r = call({
            challenge: { id: 2, type: 'flash', join_coins: 100 },
            excludeTypes: ['flash'],
            maxCoins: 250,
            remainingBudget: 500,
            bankroll: { coins: 500 },
        });
        expect(r.reason).toBe('excluded-type');
    });
    test('a typeless challenge is never excluded and joins by default', () => {
        expect(call({ challenge: { id: 3, type: '', join_coins: 0 }, excludeTypes: ['flash'] })).toMatchObject({
            join: true,
            reason: 'free',
        });
    });
});

describe('paid gate', () => {
    const paid = { challenge: { id: 2, type: 'flash', join_coins: 100 } };

    test('both caps at 0 disable paid (per-challenge sentinel)', () => {
        expect(call({ ...paid, maxCoins: 0, remainingBudget: 0 }).reason).toBe('paid-disabled');
    });
    test('per-cycle budget 0 alone disables paid even with a per-challenge cap', () => {
        expect(call({ ...paid, maxCoins: 150, remainingBudget: 0 }).reason).toBe('over-cycle-budget');
    });
    test('over per-challenge cap', () => {
        expect(call({ ...paid, maxCoins: 50, remainingBudget: 1000 }).reason).toBe('over-per-challenge-cap');
    });
    test('insufficient coins', () => {
        expect(call({ ...paid, maxCoins: 150, remainingBudget: 1000, bankroll: { coins: 50 } }).reason).toBe(
            'insufficient-coins',
        );
    });
    test('null bankroll blocks paid (fail-safe) but allows free', () => {
        expect(call({ ...paid, maxCoins: 150, bankroll: null }).reason).toBe('balance-unknown');
        expect(call({ bankroll: null })).toMatchObject({ join: true, reason: 'free' });
    });
    test('affordable within both caps joins', () => {
        expect(call({ ...paid, maxCoins: 150, remainingBudget: 300, bankroll: { coins: 500 } })).toMatchObject({
            join: true,
            needsCoins: 100,
            reason: 'paid',
        });
    });
});

/**
 * Join window: `joinWithinSec` (0 = off) defers a candidate until it is within
 * that many seconds of its own close_time, so entries land near the end of a
 * challenge instead of the moment it appears. Fail-closed — a candidate that
 * cannot prove it is inside the window is never joined while one is set.
 */
describe('join window (timing)', () => {
    const HOUR = 3600;
    const NOW = 1_700_000_000;
    const far = { id: 5, type: 'flash', join_coins: 0, close_time: NOW + 48 * HOUR };
    const near = { id: 5, type: 'flash', join_coins: 0, close_time: NOW + 5 * HOUR };
    // A 24h window evaluated at a fixed clock — the shape of "join 24h from end".
    const win = (over) => call({ joinWithinSec: 24 * HOUR, nowSec: NOW, ...over });

    test('a window of 0 is off — the candidate joins on sight (historical behavior)', () => {
        expect(call({ challenge: far, joinWithinSec: 0, nowSec: NOW })).toMatchObject({ join: true, reason: 'free' });
    });
    test('an absent window is off, and close_time is never read', () => {
        expect(call({ challenge: { id: 5, type: 'flash', join_coins: 0 } })).toMatchObject({
            join: true,
            reason: 'free',
        });
    });
    test('outside the window the candidate is deferred', () => {
        expect(win({ challenge: far })).toMatchObject({ join: false, reason: 'too-early' });
    });
    test('inside the window it joins', () => {
        expect(win({ challenge: near })).toMatchObject({ join: true, reason: 'free' });
    });
    test('the window boundary is inclusive', () => {
        const exactly = { id: 5, type: 'flash', join_coins: 0, close_time: NOW + 24 * HOUR };
        expect(win({ challenge: exactly })).toMatchObject({ join: true, reason: 'free' });
        const oneSecondOut = { id: 5, type: 'flash', join_coins: 0, close_time: NOW + 24 * HOUR + 1 };
        expect(win({ challenge: oneSecondOut }).reason).toBe('too-early');
    });

    describe('fail-closed', () => {
        test('a missing close_time is not joined while a window is set', () => {
            expect(win({ challenge: { id: 5, type: 'flash', join_coins: 0 } })).toMatchObject({
                join: false,
                reason: 'close-time-unknown',
            });
        });
        test('an unparseable close_time is not joined either', () => {
            for (const bad of ['soon', null, NaN, 0, -1]) {
                expect(win({ challenge: { id: 5, type: 'flash', join_coins: 0, close_time: bad } }).join).toBe(false);
            }
        });
        test('an already-closed candidate is refused, not treated as "in window"', () => {
            const dead = { id: 5, type: 'flash', join_coins: 0, close_time: NOW - 60 };
            expect(win({ challenge: dead })).toMatchObject({ join: false, reason: 'already-closed' });
        });
        test('a missing clock refuses rather than measuring against epoch 0', () => {
            expect(call({ challenge: near, joinWithinSec: 24 * HOUR, nowSec: 0 }).reason).toBe('close-time-unknown');
        });
    });

    test('a title opt-in does NOT bypass the window (unlike the type filters)', () => {
        // hasProfileMatch bypasses include/exclude, but the window says WHEN, not
        // WHETHER — bypassing it would invert the user's explicit instruction.
        expect(win({ challenge: far, hasProfileMatch: true })).toMatchObject({ join: false, reason: 'too-early' });
    });

    test('timing gates paid candidates identically, before the coin caps', () => {
        const paidFar = { id: 5, type: 'flash', join_coins: 100, close_time: NOW + 48 * HOUR };
        expect(win({ challenge: paidFar, maxCoins: 150 })).toMatchObject({ join: false, reason: 'too-early' });
        const paidNear = { id: 5, type: 'flash', join_coins: 100, close_time: NOW + 5 * HOUR };
        expect(win({ challenge: paidNear, maxCoins: 150 })).toMatchObject({ join: true, reason: 'paid' });
    });

    test('scope filters still report their own reason ahead of timing', () => {
        expect(win({ challenge: far, excludeTypes: ['flash'] }).reason).toBe('excluded-type');
    });

    test('the coin caps still veto a paid candidate that IS inside the window', () => {
        const paidNear = { id: 5, type: 'flash', join_coins: 100, close_time: NOW + 5 * HOUR };
        expect(win({ challenge: paidNear, maxCoins: 0 }).reason).toBe('paid-disabled');
        expect(win({ challenge: paidNear, maxCoins: 150, remainingBudget: 10 }).reason).toBe('over-cycle-budget');
    });
});
