/**
 * Tests for services/currencyAuto.ts — the automatic key / swap / fill runners
 * the voting pass calls. The spend services are mocked (their own live re-check
 * is covered in currencyActions.test.js); the spend lock is the real one, so the
 * "another spend in flight" deferral is exercised for real.
 */

jest.mock('../../src/js/settings');
jest.mock('../../src/js/services/currencyActions', () => ({
    __esModule: true,
    ...jest.requireActual('../../src/js/services/currencyActions'),
    unlockBoostWithKey: jest.fn(),
    previewSwap: jest.fn(),
    swapEntry: jest.fn(),
    fillExposure: jest.fn(),
}));

import settingsModule = require('../../src/js/settings');
const settings = jest.mocked(settingsModule);
import currencyActionsModule = require('../../src/js/services/currencyActions');
const currencyActions = jest.mocked(currencyActionsModule);
import type * as currencyAutoModule from '../../src/js/services/currencyAuto';
import type * as currencyAutoStoreModule from '../../src/js/currencyAutoStore';
import type { CurrencyPassDeps } from '../../src/js/services/currencyAuto';
import type {
    Challenge,
    MemberBoost,
    MemberRanking,
    RankingEntry,
    RankingExposure,
} from '../../src/js/types/gurushots';
import { invalid } from '../helpers/invalid';
const {
    runAutoKey,
    runAutoSwap,
    runAutoExposureFill,
    runMissionFill,
}: typeof currencyAutoModule = require('../../src/js/services/currencyAuto');
const { createMemoryAutoSpendLedger }: typeof currencyAutoStoreModule = require('../../src/js/currencyAutoStore');

const NOW = 1_000_000;
const H = 3600;
const OK = { ok: true, outcome: 'ok' };

let values: Record<string, unknown>;
const set = (overrides: Record<string, unknown>) => Object.assign(values, overrides);

// A partial challenge (no entries/players counts): the runners never read those.
type FixtureChallenge = Challenge & {
    member: { boost: MemberBoost; ranking: MemberRanking & { exposure: RankingExposure; entries: RankingEntry[] } };
};
const makeChallenge = (overrides: object = {}) =>
    invalid<FixtureChallenge>({
        id: 555,
        title: 'Anything Goes',
        start_time: NOW - 12 * H,
        close_time: NOW + 12 * H,
        boost_enable: true,
        swap_enable: true,
        swap_locked: false,
        fill_enable: true,
        fill_locked: false,
        member: {
            boost: { state: 'LOCKED', timeout: null },
            ranking: {
                exposure: { exposure_factor: 20 },
                entries: [
                    { id: 'e1', member_id: 'm', votes: 50 },
                    { id: 'e2', member_id: 'm', votes: 5 },
                ],
                swaps: [],
            },
        },
        ...overrides,
    });

type FixtureCtx = Parameters<typeof runAutoKey>[0] & {
    challenge: FixtureChallenge;
    currency: CurrencyPassDeps & {
        strategy: { getBankroll: jest.Mock; getVoteImages: jest.Mock };
        spendLedger: ReturnType<typeof createMemoryAutoSpendLedger>;
    };
};
// The currency block is a partial double: only the endpoints the runners call.
const makeCtx = ({
    challenge = makeChallenge(),
    bankroll = { keys: 3, swaps: 3, fills: 3 },
    pool = null,
}: { challenge?: FixtureChallenge; bankroll?: Record<string, number> | null; pool?: unknown } = {}) =>
    invalid<FixtureCtx>({
        challenge,
        token: 'tok',
        now: NOW,
        currency: {
            strategy: {
                getBankroll: jest.fn().mockResolvedValue(bankroll),
                getVoteImages: jest.fn().mockResolvedValue(pool),
            },
            swapLedger: { onSwapped: jest.fn() },
            spendLedger: createMemoryAutoSpendLedger(),
        },
    });

beforeEach(() => {
    jest.clearAllMocks();
    values = {
        autoKeyUnlock: true,
        autoKeyAfterStart: 0,
        autoKeyBeforeEnd: 0,
        autoKeyAfterPercent: 0,
        autoSwap: true,
        autoSwapAfterStart: 0,
        autoSwapBeforeEnd: 0,
        autoSwapAfterPercent: 0,
        autoSwapImageIndex: 0,
        autoSwapLowestVotes: false,
        autoSwapAllowBoosted: false,
        autoSwapMaxVotes: 0,
        autoSwapMax: 1,
        autoExposureFill: true,
        autoExposureFillBelow: 50,
        autoExposureFillAfterStart: 0,
        autoExposureFillBeforeEnd: 0,
        autoExposureFillAfterPercent: 0,
        autoExposureFillMax: 1,
        currencyReserveKeys: 0,
        currencyReserveSwaps: 0,
        currencyReserveFills: 0,
    };
    settings.getEffectiveSetting = invalid(jest.fn((key: string) => values[key]));
    currencyActions.unlockBoostWithKey.mockResolvedValue(OK);
    currencyActions.previewSwap.mockResolvedValue({ ...OK, candidate: { id: 'new1', member_id: 'm' } });
    currencyActions.swapEntry.mockResolvedValue(OK);
    currencyActions.fillExposure.mockResolvedValue(OK);
});

