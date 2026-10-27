/**
 * The auto-swap cap when GuruShots sends no swap history: auto-swaps are then
 * counted locally in the auto-spend ledger (`swap:<id>`), reserved inside the
 * spend lock right before the spend and released when the spend is refused.
 * `swapEntry` runs for real here — its own live re-check is part of the money
 * path — over the in-memory ledger the passes share; only `previewSwap` is a
 * double. `currencyActions` is mocked for the whole file (services/
 * currencyAuto.test.ts does the same), and the mock implementations are reset
 * in the beforeEach, since clearAllMocks keeps implementations.
 */

jest.mock('../../src/ts/settings');
jest.mock('../../src/ts/services/currencyActions', () => ({
    __esModule: true,
    ...jest.requireActual<typeof import('../../src/ts/services/currencyActions')>(
        '../../src/ts/services/currencyActions',
    ),
    previewSwap: jest.fn(),
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
import type {
    Challenge,
    MemberBoost,
    MemberRanking,
    RankingEntry,
    RankingExposure,
} from '../../src/ts/types/gurushots';
import { invalid } from '../helpers/invalid';
const { runAutoSwap, runAutoExposureFill } = require('../../src/ts/services/currencyAuto') as typeof currencyAutoModule;
const { createMemoryAutoSpendLedger, createAutoSpendLedger } =
    require('../../src/ts/currencyAutoStore') as typeof currencyAutoStoreModule;

const NOW = 1_000_000;
const H = 3600;
const OK = { ok: true, outcome: 'ok' };
const KEY = (id: number | string) => `swap:${id}`;

let values: Record<string, unknown>;
const set = (overrides: Record<string, unknown>) => Object.assign(values, overrides);

// A partial challenge (no entries/players counts): the runners never read those.
type FixtureChallenge = Challenge & {
    member: {
        boost: MemberBoost;
        ranking: Omit<MemberRanking, 'swaps'> & { exposure: RankingExposure; entries: RankingEntry[]; swaps?: unknown };
    };
};
// No swap history by default: the subject of this file. A test that wants one
// assigns `member.ranking.swaps` itself.
const makeChallenge = (overrides: object = {}): FixtureChallenge =>
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
            },
        },
        ...overrides,
    });

// The LIVE challenge the real swapEntry re-checks: it must be running by the
// real clock, and swap-ready, or every spend is refused before the endpoint.
const runningChallenge = (overrides: object = {}): FixtureChallenge => {
    const live = makeChallenge(overrides);
    live.start_time = Math.floor(Date.now() / 1000) - 3600;
    live.close_time = Math.floor(Date.now() / 1000) + 3600;
    return live;
};

