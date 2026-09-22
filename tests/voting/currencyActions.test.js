/**
 * Tests for voting/currencyActions.js — the availability predicates shared by
 * the renderer, the IPC re-check and future automation.
 */

const {
    CURRENCY_OUTCOME,
    isRunning,
    canKeyUnlock,
    canSwapEntry,
    canFillExposure,
    swapExcludedIds,
    blockedOutcome,
} = require('../../src/js/voting/currencyActions');

const NOW = 1_790_100_000;
const FULL = { keys: 3, swaps: 3, fills: 3, coins: 0 };

const makeChallenge = (overrides = {}) => ({
    id: 1,
    start_time: NOW - 3600,
    close_time: NOW + 3600,
    boost_enable: true,
    swap_enable: true,
    swap_locked: false,
    fill_enable: true,
    fill_locked: false,
    member: {
        boost: { state: 'LOCKED', timeout: null },
        ranking: {
            exposure: { exposure_factor: 60 },
            entries: [{ id: 'e1' }, { id: 'e2' }],
            swaps: [{ id: 's1' }],
        },
    },
    ...overrides,
});

describe('isRunning', () => {
    test('open between start and close', () => {
        expect(isRunning(makeChallenge(), NOW)).toBe(true);
    });

    test('closed at exactly close_time', () => {
        expect(isRunning(makeChallenge({ close_time: NOW }), NOW)).toBe(false);
    });

    test('not yet started', () => {
        expect(isRunning(makeChallenge({ start_time: NOW + 1 }), NOW)).toBe(false);
    });

    test('missing times → false', () => {
        expect(isRunning({}, NOW)).toBe(false);
    });
});

describe('canKeyUnlock', () => {
    test('true for a LOCKED boost with keys', () => {
        expect(canKeyUnlock(makeChallenge(), FULL, NOW)).toBe(true);
    });

    test.each([
        ['already unlocked', { member: { boost: { state: 'AVAILABLE_KEY' }, ranking: {} } }],
        ['boost disabled', { boost_enable: false }],
        ['closed', { close_time: NOW - 1 }],
    ])('false when %s', (_, overrides) => {
        expect(canKeyUnlock(makeChallenge(overrides), FULL, NOW)).toBe(false);
    });

    test('false with zero keys or an unreadable bankroll', () => {
        expect(canKeyUnlock(makeChallenge(), { ...FULL, keys: 0 }, NOW)).toBe(false);
        expect(canKeyUnlock(makeChallenge(), null, NOW)).toBe(false);
    });
});

describe('canSwapEntry', () => {
    test('true when enabled, unlocked and swaps held', () => {
        expect(canSwapEntry(makeChallenge(), FULL, NOW)).toBe(true);
    });

    test('false when locked, disabled or out of swaps', () => {
        expect(canSwapEntry(makeChallenge({ swap_locked: true }), FULL, NOW)).toBe(false);
        expect(canSwapEntry(makeChallenge({ swap_enable: false }), FULL, NOW)).toBe(false);
        expect(canSwapEntry(makeChallenge(), { ...FULL, swaps: 0 }, NOW)).toBe(false);
    });
});

describe('canFillExposure', () => {
    test('true below 100% exposure', () => {
        expect(canFillExposure(makeChallenge(), FULL, NOW)).toBe(true);
    });

    test('false at 100% exposure', () => {
        const c = makeChallenge();
        c.member.ranking.exposure.exposure_factor = 100;
        expect(canFillExposure(c, FULL, NOW)).toBe(false);
    });

    test('false when fill is locked or no fills held', () => {
        expect(canFillExposure(makeChallenge({ fill_locked: true }), FULL, NOW)).toBe(false);
        expect(canFillExposure(makeChallenge(), { ...FULL, fills: 0 }, NOW)).toBe(false);
    });
});

describe('malformed payloads never throw', () => {
    test.each([null, undefined, {}, { member: null }, { member: { ranking: null } }])('%p', (challenge) => {
        expect(() => canKeyUnlock(challenge, FULL, NOW)).not.toThrow();
        expect(canKeyUnlock(challenge, FULL, NOW)).toBe(false);
        expect(canSwapEntry(challenge, FULL, NOW)).toBe(false);
        expect(canFillExposure(challenge, FULL, NOW)).toBe(false);
        expect(swapExcludedIds(challenge).size).toBe(0);
    });
});

describe('swapExcludedIds', () => {
    test('union of current entries and previously swapped-out photos, as strings', () => {
        const c = makeChallenge();
        c.member.ranking.entries.push({ id: 42 });
        expect([...swapExcludedIds(c)].sort()).toEqual(['42', 'e1', 'e2', 's1']);
    });
});

describe('blockedOutcome', () => {
    test('null when allowed', () => {
        expect(blockedOutcome('fill', makeChallenge(), FULL, NOW)).toBeNull();
    });

    test('unreadable bankroll → balanceUnknown', () => {
        expect(blockedOutcome('key', makeChallenge(), null, NOW)).toBe(CURRENCY_OUTCOME.balanceUnknown);
    });

    test('empty balance → noBalance (even if the challenge also forbids it)', () => {
        expect(blockedOutcome('swap', makeChallenge({ swap_locked: true }), { ...FULL, swaps: 0 }, NOW)).toBe(
            CURRENCY_OUTCOME.noBalance,
        );
    });

    test('state already changed → notAvailable', () => {
        const c = makeChallenge({ member: { boost: { state: 'AVAILABLE_KEY' }, ranking: {} } });
        expect(blockedOutcome('key', c, FULL, NOW)).toBe(CURRENCY_OUTCOME.notAvailable);
    });
});