describe('shared gates', () => {
    test.each([
        ['key', runAutoKey, 'autoKeyUnlock', 'unlockBoostWithKey'],
        ['swap', runAutoSwap, 'autoSwap', 'swapEntry'],
        ['fill', runAutoExposureFill, 'autoExposureFill', 'fillExposure'],
    ] as const)('%s: off unless explicitly enabled', async (_, run, enableKey, spendFn) => {
        set({ [enableKey]: false });
        expect(await run(makeCtx(), null)).toBe(false);
        expect(currencyActions[spendFn]).not.toHaveBeenCalled();
    });

    test.each([
        ['key', runAutoKey, 'unlockBoostWithKey'],
        ['swap', runAutoSwap, 'swapEntry'],
        ['fill', runAutoExposureFill, 'fillExposure'],
    ] as const)('%s: inert without currency deps', async (_, run, spendFn) => {
        expect(await run({ ...makeCtx(), currency: null }, null)).toBe(false);
        expect(currencyActions[spendFn]).not.toHaveBeenCalled();
    });

    test.each([
        ['key', runAutoKey, { boost_enable: false }],
        ['swap', runAutoSwap, { swap_locked: true }],
        ['fill', runAutoExposureFill, { fill_enable: false }],
    ])('%s: nothing when the challenge does not offer the action', async (_, run, overrides) => {
        expect(await run(makeCtx({ challenge: makeChallenge(overrides) }), null)).toBe(false);
    });

    test.each([
        ['key', runAutoKey, 'autoKeyAfterStart'],
        ['swap', runAutoSwap, 'autoSwapBeforeEnd'],
        ['fill', runAutoExposureFill, 'autoExposureFillAfterPercent'],
    ])('%s: waits for its timing rule', async (_, run, timingKey) => {
        // 13h after start / within 11h of end / after 60% — all still in the future.
        set({ [timingKey]: timingKey.endsWith('Percent') ? 60 : timingKey.endsWith('End') ? 11 * H : 13 * H });
        expect(await run(makeCtx(), null)).toBe(false);
    });

    test.each([
        ['key', runAutoKey, 'currencyReserveKeys', 'keys'],
        ['swap', runAutoSwap, 'currencyReserveSwaps', 'swaps'],
        ['fill', runAutoExposureFill, 'currencyReserveFills', 'fills'],
    ])('%s: never spends below the global reserve', async (_, run, reserveKey, field) => {
        set({ [reserveKey]: 3 });
        expect(await run(makeCtx({ bankroll: { [field]: 3 } }), null)).toBe(false);
        set({ [reserveKey]: 2 });
        expect(await run(makeCtx({ bankroll: { [field]: 3 } }), null)).toBe(true);
    });

    test('an unreadable balance refuses', async () => {
        expect(await runAutoKey(makeCtx({ bankroll: null }))).toBe(false);
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
    });

    test('a corrupt reserve counts as none', async () => {
        set({ currencyReserveKeys: 'x' });
        expect(await runAutoKey(makeCtx({ bankroll: { keys: 1 } }))).toBe(true);
    });

    test('another spend in flight defers the action', async () => {
        let release;
        const held = currencyActions.withSpendLock(() => new Promise((resolve) => (release = resolve)));
        expect(await runAutoKey(makeCtx())).toBe(false);
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
        release!();
        await held;
    });

    test('a throw is logged and swallowed', async () => {
        const ctx = makeCtx();
        ctx.currency.strategy.getBankroll.mockRejectedValue(new Error('boom'));
        expect(await runAutoKey(ctx)).toBe(false);
        ctx.currency.strategy.getBankroll.mockRejectedValue('plain');
        expect(await runAutoKey(ctx)).toBe(false);
        expect(await runAutoKey(invalid(undefined))).toBe(false);
    });
});

