/**
 * The scenario actions added with the remaining selectors: the entry targets (id, pinned, pending Boost target, newest and
 * oldest, slowest, matching), `earnTurbo`, `runAutomation`, the runtime settings patch and profile, `pauseScenario` and
 * `handoffScenario`. The runner runs for real over an in-memory progress ledger; the settings facade, the producers of the
 * normal automation (Turbo game, deadline runners, vote, currency runners) and the pass endpoints are stubbed, so what is
 * asserted is what a step decides, writes and hands to them. The installation and the join are in scenarioLifecycle.test.ts.
 */

jest.mock('../../src/ts/core/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warning: jest.fn(), success: jest.fn() };
    return {
        withCategory: jest.fn(() => category),
        challengeTag: jest.fn((c: { id?: string | number } | null | undefined) => `[${c?.id}]`),
        __category: category,
    };
});
jest.mock('../../src/ts/core/settings', () => {
    const getEffectiveSetting = jest.fn();
    const unknown = { state: 'unknown', reason: 'test', dependencies: [] };
    return {
        getEffectiveSetting,
        captureInstallationSettings: jest.fn((keys: string[]) => ({
            ok: true,
            values: Object.fromEntries(keys.map((key) => [key, getEffectiveSetting(key, null)])),
        })),
        getScenario: jest.fn(),
        getSetting: jest.fn(() => 'UTC'),
        unresolvedScenarioWork: jest.fn(() => false),
        settleHandoff: jest.fn(() => 'finished'),
        getEntryPins: jest.fn(() => ({ boost: null, turbo: null })),
        prepareScenarioSnapshot: jest.fn(() => ({
            ok: true,
            snapshot: { publication: null, readSetting: () => unknown },
        })),
        scenarioCapability: jest.requireActual<typeof import('../../src/ts/core/settings/scenarioCapabilities')>(
            '../../src/ts/core/settings/scenarioCapabilities',
        ).scenarioCapability,
        readScenarioSetting: jest.fn(() => unknown),
        readInstallationSetting: jest.fn(() => unknown),
        checkPhaseProfile: jest.fn(),
        requestScenarioHandoff: jest.fn(),
        installationGeneration: jest.fn(),
    };
});
jest.mock('../../src/ts/core/services/currencyAuto', () => ({
    ...jest.requireActual<typeof import('../../src/ts/core/services/currencyAuto')>(
        '../../src/ts/core/services/currencyAuto',
    ),
    runAutoKey: jest.fn(),
    runAutoSwap: jest.fn(),
    runAutoExposureFill: jest.fn(),
}));
jest.mock('../../src/ts/core/services/votingOrchestrator/turbo', () => ({ playAutoTurbo: jest.fn() }));
jest.mock('../../src/ts/core/services/votingOrchestrator/actionRunners', () => ({ runDeadlineOperation: jest.fn() }));
jest.mock('../../src/ts/core/services/votingOrchestrator/vote', () => ({ voteOnChallenge: jest.fn() }));
jest.mock('../../src/ts/core/services/VotingLogic', () => ({ evaluateVotingDecision: jest.fn() }));
jest.mock('../../src/ts/core/services/autoFill', () => ({
    submitNewEntryForAction: jest.fn(),
    refreshChallengeState: jest.fn(async () => 'refreshed'),
    reflectNewEntry: jest.fn(),
    reflectEntryFlag: jest.fn(),
    getSlotsRemaining: jest.fn(),
}));

import loggerModule = require('../../src/ts/core/logger');
import settingsModule = require('../../src/ts/core/settings');
import currencyAutoModule = require('../../src/ts/core/services/currencyAuto');
import turboModule = require('../../src/ts/core/services/votingOrchestrator/turbo');
import actionRunnersModule = require('../../src/ts/core/services/votingOrchestrator/actionRunners');
import voteModule = require('../../src/ts/core/services/votingOrchestrator/vote');
import votingLogicModule = require('../../src/ts/core/services/VotingLogic');
import autoFillModule = require('../../src/ts/core/services/autoFill');
import type * as scenarioRunnerModule from '../../src/ts/core/services/scenarioRunner';
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import { createOperationRecord } from '../../src/ts/core/scenarios/runtime';
import type { Challenge, ChallengeMember, MemberRanking, RankingEntry } from '../../src/ts/core/types/gurushots';
import type { ScenarioDocument } from '../../src/ts/core/settings/scenarioSchema';
import type { ScenarioState } from '../../src/ts/core/types/stores';
import type { CategoryLogger } from '../../src/ts/core/logger';
import { invalid } from '../helpers/invalid';

const logger = jest.mocked(loggerModule);
const settings = jest.mocked(settingsModule);
const currencyAuto = jest.mocked(currencyAutoModule);
const { playAutoTurbo } = jest.mocked(turboModule);
const { runDeadlineOperation } = jest.mocked(actionRunnersModule);
const { voteOnChallenge } = jest.mocked(voteModule);
const { evaluateVotingDecision } = jest.mocked(votingLogicModule);
const autoFill = jest.mocked(autoFillModule);
const { runScenarioStep } = require('../../src/ts/core/services/scenarioRunner') as typeof scenarioRunnerModule;
const { createMemoryStateLedger, initialState } =
    require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;

type CategoryMock = {
    [K in 'info' | 'error' | 'debug' | 'warning' | 'success']: jest.MockedFunction<CategoryLogger[K]>;
};
const log = (logger as typeof logger & { __category: CategoryMock }).__category;
const NOW = Math.floor(Date.now() / 1000);
const H = 3600;

type TestChallenge = Challenge & {
    member: ChallengeMember & { ranking: MemberRanking & { entries: RankingEntry[] } };
};

