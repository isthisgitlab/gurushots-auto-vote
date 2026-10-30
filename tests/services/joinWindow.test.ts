/**
 * Tests for the join-timing window (services/decisions/joinWindow.ts) through
 * the VotingLogic facade: the three timing settings resolve to ONE window in a
 * fixed order — after-start → percent → hours-before-end — and the after-start
 * clamp read the join pass logs its note from.
 */

import type * as VotingLogicModule from '../../src/ts/services/VotingLogic';
import { invalid } from '../helpers/invalid';

const { shouldJoinChallenge, joinAfterStartClamped } =
    require('../../src/ts/services/VotingLogic') as typeof VotingLogicModule;

type JoinParams = Parameters<typeof shouldJoinChallenge>[0];

const base: JoinParams = {
    challenge: { id: 1, type: 'flash', join_coins: 0 },
    bankroll: { coins: 1000 },
    remainingBudget: 1000,
    includeTypes: [],
    excludeTypes: [],
    maxCoins: 0,
    hasProfileMatch: false,
    joinAfterSecFromStart: 0,
};
const call = (over: Partial<JoinParams>) => shouldJoinChallenge({ ...base, ...over });

/**
 * Hours-from-start join anchor: `joinAfterSecFromStart` (0 = off) defers a
 * candidate until that many seconds have run since its own `start_time` — the
 * shape for challenges with no fixed length (exhibitions, magazines), where a
 * fraction of the length or a distance from the end is the wrong measure.
 * First in the timing order (resolveJoinWindow): above 0 it wins over percent
 * and hours-before-end.
 */
describe('join window (hours from start)', () => {
    const HOUR = 3600;
    const START = 1_700_000_000;
    // A challenge of `durH` hours that opened at START, observed `elapsedH`
    // hours after it opened.
    const at = (
        durH: number,
        elapsedH: number,
        over: { start_time?: number; close_time?: number; join_coins?: number } = {},
    ) => ({
        challenge: {
            id: 8,
            type: 'default',
            join_coins: 0,
            start_time: START,
            close_time: START + durH * HOUR,
            ...over,
        },
        nowSec: START + elapsedH * HOUR,
    });
    const hrs = (value: number, ctx: Partial<JoinParams>) => call({ joinAfterSecFromStart: value * HOUR, ...ctx });

    test('0 is off — the candidate joins on sight, and start_time is never read', () => {
        expect(hrs(0, at(24, 0))).toMatchObject({ join: true, reason: 'free' });
        expect(call({ challenge: { id: 8, type: 'default', join_coins: 0 }, joinAfterSecFromStart: 0 })).toMatchObject({
            join: true,
            reason: 'free',
        });
    });

    test('defers before the offset has run and joins once it has', () => {
        expect(hrs(6, at(24, 5)).reason).toBe('too-early');
        expect(hrs(6, at(24, 7))).toMatchObject({ join: true, reason: 'free' });
    });

    test('the boundary is inclusive — exactly at the offset joins', () => {
        expect(hrs(6, at(24, 6))).toMatchObject({ join: true, reason: 'free' });
    });

    test('it gates paid candidates identically, before the coin caps', () => {
        const paid = at(24, 2, { join_coins: 100 });
        expect(hrs(6, { ...paid, maxCoins: 150 }).reason).toBe('too-early');
        expect(hrs(6, { ...at(24, 7, { join_coins: 100 }), maxCoins: 150 })).toMatchObject({
            join: true,
            reason: 'paid',
        });
    });

    test('a title opt-in does NOT bypass it, matching the other timing windows', () => {
        expect(hrs(6, { ...at(24, 2), hasProfileMatch: true })).toMatchObject({ join: false, reason: 'too-early' });
    });

    describe('fail-closed', () => {
        test('a missing start_time is not joined — a wait from the start needs the anchor', () => {
            expect(hrs(6, at(24, 10, { start_time: undefined })).reason).toBe('start-time-unknown');
        });
        test('an unparseable start_time is refused, not coerced', () => {
            expect(hrs(6, at(24, 10, invalid({ start_time: 'soon' }))).reason).toBe('start-time-unknown');
        });
        test('a start_time of 0 or less is refused too', () => {
            expect(hrs(6, at(24, 10, { start_time: 0 })).reason).toBe('start-time-unknown');
            expect(hrs(6, at(24, 10, { start_time: -5 })).reason).toBe('start-time-unknown');
        });
        test('a start_time at or after close_time has no anchor to measure from', () => {
            expect(hrs(6, at(24, 10, { start_time: START + 99 * HOUR })).reason).toBe('start-time-unknown');
            expect(hrs(6, at(24, 10, { start_time: START + 24 * HOUR })).reason).toBe('start-time-unknown');
        });
        test('a missing close_time still reports close-time-unknown first', () => {
            expect(hrs(6, at(24, 10, { close_time: undefined })).reason).toBe('close-time-unknown');
        });
        test('an already-closed candidate is refused before the offset is read', () => {
            expect(hrs(6, { ...at(24, 25) }).reason).toBe('already-closed');
        });
    });

    test('a start_time in the future gives negative elapsed — too-early, never a join', () => {
        // Deliberately no clamp at 0 on the elapsed side: -1h is below any
        // positive offset, so a clock skew defers instead of joining.
        expect(hrs(1, { ...at(24, 12), nowSec: START - HOUR }).reason).toBe('too-early');
    });

    /**
     * An offset at or beyond the challenge's own length clamps to the latest
     * reachable point — 99% of the run, the same ceiling as percent mode — so
     * a large value degrades to "as late as possible", never to "never join".
     */
    test('an offset at or beyond the challenge length joins at 99% elapsed', () => {
        // 100h on a 24h challenge clamps to 23.76h: still short at 23.5h.
        expect(hrs(100, at(24, 23.5)).reason).toBe('too-early');
        expect(hrs(100, at(24, 23.8))).toMatchObject({ join: true, reason: 'free' });
        // 72h on a 2h flash: too-early through most of the run, joins inside
        // the last percent, and is already-closed once the close has passed.
        expect(hrs(72, at(2, 1.5)).reason).toBe('too-early');
        expect(hrs(72, at(2, 1.99))).toMatchObject({ join: true, reason: 'free' });
        expect(hrs(72, { ...at(2, 2.5) }).reason).toBe('already-closed');
    });
});

