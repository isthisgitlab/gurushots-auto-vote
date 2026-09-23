/**
 * Tests for voting/currencyAuto.js — the pure rule math behind the automatic
 * key / swap / fill spends: timing windows (AND of the set conditions), the
 * swap target pick, the vote-pool reach and the fill-vs-vote decision.
 */

const {
    ruleOpensAt,
    isRuleOpen,
    isProtectedEntry,
    pickSwapTarget,
    votePoolReach,
    fillBeatsVoting,
} = require('../../src/js/voting/currencyAuto');
const { resolveEntryIndex } = require('../../src/js/voting/entrySlot');

const H = 3600;
// A 24h challenge started at t=1000.
const challenge = { start_time: 1000, close_time: 1000 + 24 * H };

describe('ruleOpensAt', () => {
    test('no condition set → open from the start', () => {
        expect(ruleOpensAt(challenge, {})).toBe(1000);
        expect(ruleOpensAt(challenge, { afterStartSec: 0, beforeEndSec: 0, afterPercent: 0 })).toBe(1000);
        expect(ruleOpensAt(challenge, undefined)).toBe(1000);
    });

    test('after start', () => {
        expect(ruleOpensAt(challenge, { afterStartSec: 11 * H })).toBe(1000 + 11 * H);
    });

    test('before end', () => {
        expect(ruleOpensAt(challenge, { beforeEndSec: 7 * H })).toBe(1000 + 17 * H);
    });

    test('after percent', () => {
        expect(ruleOpensAt(challenge, { afterPercent: 50 })).toBe(1000 + 12 * H);
    });

    test('a percent over the 99 ceiling clamps to 99', () => {
        expect(ruleOpensAt(challenge, { afterPercent: 150 })).toBe(1000 + 24 * H * 0.99);
    });

    test('every set condition must hold — the latest instant wins', () => {
        expect(ruleOpensAt(challenge, { afterStartSec: 11 * H, beforeEndSec: 7 * H })).toBe(1000 + 17 * H);
        expect(ruleOpensAt(challenge, { afterStartSec: 20 * H, beforeEndSec: 7 * H })).toBe(1000 + 20 * H);
        expect(ruleOpensAt(challenge, { afterStartSec: H, afterPercent: 75 })).toBe(1000 + 18 * H);
    });

    test('non-numeric and negative conditions count as off', () => {
        expect(ruleOpensAt(challenge, { afterStartSec: 'x', beforeEndSec: -5, afterPercent: NaN })).toBe(1000);
    });

    test('fails closed when a condition needs a missing clock', () => {
        expect(ruleOpensAt({ close_time: 5000 }, { afterStartSec: 10 })).toBeNull();
        expect(ruleOpensAt({ start_time: 5000 }, { beforeEndSec: 10 })).toBeNull();
        expect(ruleOpensAt({ start_time: 5000 }, { afterPercent: 10 })).toBeNull();
        expect(ruleOpensAt({ start_time: 5000, close_time: 5000 }, { afterPercent: 10 })).toBeNull();
    });

    test('no condition and no start → open from the beginning of time', () => {
        expect(ruleOpensAt({}, {})).toBe(-Infinity);
        expect(ruleOpensAt(null, {})).toBe(-Infinity);
    });
});

describe('isRuleOpen', () => {
    const timing = { afterStartSec: 11 * H };

    test('closed before the opening instant', () => {
        expect(isRuleOpen(challenge, timing, 1000 + 11 * H - 1)).toBe(false);
    });

    test('open from the opening instant until close', () => {
        expect(isRuleOpen(challenge, timing, 1000 + 11 * H)).toBe(true);
        expect(isRuleOpen(challenge, timing, 1000 + 24 * H - 1)).toBe(true);
    });

    test('closed once the challenge has closed', () => {
        expect(isRuleOpen(challenge, timing, 1000 + 24 * H)).toBe(false);
    });

    test('closed when the rule cannot be decided', () => {
        expect(isRuleOpen({}, timing, 5000)).toBe(false);
    });

    test('open without a close_time when the conditions need none', () => {
        expect(isRuleOpen({ start_time: 0 }, timing, 11 * H)).toBe(true);
    });
});

describe('isProtectedEntry', () => {
    test.each([
        [{ boosted: true }, true],
        [{ boosting: true }, true],
        [{ turbo: true }, true],
        [{ boosted: false, turbo: false, boosting: false }, false],
        [null, false],
    ])('%p → %p', (entry, expected) => {
        expect(isProtectedEntry(entry)).toBe(expected);
    });
});