const challenge = () =>
    invalid<TestChallenge>({
        id: 7,
        start_time: NOW - 86400,
        close_time: NOW + 5 * 86400,
        max_photo_submits: 4,
        member: {
            boost: { state: 'AVAILABLE', timeout: NOW + 3600 },
            turbo: { state: 'WON', mode: 'classic' },
            ranking: {
                entries: [
                    { id: 'a', votes: 10, rank: 20, member_id: 'm' },
                    { id: 'b', votes: 3, rank: 90, member_id: 'm' },
                ],
                exposure: { exposure_factor: 30 },
                swaps: [],
            },
        },
    });

const plan = (phases: Record<string, object>, extra = {}) =>
    invalid<ScenarioDocument>({ name: 'Plan', version: 1, start: 'main', phases, ...extra });
const single = (actions: object[], extra = {}, scenarioExtra = {}) =>
    plan({ main: { rules: [{ id: 'r1', do: actions, ...extra }] } }, scenarioExtra);

let ledger: ReturnType<typeof createMemoryStateLedger>;
let operations: ReturnType<typeof createOperationRecord>;
let entryAges: {
    refresh: jest.Mock<Promise<void>, []>;
    entryTimes: jest.Mock<Record<string, { at: number; exact: boolean }>, []>;
    isUncertain: jest.Mock<boolean, [string | number, string | number]>;
    pending: jest.Mock<string | null, [string | number]>;
    health: jest.Mock<{ read: boolean; refresh: boolean }, []>;
};
let missions: { fill: number; boost: number; turbo: number; join: number; vote: number } | null;

const setup = (scenario: ScenarioDocument) => settings.getScenario.mockReturnValue(scenario);

const pass = () => ({
    token: 'tok',
    api: {
        applyBoostToEntry: jest.fn(async () => ({ success: true })),
        applyTurbo: jest.fn(async () => ({ ok: true })),
        getActiveChallenges: jest.fn(),
    },
    fillDeps: {},
    entryAges,
    missions,
    operations,
    currency: {
        strategy: {
            getBankroll: jest.fn(async () => ({ keys: 5, swaps: 5, fills: 5, coins: 0 })),
            keyUnlock: jest.fn(),
            swapPhoto: jest.fn(),
            exposureAutofill: jest.fn(),
        },
    },
    scenarios: { ledger },
});
let current: ReturnType<typeof pass>;

const run = async (c = challenge()) => {
    await runScenarioStep(c, NOW, invalid(current));
    return c;
};
const state = () => ledger.get(7).state as ScenarioState;
const seed = (over: Partial<ScenarioState> = {}) =>
    expect(ledger.change('7', () => ({ ...initialState('Plan', 'main', NOW - 100), ...over }))).toMatchObject({
        ok: true,
    });
/** A new progress ledger, for a test that runs the step more than once from nothing. */
const fresh = () => {
    ledger = createMemoryStateLedger();
    current = pass();
};

beforeEach(() => {
    jest.clearAllMocks();
    ledger = createMemoryStateLedger();
    operations = createOperationRecord();
    missions = null;
    entryAges = {
        refresh: jest.fn(async () => {}),
        entryTimes: jest.fn(() => ({})),
        isUncertain: jest.fn((_challengeId: string | number, _imageId: string | number) => false),
        pending: jest.fn((_id: string | number): string | null => null),
        health: jest.fn(() => ({ read: true, refresh: true })),
    };
    current = pass();
    settings.getEffectiveSetting.mockImplementation((key) => (key === 'scenario' ? 'Plan' : 0));
    settings.getEntryPins.mockReturnValue({ boost: null, turbo: null });
    settings.prepareScenarioSnapshot.mockImplementation(() => ({
        ok: true,
        snapshot: { publication: null, readSetting: () => ({ state: 'unknown', reason: 'test', dependencies: [] }) },
    }));
});