type FixtureCtx = Parameters<typeof runAutoSwap>[0] & {
    challenge: FixtureChallenge;
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

const makeCtx = ({
    challenge = makeChallenge(),
    ledger = createMemoryAutoSpendLedger(),
    // The live challenge the real swapEntry re-checks carries the same id as the pass's snapshot.
    live = runningChallenge({ id: challenge.id }),
    swapHistorySent = false,
}: {
    challenge?: FixtureChallenge;
    ledger?: ReturnType<typeof createMemoryAutoSpendLedger>;
    live?: FixtureChallenge;
    swapHistorySent?: boolean;
} = {}) =>
    invalid<FixtureCtx>({
        challenge,
        token: 'tok',
        now: NOW,
        swapHistorySent,
        currency: {
            strategy: {
                getBankroll: jest.fn().mockResolvedValue({ keys: 3, swaps: 3, fills: 3 }),
                getVoteImages: jest.fn().mockResolvedValue(null),
                getActiveChallenges: jest.fn().mockResolvedValue({ challenges: [live] }),
                swapPhoto: jest.fn().mockResolvedValue({ ok: true, raw: { success: true } }),
            },
            swapLedger: { onSwapped: jest.fn() },
            spendLedger: ledger,
        },
    });

beforeEach(() => {
    jest.clearAllMocks();
    values = {
        autoSwap: true,
        autoSwapAfterStart: 0,
        autoSwapBeforeEnd: 0,
        autoSwapAfterPercent: 0,
        autoSwapImageIndex: 0,
        autoSwapLowestVotes: false,
        autoSwapAllowBoosted: false,
        autoSwapMaxVotes: 0,
        autoSwapMax: 1,
        currencyReserveSwaps: 0,
        autoExposureFill: true,
        autoExposureFillBelow: 50,
        autoExposureFillAfterStart: 0,
        autoExposureFillBeforeEnd: 0,
        autoExposureFillAfterPercent: 0,
        autoExposureFillMax: 1,
        currencyReserveFills: 0,
    };
    settings.getEntryPins.mockReturnValue({ boost: null, turbo: null });
    settings.getEffectiveSetting = invalid(jest.fn((key: string) => values[key]));
    currencyActions.previewSwap.mockResolvedValue({ ...OK, candidate: { id: 'new1', member_id: 'm' } });
    currencyActions.fillExposure.mockResolvedValue(OK);
});

// Every line the code under test has logged at info / warning level (the
// T-methods render onto the same fns).
const logged = (level: 'info' | 'warning'): string[] =>
    jest
        .mocked(require('../../src/ts/logger') as typeof loggerModule)
        .withCategory.mock.results.flatMap((result) =>
            jest.mocked((result.value as loggerModule.CategoryLogger)[level]).mock.calls.map((call) => String(call[0])),
        );
const infoLines = () => logged('info');
const warningLines = () => logged('warning');

describe('runAutoSwap — the local cap without a swap history', () => {
    test('history absent, max 1: exactly one swap; the next pass refuses without spending', async () => {
        const ledger = createMemoryAutoSpendLedger();
        const first = makeCtx({ ledger });
        expect(await runAutoSwap(first)).toBe(true);
        expect(first.currency.strategy.swapPhoto).toHaveBeenCalledTimes(1);
        expect(ledger.fills(KEY(555))).toBe(1);

        // The next pass: a fresh snapshot of the same challenge, still no history.
        const second = makeCtx({ ledger });
        expect(await runAutoSwap(second)).toBe(false);
        expect(currencyActions.previewSwap).toHaveBeenCalledTimes(1);
        expect(second.currency.strategy.swapPhoto).not.toHaveBeenCalled();
        expect(ledger.fills(KEY(555))).toBe(1);
    });

    test('history present: the ledger is not touched — a stale count does not block, an untrusted ledger does not either', async () => {
        const ledger = createMemoryAutoSpendLedger();
        // A count left by an unanswered swap that did not land.
        await ledger.reserveFill(KEY(555));
        const challenge = makeChallenge();
        challenge.member.ranking.swaps = [];
        const ctx = makeCtx({ challenge, ledger, swapHistorySent: true });
        expect(await runAutoSwap(ctx)).toBe(true);
        expect(ctx.currency.strategy.swapPhoto).toHaveBeenCalledTimes(1);
        expect(ledger.fills(KEY(555))).toBe(1);

        // An untrusted ledger reads as unlimited — but the server branch never asks it.
        const untrusted = createAutoSpendLedger({ readRaw: () => '{nope', writeRaw: () => {} });
        const ctx2 = makeCtx({ challenge: makeChallenge(), ledger: untrusted, swapHistorySent: true });
        expect(await runAutoSwap(ctx2)).toBe(true);
    });

    test('a fill on the same challenge leaves the swap count unchanged', async () => {
        const ledger = createMemoryAutoSpendLedger();
        const ctx = makeCtx({ ledger });
        expect(await runAutoSwap(ctx)).toBe(true);
        expect(ledger.fills(KEY(555))).toBe(1);
        expect(await runAutoExposureFill(ctx, invalid<Parameters<typeof runAutoExposureFill>[1]>({ images: [] }))).toBe(
            true,
        );
        expect(ledger.fills(KEY(555))).toBe(1);
        expect(ledger.fills('555')).toBe(1);
    });

    test('a missing ledger with the history absent refuses', async () => {
        const ctx = makeCtx();
        (ctx.currency as CurrencyPassDeps).spendLedger = null;
        expect(await runAutoSwap(ctx)).toBe(false);
        expect(ctx.currency.strategy.swapPhoto).not.toHaveBeenCalled();
    });

    test('two passes over one in-memory ledger auto-swap once, then stop (the mock mode shape)', async () => {
        // Mock mode's ledger is in memory and shared by the passes; the mock challenge carries no
        // swap history, so the count that stops the second pass is the ledger's own.
        const ledger = createMemoryAutoSpendLedger();
        const pass = async () => {
            const ctx = makeCtx({ challenge: makeChallenge({ id: 4242 }), ledger });
            const spent = await runAutoSwap(ctx);
            return { spent, swapPhoto: ctx.currency.strategy.swapPhoto };
        };
        const first = await pass();
        expect(first.spent).toBe(true);
        const second = await pass();
        expect(second.spent).toBe(false);
        expect(first.swapPhoto).toHaveBeenCalledTimes(1);
        expect(second.swapPhoto).not.toHaveBeenCalled();
    });
});

describe('runAutoSwap — what counts as a missing history', () => {
    test.each([null, 'nope'])('a %p history is missing: the ledger decides', async (history) => {
        const ledger = createMemoryAutoSpendLedger();
        await ledger.reserveFill(KEY(555));
        set({ autoSwapMax: 1 });
        const challenge = makeChallenge();
        challenge.member.ranking.swaps = invalid(history);
        expect(await runAutoSwap(makeCtx({ challenge, ledger }))).toBe(false);
        expect(currencyActions.previewSwap).not.toHaveBeenCalled();
    });

    test('an array history (an empty one included) does not: the ledger is not even read', async () => {
        const ledger = createMemoryAutoSpendLedger();
        set({ autoSwapMax: 1 });
        // An empty history swaps (the server count of 0 is under the cap); a one-swap history
        // refuses on that count alone. Neither may read the ledger.
        for (const [swaps, expected] of [
            [[], true],
            [[{ id: 'old' }], false],
        ] as Array<[unknown[], boolean]>) {
            const challenge = makeChallenge();
            challenge.member.ranking.swaps = invalid(swaps);
            const fills = jest.spyOn(ledger, 'fills');
            expect(await runAutoSwap(makeCtx({ challenge, ledger, swapHistorySent: true }))).toBe(expected);
            expect(fills).not.toHaveBeenCalled();
            fills.mockRestore();
        }
    });
});

describe('runAutoSwap — the scenario wrote a history the server did not send', () => {
    test('a swaps array of 1 on the object with swapHistorySent false is capped by the ledger, not the object', async () => {
        // The scenario swap wrote its record onto the pass object this pass. With a cap of 2 the
        // server count of 1 would allow another swap, so this fails if the code branches on the
        // object: the ledger, seeded at 2, must refuse.
        const ledger = createMemoryAutoSpendLedger();
        await ledger.reserveFill(KEY(555));
        await ledger.reserveFill(KEY(555));
        set({ autoSwapMax: 2 });
        const challenge = makeChallenge();
        challenge.member.ranking.swaps = [{ id: 'e2' }];
        expect(await runAutoSwap(makeCtx({ challenge, ledger }))).toBe(false);
        expect(currencyActions.previewSwap).not.toHaveBeenCalled();
    });
});

describe('runAutoSwap — the local-count notice', () => {
    test('logged once per challenge when the history is missing', async () => {
        // One ledger across both passes, so the count of the first pass is the second pass's cap.
        const ledger = createMemoryAutoSpendLedger();
        expect(await runAutoSwap(makeCtx({ challenge: makeChallenge({ id: 777 }), ledger }))).toBe(true);
        expect(infoLines().filter((line) => line.includes('counting auto-swaps locally'))).toHaveLength(1);
        // The same challenge again: still refused at the cap, never told twice.
        expect(await runAutoSwap(makeCtx({ challenge: makeChallenge({ id: 777 }), ledger }))).toBe(false);
        expect(infoLines().filter((line) => line.includes('counting auto-swaps locally'))).toHaveLength(1);
    });

    test('not logged when the history is present', async () => {
        const challenge = makeChallenge();
        challenge.member.ranking.swaps = [];
        expect(await runAutoSwap(makeCtx({ challenge, swapHistorySent: true }))).toBe(true);
        expect(infoLines().filter((line) => line.includes('counting auto-swaps locally'))).toHaveLength(0);
    });

    test('autoSwap off logs nothing', async () => {
        set({ autoSwap: false });
        expect(await runAutoSwap(makeCtx({ challenge: makeChallenge({ id: 999 }) }))).toBe(false);
        expect(infoLines().filter((line) => line.includes('counting auto-swaps locally'))).toHaveLength(0);
    });
});

describe('runAutoSwap — the release, money path', () => {
    // The count is seeded at 1 and the cap is 3, so a spend first reserves (2) and
    // only a refusal releases back to 1.
    const seed = async (max = 3) => {
        const ledger = createMemoryAutoSpendLedger();
        await ledger.reserveFill(KEY(555));
        set({ autoSwapMax: max });
        return ledger;
    };

    test('a busy lock reserves nothing: the callback never runs', async () => {
        const ledger = await seed();
        let release: ((value?: unknown) => void) | undefined;
        const held = currencyActions.withSpendLock(() => new Promise((resolve) => (release = resolve)));
        expect(await runAutoSwap(makeCtx({ ledger }))).toBe(false);
        expect(ledger.fills(KEY(555))).toBe(1);
        release!();
        await held;
    });

    test.each([
        ['failed', { ok: false, outcome: 'api-failed' }],
        ['no-alternative', { ok: false, outcome: 'no-alternative' }],
    ])('a %s preview reserves nothing', async (_label, preview) => {
        const ledger = await seed();
        currencyActions.previewSwap.mockResolvedValueOnce(invalid(preview));
        expect(await runAutoSwap(makeCtx({ ledger }))).toBe(false);
        expect(ledger.fills(KEY(555))).toBe(1);
    });

    test('a refused reserve leaves the count at 1', async () => {
        const ledger = await seed();
        // The pre-check passed on the real count; inside the lock the write fails.
        jest.spyOn(ledger, 'reserveFill').mockResolvedValue(false);
        expect(await runAutoSwap(makeCtx({ ledger }))).toBe(false);
        expect(ledger.fills(KEY(555))).toBe(1);
        expect(infoLines().filter((line) => line.includes('has reached its limit'))).toHaveLength(0);
        expect(warningLines().filter((line) => line.includes('could not be saved'))).toHaveLength(1);
    });

    test('a failed reserve at the cap logs "cap reached", not a save failure', async () => {
        const ledger = await seed(2);
        // The pre-check sees 1; by the re-read another context has counted one more.
        jest.spyOn(ledger, 'fills').mockReturnValueOnce(1).mockReturnValue(2);
        jest.spyOn(ledger, 'reserveFill').mockResolvedValue(false);
        const ctx = makeCtx({ ledger });
        expect(await runAutoSwap(ctx)).toBe(false);
        expect(ctx.currency.strategy.swapPhoto).not.toHaveBeenCalled();
        expect(infoLines().filter((line) => line.includes('has reached its limit'))).toHaveLength(1);
        expect(warningLines().filter((line) => line.includes('could not be saved'))).toHaveLength(0);
    });

    test.each([
        ['already-entered', 'entered'],
        ['api-failed', 'api-failed'],
        ['not-available (guard refusal)', 'guard'],
    ])('a swapEntry refusal: %s is released, back to 1', async (_label, kind) => {
        const ledger = await seed();
        const live = runningChallenge();
        if (kind === 'entered') {
            // The candidate the preview chose is already entered on the live challenge.
            live.member.ranking.entries = invalid<RankingEntry[]>([
                ...live.member.ranking.entries,
                { id: 'new1', member_id: 'm', votes: 1 },
            ]);
        }
        if (kind === 'guard') {
            live.member.ranking.entries = invalid<RankingEntry[]>([
                { id: 'e1', member_id: 'm', votes: 50 },
                { id: 'e2', member_id: 'm', votes: 5, guru_pick: true },
            ]);
        }
        const ctx = makeCtx({ ledger, live });
        if (kind === 'api-failed') ctx.currency.strategy.swapPhoto.mockResolvedValue({ ok: false, raw: null });
        expect(await runAutoSwap(ctx)).toBe(false);
        expect(ledger.fills(KEY(555))).toBe(1);
    });

    test('the live swap cap (not-available) is released', async () => {
        const ledger = await seed(3);
        const live = runningChallenge();
        live.member.ranking.swaps = invalid<Array<{ id: string }>>([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
        const ctx = makeCtx({ ledger, live });
        expect(await runAutoSwap(ctx)).toBe(false);
        expect(ctx.currency.strategy.swapPhoto).not.toHaveBeenCalled();
        expect(ledger.fills(KEY(555))).toBe(1);
    });

    test('a blocked live read is released', async () => {
        const ledger = await seed();
        const ctx = makeCtx({ ledger, live: runningChallenge({ swap_locked: true }) });
        expect(await runAutoSwap(ctx)).toBe(false);
        expect(ledger.fills(KEY(555))).toBe(1);
    });

    test('unclear stays counted: a swap that got no answer may have been made', async () => {
        const ledger = await seed();
        const ctx = makeCtx({ ledger });
        ctx.currency.strategy.swapPhoto.mockResolvedValue({ ok: false, raw: null, unclear: true });
        expect(await runAutoSwap(ctx)).toBe(false);
        expect(ledger.fills(KEY(555))).toBe(2);
    });
});
