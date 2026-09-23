/**
 * The currency-automation wake-up cap: the scheduler must not sleep past the
 * moment an automatic key / swap / fill rule opens (e.g. "11h after start").
 * Covers soonestCurrencyRuleStart directly and its wiring into
 * computeNextCycleDelayMs (mode 'currency-rule').
 */

const { soonestCurrencyRuleStart, computeNextCycleDelayMs } = require('../../src/js/scheduling/thresholdWindow');

const NOW = 1_000_000;
const H = 3600;

const makeChallenge = (overrides = {}) => ({
    id: 7,
    title: 'Flash Me',
    type: 'flash',
    start_time: NOW - H,
    close_time: NOW + 23 * H,
    boost_enable: true,
    swap_enable: true,
    fill_enable: true,
    member: { boost: { state: 'LOCKED' } },
    ...overrides,
});

const only = (action, timing) => () => ({ key: null, swap: null, fill: null, [action]: timing });

describe('soonestCurrencyRuleStart', () => {
    test('finds an upcoming rule opening, flash challenges included', async () => {
        const result = await soonestCurrencyRuleStart([makeChallenge()], NOW, only('key', { afterStartSec: 11 * H }));
        expect(result).toEqual({ challengeId: 7, challengeTitle: 'Flash Me', startTime: NOW + 10 * H, action: 'key' });
    });

    test('picks the soonest across actions and challenges', async () => {
        const resolve = (id) => ({
            key: { afterStartSec: 11 * H },
            swap: id === '8' ? { beforeEndSec: 20 * H } : null,
            fill: null,
        });
        const result = await soonestCurrencyRuleStart(
            [makeChallenge(), makeChallenge({ id: 8, title: '' })],
            NOW,
            resolve,
        );
        expect(result).toMatchObject({ challengeId: 8, challengeTitle: 'challenge 8', action: 'swap' });
        expect(result.startTime).toBe(NOW + 3 * H);
    });

    test('ignores rules already open, never opening before close, or undecidable', async () => {
        const c = makeChallenge();
        expect(await soonestCurrencyRuleStart([c], NOW, only('fill', {}))).toBeNull();
        expect(await soonestCurrencyRuleStart([c], NOW, only('fill', { afterStartSec: 30 * H }))).toBeNull();
        expect(
            await soonestCurrencyRuleStart(
                [makeChallenge({ start_time: undefined })],
                NOW,
                only('fill', { afterStartSec: H * 2 }),
            ),
        ).toBeNull();
    });

    test.each([
        ['key', { boost_enable: false }],
        ['key', { member: { boost: { state: 'USED' } } }],
        ['swap', { swap_enable: false }],
        ['swap', { swap_locked: true }],
        ['fill', { fill_enable: false }],
        ['fill', { fill_locked: true }],
    ])('never wakes for a %s the challenge does not offer (%o)', async (action, overrides) => {
        const result = await soonestCurrencyRuleStart(
            [makeChallenge(overrides)],
            NOW,
            only(action, { afterStartSec: 2 * H }),
        );
        expect(result).toBeNull();
    });

    test('skips closed challenges, a throwing resolver, and a non-array list', async () => {
        const closed = makeChallenge({ close_time: NOW - 1 });
        expect(await soonestCurrencyRuleStart([closed], NOW, only('key', { afterStartSec: 2 * H }))).toBeNull();
        const boom = () => {
            throw new Error('boom');
        };
        expect(await soonestCurrencyRuleStart([makeChallenge()], NOW, boom)).toBeNull();
        expect(await soonestCurrencyRuleStart(null, NOW, boom)).toBeNull();
    });
});

describe('computeNextCycleDelayMs with a currency rule', () => {
    const base = {
        resolveThreshold: () => 0,
        normalDelayMs: 30 * 60_000,
        lastMinuteCheckMinutes: 1,
        minGapMs: 5_000,
    };

    test('caps the delay to an upcoming rule opening', async () => {
        const result = await computeNextCycleDelayMs([makeChallenge({ type: 'default' })], NOW, {
            ...base,
            resolveCurrencyAuto: only('key', { afterStartSec: H + 600 }),
        });
        expect(result.mode).toBe('currency-rule');
        expect(result.delayMs).toBe(600_000);
        expect(result.nextCurrencyRule).toMatchObject({ action: 'key', challengeId: 7 });
    });

    test('a far-off rule leaves the normal delay alone', async () => {
        const result = await computeNextCycleDelayMs([makeChallenge({ type: 'default' })], NOW, {
            ...base,
            resolveCurrencyAuto: only('key', { afterStartSec: 5 * H }),
        });
        expect(result.mode).toBe('normal');
        expect(result.nextCurrencyRule).toMatchObject({ action: 'key' });
    });

    test('no resolver → no cap and no rule reported', async () => {
        const result = await computeNextCycleDelayMs([makeChallenge({ type: 'default' })], NOW, base);
        expect(result.nextCurrencyRule).toBeNull();
    });
});