describe('the target of an action, by the selectors that read evidence', () => {
    const boostOn = (entry: object) => single([{ type: 'boost', entry }]);

    test('id: the entry with that id', async () => {
        setup(boostOn({ by: 'id', id: 'b' }));
        await run();
        expect(current.api.applyBoostToEntry).toHaveBeenCalledWith(7, 'b', 'tok');
    });

    test('pinned: the photo the power is pinned to; none pinned is a skip', async () => {
        settings.getEntryPins.mockReturnValue({ boost: 'b', turbo: 'a' });
        setup(boostOn({ by: 'pinned', power: 'boost' }));
        await run();
        expect(current.api.applyBoostToEntry).toHaveBeenCalledWith(7, 'b', 'tok');
        expect(settings.getEntryPins).toHaveBeenCalledWith('7');

        fresh();
        settings.getEntryPins.mockReturnValue({ boost: null, turbo: null });
        await run();
        expect(state().lastError?.message).toContain('no entry matches the boost target');
        expect(current.api.applyBoostToEntry).not.toHaveBeenCalled();
    });

    test('pendingBoostTarget: the photo an earlier fill-new submitted, read through the existing producer', async () => {
        entryAges.pending.mockReturnValue('a');
        setup(boostOn({ by: 'pendingBoostTarget' }));
        await run();
        expect(entryAges.pending).toHaveBeenCalledWith('7');
        expect(current.api.applyBoostToEntry).toHaveBeenCalledWith(7, 'a', 'tok');
    });

    test('newest and oldest read the entry ages the ledger holds', async () => {
        entryAges.entryTimes.mockReturnValue({ a: { at: NOW - 900, exact: true }, b: { at: NOW - 100, exact: false } });
        setup(boostOn({ by: 'newest', time: 'observed' }));
        await run();
        expect(entryAges.refresh).toHaveBeenCalled();
        expect(current.api.applyBoostToEntry).toHaveBeenCalledWith(7, 'b', 'tok');
    });

    test('a selection the data cannot decide defers the step: nothing is sent, nothing is guessed', async () => {
        entryAges.entryTimes.mockReturnValue({ a: { at: NOW - 900, exact: true }, b: { at: NOW - 100, exact: false } });
        setup(boostOn({ by: 'oldest', time: 'exact' }));
        await run();
        expect(current.api.applyBoostToEntry).not.toHaveBeenCalled();
        expect(state().lastError).toBeNull();
        expect(log.warning).toHaveBeenCalledWith(
            expect.stringContaining('the boost target cannot be told yet (entry-age-unusable)'),
            null,
        );
    });

    test('evidence that cannot be read defers the step, whatever the selector asks of it', async () => {
        entryAges.health.mockReturnValue({ read: false, refresh: true });
        setup(boostOn({ by: 'pendingBoostTarget' }));
        await run();
        expect(current.api.applyBoostToEntry).not.toHaveBeenCalled();
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('entry-ages-unreadable'), null);
    });

    test('slowest reads the sampled vote history of the record', async () => {
        seed({ history: { a: [[NOW - 2 * H, 0]], b: [[NOW - 2 * H, 0]] } });
        setup(boostOn({ by: 'slowest' }));
        await run();
        expect(current.api.applyBoostToEntry).toHaveBeenCalledWith(7, 'b', 'tok');
    });

    test('matching: the first entry that meets every predicate by the order', async () => {
        setup(
            boostOn({
                by: 'matching',
                where: [{ field: 'votes', op: '>=', value: 3 }],
                order: 'votes',
                direction: 'asc',
            }),
        );
        await run();
        expect(current.api.applyBoostToEntry).toHaveBeenCalledWith(7, 'b', 'tok');
    });

    test('the turbo, the swap and remember take the same targets', async () => {
        setup(
            single([
                { type: 'turbo', entry: { by: 'id', id: 'a' } },
                { type: 'remember', slot: 'x', entry: { by: 'id', id: 'b' } },
            ]),
        );
        await run();
        expect(current.api.applyTurbo).toHaveBeenCalledWith(7, 'a', 'tok');
        expect(state().memory).toEqual({ x: 'b' });
    });

    test('a swap of an entry that has no match is a skip', async () => {
        setup(single([{ type: 'swap', entry: { by: 'id', id: 'zz' }, with: 'best' }]));
        await run();
        expect(state().lastError?.message).toContain('no entry matches the swap target');
    });

    test('the original selectors skip, as they always did, where the newer ones defer', async () => {
        setup(single([{ type: 'remember', slot: 'x', entry: { by: 'fastest' } }]));
        await run();
        expect(state().lastError?.message).toContain('no entry matches');
        expect(state().inFlight).toBeNull();
    });
});

describe('earnTurbo', () => {
    test('plays the Turbo game through its producer and counts the game as done this pass', async () => {
        playAutoTurbo.mockResolvedValue({ kind: 'played', won: true });
        setup(single([{ type: 'earnTurbo' }]));
        await run();
        // a direct game: the Auto-Play Turbo switch is not asked of it
        expect(playAutoTurbo).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), expect.any(Number), current, {
            direct: true,
        });
        expect(state().lastAction).toMatchObject({ action: 'earnTurbo', outcome: 'done' });
        expect(operations.has('earn', '7')).toBe(true);
    });

    test('a game the producer refuses defers: the rule waits, nothing is recorded as done', async () => {
        playAutoTurbo.mockResolvedValue({ kind: 'refused', reason: 'a Snap turbo is played once a pass' });
        setup(single([{ type: 'earnTurbo' }]));
        await run();
        expect(state().lastError).toBeNull();
        expect(state().lastAction).toBeNull();
        expect(operations.has('earn', '7')).toBe(false);
        expect(log.warning).toHaveBeenCalledWith(
            expect.stringContaining('the turbo game was not played (a Snap turbo is played once a pass)'),
            null,
        );
    });

    test('a game that fails is a failed step', async () => {
        playAutoTurbo.mockResolvedValue({ kind: 'failed' });
        setup(single([{ type: 'earnTurbo' }]));
        await run();
        expect(state().lastError?.message).toContain('the turbo game could not be completed');
    });

    test('a game already played for the challenge this pass is not played again', async () => {
        operations.mark('earn', '7');
        setup(single([{ type: 'earnTurbo' }]));
        await run();
        expect(playAutoTurbo).not.toHaveBeenCalled();
        expect(state().lastAction).toMatchObject({ outcome: 'not due: the turbo game was already played this pass' });
    });
});

