/**
 * The pure boost-window helpers (`src/js/voting/boostWindow.js`).
 *
 * These are settings-free and shared by the voting engine, the scheduler and the
 * renderer, so their contract is pinned here directly rather than only through
 * whichever caller happens to exercise it. `boostApplyThreshold` in particular is
 * the single source of the boost-apply instant for BOTH `VotingLogic`
 * (getBoostThresholdSec / getBoostPrefillState) and
 * `scheduling/thresholdWindow.js` (soonestBoostPrefillStart) — if the two ever
 * disagree, the scheduler wakes for a fill the rule then refuses.
 */

const { isBoostWindowOpen, openBoostWindows, boostApplyThreshold } = require('../../src/js/voting/boostWindow');

const NOW = 1_700_000_000;
const WINDOWS = { boostTimeSec: 3600, keyUnlockedBoostTimeSec: 900 };

describe('boostApplyThreshold — branch selection', () => {
    test('AVAILABLE_KEY measures against close time via the key-unlocked window', () => {
        expect(boostApplyThreshold({ state: 'AVAILABLE_KEY' }, NOW + 7200, WINDOWS)).toEqual({
            thresholdSec: 900,
            branch: 'key',
        });
    });

    test('AVAILABLE with no timeout is treated as key-unlocked', () => {
        expect(boostApplyThreshold({ state: 'AVAILABLE' }, NOW + 7200, WINDOWS)).toEqual({
            thresholdSec: 900,
            branch: 'key',
        });
    });

    test('AVAILABLE with a zero timeout is key-unlocked too (0 is not a live timer)', () => {
        expect(boostApplyThreshold({ state: 'AVAILABLE', timeout: 0 }, NOW + 7200, WINDOWS)).toEqual({
            thresholdSec: 900,
            branch: 'key',
        });
    });

    test('AVAILABLE with a live timeout converts the boost timer to seconds-before-close', () => {
        // close − timeout + boostTime = 7200 − 4200 + 3600 = 6600.
        expect(boostApplyThreshold({ state: 'AVAILABLE', timeout: NOW + 4200 }, NOW + 7200, WINDOWS)).toEqual({
            thresholdSec: 6600,
            branch: 'timer',
        });
    });

    test.each([['NONE'], ['USED'], ['LOCKED'], ['UNAVAILABLE']])('%s sorts last with no branch', (state) => {
        expect(boostApplyThreshold({ state }, NOW + 7200, WINDOWS)).toEqual({
            thresholdSec: -Infinity,
            branch: null,
        });
    });

    test.each([
        ['null', null],
        ['undefined', undefined],
        ['empty object', {}],
    ])('%s boost yields no branch rather than throwing', (_label, boost) => {
        expect(boostApplyThreshold(boost, NOW + 7200, WINDOWS)).toEqual({ thresholdSec: -Infinity, branch: null });
    });
});

