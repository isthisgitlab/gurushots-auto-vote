/**
 * Unit tests for isBoostWindowOpen — the renderer-side predicate that decides
 * whether a challenge's boost window is open right now. It mirrors the voting
 * engine's services/VotingLogic.isBoostWindowOpen but operates on the boost
 * object + an explicit `now` so it stays a pure util. The BoostWindowBanner and
 * the CLI status command both filter on this rule.
 */

const { isBoostWindowOpen } = require('../../src/js/react/utils/formatters');

describe('isBoostWindowOpen', () => {
    const now = 1_000_000;

    test('AVAILABLE_KEY is open regardless of any timeout', () => {
        expect(isBoostWindowOpen({ state: 'AVAILABLE_KEY' }, now)).toBe(true);
        expect(isBoostWindowOpen({ state: 'AVAILABLE_KEY', timeout: now - 100 }, now)).toBe(true);
    });

    test('AVAILABLE with a future timeout is open', () => {
        expect(isBoostWindowOpen({ state: 'AVAILABLE', timeout: now + 600 }, now)).toBe(true);
    });

    test('AVAILABLE with an expired (or exactly-now) timeout is closed', () => {
        expect(isBoostWindowOpen({ state: 'AVAILABLE', timeout: now - 1 }, now)).toBe(false);
        expect(isBoostWindowOpen({ state: 'AVAILABLE', timeout: now }, now)).toBe(false);
    });

    test('AVAILABLE with no positive timeout is treated as key-unlocked (open)', () => {
        expect(isBoostWindowOpen({ state: 'AVAILABLE' }, now)).toBe(true);
        expect(isBoostWindowOpen({ state: 'AVAILABLE', timeout: 0 }, now)).toBe(true);
        expect(isBoostWindowOpen({ state: 'AVAILABLE', timeout: null }, now)).toBe(true);
    });

    test('other / missing states are closed', () => {
        expect(isBoostWindowOpen({ state: 'USED' }, now)).toBe(false);
        expect(isBoostWindowOpen({ state: 'UNAVAILABLE' }, now)).toBe(false);
        expect(isBoostWindowOpen({ state: 'LOCKED' }, now)).toBe(false);
        expect(isBoostWindowOpen({}, now)).toBe(false);
        expect(isBoostWindowOpen(null, now)).toBe(false);
        expect(isBoostWindowOpen(undefined, now)).toBe(false);
    });
});