describe('runAutomation', () => {
    const automation = (operation: string, extra: object = {}) => single([{ type: 'runAutomation', operation }], extra);

    describe('the deadline operations: submit, boost, turbo', () => {
        test.each([
            ['boost', 'boost'],
            ['turbo', 'turbo'],
            ['submit', 'submit'],
        ] as const)('%s runs its normal runner once and is recorded when it was done', async (operation, kind) => {
            runDeadlineOperation.mockResolvedValue(true);
            setup(automation(operation));
            await run();
            expect(runDeadlineOperation).toHaveBeenCalledWith(
                operation,
                expect.objectContaining({ id: 7 }),
                expect.any(Number),
                current,
            );
            expect(state().lastAction).toMatchObject({ action: 'runAutomation', outcome: 'done' });
            expect(operations.has(kind, '7')).toBe(true);
        });

        test('when the normal policy says not now, the step completes, says why, and marks nothing', async () => {
            runDeadlineOperation.mockResolvedValue(false);
            setup(
                single([
                    { type: 'runAutomation', operation: 'boost' },
                    { type: 'remember', slot: 'x', entry: { by: 'id', id: 'a' } },
                ]),
            );
            await run();
            expect(state().lastAction).toMatchObject({ action: 'remember', outcome: 'done' });
            expect(state().memory).toEqual({ x: 'a' });
            expect(state().lastError).toBeNull();
            expect(state().fired.r1).toBeDefined();
            expect(operations.has('boost', '7')).toBe(false);
        });

        test('the reason is on the step that found nothing due', async () => {
            runDeadlineOperation.mockResolvedValue(false);
            setup(automation('turbo'));
            await run();
            expect(state().lastAction).toMatchObject({
                action: 'runAutomation',
                outcome: 'not due: the turbo is not due under its normal policy',
            });
        });
    });

    describe('vote', () => {
        test('votes when the voting rules call for it, and records the vote', async () => {
            evaluateVotingDecision.mockReturnValue(
                invalid({ shouldVote: true, voteReason: 'low', targetExposure: 100 }),
            );
            voteOnChallenge.mockResolvedValue({ cancelled: null, voteThrew: false, votePool: undefined });
            setup(automation('vote'));
            await run();
            expect(evaluateVotingDecision).toHaveBeenCalledWith(
                expect.objectContaining({ id: 7 }),
                expect.any(Number),
                {
                    hasNewEntry: false,
                },
            );
            expect(voteOnChallenge).toHaveBeenCalledWith(
                expect.objectContaining({ id: 7 }),
                expect.objectContaining({ shouldVote: true }),
                current,
                expect.any(Function),
            );
            expect(operations.has('vote', '7')).toBe(true);
        });

        test('the vote is made as the pass makes its own: its landing callback is harmless here', async () => {
            evaluateVotingDecision.mockReturnValue(
                invalid({ shouldVote: true, voteReason: 'low', targetExposure: 100 }),
            );
            voteOnChallenge.mockImplementation(async (_challenge, _decision, _pass, onVoteLanded) => {
                onVoteLanded();
                return { cancelled: null, voteThrew: false, votePool: undefined };
            });
            setup(automation('vote'));
            await run();
            expect(state().lastAction).toMatchObject({ action: 'runAutomation', outcome: 'done' });
        });

        test('when the rules say not to vote, the step completes with their reason and no vote is made', async () => {
            evaluateVotingDecision.mockReturnValue(invalid({ shouldVote: false, voteReason: 'above the threshold' }));
            setup(automation('vote'));
            await run();
            expect(voteOnChallenge).not.toHaveBeenCalled();
            expect(state().lastAction).toMatchObject({ outcome: 'not due: above the threshold' });
            expect(operations.has('vote', '7')).toBe(false);
        });

        test('a cancelled pass defers the step and a vote that threw fails it', async () => {
            evaluateVotingDecision.mockReturnValue(invalid({ shouldVote: true, voteReason: 'low' }));
            voteOnChallenge.mockResolvedValueOnce(invalid({ cancelled: { success: false }, voteThrew: false }));
            setup(automation('vote'));
            await run();
            expect(state().lastError).toBeNull();
            expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('the pass was cancelled'), null);
            voteOnChallenge.mockResolvedValueOnce({ cancelled: null, voteThrew: true, votePool: undefined });
            await run();
            expect(state().lastError?.message).toContain('the vote could not be completed');
        });
    });

    describe('the currency operations go through the normal runner, with the spend written down before its request', () => {
        const ok = { ok: true, raw: {} };
        const duringRequest: { marker: unknown[] } = { marker: [] };

        /** The normal key runner, as it makes its one request through the endpoint it is given (`times`: it asks again). */
        const makesRequest =
            (times = 1) =>
            async (ctx: Parameters<typeof currencyAuto.runAutoKey>[0]) => {
                let last = { ok: false };
                for (let attempt = 0; attempt < times; attempt++) {
                    last = await ctx.currency!.strategy.keyUnlock(7, 'tok');
                    duringRequest.marker.push(state().inFlight);
                }
                return last.ok;
            };

        beforeEach(() => {
            duringRequest.marker = [];
        });

        test('unlockBoost: the marker is in the record while the request is made; a confirmed key is counted once', async () => {
            currencyAuto.runAutoKey.mockImplementation(makesRequest());
            current.currency.strategy.keyUnlock.mockResolvedValue(invalid(ok));
            setup(automation('unlockBoost'));
            await run();
            expect(duringRequest.marker).toEqual([{ ruleId: 'r1', actionIndex: 0, pending: 'unlockBoost' }]);
            expect(current.currency.strategy.keyUnlock).toHaveBeenCalledTimes(1);
            expect(state().spent.keys).toBe(1);
            expect(state().inFlight).toBeNull();
            expect(state().lastAction).toMatchObject({ outcome: 'done' });
            // a key unlock has no operation of its own in the record: its effect shows on the boost
            expect(
                [...['join', 'claim', 'vote', 'boost', 'turbo', 'earn', 'swap', 'fill', 'submit']].some((kind) =>
                    operations.has(kind as 'join', '7'),
                ),
            ).toBe(false);
        });

        test('the runner makes one request per step: a second is refused, and written down no second time', async () => {
            currencyAuto.runAutoKey.mockImplementation(makesRequest(2));
            current.currency.strategy.keyUnlock.mockResolvedValue(invalid(ok));
            setup(automation('unlockBoost'));
            await run();
            expect(current.currency.strategy.keyUnlock).toHaveBeenCalledTimes(1);
            expect(state().spent.keys).toBe(1);
        });

        test('a request that is not made because the runner finds nothing due: not due, no marker, nothing counted', async () => {
            currencyAuto.runAutoKey.mockResolvedValue(false);
            setup(automation('unlockBoost'));
            await run();
            expect(current.currency.strategy.keyUnlock).not.toHaveBeenCalled();
            expect(state().spent.keys ?? 0).toBe(0);
            expect(state().lastAction).toMatchObject({
                outcome: 'not due: the unlockBoost is not due under its normal policy',
            });
        });

        test('a request that got no answer may have gone through: counted, never repeated, and the rule stopped', async () => {
            currencyAuto.runAutoKey.mockImplementation(makesRequest());
            current.currency.strategy.keyUnlock.mockResolvedValue(invalid({ ok: false, raw: null, unclear: true }));
            setup(
                single([
                    { type: 'runAutomation', operation: 'unlockBoost' },
                    { type: 'notify', message: 'after' },
                ]),
            );
            await run();
            expect(state().spent.keys).toBe(1);
            expect(state().inFlight).toMatchObject({ ruleId: 'r1', actionIndex: 0, unclear: ['unlockBoost'] });
            expect(state().lastError?.message).toContain('may have gone through');
            expect(state().outbox).toEqual([]);
            // the next pass only looks at the live challenge: the boost is unlocked, so the spend landed and the rule goes on
            currencyAuto.runAutoKey.mockClear();
            const live = challenge();
            live.member.boost = { state: 'AVAILABLE_KEY' };
            await run(live);
            expect(current.currency.strategy.keyUnlock).toHaveBeenCalledTimes(1);
            expect(currencyAuto.runAutoKey).not.toHaveBeenCalled();
            expect(state().outbox?.map((notice) => notice.message)).toEqual(['after']);
            expect(state().fired.r1).toBeDefined();
        });

        test('…and when the live challenge does not show it, the rule is stopped for the phase rather than spending again', async () => {
            currencyAuto.runAutoKey.mockImplementation(makesRequest());
            current.currency.strategy.keyUnlock.mockResolvedValue(invalid({ ok: false, raw: null, unclear: true }));
            setup(automation('unlockBoost'));
            await run();
            await run();
            expect(current.currency.strategy.keyUnlock).toHaveBeenCalledTimes(1);
            expect(state().fired.r1.unclearHalt).toBe('unlockBoost');
            expect(state().spent.keys).toBe(1);
        });

        test('a request the server refused was not spent: a failed step, no marker left', async () => {
            currencyAuto.runAutoKey.mockImplementation(makesRequest());
            current.currency.strategy.keyUnlock.mockResolvedValue(invalid({ ok: false, raw: null }));
            setup(automation('unlockBoost'));
            await run();
            expect(state().lastError?.message).toContain('the unlockBoost was refused');
            expect(state().inFlight).toBeNull();
            expect(state().spent.keys ?? 0).toBe(0);
        });

        test('a spend whose marker cannot be written down is not made: deferred', async () => {
            currencyAuto.runAutoKey.mockImplementation(makesRequest());
            setup(automation('unlockBoost'));
            const real = ledger.set.bind(ledger);
            let writes = 0;
            jest.spyOn(ledger, 'set').mockImplementation((id, next) => (++writes <= 2 ? real(id, next) : 'failed'));
            await run();
            expect(current.currency.strategy.keyUnlock).not.toHaveBeenCalled();
            expect(log.warning).toHaveBeenCalledWith(
                expect.stringContaining('the unlockBoost could not be written down first, so it was not made'),
                null,
            );
        });

        test('swap: the runner is told whether GuruShots sent a swap history, and a confirmed swap is counted', async () => {
            currencyAuto.runAutoSwap.mockImplementation(async (ctx) => {
                const result = await ctx.currency!.strategy.swapPhoto(7, 'a', 'z', 'tok');
                return result.ok;
            });
            current.currency.strategy.swapPhoto.mockResolvedValue(invalid(ok));
            setup(automation('swap'));
            await run();
            expect(currencyAuto.runAutoSwap).toHaveBeenCalledWith(expect.objectContaining({ swapHistorySent: true }));
            expect(state().spent.swaps).toBe(1);
            expect(operations.has('swap', '7')).toBe(true);
        });

        test('swap: a history GuruShots did not send is passed on as it was read', async () => {
            currencyAuto.runAutoSwap.mockResolvedValue(false);
            setup(automation('swap'));
            const c = challenge();
            delete (c.member.ranking as { swaps?: unknown }).swaps;
            await run(c);
            expect(currencyAuto.runAutoSwap).toHaveBeenCalledWith(expect.objectContaining({ swapHistorySent: false }));
        });

        test('fillExposure: the runner picks the pool itself, a confirmed fill is counted, and counts for the fill mission', async () => {
            missions = { fill: 2, boost: 0, turbo: 0, join: 0, vote: 0 };
            current = pass();
            currencyAuto.runAutoExposureFill.mockImplementation(async (ctx) => {
                const result = await ctx.currency!.strategy.exposureAutofill(7, 'm', 'tok');
                return result.ok;
            });
            current.currency.strategy.exposureAutofill.mockResolvedValue(invalid(ok));
            setup(automation('fillExposure'));
            await run();
            expect(currencyAuto.runAutoExposureFill).toHaveBeenCalledWith(
                expect.objectContaining({ now: expect.any(Number) }),
                undefined,
            );
            expect(state().spent.fills).toBe(1);
            expect(operations.has('fill', '7')).toBe(true);
            expect(missions.fill).toBe(1);
        });

        test('the scenario’s own limit is asked first: a spent allowance runs nothing', async () => {
            setup(single([{ type: 'runAutomation', operation: 'unlockBoost' }], {}, { limits: { keys: 1 } }));
            seed({ spent: { keys: 1 } });
            await run();
            expect(currencyAuto.runAutoKey).not.toHaveBeenCalled();
            expect(state().lastError?.message).toContain("the scenario's keys limit of 1 is reached");
        });
    });

    test('an operation that does not belong to the stage is a skip (a stored document is read back without its validation)', async () => {
        setup(automation('join'));
        await run();
        expect(state().lastError?.message).toContain('join runs before the challenge is joined');
    });

    test('a step that retries a spend with the original request: a changed patch does not aim another', async () => {
        setup(automation('swap'));
        // the step wrote its spend down and never wrote the result; a patch of the settings it reads has changed since
        seed({
            inFlight: { ruleId: 'r1', actionIndex: 0, pending: 'swap' },
            phasePatch: { autoSwapImageIndex: 2 },
        });
        const c = challenge();
        await run(c);
        expect(currencyAuto.runAutoSwap).not.toHaveBeenCalled();
        expect(current.currency.strategy.swapPhoto).not.toHaveBeenCalled();
        // it could not be shown to have landed, so the rule is stopped, the swap counted as spent
        expect(state().fired.r1.unclearHalt).toBe('swap');
        expect(state().spent.swaps).toBe(1);
        expect(state().phasePatch).toEqual({ autoSwapImageIndex: 2 });
    });

    test('an unclear key unlock of a runAutomation step is settled by the live boost, with no request', async () => {
        setup(automation('unlockBoost'));
        seed({
            inFlight: { ruleId: 'r1', actionIndex: 0, unclear: ['unlockBoost'], unclearAt: NOW - 5 },
            spent: { keys: 1 },
        });
        const c = challenge();
        c.member.boost = { state: 'AVAILABLE_KEY' };
        await run(c);
        expect(currencyAuto.runAutoKey).not.toHaveBeenCalled();
        expect(state().fired.r1).toBeDefined();
        // already counted when it was marked: not counted again
        expect(state().spent.keys).toBe(1);
    });
});

