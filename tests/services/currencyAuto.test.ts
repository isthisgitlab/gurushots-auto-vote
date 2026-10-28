/**
 * Tests for services/currencyAuto.ts — the automatic key / swap / fill runners
 * the voting pass calls. The spend services are mocked (their own live re-check
 * is covered in currencyActions.test.ts); the spend lock is the real one, so the
 * "another spend in flight" deferral is exercised for real.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/services/currencyActions', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/services/currencyActions')>(
        '../../src/ts/services/currencyActions',
    ),
    unlockBoostWithKey: jest.fn(),
    previewSwap: jest.fn(),
    swapEntry: jest.fn(),
    fillExposure: jest.fn(),
}));

import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import currencyActionsModule = require('../../src/ts/services/currencyActions');
const currencyActions = jest.mocked(currencyActionsModule);
import type * as loggerModule from '../../src/ts/logger';
import type * as currencyAutoModule from '../../src/ts/services/currencyAuto';
import type * as currencyAutoStoreModule from '../../src/ts/currencyAutoStore';
import type { CurrencyPassDeps } from '../../src/ts/services/currencyAuto';
import type { FillMission, MissionNeeds } from '../../src/ts/services/missions';
import type {
    Challenge,
    MemberBoost,
    MemberRanking,
    RankingEntry,
    RankingExposure,
} from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';
const { runAutoKey, runAutoSwap, runAutoExposureFill, runMissionFill } =
    require('../../src/ts/services/currencyAuto') as typeof currencyAutoModule;
const { createMemoryAutoSpendLedger, createAutoSpendLedger } =
    require('../../src/ts/currencyAutoStore') as typeof currencyAutoStoreModule;

const NOW = 1_000_000;
const H = 3600;
const OK = { ok: true, outcome: 'ok' };
// A readable, spent pool: the fill's shortfall check needs one to spend at all.
// The key and swap runners ignore it, so the shared-gates table passes one for all.
const spentPool = () =>
    invalid<Parameters<typeof runAutoExposureFill>[1]>({
        voting: { exposure: { exposure_factor: 0 } },
        images: [],
    });

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
        url: 'https://exampleshots.test/c/anything-goes',
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
    swapHistorySent: boolean;
    currency: CurrencyPassDeps & {
        strategy: {
            getBankroll: jest.MockedFunction<CurrencyPassDeps['strategy']['getBankroll']>;
            getVoteImages: jest.MockedFunction<CurrencyPassDeps['strategy']['getVoteImages']>;
            getActiveChallenges: jest.MockedFunction<CurrencyPassDeps['strategy']['getActiveChallenges']>;
            swapPhoto: jest.MockedFunction<CurrencyPassDeps['strategy']['swapPhoto']>;
        };
        spendLedger: ReturnType<typeof createMemoryAutoSpendLedger>;
    };
};
// The currency block is a partial double: only the endpoints the runners call.
// The fixture challenge carries a `swaps: []` history, so `swapHistorySent`
// defaults to true; a test that deletes or replaces it sets the flag itself.
const makeCtx = ({
    challenge = makeChallenge(),
    bankroll = { keys: 3, swaps: 3, fills: 3 },
    pool = null,
    swapHistorySent = true,
}: {
    challenge?: FixtureChallenge;
    bankroll?: Record<string, number> | null;
    pool?: unknown;
    swapHistorySent?: boolean;
} = {}) =>
    invalid<FixtureCtx>({
        challenge,
        token: 'tok',
        now: NOW,
        swapHistorySent,
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
    settings.getEntryPins.mockReturnValue({ boost: null, turbo: null });
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
        expect(await run(makeCtx({ bankroll: { [field]: 3 } }), spentPool())).toBe(false);
        set({ [reserveKey]: 2 });
        expect(await run(makeCtx({ bankroll: { [field]: 3 } }), spentPool())).toBe(true);
    });

    test('an unreadable balance refuses', async () => {
        expect(await runAutoKey(makeCtx({ bankroll: null }))).toBe(false);
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
    });

    test('another spend in flight defers the action', async () => {
        let release: ((value?: unknown) => void) | undefined;
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

    test('unlocks a MISSED free boost', async () => {
        const ctx = makeCtx({ challenge: makeChallenge({ member: { boost: { state: 'MISSED' } } }) });
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
            expect.objectContaining({ ledger: ctx.currency.swapLedger, maxSwaps: 1 }),
        );
        const ranking = ctx.challenge.member.ranking;
        expect(ranking.entries.map((e) => e.id)).toEqual(['e1', 'new1']);
        expect(ranking.swaps).toEqual([{ id: 'e2' }]);
    });

    test('does nothing while Manual Only is on, however auto-swap is set', async () => {
        set({ manualPhotosOnly: true });
        const ctx = makeCtx();
        expect(await runAutoSwap(ctx)).toBe(false);
        expect(currencyActions.previewSwap).not.toHaveBeenCalled();
        expect(currencyActions.swapEntry).not.toHaveBeenCalled();
        expect(ctx.challenge.member.ranking.entries.map((e) => e.id)).toEqual(['e1', 'e2']);
        // The switch is read per challenge, so turning it off brings the swap back.
        set({ manualPhotosOnly: false });
        expect(await runAutoSwap(makeCtx())).toBe(true);
    });

    test('a missing swap ledger and swap history are tolerated', async () => {
        const ctx = makeCtx({ swapHistorySent: false });
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

    test('never swaps out a photo pinned for a Boost or Turbo that can still fire, unless allowed', async () => {
        const challenge = makeChallenge();
        challenge.member.ranking.entries = [
            { id: 'e1', member_id: 'm', votes: 50 },
            { id: 'e2', member_id: 'm', votes: 5 },
        ];
        // The configured slot (the last entry) holds the pin, so the swap steps back to the first one.
        settings.getEntryPins.mockReturnValue({ boost: 'e2', turbo: null });
        expect(await runAutoSwap(makeCtx({ challenge }))).toBe(true);
        expect(currencyActions.previewSwap).toHaveBeenCalledWith(
            555,
            'e1',
            'tok',
            expect.anything(),
            expect.anything(),
        );

        // Both entries protected (one pinned, one turbo'd): nothing qualifies.
        jest.clearAllMocks();
        const protectedOnly = makeChallenge();
        protectedOnly.member.ranking.entries = [
            { id: 'e1', member_id: 'm', votes: 50, turbo: true },
            { id: 'e2', member_id: 'm', votes: 5 },
        ];
        expect(await runAutoSwap(makeCtx({ challenge: protectedOnly }))).toBe(false);
        expect(currencyActions.swapEntry).not.toHaveBeenCalled();
        set({ autoSwapAllowBoosted: true });
        expect(await runAutoSwap(makeCtx({ challenge: protectedOnly }))).toBe(true);
    });

    test('a pin whose feature is spent protects nothing', async () => {
        const challenge = makeChallenge();
        challenge.member.boost = { state: 'USED', timeout: null };
        settings.getEntryPins.mockReturnValue({ boost: 'e2', turbo: null });
        expect(await runAutoSwap(makeCtx({ challenge }))).toBe(true);
        expect(currencyActions.previewSwap).toHaveBeenCalledWith(
            555,
            'e2',
            'tok',
            expect.anything(),
            expect.anything(),
        );
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

    describe('the live guard on the spend (the real swapEntry)', () => {
        // The guarded spend is the real service one: the pass's snapshot says the target is plain,
        // while the LIVE challenge the strategy answers is what the guard reads.
        const realSwapEntry = jest.requireActual<typeof currencyActionsModule>(
            '../../src/ts/services/currencyActions',
        ).swapEntry;

        const runWithLive = async (
            liveEntries: Partial<RankingEntry>[],
            { allowProtected = false }: { allowProtected?: boolean } = {},
        ) => {
            const ctx = makeCtx();
            const live = makeChallenge();
            // The live re-check reads the real clock, so the live challenge must be running now
            // (the pass snapshot's frozen NOW only feeds the runner's own gates).
            live.start_time = Math.floor(Date.now() / 1000) - 3600;
            live.close_time = Math.floor(Date.now() / 1000) + 3600;
            live.member.ranking.entries = invalid<RankingEntry[]>(
                liveEntries.map((entry) => ({ member_id: 'm', ...entry })),
            );
            ctx.currency.strategy.getActiveChallenges = jest.fn().mockResolvedValue({ challenges: [live] });
            ctx.currency.strategy.swapPhoto = jest.fn().mockResolvedValue({ ok: true, raw: { success: true } });
            const onSwapped = jest.fn();
            ctx.currency.swapLedger = invalid({ onSwapped });
            currencyActions.swapEntry.mockImplementationOnce(realSwapEntry);
            set({ autoSwapAllowBoosted: allowProtected });
            return { ctx, swapPhoto: ctx.currency.strategy.swapPhoto, onSwapped, ok: await runAutoSwap(ctx) };
        };

        test('a photo that gained a guru pick before the spend is not swapped out', async () => {
            const { swapPhoto, onSwapped, ok } = await runWithLive([
                { id: 'e1', votes: 50 },
                { id: 'e2', votes: 5, guru_pick: true },
            ]);
            expect(ok).toBe(false);
            expect(swapPhoto).not.toHaveBeenCalled();
            expect(onSwapped).not.toHaveBeenCalled();
        });

        test('a photo that gained a boost before the spend is not swapped out', async () => {
            const { swapPhoto, onSwapped, ok } = await runWithLive([
                { id: 'e1', votes: 50 },
                { id: 'e2', votes: 5, boosted: true },
            ]);
            expect(ok).toBe(false);
            expect(swapPhoto).not.toHaveBeenCalled();
            expect(onSwapped).not.toHaveBeenCalled();
        });

        test('a plain live entry is swapped out', async () => {
            const { swapPhoto, onSwapped, ok, ctx } = await runWithLive([
                { id: 'e1', votes: 50 },
                { id: 'e2', votes: 5 },
            ]);
            expect(ok).toBe(true);
            expect(swapPhoto).toHaveBeenCalledWith(555, 'e2', 'new1', 'tok');
            expect(onSwapped).toHaveBeenCalledWith(555, expect.objectContaining({ id: 'e2' }), 'new1');
            expect(ctx.challenge.member.ranking.entries.map((e) => e.id)).toEqual(['e1', 'new1']);
        });

        test('allowProtected skips the guard: a live pick may be swapped out', async () => {
            const { swapPhoto, ok } = await runWithLive(
                [
                    { id: 'e1', votes: 50 },
                    { id: 'e2', votes: 5, guru_pick: true },
                ],
                { allowProtected: true },
            );
            expect(ok).toBe(true);
            expect(swapPhoto).toHaveBeenCalledWith(555, 'e2', 'new1', 'tok');
        });

        test('the pass snapshot carries the guard only while protected entries stay refused', async () => {
            const ctx = makeCtx();
            await runAutoSwap(ctx);
            expect(currencyActions.swapEntry).toHaveBeenLastCalledWith(
                555,
                'e2',
                'new1',
                'tok',
                expect.objectContaining({ guard: expect.any(Function) }),
            );
            set({ autoSwapAllowBoosted: true });
            await runAutoSwap(makeCtx());
            expect(currencyActions.swapEntry).toHaveBeenLastCalledWith(
                555,
                'e2',
                'new1',
                'tok',
                expect.objectContaining({ guard: undefined }),
            );
        });
    });
});

describe('runAutoExposureFill', () => {
    const pool = (start: number, ratios: number[]) =>
        invalid<Parameters<typeof runAutoExposureFill>[1]>({
            voting: { exposure: { exposure_factor: start } },
            images: ratios.map((ratio, i) => ({ id: i, ratio })),
        });
    // A readable pool with nothing left in it: the one "voting cannot help" case that still fills.
    const emptyPool = () => pool(0, []);

    test('fills when exposure is low and the pool this pass voted from was empty', async () => {
        const ctx = makeCtx();
        expect(await runAutoExposureFill(ctx, emptyPool())).toBe(true);
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

    test('a failed or unreadable pool read is not filled, whatever its shape', async () => {
        for (const unreadable of [null, invalid<Parameters<typeof runAutoExposureFill>[1]>({ images: 'nope' })]) {
            expect(await runAutoExposureFill(makeCtx(), unreadable)).toBe(false);
            expect(currencyActions.fillExposure).not.toHaveBeenCalled();
        }
    });

    test('a non-empty pool with an unreadable exposure figure gives no fill', async () => {
        expect(
            await runAutoExposureFill(
                makeCtx(),
                invalid<Parameters<typeof runAutoExposureFill>[1]>({
                    images: [{ id: 1, ratio: 30 }],
                }),
            ),
        ).toBe(false);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('the unreadable-pool warning is said once per run of unreadable reads, and a readable pool re-arms it', async () => {
        // A challenge of its own: the once-per-run set is module state shared by every test here.
        const challenge556 = () => makeChallenge({ id: 556 });
        const ctx = makeCtx({ challenge: challenge556() });
        expect(await runAutoExposureFill(ctx, null)).toBe(false);
        expect(await runAutoExposureFill(ctx, null)).toBe(false);
        expect(warningLines().filter((line) => line.includes('the vote pool could not be read'))).toHaveLength(1);
        // A readable (empty) pool re-arms the warning; a fresh context, so the fill's own
        // 100% reflect does not stand in the way of the next refusal.
        expect(await runAutoExposureFill(makeCtx({ challenge: challenge556() }), emptyPool())).toBe(true);
        expect(await runAutoExposureFill(makeCtx({ challenge: challenge556() }), null)).toBe(false);
        expect(warningLines().filter((line) => line.includes('the vote pool could not be read'))).toHaveLength(2);
    });

    test('a pool the fill read itself answers null refuses the fill', async () => {
        const ctx = makeCtx({ pool: null });
        expect(await runAutoExposureFill(ctx, undefined)).toBe(false);
        expect(ctx.currency.strategy.getVoteImages).toHaveBeenCalledWith(ctx.challenge, 'tok');
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('fetches the pool itself when voting did not run this pass', async () => {
        const ctx = makeCtx({ pool: pool(20, [40]) });
        expect(await runAutoExposureFill(ctx, undefined)).toBe(false);
        expect(ctx.currency.strategy.getVoteImages).toHaveBeenCalledWith(ctx.challenge, 'tok');
    });

    test('no fill when the pool must be read but the challenge has no URL', async () => {
        const ctx = makeCtx({ pool: pool(20, [40]) });
        delete ctx.challenge.url;
        expect(await runAutoExposureFill(ctx, undefined)).toBe(false);
        expect(ctx.currency.strategy.getVoteImages).not.toHaveBeenCalled();
    });

    test('a pool the pass already voted from fills without a URL', async () => {
        const ctx = makeCtx();
        delete ctx.challenge.url;
        expect(await runAutoExposureFill(ctx, emptyPool())).toBe(true);
        expect(ctx.currency.strategy.getVoteImages).not.toHaveBeenCalled();
    });

    test('no fill while exposure is at or above the threshold', async () => {
        set({ autoExposureFillBelow: 20 });
        expect(await runAutoExposureFill(makeCtx(), emptyPool())).toBe(false);
    });

    test('stops at the per-challenge automatic fill cap', async () => {
        const ctx = makeCtx();
        await ctx.currency.spendLedger.reserveFill('555');
        expect(await runAutoExposureFill(ctx, emptyPool())).toBe(false);
        set({ autoExposureFillMax: 2 });
        expect(await runAutoExposureFill(ctx, emptyPool())).toBe(true);
    });

    test('inert without the spend ledger', async () => {
        const ctx = makeCtx();
        (ctx.currency as CurrencyPassDeps).spendLedger = null;
        expect(await runAutoExposureFill(ctx, emptyPool())).toBe(false);
    });

    test('a fill counted by another context since the cap was looked at is not spent past it', async () => {
        const ctx = makeCtx();
        const ledger = ctx.currency.spendLedger;
        // The look at the cap sees no fill; one is counted before this one is.
        jest.spyOn(ledger, 'fills').mockReturnValueOnce(0);
        await ledger.reserveFill('555');
        expect(await runAutoExposureFill(ctx, emptyPool())).toBe(false);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
        expect(ledger.fills('555')).toBe(1);
    });

    test('a fill whose count could not be written down is not made', async () => {
        const ctx = makeCtx();
        jest.spyOn(ctx.currency.spendLedger, 'reserveFill').mockResolvedValue(false);
        expect(await runAutoExposureFill(ctx, emptyPool())).toBe(false);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('a spend that throws after the count was written down stays counted', async () => {
        currencyActions.fillExposure.mockRejectedValue(new Error('boom'));
        const ctx = makeCtx();
        expect(await runAutoExposureFill(ctx, emptyPool())).toBe(false);
        expect(ctx.currency.spendLedger.fills('555')).toBe(1);
    });

    test('with the fills left to the background service the window spends none, the exposure rule or a mission', async () => {
        const ctx = makeCtx();
        (ctx.currency as CurrencyPassDeps).fillsLeftToService = true;
        expect(await runAutoExposureFill(ctx, emptyPool())).toBe(false);
        expect(await runMissionFill(ctx, fillNeeds())).toBe(false);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
        expect(ctx.currency.spendLedger.fills('555')).toBe(0);
    });

    test('a fill that got no answer stays counted: it may have been made', async () => {
        currencyActions.fillExposure.mockResolvedValue({ ok: false, outcome: 'unclear' });
        const ctx = makeCtx();
        expect(await runAutoExposureFill(ctx, emptyPool())).toBe(false);
        expect(ctx.currency.spendLedger.fills('555')).toBe(1);
    });

    test('a fill deferred behind another spend is not counted', async () => {
        let release: ((value?: unknown) => void) | undefined;
        const held = currencyActions.withSpendLock(() => new Promise((resolve) => (release = resolve)));
        const ctx = makeCtx();
        expect(await runAutoExposureFill(ctx, emptyPool())).toBe(false);
        expect(ctx.currency.spendLedger.fills('555')).toBe(0);
        release!();
        await held;
    });

    test('a refused fill is not counted', async () => {
        currencyActions.fillExposure.mockResolvedValue({ ok: false, outcome: 'api-failed' });
        const ctx = makeCtx();
        expect(await runAutoExposureFill(ctx, emptyPool())).toBe(false);
        expect(ctx.currency.spendLedger.fills('555')).toBe(0);
    });
});

// Every line the code under test has logged at info level.
const infoLines = (): string[] =>
    jest
        .mocked(require('../../src/ts/logger') as typeof loggerModule)
        .withCategory.mock.results.flatMap((result) =>
            jest.mocked((result.value as loggerModule.CategoryLogger).info).mock.calls.map((call) => String(call[0])),
        );

// The same, for warnings (the T-methods render onto the warning fn too).
const warningLines = (): string[] =>
    jest
        .mocked(require('../../src/ts/logger') as typeof loggerModule)
        .withCategory.mock.results.flatMap((result) =>
            jest
                .mocked((result.value as loggerModule.CategoryLogger).warning)
                .mock.calls.map((call) => String(call[0])),
        );

// The mission needs a pass hands over, with one "Use Fill" mission (id 77: 1 of 3 done) unless told otherwise.
const fillNeeds = (over: Partial<FillMission> = {}) => {
    const mission = { id: '77', required: 3, current: 1, remaining: 2, spentThisPass: 0, ...over };
    return invalid<MissionNeeds>({
        join: 0,
        fill: mission.remaining,
        turbo: 0,
        boost: 0,
        vote: 0,
        fillMissions: [mission],
    });
};

describe('runMissionFill', () => {
    // A context on a fresh challenge over a ledger the passes share: one fill raises a challenge to 100%.
    const ctxOn = (ledger: ReturnType<typeof createMemoryAutoSpendLedger>) => {
        const ctx = makeCtx();
        ctx.currency.spendLedger = ledger;
        return ctx;
    };

    test('fills toward the mission regardless of the exposure rule, without touching its cap', async () => {
        set({ autoExposureFill: false, autoExposureFillBelow: 0 });
        const ctx = makeCtx({
            challenge: makeChallenge({ member: { ranking: { exposure: { exposure_factor: 95 } } } }),
        });
        expect(await runMissionFill(ctx, fillNeeds())).toBe(true);
        expect(currencyActions.fillExposure).toHaveBeenCalledWith(555, 'tok', expect.any(Object));
        expect(ctx.challenge.member.ranking.exposure.exposure_factor).toBe(100);
        expect(ctx.currency.spendLedger.fills('555')).toBe(0);
    });

    test('counts the fill against the mission, with the progress it had', async () => {
        const ctx = makeCtx();
        const needs = fillNeeds();
        expect(await runMissionFill(ctx, needs)).toBe(true);
        expect(ctx.currency.spendLedger.fills('mission:77')).toBe(1);
        expect(ctx.currency.spendLedger.lastProgress('mission:77')).toBe(1);
        expect(needs.fillMissions![0].spentThisPass).toBe(1);
    });

    test('nothing to do without a mission need, a mission to count against, a ledger or currency endpoints', async () => {
        expect(await runMissionFill(makeCtx(), fillNeeds({ remaining: 0 }))).toBe(false);
        expect(await runMissionFill(makeCtx(), null)).toBe(false);
        // A need no "Use Fill" mission stands behind cannot be counted, so it is not spent on.
        expect(
            await runMissionFill(makeCtx(), invalid<MissionNeeds>({ join: 0, fill: 2, turbo: 0, boost: 0, vote: 0 })),
        ).toBe(false);
        const noLedger = makeCtx();
        (noLedger.currency as CurrencyPassDeps).spendLedger = null;
        expect(await runMissionFill(noLedger, fillNeeds())).toBe(false);
        const ctx = makeCtx();
        (ctx as Parameters<typeof runMissionFill>[0]).currency = null;
        expect(await runMissionFill(ctx, fillNeeds())).toBe(false);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('skips a challenge that cannot take a fill (full exposure, fill locked)', async () => {
        const full = makeChallenge({ member: { ranking: { exposure: { exposure_factor: 100 } } } });
        expect(await runMissionFill(makeCtx({ challenge: full }), fillNeeds())).toBe(false);
        expect(await runMissionFill(makeCtx({ challenge: makeChallenge({ fill_locked: true }) }), fillNeeds())).toBe(
            false,
        );
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('keeps the fill reserve', async () => {
        set({ currencyReserveFills: 3 });
        const ctx = makeCtx();
        expect(await runMissionFill(ctx, fillNeeds())).toBe(false);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
        expect(ctx.currency.spendLedger.fills('mission:77')).toBe(0);
    });

    test('a refused fill leaves the challenge as it was, and is not counted', async () => {
        currencyActions.fillExposure.mockResolvedValue({ ok: false, outcome: 'api-failed' });
        const ctx = makeCtx();
        expect(await runMissionFill(ctx, fillNeeds())).toBe(false);
        expect(ctx.challenge.member.ranking.exposure.exposure_factor).toBe(20);
        expect(ctx.currency.spendLedger.fills('mission:77')).toBe(0);
    });

    test('a fill that got no answer stays counted: it may have been made', async () => {
        currencyActions.fillExposure.mockResolvedValue({ ok: false, outcome: 'unclear' });
        const ctx = makeCtx();
        expect(await runMissionFill(ctx, fillNeeds())).toBe(false);
        expect(ctx.currency.spendLedger.fills('mission:77')).toBe(1);
    });

    test('a fill whose count could not be written down is not made', async () => {
        const ctx = makeCtx();
        jest.spyOn(ctx.currency.spendLedger, 'reserveFill').mockResolvedValue(false);
        expect(await runMissionFill(ctx, fillNeeds())).toBe(false);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    describe('a mission is not filled for on every pass', () => {
        test('the fills stop once as many were spent as the mission asks for in all', async () => {
            const ctx = makeCtx();
            const ledger = ctx.currency.spendLedger;
            await ledger.reserveFill('mission:77');
            await ledger.reserveFill('mission:77');
            await ledger.reserveFill('mission:77');
            expect(await runMissionFill(ctx, fillNeeds())).toBe(false);
            expect(currencyActions.fillExposure).not.toHaveBeenCalled();
            expect(infoLines().some((line) => line.includes('3 fills already spent on mission 77'))).toBe(true);
            // The count is held to the cap where it is written, too: not counted past it.
            expect(ledger.fills('mission:77')).toBe(3);
        });

        test('across passes: fills that moved the mission go on, up to what it asks for', async () => {
            const ledger = createMemoryAutoSpendLedger();
            // Pass 1: 0 of 3 done, two challenges take a fill each.
            const pass1 = fillNeeds({ current: 0, remaining: 3 });
            expect(await runMissionFill(ctxOn(ledger), pass1)).toBe(true);
            expect(await runMissionFill(ctxOn(ledger), pass1)).toBe(true);
            // Pass 2: the mission moved to 2 of 3: one more.
            const pass2 = fillNeeds({ current: 2, remaining: 1 });
            expect(await runMissionFill(ctxOn(ledger), pass2)).toBe(true);
            expect(ledger.fills('mission:77')).toBe(3);
            // Pass 3: it asks for no more.
            expect(await runMissionFill(ctxOn(ledger), fillNeeds({ current: 2, remaining: 1 }))).toBe(false);
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(3);
        });

        test('a pass after one whose fill did not move the mission spends none, and says so once', async () => {
            const ledger = createMemoryAutoSpendLedger();
            expect(await runMissionFill(ctxOn(ledger), fillNeeds({ id: '88', current: 0, remaining: 3 }))).toBe(true);
            // Next pass: the mission still reads 0 of 3.
            const next = fillNeeds({ id: '88', current: 0, remaining: 3 });
            expect(await runMissionFill(ctxOn(ledger), next)).toBe(false);
            expect(await runMissionFill(ctxOn(ledger), next)).toBe(false);
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
            expect(ledger.fills('mission:88')).toBe(1);
            expect(infoLines().filter((line) => line.includes('mission 88 did not move'))).toHaveLength(1);
        });

        test('a fill that is deferred leaves no stalled mission behind: the next pass still fills', async () => {
            const ledger = createMemoryAutoSpendLedger();
            // Pass 1: the fill lands at 0 of 3.
            expect(await runMissionFill(ctxOn(ledger), fillNeeds({ id: '31', current: 0, remaining: 3 }))).toBe(true);
            // Pass 2: the mission moved to 1, but another spend holds the lock: the fill is deferred.
            let release: ((value?: unknown) => void) | undefined;
            const held = currencyActions.withSpendLock(() => new Promise((resolve) => (release = resolve)));
            expect(await runMissionFill(ctxOn(ledger), fillNeeds({ id: '31', current: 1, remaining: 2 }))).toBe(false);
            release!();
            await held;
            expect(ledger.fills('mission:31')).toBe(1);
            expect(ledger.lastProgress('mission:31')).toBe(0);
            // Pass 3: still at 1 (nothing was spent in pass 2): not a stalled mission.
            expect(await runMissionFill(ctxOn(ledger), fillNeeds({ id: '31', current: 1, remaining: 2 }))).toBe(true);
            expect(infoLines().some((line) => line.includes('mission 31 did not move'))).toBe(false);
        });

        test('a fill that got no answer is not read as a mission that did not move: the next pass still fills', async () => {
            const ledger = createMemoryAutoSpendLedger();
            currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'unclear' });
            expect(await runMissionFill(ctxOn(ledger), fillNeeds({ id: '32', current: 0, remaining: 3 }))).toBe(false);
            // Counted, because it may have been made; its reserved progress is not kept.
            expect(ledger.fills('mission:32')).toBe(1);
            expect(ledger.lastProgress('mission:32')).toBeNull();
            expect(await runMissionFill(ctxOn(ledger), fillNeeds({ id: '32', current: 0, remaining: 3 }))).toBe(true);
            expect(infoLines().some((line) => line.includes('mission 32 did not move'))).toBe(false);
        });

        test('the second fill of the same pass is not held to the progress the pass started from', async () => {
            const ledger = createMemoryAutoSpendLedger();
            const needs = fillNeeds({ id: '99', current: 0, remaining: 3 });
            expect(await runMissionFill(ctxOn(ledger), needs)).toBe(true);
            expect(await runMissionFill(ctxOn(ledger), needs)).toBe(true);
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(2);
        });

        test('a mission that moves again after it stalled is filled for again', async () => {
            const ledger = createMemoryAutoSpendLedger();
            expect(await runMissionFill(ctxOn(ledger), fillNeeds({ id: '55', current: 0, remaining: 3 }))).toBe(true);
            expect(await runMissionFill(ctxOn(ledger), fillNeeds({ id: '55', current: 0, remaining: 3 }))).toBe(false);
            expect(await runMissionFill(ctxOn(ledger), fillNeeds({ id: '55', current: 1, remaining: 2 }))).toBe(true);
        });

        test('the count lasts across a restart: a ledger read again from what was saved holds the same stop', async () => {
            const saved: { raw: string | null } = { raw: null };
            const store = { readRaw: () => saved.raw, writeRaw: (data: string) => (saved.raw = data) };
            expect(
                await runMissionFill(
                    ctxOn(createAutoSpendLedger(store)),
                    fillNeeds({ id: '66', current: 0, remaining: 3 }),
                ),
            ).toBe(true);
            const restarted = createAutoSpendLedger(store);
            expect(await runMissionFill(ctxOn(restarted), fillNeeds({ id: '66', current: 0, remaining: 3 }))).toBe(
                false,
            );
            expect(await runMissionFill(ctxOn(restarted), fillNeeds({ id: '66', current: 1, remaining: 2 }))).toBe(
                true,
            );
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(2);
        });

        test('a ledger that cannot be trusted spends nothing for a mission', async () => {
            const ctx = makeCtx();
            ctx.currency.spendLedger = createAutoSpendLedger({ readRaw: () => '{nope', writeRaw: () => {} });
            expect(await runMissionFill(ctx, fillNeeds())).toBe(false);
            expect(currencyActions.fillExposure).not.toHaveBeenCalled();
        });
    });
});