describe('pickSwapTarget', () => {
    const a = { id: 'a', votes: 30 };
    const b = { id: 'b', votes: 10 };
    const c = { id: 'c', votes: 20 };

    test('no entries → null', () => {
        expect(pickSwapTarget([], {})).toBeNull();
        expect(pickSwapTarget(null, {})).toBeNull();
    });

    test('index 0 picks the last entry; 1-4 pick that slot', () => {
        expect(pickSwapTarget([a, b, c], { imageIndex: 0 })).toBe(c);
        expect(pickSwapTarget([a, b, c], { imageIndex: 1 })).toBe(a);
        expect(pickSwapTarget([a, b, c], { imageIndex: 2 })).toBe(b);
        expect(pickSwapTarget([a, b, c], { imageIndex: 4 })).toBe(c);
    });

    test('defaults to the last entry', () => {
        expect(pickSwapTarget([a, b, c], {})).toBe(c);
    });

    test('steps backward past a protected entry, wrapping', () => {
        const turbo = { id: 't', votes: 1, turbo: true };
        expect(pickSwapTarget([a, turbo], { imageIndex: 2 })).toBe(a);
        expect(pickSwapTarget([turbo, a], { imageIndex: 1 })).toBe(a);
    });

    test('only protected entries → null unless allowed', () => {
        const boosted = { id: 'x', votes: 1, boosted: true };
        expect(pickSwapTarget([boosted], {})).toBeNull();
        expect(pickSwapTarget([boosted], { allowProtected: true })).toBe(boosted);
    });

    test('lowestVotes picks the fewest-votes entry, the later one on a tie', () => {
        expect(pickSwapTarget([a, b, c], { lowestVotes: true })).toBe(b);
        const b2 = { id: 'b2', votes: 10 };
        expect(pickSwapTarget([a, b, b2], { lowestVotes: true })).toBe(b2);
    });

    test('lowestVotes skips protected entries unless allowed', () => {
        const lowTurbo = { id: 'lt', votes: 0, turbo: true };
        expect(pickSwapTarget([a, lowTurbo], { lowestVotes: true })).toBe(a);
        expect(pickSwapTarget([a, lowTurbo], { lowestVotes: true, allowProtected: true })).toBe(lowTurbo);
        expect(pickSwapTarget([lowTurbo], { lowestVotes: true })).toBeNull();
    });

    test('missing votes count as 0', () => {
        const noVotes = { id: 'n' };
        expect(pickSwapTarget([a, noVotes], { lowestVotes: true })).toBe(noVotes);
    });

    test('maxVotes: the target must have fewer votes than the ceiling', () => {
        expect(pickSwapTarget([a, b, c], { imageIndex: 1, maxVotes: 30 })).toBeNull();
        expect(pickSwapTarget([a, b, c], { imageIndex: 1, maxVotes: 31 })).toBe(a);
        expect(pickSwapTarget([a, b, c], { imageIndex: 1, maxVotes: 0 })).toBe(a);
    });

    test('null holes in the entry list are never picked', () => {
        expect(pickSwapTarget([a, null], { imageIndex: 2 })).toBe(a);
    });
});

describe('votePoolReach', () => {
    test('starting exposure plus every distinct image ratio', () => {
        const pool = {
            voting: { exposure: { exposure_factor: 40 } },
            images: [{ id: 1, ratio: 5 }, { id: 1, ratio: 5 }, { id: 2, ratio: '2.5' }, { id: 3, ratio: 'x' }, null],
        };
        expect(votePoolReach(pool)).toBe(47.5);
    });

    test('null when there is no readable pool', () => {
        expect(votePoolReach(null)).toBeNull();
        expect(votePoolReach({ voting: { exposure: { exposure_factor: 40 } }, images: [] })).toBeNull();
        expect(votePoolReach({ voting: {}, images: [{ id: 1, ratio: 1 }] })).toBeNull();
    });
});

describe('fillBeatsVoting', () => {
    test('exposure at or above the threshold → no fill', () => {
        expect(fillBeatsVoting(50, null, 50)).toBe(false);
    });

    test('below the threshold with no pool → fill', () => {
        expect(fillBeatsVoting(20, null, 50)).toBe(true);
    });

    test('below the threshold but voting reaches it → no fill', () => {
        expect(fillBeatsVoting(20, 60, 50)).toBe(false);
    });

    test('below the threshold and voting falls short → fill', () => {
        expect(fillBeatsVoting(20, 35, 50)).toBe(true);
    });

    test('unreadable exposure or threshold → no fill', () => {
        expect(fillBeatsVoting(undefined, null, 50)).toBe(false);
        expect(fillBeatsVoting(20, null, undefined)).toBe(false);
    });
});

describe('resolveEntryIndex', () => {
    test('0 = last, 1-4 = slot, clamped, corrupt → first', () => {
        expect(resolveEntryIndex([1, 2, 3], 0)).toBe(2);
        expect(resolveEntryIndex([1, 2, 3], 2)).toBe(1);
        expect(resolveEntryIndex([1, 2, 3], 9)).toBe(2);
        expect(resolveEntryIndex([1, 2, 3], -1)).toBe(0);
        expect(resolveEntryIndex([], 1)).toBeNull();
    });
});