describe('setSetting and clearSetting', () => {
    const set = (key: string, value: unknown, more: object[] = []) =>
        single([{ type: 'setSetting', key, value }, ...more]);

    test('a literal is kept in the record as the runtime patch, and the overlay is published again from the record', async () => {
        setup(set('autoBoost', true));
        settings.prepareScenarioSnapshot.mockImplementation((_id, _scenario, record) => ({
            ok: true,
            snapshot: {
                publication: {
                    revision: 1,
                    documentFingerprint: 'abc',
                    phase: record.phase,
                    phaseEnteredAt: record.phaseEnteredAt,
                    observedAt: NOW,
                    validUntil: null,
                    bindings: {},
                    profile: null,
                },
                readSetting: () => ({ state: 'unknown', reason: 'test', dependencies: [] }),
            },
        }));
        await run();
        expect(state().phasePatch).toEqual({ autoBoost: true });
        expect(state().published).toMatchObject({ revision: 1, phase: 'main' });
        // checked as the record it would leave, then published from the record as it stands
        const seen = settings.prepareScenarioSnapshot.mock.calls.map(([, , record]) => record.phasePatch);
        expect(seen).toEqual([undefined, { autoBoost: true }, { autoBoost: true }, { autoBoost: true }]);
        expect(state().lastAction).toMatchObject({ action: 'setSetting', outcome: 'done' });
    });

    test('an expression is worked out as the step runs, with the facts of the subject, and stored in the setting’s form', async () => {
        setup(set('autoBoost', { kind: 'fact', name: 'boost.open' }));
        await run();
        expect(state().phasePatch).toEqual({ autoBoost: true });
        setup(set('autoExposureFillBelow', { kind: 'literal', value: 60, quantity: 'percent' }));
        fresh();
        await run();
        expect(state().phasePatch).toEqual({ autoExposureFillBelow: 60 });
        // a duration is stored in the unit its setting is kept in
        setup(set('autoExposureFillBeforeEnd', { kind: 'literal', value: 2, quantity: 'duration', unit: 'hours' }));
        fresh();
        await run();
        expect(state().phasePatch).toEqual({ autoExposureFillBeforeEnd: 7200 });
    });

    test('a value that cannot be worked out yet defers the step; an absent one skips it; one of the wrong type skips it', async () => {
        setup(set('autoBoost', { kind: 'fact', name: 'rewards.claimable' }));
        await run();
        expect(state().phasePatch).toBeUndefined();
        expect(state().lastError).toBeNull();
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('the value cannot be worked out yet'), null);

        fresh();
        setup(set('autoJoinTypes', { kind: 'fact', name: 'challenge.type' }));
        await run();
        expect(state().lastError?.message).toContain('the value is absent (not-present)');

        fresh();
        setup(set('autoBoost', { kind: 'fact', name: 'challenge.title' }));
        await run(Object.assign(challenge(), { title: 'Spring' }));
        expect(state().lastError?.message).toContain('the value does not fit autoBoost (type-mismatch)');
        expect(state().phasePatch).toBeUndefined();
    });

    test('an expression reads the settings through the facade: the base view, and the view with the published overlay', async () => {
        settings.readScenarioSetting.mockReturnValue({
            state: 'known',
            value: { kind: 'number', value: 40, quantity: 'percent' },
        });
        const read = (view: 'base' | 'effective') =>
            set('autoExposureFillBelow', { kind: 'setting', key: 'autoExposureFillBelow', view });
        setup(read('effective'));
        await run();
        expect(settings.readScenarioSetting).toHaveBeenCalledWith('autoExposureFillBelow', 'effective', '7');
        expect(state().phasePatch).toEqual({ autoExposureFillBelow: 40 });
    });

    test('a key the subject’s scope may not change is a skip, whatever the stored document says', async () => {
        for (const key of ['manualPhotosOnly', 'missionJoinEarly', 'nonsense']) {
            fresh();
            setup(set(key, true));
            await run();
            expect(state().lastError?.message).toContain(`${key} is not a setting a challenge scenario can change`);
            expect(state().phasePatch).toBeUndefined();
        }
    });

    test('a patch the settings refuse changes nothing: the reason is the step’s, atomically', async () => {
        setup(set('exposure', 95, [{ type: 'notify', message: 'later' }]));
        settings.prepareScenarioSnapshot.mockImplementation((_id, _scenario, record) =>
            record.phasePatch?.exposure === undefined
                ? { ok: true, snapshot: { publication: null, readSetting: () => invalid(null) } }
                : { ok: false, key: 'exposure', reason: 'these values conflict' },
        );
        await run();
        expect(state().phasePatch).toBeUndefined();
        expect(state().published).toBeUndefined();
        expect(state().lastError?.message).toContain('the setting was not changed: exposure: these values conflict');
        expect(state().outbox).toEqual([]);
    });

    test('a refusal that names no setting says only why', async () => {
        setup(set('autoBoost', true));
        settings.prepareScenarioSnapshot.mockReturnValueOnce({
            ok: false,
            key: null,
            reason: 'profile-unavailable: X',
        });
        // (the first preparation is the evaluation's own: the rule does not run on a phase it cannot prepare)
        await run();
        expect(state().phasePatch).toBeUndefined();
    });

    test('a patch refused for a candidate record reads as a skip, with the reason as the settings gave it', async () => {
        setup(set('autoBoost', true));
        let calls = 0;
        settings.prepareScenarioSnapshot.mockImplementation(() =>
            ++calls === 2
                ? { ok: false, key: null, reason: 'profile-unavailable: Calm' }
                : { ok: true, snapshot: { publication: null, readSetting: () => invalid(null) } },
        );
        await run();
        expect(state().lastError?.message).toContain('the setting was not changed: profile-unavailable: Calm');
    });

    test('clearSetting takes the key back out, and the last one takes the patch with it', async () => {
        setup(single([{ type: 'clearSetting', key: 'autoBoost' }]));
        seed({ phasePatch: { autoBoost: true, autoSubmit: true } });
        await run();
        expect(state().phasePatch).toEqual({ autoSubmit: true });
        expect(state().lastAction).toMatchObject({ action: 'clearSetting', outcome: 'done' });
        fresh();
        seed({ phasePatch: { autoBoost: true } });
        await run();
        expect(state().phasePatch).toBeUndefined();
    });

    test('clearSetting with no patch at all has nothing to undo either', async () => {
        setup(single([{ type: 'clearSetting', key: 'autoBoost' }]));
        await run();
        expect(state().phasePatch).toBeUndefined();
        expect(state().lastAction).toMatchObject({ action: 'clearSetting', outcome: 'done' });
    });

    test('a record that is gone when the overlay is published again is no error: the runner goes on from the state it held', async () => {
        setup(set('autoBoost', true, [{ type: 'notify', message: 'after' }]));
        let gone = false;
        const get = ledger.get.bind(ledger);
        jest.spyOn(ledger, 'get').mockImplementation((id) =>
            gone ? { state: null, corrupt: false, epoch: { all: 0, gen: 0 } } : get(id),
        );
        // the second preparation is the check of the patch: after it the record reads as gone
        let prepared = 0;
        settings.prepareScenarioSnapshot.mockImplementation(() => {
            if (++prepared === 2) gone = true;
            return { ok: true, snapshot: { publication: null, readSetting: () => invalid(null) } };
        });
        await expect(run()).resolves.toBeDefined();
        expect(prepared).toBeGreaterThanOrEqual(2);
    });

    test('clearSetting of a key nothing patched has nothing to undo', async () => {
        setup(single([{ type: 'clearSetting', key: 'autoBoost' }]));
        seed({ phasePatch: { autoSubmit: true } });
        await run();
        expect(state().phasePatch).toEqual({ autoSubmit: true });
        expect(state().lastAction).toMatchObject({ action: 'clearSetting', outcome: 'done' });
        // only the evaluation of the phase prepared anything: no candidate record was checked
        expect(settings.prepareScenarioSnapshot.mock.calls.map(([, , record]) => record.phasePatch)).toEqual([
            { autoSubmit: true },
            { autoSubmit: true },
        ]);
    });

    test('a clear that leaves settings that do not hold together is refused, and the patch stays as it was', async () => {
        setup(single([{ type: 'clearSetting', key: 'autoBoost' }]));
        seed({ phasePatch: { autoBoost: true, autoSubmit: true } });
        settings.prepareScenarioSnapshot.mockImplementation((_id, _scenario, record) =>
            record.phasePatch?.autoBoost === undefined
                ? { ok: false, key: 'autoSubmit', reason: 'needs autoBoost' }
                : { ok: true, snapshot: { publication: null, readSetting: () => invalid(null) } },
        );
        await run();
        expect(state().phasePatch).toEqual({ autoBoost: true, autoSubmit: true });
        expect(state().lastError?.message).toContain('the setting was not changed: autoSubmit: needs autoBoost');
    });

    test('leaving the phase drops the patch, and the phase it goes to starts from its own settings', async () => {
        setup(
            plan({
                main: {
                    rules: [
                        {
                            id: 'r1',
                            do: [
                                { type: 'setSetting', key: 'autoBoost', value: true },
                                { type: 'goto', phase: 'next' },
                            ],
                        },
                    ],
                },
                next: {},
            }),
        );
        await run();
        expect(state().phase).toBe('next');
        expect(state().phasePatch).toBeUndefined();
        expect(state().phaseProfile).toBeUndefined();
    });
});