describe('runAutoKey', () => {
    test('unlocks and makes the boost available to the rest of the pass', async () => {
        const ctx = makeCtx();
        expect(await runAutoKey(ctx)).toBe(true);
        expect(currencyActions.unlockBoostWithKey).toHaveBeenCalledWith(555, 'tok', expect.any(Object));
        expect(ctx.challenge.member.boost.state).toBe('AVAILABLE_KEY');
    });

    test('a refused unlock leaves the boost untouched', async () => {
        currencyActions.unlockBoostWithKey.mockResolvedValue({ ok: false, outcome: 'api-failed' });
        const ctx = makeCtx();
        expect(await runAutoKey(ctx)).toBe(false);
        expect(ctx.challenge.member.boost.state).toBe('LOCKED');
    });

    test('opens 11h into the challenge', async () => {
        set({ autoKeyAfterStart: 11 * H });
        expect(await runAutoKey(makeCtx())).toBe(true);
    });
});

describe('runAutoSwap', () => {
    test('replaces the last entry by default and records it in the pass', async () => {
        const ctx = makeCtx();
        expect(await runAutoSwap(ctx)).toBe(true);
        // Auto swap always brings in a fresh photo — never one swapped out before.
        expect(currencyActions.previewSwap).toHaveBeenCalledWith(555, 'e2', 'tok', expect.any(Object), {
            excludeSwapped: true,
        });
        expect(currencyActions.swapEntry).toHaveBeenCalledWith(
            555,
            'e2',
            'new1',
            'tok',
            expect.objectContaining({ ledger: ctx.currency.swapLedger }),
        );
        const ranking = ctx.challenge.member.ranking;
        expect(ranking.entries.map((e) => e.id)).toEqual(['e1', 'new1']);
        expect(ranking.swaps).toEqual([{ id: 'e2' }]);
    });

    test('a missing swap ledger and swap history are tolerated', async () => {
        const ctx = makeCtx();
        ctx.currency.swapLedger = undefined;
        delete ctx.challenge.member.ranking.swaps;
        expect(await runAutoSwap(ctx)).toBe(true);
        expect(currencyActions.swapEntry.mock.calls[0][4].ledger).toBeNull();
        expect(ctx.challenge.member.ranking.swaps).toEqual([{ id: 'e2' }]);
    });

    test('stops at the per-challenge swap cap (manual swaps count)', async () => {
        const challenge = makeChallenge();
        challenge.member.ranking.swaps = [{ id: 'old' }];
        expect(await runAutoSwap(makeCtx({ challenge }))).toBe(false);
        set({ autoSwapMax: 2 });
        expect(await runAutoSwap(makeCtx({ challenge }))).toBe(true);
    });

    test('follows the slot / lowest-votes / vote-ceiling options', async () => {
        set({ autoSwapImageIndex: 1 });
        await runAutoSwap(makeCtx());
        expect(currencyActions.previewSwap.mock.calls[0][1]).toBe('e1');

        set({ autoSwapImageIndex: 1, autoSwapLowestVotes: true });
        await runAutoSwap(makeCtx());
        expect(currencyActions.previewSwap.mock.calls[1][1]).toBe('e2');

        set({ autoSwapLowestVotes: false, autoSwapMaxVotes: 10 });
        expect(await runAutoSwap(makeCtx())).toBe(false);
        expect(currencyActions.previewSwap).toHaveBeenCalledTimes(2);
    });

    test('never swaps a boosted/turbo entry unless allowed', async () => {
        const challenge = makeChallenge();
        challenge.member.ranking.entries = [{ id: 'b', votes: 1, boosted: true }];
        expect(await runAutoSwap(makeCtx({ challenge }))).toBe(false);
        set({ autoSwapAllowBoosted: true });
        expect(await runAutoSwap(makeCtx({ challenge }))).toBe(true);
    });

    test('nothing when the challenge has no entries', async () => {
        const challenge = makeChallenge();
        challenge.member.ranking.entries = invalid(undefined);
        expect(await runAutoSwap(makeCtx({ challenge }))).toBe(false);
    });

    test('a failed preview or swap spends nothing and changes nothing', async () => {
        currencyActions.previewSwap.mockResolvedValueOnce({ ok: false, outcome: 'no-alternative' });
        const ctx = makeCtx();
        expect(await runAutoSwap(ctx)).toBe(false);
        expect(currencyActions.swapEntry).not.toHaveBeenCalled();

        currencyActions.swapEntry.mockResolvedValueOnce({ ok: false, outcome: 'api-failed' });
        expect(await runAutoSwap(ctx)).toBe(false);
        expect(ctx.challenge.member.ranking.entries.map((e) => e.id)).toEqual(['e1', 'e2']);
    });
});

