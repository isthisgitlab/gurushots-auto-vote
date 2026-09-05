/**
 * Non-default finalWindowDuration coverage for the two seams that consume it:
 *
 *   1. VotingLogic.isWithinFinalWindow(closeTime, now, windowSec) — the pure
 *      membership check the final-window exposure rule keys off. The existing
 *      tests/api/final-window-exposure.test.js reimplements this inline with a
 *      hardcoded 3600, so it can never catch a regression in the real function's
 *      windowSec handling. These call the REAL export at a non-default width.
 *   2. schema.finalWindowDuration bounds — the 'time' setting is an integer in
 *      [60, MAX_SCHEDULE_SECONDS]; sub-60, over-cap, non-integer and non-finite
 *      values must be rejected, and the schema default is the legacy fixed hour.
 */

const { isWithinFinalWindow } = require('../../src/js/services/VotingLogic');
const { validateSetting, getSchemaDefault, SETTINGS_SCHEMA } = require('../../src/js/settings/schema');

describe('isWithinFinalWindow with a non-default windowSec', () => {
    const now = 1_000_000;

    test('a half-hour window (1800s) excludes a challenge 45 min out but includes one 20 min out', () => {
        // 45 min (2700s) to close is outside a 1800s window; 20 min (1200s) is inside.
        expect(isWithinFinalWindow(now + 2700, now, 1800)).toBe(false);
        expect(isWithinFinalWindow(now + 1200, now, 1800)).toBe(true);
    });

    test('is inclusive at the exact window edge (timeUntilEnd === windowSec)', () => {
        expect(isWithinFinalWindow(now + 1800, now, 1800)).toBe(true);
    });

    test('excludes a challenge one second past the edge', () => {
        expect(isWithinFinalWindow(now + 1801, now, 1800)).toBe(false);
    });

    test('excludes an already-closed challenge (timeUntilEnd <= 0) at any width', () => {
        expect(isWithinFinalWindow(now, now, 1800)).toBe(false); // exactly at close
        expect(isWithinFinalWindow(now - 5, now, 1800)).toBe(false); // past close
    });

    test('a wide window (7200s) reaches a challenge the legacy 3600 default would miss', () => {
        const closeIn90Min = now + 5400; // 90 min out
        expect(isWithinFinalWindow(closeIn90Min, now)).toBe(false); // default 3600 → outside
        expect(isWithinFinalWindow(closeIn90Min, now, 7200)).toBe(true); // 2h window → inside
    });
});

describe('schema finalWindowDuration bounds', () => {
    const MAX = SETTINGS_SCHEMA.finalWindowDuration.max;

    test('defaults to the legacy fixed hour (3600s)', () => {
        expect(getSchemaDefault('finalWindowDuration')).toBe(3600);
    });

    test('accepts the 60s floor, the schema default, and the max ceiling', () => {
        expect(validateSetting('finalWindowDuration', 60)).toBe(true);
        expect(validateSetting('finalWindowDuration', 3600)).toBe(true);
        expect(validateSetting('finalWindowDuration', MAX)).toBe(true);
    });

    test('rejects a sub-60 window (meaningless against poll cadence)', () => {
        expect(validateSetting('finalWindowDuration', 59)).toBe(false);
        expect(validateSetting('finalWindowDuration', 0)).toBe(false);
    });

    test('rejects a value above the 30-day schedule ceiling', () => {
        expect(validateSetting('finalWindowDuration', MAX + 1)).toBe(false);
    });

    test('rejects non-integer, negative, and non-finite values', () => {
        expect(validateSetting('finalWindowDuration', 1800.5)).toBe(false);
        expect(validateSetting('finalWindowDuration', -3600)).toBe(false);
        expect(validateSetting('finalWindowDuration', Number.NaN)).toBe(false);
        expect(validateSetting('finalWindowDuration', 'hour')).toBe(false);
    });
});