describe('useProfile', () => {
    test('uses a saved profile for this phase: its canonical name is kept in the record, and the overlay published again', async () => {
        settings.checkPhaseProfile.mockReturnValue({ ok: true, name: 'Calm' });
        setup(single([{ type: 'useProfile', name: 'calm' }]));
        await run();
        expect(settings.checkPhaseProfile).toHaveBeenCalledWith('calm');
        expect(state().phaseProfile).toBe('Calm');
        const seen = settings.prepareScenarioSnapshot.mock.calls.map(([, , record]) => record.phaseProfile);
        expect(seen).toEqual([undefined, 'Calm', 'Calm', 'Calm']);
    });

    test('null: no phase profile, and nothing to look up', async () => {
        setup(single([{ type: 'useProfile', name: null }]));
        await run();
        expect(settings.checkPhaseProfile).not.toHaveBeenCalled();
        expect(state().phaseProfile).toBeNull();
    });

    test('a profile that is missing, or holds a key a phase cannot change, refuses the step with the reason', async () => {
        settings.checkPhaseProfile.mockReturnValue({ ok: false, reason: 'there is no profile named "Nope"' });
        setup(single([{ type: 'useProfile', name: 'Nope' }]));
        await run();
        expect(state().lastError?.message).toContain('there is no profile named "Nope"');
        expect(state().phaseProfile).toBeUndefined();
        expect(state().inFlight).toBeNull();
    });

    test('a profile whose settings cannot be prepared with the rest changes nothing', async () => {
        settings.checkPhaseProfile.mockReturnValue({ ok: true, name: 'Calm' });
        setup(single([{ type: 'useProfile', name: 'Calm' }]));
        settings.prepareScenarioSnapshot.mockImplementation((_id, _scenario, record) =>
            record.phaseProfile === undefined
                ? { ok: true, snapshot: { publication: null, readSetting: () => invalid(null) } }
                : { ok: false, key: null, reason: 'these values conflict' },
        );
        await run();
        expect(state().phaseProfile).toBeUndefined();
        expect(state().lastError?.message).toContain('the profile was not changed: these values conflict');
    });
});