describe('boostApplyThreshold — contract edges', () => {
    test('a string timeout is NOT treated as a live timer (typeof check, not coercion)', () => {
        // Mirrors shouldApplyBoost's own `typeof boost.timeout === 'number'` guard:
        // a hand-edited/garbled payload must not silently become a timer boost.
        expect(boostApplyThreshold({ state: 'AVAILABLE', timeout: '4200' }, NOW + 7200, WINDOWS)).toEqual({
            thresholdSec: 900,
            branch: 'key',
        });
    });

    test('a negative timeout is not a live timer either', () => {
        expect(boostApplyThreshold({ state: 'AVAILABLE', timeout: -5 }, NOW + 7200, WINDOWS)).toEqual({
            thresholdSec: 900,
            branch: 'key',
        });
    });

    test('an unusable close time never yields a plausible-looking positive instant', () => {
        // Two different unusable values, two different (both safe) outcomes — pinned
        // because callers reject on `thresholdSec <= 0` / !isFinite, so what matters
        // is that neither can pass those guards:
        //   undefined → NaN (Number(undefined))
        //   null      → 0, so the subtraction lands far negative (Number(null) === 0)
        const undef = boostApplyThreshold({ state: 'AVAILABLE', timeout: NOW + 4200 }, undefined, WINDOWS);
        expect(undef.branch).toBe('timer');
        expect(Number.isNaN(undef.thresholdSec)).toBe(true);

        const nul = boostApplyThreshold({ state: 'AVAILABLE', timeout: NOW + 4200 }, null, WINDOWS);
        expect(nul.branch).toBe('timer');
        expect(nul.thresholdSec).toBeLessThan(0);
    });

    test('a boost expiring AFTER close yields a negative instant, never a positive one', () => {
        // Malformed data: callers reject this via `thresholdSec <= 0`.
        const { thresholdSec } = boostApplyThreshold({ state: 'AVAILABLE', timeout: NOW + 7200 }, NOW + 3600, {
            boostTimeSec: 60,
            keyUnlockedBoostTimeSec: 900,
        });
        expect(thresholdSec).toBeLessThan(0);
    });

    test('the 0 = off sentinel is deliberately NOT applied here — it is returned verbatim', () => {
        // orderDeadlineActions relies on this staying a pure function of the configured
        // numbers; the sentinel is re-checked by getBoostPrefillState / describeDeadlineActions.
        expect(
            boostApplyThreshold({ state: 'AVAILABLE_KEY' }, NOW + 7200, { ...WINDOWS, keyUnlockedBoostTimeSec: 0 }),
        ).toEqual({ thresholdSec: 0, branch: 'key' });
        const timer = boostApplyThreshold({ state: 'AVAILABLE', timeout: NOW + 4200 }, NOW + 7200, {
            ...WINDOWS,
            boostTimeSec: 0,
        });
        expect(timer).toEqual({ thresholdSec: 3000, branch: 'timer' });
    });
});

describe('isBoostWindowOpen', () => {
    test.each([
        ['AVAILABLE_KEY never expires', { state: 'AVAILABLE_KEY' }, true],
        ['AVAILABLE with a future timeout', { state: 'AVAILABLE', timeout: NOW + 60 }, true],
        ['AVAILABLE with a past timeout', { state: 'AVAILABLE', timeout: NOW - 60 }, false],
        ['AVAILABLE with no timeout', { state: 'AVAILABLE' }, true],
        ['USED', { state: 'USED' }, false],
        ['no state', {}, false],
        ['null', null, false],
    ])('%s', (_label, boost, expected) => {
        expect(isBoostWindowOpen(boost, NOW)).toBe(expected);
    });
});

describe('openBoostWindows', () => {
    test('returns only open windows, soonest-expiring first, key-unlocked last', () => {
        const challenges = [
            { id: 'a', title: 'Key', member: { boost: { state: 'AVAILABLE_KEY' } } },
            { id: 'b', title: 'Late', member: { boost: { state: 'AVAILABLE', timeout: NOW + 600 } } },
            { id: 'c', title: 'Soon', member: { boost: { state: 'AVAILABLE', timeout: NOW + 60 } } },
            { id: 'd', title: 'Used', member: { boost: { state: 'USED' } } },
        ];
        expect(openBoostWindows(challenges, NOW)).toEqual([
            { id: 'c', title: 'Soon', remaining: 60 },
            { id: 'b', title: 'Late', remaining: 600 },
            { id: 'a', title: 'Key', remaining: null },
        ]);
    });

    test('two key-unlocked windows (no countdown) keep their relative order', () => {
        const challenges = [
            { id: 'k1', title: 'Key 1', member: { boost: { state: 'AVAILABLE_KEY' } } },
            { id: 'k2', title: 'Key 2', member: { boost: { state: 'AVAILABLE_KEY' } } },
        ];
        expect(openBoostWindows(challenges, NOW).map((w) => w.id)).toEqual(['k1', 'k2']);
    });

    test('a missing/empty list is an empty result, not a throw', () => {
        expect(openBoostWindows(null, NOW)).toEqual([]);
        expect(openBoostWindows([], NOW)).toEqual([]);
    });
});
