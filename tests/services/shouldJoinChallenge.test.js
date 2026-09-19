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

/**
 * Challenge-tag scope: the same include/exclude shape as the type lists, over
 * the challenge's OWN tags (Exhibition / Comm / Turbo / …). Types and tags are
 * independent axes — both must pass.
 */
describe('challenge-tag scope', () => {
    const tagged = (...tags) => ({ id: 1, type: 'flash', join_coins: 0, tags });

    test('no tag lists = all tags allowed (default)', () => {
        expect(call({ challenge: tagged('Comm') })).toMatchObject({ join: true, reason: 'free' });
    });
    test('a non-empty require-list narrows to challenges carrying any of them', () => {
        expect(call({ challenge: tagged('Exhibition'), includeTags: ['exhibition'] }).join).toBe(true);
        expect(call({ challenge: tagged('Turbo'), includeTags: ['exhibition'] }).reason).toBe('tag-out-of-scope');
    });
    test('ANY listed tag is enough, not all of them', () => {
        expect(call({ challenge: tagged('Turbo', 'Comm'), includeTags: ['exhibition', 'comm'] }).join).toBe(true);
    });
    test('an excluded tag vetoes', () => {
        expect(call({ challenge: tagged('Comm', 'Turbo'), excludeTags: ['comm'] })).toMatchObject({
            join: false,
            reason: 'excluded-tag',
        });
    });
    test('a challenge with no tags passes an empty filter but never a require-list', () => {
        expect(call({ challenge: { id: 1, type: 'flash', join_coins: 0 } }).join).toBe(true);
        expect(call({ challenge: { id: 1, type: 'flash', join_coins: 0 }, includeTags: ['comm'] }).reason).toBe(
            'tag-out-of-scope',
        );
    });
    test('a title opt-in bypasses both tag lists, as it does the type lists', () => {
        expect(call({ challenge: tagged('Comm'), excludeTags: ['comm'], hasProfileMatch: true }).join).toBe(true);
        expect(call({ challenge: tagged('Turbo'), includeTags: ['exhibition'], hasProfileMatch: true }).join).toBe(
            true,
        );
    });
    test('types and tags are independent — a type veto still applies to an allowed tag', () => {
        expect(
            call({ challenge: tagged('Exhibition'), includeTags: ['exhibition'], excludeTypes: ['flash'] }).reason,
        ).toBe('excluded-type');
    });
    test('the type veto is reported before the tag veto', () => {
        expect(call({ challenge: tagged('Comm'), excludeTypes: ['flash'], excludeTags: ['comm'] }).reason).toBe(
            'excluded-type',
        );
    });
    test('a non-string tag in the payload is ignored, not crashed on', () => {
        expect(call({ challenge: { id: 1, type: 'flash', join_coins: 0, tags: [null, 42, 'Comm'] } }).join).toBe(true);
        expect(
            call({ challenge: { id: 1, type: 'flash', join_coins: 0, tags: [null, 'Comm'] }, excludeTags: ['comm'] })
                .reason,
        ).toBe('excluded-tag');
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

/**
 * Percent-elapsed join anchor: `joinAfterPercentElapsed` (0 = off) defers a
 * candidate until that share of its OWN lifetime has run, so one setting suits
 * challenges of wildly different lengths — the live payload carries 2h flash
 * challenges and 515h exhibitions side by side.
 */
describe('join window (percent elapsed)', () => {
    const HOUR = 3600;
    const START = 1_700_000_000;
    // A challenge of `durH` hours, observed `elapsedH` hours after it opened.
    const at = (durH, elapsedH, over = {}) => ({
        challenge: {
            id: 7,
            type: 'default',
            join_coins: 0,
            start_time: START,
            close_time: START + durH * HOUR,
            ...over,
        },
        nowSec: START + elapsedH * HOUR,
    });
    const pct = (value, ctx) => call({ joinAfterPercentElapsed: value, ...ctx });

    test('0 is off — the candidate joins on sight, and start_time is never read', () => {
        expect(pct(0, at(24, 0))).toMatchObject({ join: true, reason: 'free' });
        expect(
            call({ challenge: { id: 7, type: 'default', join_coins: 0 }, joinAfterPercentElapsed: 0 }),
        ).toMatchObject({ join: true, reason: 'free' });
    });

    test('defers before the fraction has run and joins once it has', () => {
        expect(pct(75, at(24, 17)).reason).toBe('too-early');
        expect(pct(75, at(24, 19))).toMatchObject({ join: true, reason: 'free' });
    });

    test('the boundary is inclusive — exactly at the fraction joins', () => {
        expect(pct(75, at(24, 18))).toMatchObject({ join: true, reason: 'free' });
        // One minute short is still too early.
        expect(pct(75, { ...at(24, 18), nowSec: START + 18 * HOUR - 60 }).reason).toBe('too-early');
    });

    /**
     * The whole point of the anchor: ONE value tracks the challenge's length,
     * where a fixed hours window cannot. These are the real durations observed
     * on the live account (24/48/72h defaults, a 515.7h exhibition, a 2h flash).
     */
    test.each([
        [24, 6],
        [48, 12],
        [72, 18],
        [168, 42],
    ])('75%% of a %ih challenge leaves %ih before close', (durH, leftH) => {
        expect(pct(75, at(durH, durH - leftH - 0.05)).reason).toBe('too-early');
        expect(pct(75, at(durH, durH - leftH)).join).toBe(true);
    });

    test('a 2h flash and a 515.7h exhibition are both handled by the same value', () => {
        // Flash: 75% of 2h = 30 minutes left.
        expect(pct(75, at(2, 1.4)).reason).toBe('too-early');
        expect(pct(75, at(2, 1.5)).join).toBe(true);
        // Exhibition: 75% of 515.7h leaves ~128.9h — an hours window tuned for
        // the flash would have joined it weeks early.
        expect(pct(75, at(515.7, 386)).reason).toBe('too-early');
        expect(pct(75, at(515.7, 387)).join).toBe(true);
    });

    test('percent wins when an hours window is also set — one candidate, one window', () => {
        // The hours window alone would defer (1s from close); percent alone
        // would join. Percent is the one that decides.
        expect(pct(75, { ...at(24, 20), joinWithinSec: 1 })).toMatchObject({ join: true, reason: 'free' });
        // And the reverse: percent defers even though the hours window is wide open.
        expect(pct(75, { ...at(24, 2), joinWithinSec: 48 * HOUR }).reason).toBe('too-early');
    });

    test('a title opt-in does NOT bypass it, matching the hours window', () => {
        expect(pct(75, { ...at(24, 2), hasProfileMatch: true })).toMatchObject({
            join: false,
            reason: 'too-early',
        });
    });

    test('it gates paid candidates identically, before the coin caps', () => {
        const paid = at(24, 2, { join_coins: 100 });
        expect(pct(75, { ...paid, maxCoins: 150 }).reason).toBe('too-early');
        const paidLate = at(24, 20, { join_coins: 100 });
        expect(pct(75, { ...paidLate, maxCoins: 150 })).toMatchObject({ join: true, reason: 'paid' });
    });

    describe('fail-closed', () => {
        test('a missing start_time is not joined — a percentage needs a length', () => {
            expect(pct(75, at(24, 20, { start_time: undefined })).reason).toBe('start-time-unknown');
        });
        test('an unparseable start_time is refused, not coerced', () => {
            expect(pct(75, at(24, 20, { start_time: 'soon' })).reason).toBe('start-time-unknown');
        });
        test('a start_time at or after close_time has no fraction to compute', () => {
            expect(pct(75, at(24, 20, { start_time: START + 99 * HOUR })).reason).toBe('start-time-unknown');
            expect(pct(75, at(24, 20, { start_time: START + 24 * HOUR })).reason).toBe('start-time-unknown');
        });
        test('a missing close_time still reports close-time-unknown first', () => {
            expect(pct(75, at(24, 20, { close_time: undefined })).reason).toBe('close-time-unknown');
        });
        test('an already-closed candidate is refused before the fraction is read', () => {
            expect(pct(75, { ...at(24, 25) }).reason).toBe('already-closed');
        });
    });

    test('a start_time in the future reads as 0% elapsed, never negative', () => {
        // Clock skew: now is before start. 0% < 75%, so defer rather than join.
        expect(pct(75, { ...at(24, 12), nowSec: START - HOUR }).reason).toBe('too-early');
        // And a 1% anchor does not accidentally pass on a negative fraction.
        expect(pct(1, { ...at(24, 12), nowSec: START - HOUR }).reason).toBe('too-early');
    });

    /**
     * 100% elapsed is only true once close_time has passed, at which point the
     * gate reports `already-closed` instead. So the anchor clamps to the latest
     * fraction that can actually fire (99%) — a corrupted or out-of-range value
     * must degrade to "join as late as possible", never to "never join".
     */
    test('an out-of-range value clamps to the latest REACHABLE fraction, not to never', () => {
        // 98% of 24h = 23.52h elapsed: still short of the clamped 99% anchor.
        expect(pct(1000, at(24, 23.5)).reason).toBe('too-early');
        // 99.5% elapsed clears the clamped anchor and still has time left.
        expect(pct(1000, at(24, 23.88)).join).toBe(true);
    });

    test('the schema ceiling (99) is reachable, so the maximum setting still joins', () => {
        expect(pct(99, at(24, 23.5)).reason).toBe('too-early');
        expect(pct(99, at(24, 23.9)).join).toBe(true);
    });
});