describe('pauseScenario', () => {
    test('pauses the subject with the reason, keeps its progress, and stops the rule at its next step', async () => {
        setup(
            single([
                { type: 'remember', slot: 'x', entry: { by: 'id', id: 'a' } },
                { type: 'pauseScenario', reason: 'cooling off' },
                { type: 'notify', message: 'after' },
            ]),
        );
        await run();
        expect(state().paused).toEqual({ at: expect.any(Number), reason: 'cooling off' });
        expect(state().memory).toEqual({ x: 'a' });
        expect(state().inFlight).toEqual({ ruleId: 'r1', actionIndex: 2 });
        expect(state().outbox).toEqual([]);
        // a paused subject runs nothing more, and publishes nothing
        const prepared = settings.prepareScenarioSnapshot.mock.calls.length;
        await run();
        expect(state().outbox).toEqual([]);
        expect(settings.prepareScenarioSnapshot.mock.calls.length).toBe(prepared);
        expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('scenario is paused'), null);
    });

    test('a pause that is the last step lets the rule finish; no reason keeps an empty one', async () => {
        setup(single([{ type: 'pauseScenario' }]));
        await run();
        expect(state().paused).toEqual({ at: expect.any(Number), reason: '' });
        expect(state().fired.r1).toBeDefined();
        expect(state().inFlight).toBeNull();
    });

    test('Manual Only is not set by a pause', async () => {
        setup(single([{ type: 'pauseScenario', reason: 'asleep' }]));
        await run();
        expect(settings.getEffectiveSetting).not.toHaveBeenCalledWith('manualPhotosOnly', expect.anything());
    });
});