describe('runAutoExposureFill', () => {
    const pool = (start: number, ratios: number[]) =>
        invalid<Parameters<typeof runAutoExposureFill>[1]>({
            voting: { exposure: { exposure_factor: start } },
            images: ratios.map((ratio, i) => ({ id: i, ratio })),
        });

    test('fills when exposure is low and the pool this pass voted from was empty', async () => {
        const ctx = makeCtx();
        expect(await runAutoExposureFill(ctx, null)).toBe(true);
        expect(currencyActions.fillExposure).toHaveBeenCalledWith(555, 'tok', expect.any(Object));
        expect(ctx.challenge.member.ranking.exposure.exposure_factor).toBe(100);
        expect(ctx.currency.spendLedger.fills('555')).toBe(1);
        expect(ctx.currency.strategy.getVoteImages).not.toHaveBeenCalled();
    });

    test('fills when the pool falls short of the threshold', async () => {
        expect(await runAutoExposureFill(makeCtx(), pool(20, [5, 5]))).toBe(true);
    });

    test('no fill when voting can reach the threshold — a fill is worth what a vote is', async () => {
        expect(await runAutoExposureFill(makeCtx(), pool(20, [20, 20]))).toBe(false);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('fetches the pool itself when voting did not run this pass', async () => {
        const ctx = makeCtx({ pool: pool(20, [40]) });
        expect(await runAutoExposureFill(ctx, undefined)).toBe(false);
        expect(ctx.currency.strategy.getVoteImages).toHaveBeenCalledWith(ctx.challenge, 'tok');
    });

    test('no fill while exposure is at or above the threshold', async () => {
        set({ autoExposureFillBelow: 20 });
        expect(await runAutoExposureFill(makeCtx(), null)).toBe(false);
    });

    test('stops at the per-challenge automatic fill cap', async () => {
        const ctx = makeCtx();
        ctx.currency.spendLedger.addFill('555');
        expect(await runAutoExposureFill(ctx, null)).toBe(false);
        set({ autoExposureFillMax: 2 });
        expect(await runAutoExposureFill(ctx, null)).toBe(true);
    });

    test('inert without the spend ledger', async () => {
        const ctx = makeCtx();
        (ctx.currency as CurrencyPassDeps).spendLedger = null;
        expect(await runAutoExposureFill(ctx, null)).toBe(false);
    });

    test('a refused fill is not counted', async () => {
        currencyActions.fillExposure.mockResolvedValue({ ok: false, outcome: 'api-failed' });
        const ctx = makeCtx();
        expect(await runAutoExposureFill(ctx, null)).toBe(false);
        expect(ctx.currency.spendLedger.fills('555')).toBe(0);
    });
});

describe('runMissionFill', () => {
    test('fills toward the mission regardless of the exposure rule, without touching its cap', async () => {
        set({ autoExposureFill: false, autoExposureFillBelow: 0 });
        const ctx = makeCtx({
            challenge: makeChallenge({ member: { ranking: { exposure: { exposure_factor: 95 } } } }),
        });
        expect(await runMissionFill(ctx, 2)).toBe(true);
        expect(currencyActions.fillExposure).toHaveBeenCalledWith(555, 'tok', expect.any(Object));
        expect(ctx.challenge.member.ranking.exposure.exposure_factor).toBe(100);
        expect(ctx.currency.spendLedger.fills('555')).toBe(0);
    });

    test('nothing to do without a mission need or currency endpoints', async () => {
        expect(await runMissionFill(makeCtx(), 0)).toBe(false);
        const ctx = makeCtx();
        (ctx as Parameters<typeof runMissionFill>[0]).currency = null;
        expect(await runMissionFill(ctx, 1)).toBe(false);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('skips a challenge that cannot take a fill (full exposure, fill locked)', async () => {
        const full = makeChallenge({ member: { ranking: { exposure: { exposure_factor: 100 } } } });
        expect(await runMissionFill(makeCtx({ challenge: full }), 1)).toBe(false);
        expect(await runMissionFill(makeCtx({ challenge: makeChallenge({ fill_locked: true }) }), 1)).toBe(false);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('keeps the fill reserve', async () => {
        set({ currencyReserveFills: 3 });
        expect(await runMissionFill(makeCtx(), 1)).toBe(false);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('a refused fill leaves the challenge as it was', async () => {
        currencyActions.fillExposure.mockResolvedValue({ ok: false, outcome: 'api-failed' });
        const ctx = makeCtx();
        expect(await runMissionFill(ctx, 1)).toBe(false);
        expect(ctx.challenge.member.ranking.exposure.exposure_factor).toBe(20);
    });
});