/**
 * The fixed order across the three timing keys (resolveJoinWindow): the FIRST
 * above 0 applies — after-start → percent → before-end — so a lower window
 * never narrows the winner and the effective timing stays readable off one
 * number. Each test sets the losing values above 0 too and picks windows that
 * disagree, so the verdict names the winner.
 */
describe('join window (fixed order: after-start → percent → hours)', () => {
    const HOUR = 3600;
    const START = 1_700_000_000;
    // A 24h challenge observed `elapsedH` hours after it opened.
    const at = (elapsedH: number) => ({
        challenge: {
            id: 9,
            type: 'default',
            join_coins: 0,
            start_time: START,
            close_time: START + 24 * HOUR,
        },
        nowSec: START + elapsedH * HOUR,
    });

    test('after-start beats percent and hours-before-end when all three are set', () => {
        // 10h elapsed: after-start 20h defers, while percent 10% and a
        // 48h-of-end window (the whole life of a 24h challenge) would both join.
        expect(
            call({
                ...at(10),
                joinAfterSecFromStart: 20 * HOUR,
                joinAfterPercentElapsed: 10,
                joinWithinSec: 48 * HOUR,
            }).reason,
        ).toBe('too-early');
    });

    test('after-start beats hours-before-end when percent is off', () => {
        expect(call({ ...at(10), joinAfterSecFromStart: 20 * HOUR, joinWithinSec: 48 * HOUR }).reason).toBe(
            'too-early',
        );
    });

    test('percent beats hours-before-end when after-start is off', () => {
        // 1h elapsed: percent 10% defers, while the 48h-of-end window would join.
        expect(call({ ...at(1), joinAfterPercentElapsed: 10, joinWithinSec: 48 * HOUR }).reason).toBe('too-early');
    });

    test('a non-finite after-start is off, and percent applies in its place', () => {
        expect(call({ ...at(10), joinAfterSecFromStart: NaN, joinAfterPercentElapsed: 90 }).reason).toBe('too-early');
        // With percent off too, all windows are off and the candidate joins.
        expect(call({ ...at(10), joinAfterSecFromStart: NaN, joinAfterPercentElapsed: 0 }).join).toBe(true);
    });
});

/**
 * `joinAfterStartClamped` — the boolean the join pass logs its clamp note from:
 * true when the clamp reduced the offset, false when it left the value alone
 * (or the after-start gate would refuse before consulting it at all).
 */
describe('joinAfterStartClamped', () => {
    const HOUR = 3600;
    const START = 1_700_000_000;
    const open24 = { start_time: START, close_time: START + 24 * HOUR };
    const clamped = (challenge: { start_time?: number; close_time?: number }, nowSec: number, value: number) =>
        joinAfterStartClamped(challenge, nowSec, value);

    test('false when the value is not above 0 (off, or lifted for an early join)', () => {
        expect(clamped(open24, START + HOUR, 0)).toBe(false);
        expect(clamped(open24, START + HOUR, -5)).toBe(false);
        expect(clamped(open24, START + HOUR, NaN)).toBe(false);
    });

    test('false when the close_time, the clock or the start_time cannot be read', () => {
        expect(clamped({ start_time: START }, START + HOUR, 100 * HOUR)).toBe(false);
        expect(clamped({ ...open24, close_time: 0 }, START + HOUR, 100 * HOUR)).toBe(false);
        expect(clamped(open24, 0, 100 * HOUR)).toBe(false);
        expect(clamped({ close_time: START + 24 * HOUR }, START + HOUR, 100 * HOUR)).toBe(false);
        expect(clamped(invalid({ start_time: 'soon', close_time: START + 24 * HOUR }), START + HOUR, 100 * HOUR)).toBe(
            false,
        );
        expect(clamped({ start_time: -5, close_time: START + 24 * HOUR }, START + HOUR, 100 * HOUR)).toBe(false);
    });

    test('false when the candidate is already closed or start sits at/after close', () => {
        expect(clamped(open24, START + 25 * HOUR, 100 * HOUR)).toBe(false);
        expect(
            clamped({ start_time: START + 24 * HOUR, close_time: START + 24 * HOUR }, START + HOUR, 100 * HOUR),
        ).toBe(false);
    });

    test('false when the clamp leaves the value alone', () => {
        // 6h offset on a 24h challenge: under the ceiling, nothing reduced.
        expect(clamped(open24, START + HOUR, 6 * HOUR)).toBe(false);
    });

    test('true when the clamp reduced the value', () => {
        // A 100h offset on a 24h challenge (or 72h on a 2h flash) degrades to
        // 99% of the run — the gate joins only inside that last percent.
        expect(clamped(open24, START + HOUR, 100 * HOUR)).toBe(true);
        expect(clamped({ start_time: START, close_time: START + 2 * HOUR }, START, 72 * HOUR)).toBe(true);
    });
});