describe('handoffScenario', () => {
    const handoff = (to: string | null, before: object[] = []) => single([...before, { type: 'handoffScenario', to }]);

    test('hands the subject to the scenario at its current generation, as the step of the rule in progress', async () => {
        settings.requestScenarioHandoff.mockResolvedValue({ ok: true, generation: 4 });
        setup(handoff('Other', [{ type: 'remember', slot: 'x', entry: { by: 'id', id: 'a' } }]));
        seed({ generation: 3 });
        await run();
        expect(settings.requestScenarioHandoff).toHaveBeenCalledWith('7', 'Other', 3, { ruleId: 'r1', actionIndex: 1 });
        // the record is the next scenario's now: the runner writes nothing more to it, and the rule is not recorded as fired
        expect(state().fired.r1).toBeUndefined();
        expect(state().lastError).toBeNull();
    });

    test('a handoff that is the first step has no rule in progress to name; none is a legal target', async () => {
        settings.requestScenarioHandoff.mockResolvedValue({ ok: true, generation: 1 });
        setup(handoff(null));
        await run();
        expect(settings.requestScenarioHandoff).toHaveBeenCalledWith('7', null, 0, undefined);
        expect(state().fired.r1).toBeUndefined();
    });

    test('a refusal that the user must look at stops the rule with the reason and changes nothing', async () => {
        settings.requestScenarioHandoff.mockResolvedValue({ ok: false, reason: 'unresolved-spend' });
        setup(handoff('Other', [{ type: 'remember', slot: 'x', entry: { by: 'id', id: 'a' } }]));
        await run();
        expect(state().lastError?.message).toContain('the handoff was refused (unresolved-spend)');
        expect(state().fired.r1).toBeUndefined();
        expect(state().inFlight).toEqual({ ruleId: 'r1', actionIndex: 1 });
        expect(state().paused).toBeUndefined();
    });

    test.each(['busy', 'not-saved', 'state-unreadable'] as const)(
        '%s defers the step: nothing is recorded as wrong',
        async (reason) => {
            settings.requestScenarioHandoff.mockResolvedValue({ ok: false, reason });
            setup(handoff('Other'));
            await run();
            expect(state().lastError).toBeNull();
            expect(log.warning).toHaveBeenCalledWith(
                expect.stringContaining(`the handoff was refused (${reason})`),
                null,
            );
        },
    );

    test('is tried again on the next pass, from the step that stopped', async () => {
        settings.requestScenarioHandoff.mockResolvedValueOnce({ ok: false, reason: 'busy' });
        settings.requestScenarioHandoff.mockResolvedValueOnce({ ok: true, generation: 1 });
        setup(handoff('Other'));
        await run();
        await run();
        expect(settings.requestScenarioHandoff).toHaveBeenCalledTimes(2);
    });
});

describe('the operation record is shared with the earn and the checks of the pass', () => {
    test('a step that is done for the challenge this pass marks only what it did', async () => {
        autoFill.refreshChallengeState.mockResolvedValue('refreshed');
        playAutoTurbo.mockResolvedValue({ kind: 'played', won: false });
        setup(single([{ type: 'earnTurbo' }]));
        await run();
        expect(operations.has('earn', '7')).toBe(true);
        expect(operations.has('turbo', '7')).toBe(false);
    });
});
