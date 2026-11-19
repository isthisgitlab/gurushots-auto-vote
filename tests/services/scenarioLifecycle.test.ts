/**
 * The lifecycle coordinator (services/scenarioRunner/lifecycle.ts): one cycle's scenario work routed through the
 * installation, pre-join, active and post-close stages over the one runner and the existing producers. The settings facade
 * is stubbed and the progress ledger is a real in-memory one; the join itself (performJoin) and the claim endpoints are
 * spied on, so what is asserted is what the stages decide and what they hand to the producers.
 */

jest.mock('../../src/ts/core/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warning: jest.fn(), success: jest.fn() };
    return {
        withCategory: jest.fn(() => category),
        challengeTag: jest.fn((c: { id?: string | number } | null | undefined) => `[${c?.id}]`),
        __category: category,
    };
});
jest.mock('../../src/ts/core/settings', () => ({
    __esModule: true,
    getScenarios: jest.fn(),
    getScenario: jest.fn(),
    getChallengeOverride: jest.fn(),
    resolveRuleSetting: jest.fn(),
    resolveRuleSettingGroup: jest.fn(() => null),
    hasRuleJoinOptIn: jest.fn(() => false),
    getEffectiveSetting: jest.fn(),
    captureInstallationSettings: jest.fn(),
    getTitleRules: jest.fn(() => []),
    getChallengeProfiles: jest.fn(() => ({})),
    scenarioSubjectAvailable: jest.fn(() => true),
    getSetting: jest.fn(() => 'UTC'),
    unresolvedScenarioWork: jest.fn(() => false),
    settleHandoff: jest.fn(() => 'finished'),
    rememberPostCloseListing: jest.fn(),
    prepareScenarioSnapshot: jest.fn(() => ({
        ok: true,
        snapshot: { publication: null, readSetting: () => ({ state: 'unknown', reason: 'test', dependencies: [] }) },
    })),
    getInstallationScenario: jest.fn(),
    installationGeneration: jest.fn(),
    prepareInstallationSnapshot: jest.fn(),
    getEntryPins: jest.fn(() => ({ boost: null, turbo: null })),
    scenarioCapability: jest.fn(),
    readScenarioSetting: jest.fn(),
    readInstallationSetting: jest.fn(),
    checkPhaseProfile: jest.fn(),
    requestScenarioHandoff: jest.fn(),
}));
jest.mock('../../src/ts/core/voting/cancellation', () => ({ isCancelled: jest.fn(() => false) }));
jest.mock('../../src/ts/core/services/joinChallenges/performJoin', () => ({ performJoin: jest.fn() }));
jest.mock('../../src/ts/core/services/autoFill', () => ({
    refreshChallengeState: jest.fn(async () => 'refreshed'),
    reflectEntryFlag: jest.fn(),
}));

import loggerModule = require('../../src/ts/core/logger');
import settingsModule = require('../../src/ts/core/settings');
import cancellationModule = require('../../src/ts/core/voting/cancellation');
import performJoinModule = require('../../src/ts/core/services/joinChallenges/performJoin');
import autoFillModule = require('../../src/ts/core/services/autoFill');
import type * as lifecycleModule from '../../src/ts/core/services/scenarioRunner/lifecycle';
import type * as joinChallengesModule from '../../src/ts/core/services/joinChallenges';
import type * as autoClaimModule from '../../src/ts/core/services/autoClaim';
import type * as scenarioRunnerModule from '../../src/ts/core/services/scenarioRunner';
import type * as runnerFactsModule from '../../src/ts/core/services/scenarioRunner/facts';
import type * as unlockMarkerModule from '../../src/ts/core/services/joinChallenges/unlockMarker';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { ScenarioDocument } from '../../src/ts/core/settings/scenarioSchema';
import type { ScenarioState } from '../../src/ts/core/types/stores';
import type { CategoryLogger } from '../../src/ts/core/logger';
import type { JoinDeps } from '../../src/ts/core/services/joinChallenges';
import type { ClaimDeps } from '../../src/ts/core/services/autoClaim';
import type { LifecycleDeps } from '../../src/ts/core/services/scenarioRunner/lifecycle';
import { createStateLedger, createMemoryStateLedger, initialState } from '../../src/ts/core/scenarioStateStore';
import { createMemoryRawJsonStore } from '../../src/ts/core/parseUntrustedJson';
import { createOperationRecord } from '../../src/ts/core/scenarios/runtime';
import { installTestPlatform } from '../helpers/platform';
import { invalid } from '../helpers/invalid';

const settings = jest.mocked(settingsModule);
const cancellation = jest.mocked(cancellationModule);
const { performJoin } = jest.mocked(performJoinModule);
const autoFill = jest.mocked(autoFillModule);
const { createLifecycle } = require('../../src/ts/core/services/scenarioRunner/lifecycle') as typeof lifecycleModule;
const { runJoinPass } = require('../../src/ts/core/services/joinChallenges') as typeof joinChallengesModule;
const { runClaimPass, resetClaimThrottle, claimChallengeReward, claimMissionReward } =
    require('../../src/ts/core/services/autoClaim') as typeof autoClaimModule;
const { runScenarioStep } = require('../../src/ts/core/services/scenarioRunner') as typeof scenarioRunnerModule;
const { evidenceNeeded } = require('../../src/ts/core/services/scenarioRunner/facts') as typeof runnerFactsModule;
const { claimUnlock } = require('../../src/ts/core/services/joinChallenges/unlockMarker') as typeof unlockMarkerModule;

type CategoryMock = {
    [K in 'info' | 'error' | 'debug' | 'warning' | 'success']: jest.MockedFunction<CategoryLogger[K]>;
};
const log = (loggerModule as typeof loggerModule & { __category: CategoryMock }).__category;

const NOW = Math.floor(Date.now() / 1000);
const KEY = '@installation';

// --- fixtures ---------------------------------------------------------------------------------------------------------

const candidate = (over: Record<string, unknown> = {}) =>
    invalid<Challenge>({
        id: 7,
        title: 'Spring',
        start_time: NOW - 3600,
        close_time: NOW + 86400,
        join_coins: 0,
        players: 3,
        max_players: 100,
        ...over,
    });

const plan = (phases: Record<string, object>, extra: Record<string, unknown> = {}) =>
    invalid<ScenarioDocument>({ name: 'Plan', version: 1, start: 'main', phases, ...extra });
const rule = (id: string, actions: object[], extra: Record<string, unknown> = {}) => ({ id, do: actions, ...extra });
const preJoin = (actions: object[], extra: Record<string, unknown> = {}) =>
    plan({ main: { rules: [rule('r1', actions, { stages: ['preJoin'], ...extra })] } });
const postClose = (actions: object[], extra: Record<string, unknown> = {}) =>
    plan({ main: { rules: [rule('r1', actions, { stages: ['postClose'], ...extra })] } });
const account = (actions: object[], extra: Record<string, unknown> = {}, phases: Record<string, object> = {}) =>
    plan({ main: { rules: [rule('r1', actions, extra)] }, ...phases }, { name: 'Account plan', scope: 'installation' });

const coins = (value: number) => ({ kind: 'literal', value, quantity: 'coins' });
const claimable = (id: number | string, state = 'CLAIM') => ({
    id,
    title: 'Spring',
    member: { rewards_by_section: { claim_state: state, sections: [] } },
});

// --- the stubbed world ------------------------------------------------------------------------------------------------

let ledger: ReturnType<typeof createMemoryStateLedger>;
let scenarios: Record<string, ScenarioDocument>;
let assigned: Record<string, string>;
let config: Record<string, unknown>;
let operations: ReturnType<typeof createOperationRecord>;
let bankroll: { keys: number; swaps: number; fills: number; coins: number } | null;
let completed: unknown[] | null;
let missions: unknown[] | null;

const getBankroll = jest.fn(async () => bankroll);
const getMyCompletedChallenges = jest.fn(async () => completed);
const getMyMissions = jest.fn(async () => missions);
const claimChallengeResources = jest.fn(async (_id: string | number, _token: string) => true);
const claimMissionPrize = jest.fn(async (_id: string | number, _token: string) => true);

const claims = (): ClaimDeps => ({
    getMyCompletedChallenges: invalid(getMyCompletedChallenges),
    claimChallengeResources: invalid(claimChallengeResources),
    getMyMissions: invalid(getMyMissions),
    claimMissionPrize: invalid(claimMissionPrize),
});

const deps = (over: Partial<LifecycleDeps> = {}): LifecycleDeps => ({
    token: 'tok',
    ledger,
    reads: {
        getBankroll,
        getMyMissions: invalid(getMyMissions),
        getMyCompletedChallenges: invalid(getMyCompletedChallenges),
    },
    claims: claims(),
    ...over,
});

const lifecycle = (over: Partial<LifecycleDeps> = {}) => createLifecycle(deps(over), operations);

/** What the post-close passes handed to the cleanup, in order (null: forgotten). */
const rememberedCalls = () => settings.rememberPostCloseListing.mock.calls.map((call) => call[0]);
/** What the last pass remembered. */
const listing = () => rememberedCalls().at(-1);

const record = (id: string | number = 7) => ledger.get(id).state as ScenarioState;

const seed = (id: string | number, name: string, over: Partial<ScenarioState> = {}) =>
    ledger.change(String(id), () => ({ ...initialState(name, 'main', NOW - 100), ...over }));

/** The join pass over one open list, with the lifecycle's pre-join hook, the way the strategies run it. */
const joinDeps = (list: Challenge[], over: Partial<JoinDeps> = {}, hook = lifecycle().preJoin): JoinDeps =>
    invalid<JoinDeps>({
        getMemberChallenges: jest.fn(async () => list),
        getBankroll: jest.fn(async () => bankroll),
        joinStateStore: null,
        preJoin: hook,
        ...over,
    });

/** One cycle's join pass: each starts with a record of its own. */
const passOver = (list: Challenge[], needs: object | null = null, over: Partial<JoinDeps> = {}) => {
    operations = createOperationRecord();
    return runJoinPass('tok', Date.now(), joinDeps(list, over), invalid(needs));
};

beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(loggerModule.withCategory).mockReturnValue(invalid(log));
    jest.mocked(loggerModule.challengeTag).mockImplementation(
        (c: unknown) => `[${(c as { id?: string | number } | null | undefined)?.id}]`,
    );
    installTestPlatform();
    resetClaimThrottle();
    ledger = createMemoryStateLedger();
    operations = createOperationRecord();
    scenarios = {};
    assigned = {};
    config = { autoJoin: false, autoJoinMaxCoins: 150, autoJoinCycleCoinBudget: 300, autoClaimPrizes: false };
    bankroll = { keys: 5, swaps: 5, fills: 5, coins: 500 };
    completed = [];
    missions = [];
    settings.getScenarios.mockImplementation(() => scenarios);
    settings.getScenario.mockImplementation((name) => scenarios[String(name)] ?? null);
    settings.getChallengeOverride.mockImplementation(((key: string, id: string | number) =>
        key === 'scenario' ? (assigned[String(id)] ?? null) : null) as typeof settings.getChallengeOverride);
    settings.resolveRuleSetting.mockReturnValue(null);
    settings.resolveRuleSettingGroup.mockReturnValue(null);
    settings.getEffectiveSetting.mockImplementation(((key: string, id?: unknown) =>
        key === 'scenario' && id ? (assigned[String(id)] ?? '') : config[key]) as typeof settings.getEffectiveSetting);
    settings.captureInstallationSettings.mockImplementation(((keys: string[]) => ({
        ok: true,
        values: Object.fromEntries(keys.map((key) => [key, config[key]])),
    })) as typeof settings.captureInstallationSettings);
    settings.getTitleRules.mockReturnValue([]);
    settings.getChallengeProfiles.mockReturnValue({});
    settings.hasRuleJoinOptIn.mockReturnValue(false);
    settings.scenarioSubjectAvailable.mockReturnValue(true);
    settings.getSetting.mockReturnValue('UTC');
    settings.unresolvedScenarioWork.mockReturnValue(false);
    settings.settleHandoff.mockReturnValue('finished');
    settings.prepareScenarioSnapshot.mockReturnValue({
        ok: true,
        snapshot: { publication: null, readSetting: () => ({ state: 'unknown', reason: 'test', dependencies: [] }) },
    });
    settings.getEntryPins.mockReturnValue({ boost: null, turbo: null });
    settings.scenarioCapability.mockImplementation(
        jest.requireActual<typeof import('../../src/ts/core/settings/scenarioCapabilities')>(
            '../../src/ts/core/settings/scenarioCapabilities',
        ).scenarioCapability,
    );
    cancellation.isCancelled.mockReturnValue(false);
    performJoin.mockResolvedValue({ status: 'joined', charged: 0 });
    autoFill.refreshChallengeState.mockResolvedValue('refreshed');
    claimChallengeResources.mockResolvedValue(true);
    claimMissionPrize.mockResolvedValue(true);
    getBankroll.mockImplementation(async () => bankroll);
    getMyCompletedChallenges.mockImplementation(async () => completed);
    getMyMissions.mockImplementation(async () => missions);
});

// --- before the join --------------------------------------------------------------------------------------------------

describe('a candidate’s scenario decides before the Auto Join gates', () => {
    test('a candidate joins through its pre-join rule while the inherited Auto Join is off', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';

        const result = await passOver([candidate()]);

        expect(result).toEqual({ ran: true, joined: 1, results: [{ id: 7, status: 'joined' }] });
        expect(performJoin).toHaveBeenCalledTimes(1);
        expect(performJoin.mock.calls[0][0]).toEqual(expect.objectContaining({ id: 7 }));
        expect(performJoin.mock.calls[0][3]).toBe(0);
        expect(record().fired.r1).toBeDefined();
        expect(record().lastAction).toEqual(expect.objectContaining({ ruleId: 'r1', action: 'join', outcome: 'done' }));
    });

    test('with no scenario that has pre-join rules the pass is skipped as it always was: nothing is listed or joined', async () => {
        scenarios.Plan = plan({ main: { rules: [rule('r1', [{ type: 'notify', message: 'x' }])] } });
        assigned['7'] = 'Plan';
        const deps = joinDeps([candidate()]);

        await expect(runJoinPass('tok', Date.now(), deps, null)).resolves.toEqual({
            ran: false,
            joined: 0,
            results: [],
        });

        expect(deps.getMemberChallenges).not.toHaveBeenCalled();
        expect(performJoin).not.toHaveBeenCalled();
    });

    test('a candidate without pre-join rules is decided as today: refused by the Auto Join switch, or joined by it', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        // the pass is alive (a scenario has pre-join rules) but this candidate has none assigned
        await expect(passOver([candidate({ id: 8 })])).resolves.toEqual({
            ran: true,
            joined: 0,
            results: [{ id: 8, status: 'skipped:autojoin-off' }],
        });
        expect(ledger.get(8).state).toBeNull();

        config.autoJoin = true;
        await expect(passOver([candidate({ id: 8 })])).resolves.toEqual({
            ran: true,
            joined: 1,
            results: [{ id: 8, status: 'joined' }],
        });
    });

    test('an assignment from a title rule decides too, and one that is not a challenge scenario does not', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        settings.resolveRuleSetting.mockImplementation((key) => (key === 'scenario' ? { value: 'Plan' } : null));
        await expect(passOver([candidate()])).resolves.toEqual(expect.objectContaining({ joined: 1 }));

        scenarios.Plan = { ...preJoin([{ type: 'join' }]), scope: 'installation' };
        ledger = createMemoryStateLedger();
        performJoin.mockClear();
        await expect(passOver([candidate()])).resolves.toEqual(expect.objectContaining({ joined: 0 }));
        expect(performJoin).not.toHaveBeenCalled();
    });

    test('Manual Only and unreadable scenario settings still refuse the join: they are not gates the scenario passes', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';
        config.manualPhotosOnly = true;
        await expect(passOver([candidate()])).resolves.toEqual(
            expect.objectContaining({ results: [{ id: 7, status: 'skipped:manual-photos-only' }] }),
        );
        config.manualPhotosOnly = false;
        settings.scenarioSubjectAvailable.mockReturnValue(false);
        await expect(passOver([candidate()])).resolves.toEqual(
            expect.objectContaining({ results: [{ id: 7, status: 'skipped:scenario-unavailable' }] }),
        );
        expect(performJoin).not.toHaveBeenCalled();
    });

    test('the timing windows do not apply: the scenario’s own conditions are the timing', async () => {
        config.autoJoinWithinHoursOfEnd = 1;
        settings.resolveRuleSettingGroup.mockReturnValue({ values: { autoJoinWithinHoursOfEnd: 1 } });
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';
        // closes in a day, the window is the last hour: the pass's own gate would say too early
        await expect(passOver([candidate()])).resolves.toEqual(expect.objectContaining({ joined: 1 }));
    });

    test('the same progress record continues across the join: the active stage resumes the phase the pre-join rule left', async () => {
        scenarios.Plan = plan({
            main: {
                rules: [rule('enter', [{ type: 'join' }, { type: 'goto', phase: 'live' }], { stages: ['preJoin'] })],
            },
            live: { rules: [rule('say', [{ type: 'notify', message: 'joined and running' }])] },
        });
        assigned['7'] = 'Plan';

        await passOver([candidate()]);
        const afterJoin = record();
        expect(afterJoin.phase).toBe('live');
        expect(afterJoin.fired.enter).toBeDefined();

        // the same subject, now joined: the voting pass's step runs the active rule of the phase it is in
        const joined = candidate({ member: { ranking: { entries: [] } } });
        const pass = {
            token: 'tok',
            api: { getActiveChallenges: jest.fn() },
            fillDeps: {},
            currency: { strategy: { getBankroll } },
            scenarios: { ledger },
            operations,
        };
        await runScenarioStep(joined, NOW, invalid(pass));

        const after = record();
        expect(after.phaseEnteredAt).toBe(afterJoin.phaseEnteredAt);
        expect(after.fired.enter).toEqual(afterJoin.fired.enter);
        expect(after.fired.say).toBeDefined();
        expect(after.outbox?.map((item) => item.message)).toEqual(['joined and running']);
    });

    test('a rule of another stage that was interrupted is left as it is by this stage', async () => {
        scenarios.Plan = plan({
            main: {
                rules: [
                    rule('enter', [{ type: 'join' }, { type: 'notify', message: 'x' }], { stages: ['preJoin'] }),
                    rule('say', [{ type: 'notify', message: 'active' }]),
                ],
            },
        });
        assigned['7'] = 'Plan';
        seed(7, 'Plan', { inFlight: { ruleId: 'enter', actionIndex: 1 } });
        const pass = {
            token: 'tok',
            api: {},
            fillDeps: {},
            currency: { strategy: { getBankroll } },
            scenarios: { ledger },
        };

        await runScenarioStep(candidate({ member: { ranking: { entries: [] } } }), NOW, invalid(pass));

        expect(record().outbox).toEqual([]);
        expect(record().inFlight).toEqual({ ruleId: 'enter', actionIndex: 1 });
    });
});

describe('the price limit of a join', () => {
    const paid = (maxCoins?: object) => preJoin([{ type: 'join', ...(maxCoins ? { maxCoins } : {}) }]);
    const run = (price = 80) => {
        assigned['7'] = 'Plan';
        return passOver([candidate({ join_coins: price })]);
    };

    test('a paid join goes through the same decision and performJoin, at the price it was decided at', async () => {
        scenarios.Plan = paid();
        const result = await run(80);
        expect(result.results).toEqual([{ id: 7, status: 'joined' }]);
        expect(performJoin).toHaveBeenCalledWith(
            expect.objectContaining({ id: 7 }),
            'tok',
            expect.anything(),
            80,
            expect.objectContaining({ submitOnly: false, coinsBefore: 500, priceCeiling: 80 }),
        );
    });

    test('a limit narrower than the price refuses the join; one wider than the existing cap does not widen it', async () => {
        scenarios.Plan = paid(coins(50));
        expect((await run(80)).results).toEqual([{ id: 7, status: 'skipped:over-per-challenge-cap' }]);
        expect(performJoin).not.toHaveBeenCalled();

        config.autoJoinMaxCoins = 60;
        scenarios.Plan = paid(coins(500));
        ledger = createMemoryStateLedger();
        expect((await run(80)).results).toEqual([{ id: 7, status: 'skipped:over-per-challenge-cap' }]);

        // a limit that covers the price, under a cap that does too, joins
        config.autoJoinMaxCoins = 150;
        scenarios.Plan = paid(coins(100));
        ledger = createMemoryStateLedger();
        expect((await run(80)).results).toEqual([{ id: 7, status: 'joined' }]);
    });

    test('with the paid cap off, a limit does not turn it on', async () => {
        config.autoJoinMaxCoins = 0;
        scenarios.Plan = paid(coins(500));
        expect((await run(80)).results).toEqual([{ id: 7, status: 'skipped:paid-disabled' }]);
    });

    test('a limit read from the balance is worked out now, from a fresh read', async () => {
        scenarios.Plan = paid({ kind: 'fact', name: 'balance.coins' });
        bankroll = { keys: 0, swaps: 0, fills: 0, coins: 70 };
        // the limit is the balance, 70: under the price
        expect((await run(80)).results).toEqual([{ id: 7, status: 'skipped:over-per-challenge-cap' }]);
        bankroll = { keys: 0, swaps: 0, fills: 0, coins: 500 };
        ledger = createMemoryStateLedger();
        expect((await run(80)).results).toEqual([{ id: 7, status: 'joined' }]);
    });

    test('with the scenario’s coin limit and a price limit both, the narrower of them is the cap', async () => {
        scenarios.Plan = { ...paid(coins(50)), limits: { coins: 100 } };
        expect((await run(80)).results).toEqual([{ id: 7, status: 'skipped:over-per-challenge-cap' }]);
        scenarios.Plan = { ...paid(coins(500)), limits: { coins: 100 } };
        ledger = createMemoryStateLedger();
        expect((await run(80)).results).toEqual([{ id: 7, status: 'joined' }]);
    });

    test('a limit that cannot be worked out defers the join: nothing is joined on a guess', async () => {
        scenarios.Plan = paid({ kind: 'fact', name: 'balance.coins' });
        bankroll = null;
        const result = await run(80);
        expect(performJoin).not.toHaveBeenCalled();
        expect(result.joined).toBe(0);
        // the rule did not fire: it is tried again next pass
        expect(record().fired).toEqual({});
        expect(record().inFlight).toBeNull();
    });

    test('a limit that is not an amount of coins is no limit: the join defers too', async () => {
        scenarios.Plan = paid({ kind: 'literal', value: true });
        await run(80);
        expect(performJoin).not.toHaveBeenCalled();
    });

    test('the scenario’s coin limit is what it may still spend: spent coins are taken off it, never added to the cap', async () => {
        scenarios.Plan = { ...paid(), limits: { coins: 100 } };
        assigned['7'] = 'Plan';
        seed(7, 'Plan', { spent: { swaps: 0, keys: 0, fills: 0, coins: 30 } });
        // 70 left: an 80-coin join is over it
        expect((await passOver([candidate({ join_coins: 80 })])).results).toEqual([
            { id: 7, status: 'skipped:over-per-challenge-cap' },
        ]);
        // a 60-coin one is not
        performJoin.mockResolvedValue({ status: 'joined', charged: 60 });
        expect((await passOver([candidate({ join_coins: 60 })])).results).toEqual([{ id: 7, status: 'joined' }]);
        expect(record().spent.coins).toBe(90);
        // a limit of 0 means no paid join at all
        scenarios.Plan = { ...paid(), limits: { coins: 0 } };
        ledger = createMemoryStateLedger();
        expect((await passOver([candidate({ join_coins: 60 })])).results).toEqual([
            { id: 7, status: 'skipped:paid-disabled' },
        ]);
    });
});

describe('what a join came to', () => {
    const rulePlan = () => {
        scenarios.Plan = preJoin([{ type: 'join' }, { type: 'notify', message: 'after the join' }]);
        assigned['7'] = 'Plan';
    };

    test('a landed join counts the coins it spent and carries the rule on', async () => {
        rulePlan();
        performJoin.mockResolvedValue({ status: 'joined', charged: 80 });
        await passOver([candidate({ join_coins: 80 })]);
        expect(record().spent.coins).toBe(80);
        expect(record().outbox?.map((item) => item.message)).toEqual(['after the join']);
    });

    test('a join that is paid for and not entered is retried from its step, counted, and never unlocked again', async () => {
        rulePlan();
        const store = createMemoryRawJsonStore();
        const deps = { joinStateStore: store, refreshJoinState: async () => true };
        performJoin.mockResolvedValueOnce({ status: 'charged-pending-submit', charged: 80 });
        const first = await passOver([candidate({ join_coins: 80 })], null, deps);
        expect(first.results).toEqual([{ id: 7, status: 'charged-pending-submit' }]);
        expect(record().spent.coins).toBe(80);
        expect(record().inFlight).toEqual({ ruleId: 'r1', actionIndex: 0 });
        expect(record().outbox).toEqual([]);

        // the claim the unlock wrote is on file; the retry continues on it: submit only, the price and the caps not asked
        await claimUnlock(invalid<JoinDeps>(deps), 7, 500);
        config.autoJoinMaxCoins = 0;
        performJoin.mockResolvedValueOnce({ status: 'joined', charged: 0 });
        const second = await passOver([candidate({ join_coins: 80 })], null, deps);
        expect(second.results).toEqual([{ id: 7, status: 'joined' }]);
        expect(performJoin).toHaveBeenLastCalledWith(
            expect.anything(),
            'tok',
            expect.anything(),
            80,
            expect.objectContaining({ submitOnly: true }),
        );
        // not counted twice, and the rule went on past its step
        expect(record().spent.coins).toBe(80);
        expect(record().outbox?.map((item) => item.message)).toEqual(['after the join']);
        expect(record().inFlight).toBeNull();
    });

    test('an unlock that got no answer counts as spent, so the limit holds', async () => {
        rulePlan();
        performJoin.mockResolvedValueOnce({ status: 'charged-pending-submit', charged: 0, maybeCharged: 80 });
        await passOver([candidate({ join_coins: 80 })]);
        expect(record().spent.coins).toBe(80);
        expect(record().inFlight).toEqual({ ruleId: 'r1', actionIndex: 0 });
    });

    test('paid earlier and not entered, with nothing spent this time, still resumes at the join', async () => {
        rulePlan();
        performJoin.mockResolvedValueOnce({ status: 'charged-pending-submit', charged: 0 });
        await passOver([candidate({ join_coins: 80 })]);
        expect(record().spent.coins ?? 0).toBe(0);
        expect(record().inFlight).toEqual({ ruleId: 'r1', actionIndex: 0 });
    });

    test.each([
        ['busy', 'defers: tried again, no problem shown', false],
        ['failed-no-charge', 'fails: tried again, shown', true],
        ['skipped-no-photo', 'is a skip: the rule is not fired', true],
    ])('a join that is %s %s', async (status, _what, shown) => {
        rulePlan();
        performJoin.mockResolvedValueOnce({ status, charged: 0 });
        await passOver([candidate()]);
        expect(record().fired).toEqual({});
        expect(Boolean(record().lastError)).toBe(shown);
        expect(record().outbox).toEqual([]);
    });

    test('a join that threw fails the step and spends nothing', async () => {
        rulePlan();
        performJoin.mockRejectedValueOnce(new Error('boom'));
        const result = await passOver([candidate()]);
        expect(result.results).toEqual([{ id: 7, status: 'error' }]);
        expect(record().lastError?.message).toContain('error');
        expect(record().spent.coins ?? 0).toBe(0);
    });
});

describe('one decision, one budget, no repeat', () => {
    test('the cycle’s coin budget is shared by the scenario’s joins and the pass’s own', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';
        config.autoJoin = true;
        config.autoJoinMaxCoins = 250;
        performJoin.mockResolvedValue({ status: 'joined', charged: 200 });
        const result = await passOver([candidate({ join_coins: 200 }), candidate({ id: 8, join_coins: 150 })]);
        expect(result.results).toEqual([
            { id: 7, status: 'joined' },
            { id: 8, status: 'skipped:over-cycle-budget' },
        ]);
        expect(performJoin).toHaveBeenCalledTimes(1);
    });

    test('what the scenario joined is not joined again by the pass in the same cycle, nor is a free repeat made', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';
        config.autoJoin = true;
        const hook = lifecycle().preJoin;
        const deps = joinDeps([candidate(), candidate()], {}, hook);
        const result = await runJoinPass('tok', Date.now(), deps, null);
        // one candidate listed twice: the scenario joins it, the second sighting is not joined again
        expect(result.results.map((item) => item.status)).toEqual(['joined', 'skipped:done-this-pass']);
        expect(performJoin).toHaveBeenCalledTimes(1);
        expect(operations.has('join', '7')).toBe(true);
    });

    test('a join the pass made itself is recorded too, for whatever asks next', async () => {
        config.autoJoin = true;
        scenarios.Plan = preJoin([{ type: 'join' }]);
        await passOver([candidate({ id: 9 })]);
        expect(operations.has('join', '9')).toBe(true);
    });

    test('a join mission is counted down once for a landed join', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';
        const needs = { join: 2, fill: 0, turbo: 0, boost: 0, vote: 0 };
        await passOver([candidate()], needs);
        expect(needs.join).toBe(1);
    });

    test('a refused join is still the scenario’s decision this cycle: the pass does not try it again', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';
        config.autoJoin = true;
        performJoin.mockResolvedValue({ status: 'skipped-no-photo', charged: 0 });
        const result = await passOver([candidate()]);
        // the rule's step was skipped (it did not fire), so the pass's own join decided the candidate
        expect(result.results).toEqual([{ id: 7, status: 'skipped-no-photo' }]);
    });
});

describe('the step of a candidate', () => {
    test('a candidate whose step another process holds is left to the pass’s own gates', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';
        const lock = jest.fn(() => ({ ok: false, release: jest.fn() }));
        const hook = lifecycle({ lock }).preJoin;
        const result = await runJoinPass('tok', Date.now(), joinDeps([candidate()], {}, hook), null);
        expect(lock).toHaveBeenCalledWith('7');
        expect(result.results).toEqual([{ id: 7, status: 'skipped:autojoin-off' }]);
        expect(ledger.get(7).state).toBeNull();
    });

    test('a lock the app cannot make at all is said so', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';
        const hook = lifecycle({ lock: () => ({ ok: false, release: jest.fn(), unavailable: true }) }).preJoin;
        await runJoinPass('tok', Date.now(), joinDeps([candidate()], {}, hook), null);
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('cannot create its lock files'), null);
    });

    test('the lock is held while the rules run and released after', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';
        const release = jest.fn();
        const hook = lifecycle({ lock: () => ({ ok: true, release }) }).preJoin;
        await runJoinPass('tok', Date.now(), joinDeps([candidate()], {}, hook), null);
        expect(release).toHaveBeenCalledTimes(1);
    });

    test.each([new Error('ledger down'), 'ledger down'])(
        'a step that throws (%s) is logged and leaves the candidate to the pass’s own gates',
        async (thrown) => {
            scenarios.Plan = preJoin([{ type: 'join' }]);
            assigned['7'] = 'Plan';
            jest.spyOn(ledger, 'get').mockImplementation(() => {
                throw thrown;
            });
            const result = await passOver([candidate()]);
            expect(log.error).toHaveBeenCalledWith(expect.stringContaining('scenario step failed: ledger down'), null);
            expect(result.results).toEqual([{ id: 7, status: 'skipped:autojoin-off' }]);
        },
    );

    test('with scenarios left to another loop (the Android background service) no candidate work runs here', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';
        const hook = lifecycle({ enabled: () => false }).preJoin;
        expect(hook.armed()).toBe(false);
        await expect(hook.run(candidate(), jest.fn())).resolves.toBeNull();
        const result = await runJoinPass('tok', Date.now(), joinDeps([candidate()], {}, hook), null);
        expect(result).toEqual({ ran: false, joined: 0, results: [] });
    });

    test('a progress record that is unreadable halts the candidate’s rules; none run', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';
        jest.spyOn(ledger, 'get').mockReturnValue({ state: null, epoch: { all: 0, gen: 0 }, corrupt: 'record' });
        await passOver([candidate()]);
        expect(performJoin).not.toHaveBeenCalled();
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('unreadable'), null);
    });

    test('photo and entry facts are unreadable before a join: the rule waits rather than reading a guess', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }], {
            if: [
                { type: 'present', value: { kind: 'fact', name: 'photos.hasEligible' } },
                { type: 'present', value: { kind: 'fact', name: 'entry.age', select: { by: 'slot', index: 1 } } },
            ],
        });
        assigned['7'] = 'Plan';
        await passOver([candidate()]);
        expect(performJoin).not.toHaveBeenCalled();
        expect(record().fired).toEqual({});
    });
});

// --- the installation -------------------------------------------------------------------------------------------------

describe('the cycle’s record of what was done', () => {
    test('a coordinator made with none keeps one, shared by the pre-join step and the sweep', () => {
        const own = createLifecycle(deps());
        expect(own.operations.has('join', '7')).toBe(false);
        own.operations.mark('join', '7');
        expect(own.preJoin.operations.has('join', '7')).toBe(true);
    });
});

describe('the installation stage', () => {
    const publication = (phase = 'main') => ({
        revision: 1,
        documentFingerprint: 'f',
        phase,
        phaseEnteredAt: NOW,
        observedAt: NOW,
        validUntil: null,
        bindings: {},
        profile: null,
        generation: 1,
    });
    const own = (doc = account([{ type: 'notify', message: 'account rule ran' }])) => {
        scenarios['Account plan'] = doc;
        settings.getInstallationScenario.mockReturnValue({
            scenario: 'Account plan',
            executor: 'electron',
            generation: 1,
        });
        settings.installationGeneration.mockReturnValue(1);
        settings.prepareInstallationSnapshot.mockImplementation(((_scenario: unknown, at: { phase: string }) => ({
            ok: true,
            publication: publication(at.phase),
        })) as unknown as typeof settings.prepareInstallationSnapshot);
    };
    const installation = () => ledger.get(KEY).state as ScenarioState;

    test('account rules run with no challenge, over a progress record started at the scenario’s start phase', async () => {
        own();
        await expect(lifecycle().installation({ rules: true })).resolves.toBe('published');
        expect(installation().phase).toBe('main');
        expect(installation().fired.r1).toBeDefined();
        expect(installation().outbox?.map((item) => item.message)).toEqual(['account rule ran']);
        expect(installation().published).toBeDefined();
    });

    test('an account rule reads the account: the claimable rewards decide whether a mission is claimed', async () => {
        own(
            account([{ type: 'claimMissionReward', missionId: 'm1' }], {
                if: [
                    {
                        type: 'compare',
                        left: { kind: 'fact', name: 'rewards.claimableCount' },
                        op: '>=',
                        right: { kind: 'literal', value: 1, quantity: 'count' },
                    },
                ],
            }),
        );
        missions = [{ id: 'm1', claim_state: 'CLAIM' }];
        completed = [];
        await lifecycle().installation({ rules: true });
        expect(claimMissionPrize).not.toHaveBeenCalled();

        completed = [claimable(3)];
        await lifecycle().installation({ rules: true });
        expect(claimMissionPrize).toHaveBeenCalledWith('m1', 'tok');
        expect(operations.has('claim', 'mission:m1')).toBe(true);
    });

    test('the overlay is published again after each confirmed action and after a phase change', async () => {
        own(
            account(
                [
                    { type: 'notify', message: 'one' },
                    { type: 'goto', phase: 'next' },
                ],
                {},
                { next: {} },
            ),
        );
        await lifecycle().installation({ rules: true });
        const phases = settings.prepareInstallationSnapshot.mock.calls.map(
            (call) => (call[1] as { phase: string }).phase,
        );
        // before the rules, after notify, after goto (still in main: the change lands when the rule finishes), after the phase change
        expect(phases).toEqual(['main', 'main', 'main', 'next']);
        expect(installation().phase).toBe('next');
        expect(installation().published?.phase).toBe('next');
    });

    test('a record that cannot be read after the publication is no error: the runner goes on from the state it held', async () => {
        own();
        const get = ledger.get.bind(ledger);
        let gone = false;
        jest.spyOn(ledger, 'get').mockImplementation((id) =>
            gone ? { state: null, corrupt: false, epoch: { all: 0, gen: 0 } } : get(id),
        );
        let calls = 0;
        settings.prepareInstallationSnapshot.mockImplementation(((_scenario: unknown, at: { phase: string }) => {
            // the second publication is the one after the rule's first action: its record reads as gone afterwards
            if (++calls === 2) gone = true;
            return { ok: true, publication: publication(at.phase) };
        }) as unknown as typeof settings.prepareInstallationSnapshot);
        await expect(lifecycle().installation({ rules: true })).resolves.toBe('published');
        expect(calls).toBeGreaterThanOrEqual(2);
    });

    test('a runtime that does not own the installation runs nothing and touches no progress', async () => {
        own();
        settings.getInstallationScenario.mockReturnValue({ scenario: 'Account plan', executor: 'cli', generation: 1 });
        await expect(lifecycle().installation({ rules: true })).resolves.toBe('not-owner');
        expect(ledger.get(KEY).state).toBeNull();
        expect(claimMissionPrize).not.toHaveBeenCalled();
    });

    test('a paused installation runs no account rule and publishes nothing new', async () => {
        own();
        seed(KEY, 'Account plan', { generation: 1, paused: { at: NOW, reason: 'user' } });
        await expect(lifecycle().installation({ rules: true })).resolves.toBe('held');
        expect(installation().outbox).toEqual([]);
        expect(installation().fired).toEqual({});
    });

    test('an interrupted handoff is finished first, and the installation runs nothing this pass', async () => {
        own();
        seed(KEY, 'Account plan', {
            generation: 1,
            handoff: { from: 'Account plan', to: null, generation: 1, at: NOW },
        });
        await expect(lifecycle().installation({ rules: true })).resolves.toBe('held');
        expect(settings.settleHandoff).toHaveBeenCalledWith(
            KEY,
            expect.objectContaining({ handoff: expect.anything() }),
        );
        expect(installation().fired).toEqual({});
    });

    test('progress of another scenario with nothing unresolved is started afresh at the start phase', async () => {
        own();
        seed(KEY, 'Old plan', { generation: 1, phase: 'elsewhere' });
        await expect(lifecycle().installation({ rules: true })).resolves.toBe('published');
        expect(installation().scenario).toBe('Account plan');
        expect(installation().phase).toBe('main');
        expect(installation().generation).toBe(1);
    });

    test('progress of another scenario with a spend that may have landed is not started over', async () => {
        own();
        seed(KEY, 'Old plan', { generation: 1 });
        settings.unresolvedScenarioWork.mockReturnValue(true);
        await expect(lifecycle().installation({ rules: true })).resolves.toBe('stale');
        expect(installation().scenario).toBe('Old plan');
        expect(installation().lastError?.message).toBe('scenario-changed-with-unresolved-work');
    });

    test('a phase that cannot be prepared blocks the account rules', async () => {
        own();
        settings.prepareInstallationSnapshot.mockReturnValue({
            ok: false,
            key: 'apiTimeout',
            reason: 'unknown-binding',
        });
        await expect(lifecycle().installation({ rules: true })).resolves.toBe('blocked');
        expect(installation().fired).toEqual({});
    });

    test('the step lock is held for the whole stage and released; one that is held elsewhere is busy', async () => {
        own();
        const release = jest.fn();
        const lock = jest.fn(() => ({ ok: true, release }));
        await lifecycle({ lock }).installation({ rules: true });
        expect(lock).toHaveBeenCalledWith(KEY);
        expect(release).toHaveBeenCalledTimes(1);
        await expect(lifecycle({ lock: () => ({ ok: false, release }) }).installation({ rules: true })).resolves.toBe(
            'busy',
        );
    });

    test.each([new Error('settings down'), 'settings down'])(
        'a failure (%s) is logged and reported, never thrown',
        async (thrown) => {
            own();
            settings.getScenario.mockImplementation(() => {
                throw thrown;
            });
            await expect(lifecycle().installation({ rules: true })).resolves.toBe('failed');
            expect(log.error).toHaveBeenCalledWith(
                expect.stringContaining('the installation stage failed: settings down'),
                null,
            );
        },
    );

    test('a single-challenge Run only publishes: no account rule runs', async () => {
        own();
        await expect(lifecycle().installation({ rules: false })).resolves.toBe('published');
        expect(installation().fired).toEqual({});
        expect(installation().outbox).toEqual([]);
    });

    test('no installation scenario costs nothing', async () => {
        settings.getInstallationScenario.mockReturnValue(null);
        await expect(lifecycle().installation({ rules: true })).resolves.toBe('none');
        expect(ledger.get(KEY).state).toBeNull();
    });

    test('a ledger shared across processes keeps the record the stage wrote', async () => {
        own();
        const shared = createStateLedger(createMemoryRawJsonStore());
        await createLifecycle(deps({ ledger: shared }), operations).installation({ rules: true });
        expect(shared.get(KEY).state?.fired.r1).toBeDefined();
    });
});

// --- after the close --------------------------------------------------------------------------------------------------

describe('the post-close stage', () => {
    const claimRule = (extra: Record<string, unknown> = {}) => {
        scenarios.Plan = postClose([{ type: 'claimChallengeReward' }], {
            if: [
                {
                    type: 'compare',
                    left: { kind: 'fact', name: 'rewards.claimable' },
                    op: '=',
                    right: { kind: 'literal', value: true },
                },
            ],
            ...extra,
        });
        assigned['7'] = 'Plan';
        seed(7, 'Plan');
    };

    test('a confirmed completed challenge with progress claims its rewards through the claim producer', async () => {
        claimRule();
        completed = [claimable(7)];
        await lifecycle().postClose();
        expect(claimChallengeResources).toHaveBeenCalledWith(7, 'tok');
        expect(operations.has('claim', '7')).toBe(true);
        expect(record().lastAction).toEqual(
            expect.objectContaining({ action: 'claimChallengeReward', outcome: 'done' }),
        );
        // its rewards were waiting when the list was read: not settled yet
        expect(listing()).toEqual({ listed: ['7'], settled: [] });
    });

    test('the sweep does not claim again what the scenario already claimed in the cycle', async () => {
        claimRule();
        config.autoClaimPrizes = true;
        completed = [claimable(7), claimable(8)];
        await lifecycle().postClose();
        missions = [
            { id: 'm9', claim_state: 'CLAIM' },
            { id: 'm10', claim_state: 'CLAIM' },
        ];
        operations.mark('claim', 'mission:m9');
        claimChallengeResources.mockClear();
        // (the scenario's claim took the throttle's slot for the hour: the sweep's own turn is a later one)
        resetClaimThrottle();
        await runClaimPass('tok', Date.now(), { ...claims(), operations });
        expect(claimChallengeResources.mock.calls.map((call) => call[0])).toEqual([8]);
        expect(claimMissionPrize.mock.calls.map((call) => call[0])).toEqual(['m10']);
        // …and what the sweep claims is recorded for whatever asks next
        expect(operations.has('claim', '8')).toBe(true);
        expect(operations.has('claim', 'mission:m10')).toBe(true);
    });

    test('a challenge with no progress has no post-close work and is settled', async () => {
        scenarios.Plan = postClose([{ type: 'claimChallengeReward' }]);
        assigned['7'] = 'Plan';
        completed = [claimable(7)];
        await lifecycle().postClose();
        expect(claimChallengeResources).not.toHaveBeenCalled();
        expect(listing()).toEqual({ listed: ['7'], settled: [['7', 'plan']] });
    });

    test('a challenge without a post-close scenario is settled; one whose rewards are claimed and progress resolved is too', async () => {
        scenarios.Plan = postClose([{ type: 'notify', message: 'x' }]);
        assigned['7'] = 'Plan';
        seed(7, 'Plan');
        completed = [claimable(7, 'CLAIMED'), claimable(8)];
        await lifecycle().postClose();
        // (8 has no scenario: nothing to keep, under no name)
        expect(listing()).toEqual({
            listed: ['7', '8'],
            settled: [
                ['7', 'plan'],
                ['8', ''],
            ],
        });
    });

    test('unresolved progress is never settled', async () => {
        claimRule();
        settings.unresolvedScenarioWork.mockReturnValue(true);
        completed = [claimable(7, 'CLAIMED')];
        await lifecycle().postClose();
        expect(listing()).toEqual({ listed: ['7'], settled: [] });
    });

    test('a failed read of the completed challenges is no evidence: nothing runs this cycle', async () => {
        claimRule();
        completed = null;
        await lifecycle().postClose();
        expect(claimChallengeResources).not.toHaveBeenCalled();
        // nothing is remembered: what an earlier pass found is forgotten, not carried
        expect(rememberedCalls()).toEqual([null]);
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('no post-close work this cycle'), null);
    });

    test('a challenge that left the active list but is not in the completed list is not closed: its work waits', async () => {
        claimRule();
        completed = [claimable(99)];
        await lifecycle().postClose();
        expect(claimChallengeResources).not.toHaveBeenCalled();
        // it is not reported settled under any assignment of it, so its stored assignment is kept
        expect(listing()).toEqual({ listed: ['99'], settled: [['99', '']] });
        expect(record().fired).toEqual({});
    });

    test('with no post-close rule anywhere no list is read; a scenario with a phase that has no rules is no use to any stage', async () => {
        scenarios.Bare = plan({ main: {} });
        scenarios.Plan = preJoin([{ type: 'join' }]);
        await lifecycle().postClose();
        expect(getMyCompletedChallenges).not.toHaveBeenCalled();
    });

    test('with scenarios left to another loop no post-close work runs here', async () => {
        claimRule();
        completed = [claimable(7)];
        await lifecycle({ enabled: () => false }).postClose();
        expect(getMyCompletedChallenges).not.toHaveBeenCalled();
        expect(rememberedCalls()).toEqual([null]);
    });

    test('each pass forgets what the one before found, and a pass that does not complete leaves nothing', async () => {
        claimRule();
        completed = [claimable(7, 'CLAIMED'), claimable(8, 'CLAIMED')];
        await lifecycle().postClose();
        expect(rememberedCalls()).toEqual([
            null,
            {
                listed: ['7', '8'],
                settled: [
                    ['7', 'plan'],
                    ['8', ''],
                ],
            },
        ]);

        // cancelled part way: not the rows processed so far, nothing
        settings.rememberPostCloseListing.mockClear();
        cancellation.isCancelled.mockReturnValueOnce(false).mockReturnValue(true);
        await lifecycle().postClose();
        expect(rememberedCalls()).toEqual([null]);

        // no post-close stage in use any more
        settings.rememberPostCloseListing.mockClear();
        scenarios.Plan = preJoin([{ type: 'join' }]);
        await lifecycle().postClose();
        expect(rememberedCalls()).toEqual([null]);
    });

    test('a progress record that cannot be read runs nothing and is not settled', async () => {
        claimRule();
        completed = [claimable(7)];
        jest.spyOn(ledger, 'get').mockReturnValue({ state: null, epoch: { all: 0, gen: 0 }, corrupt: 'record' });
        await lifecycle().postClose();
        expect(claimChallengeResources).not.toHaveBeenCalled();
        expect(listing()).toEqual({ listed: ['7'], settled: [] });
    });

    test('a step another process holds is skipped and not settled', async () => {
        claimRule();
        completed = [claimable(7)];
        const lock = jest.fn(() => ({ ok: false, release: jest.fn() }));
        await lifecycle({ lock }).postClose();
        expect(lock).toHaveBeenCalledWith('7');
        expect(claimChallengeResources).not.toHaveBeenCalled();
        expect(listing()).toEqual({ listed: ['7'], settled: [] });
    });

    test.each([new Error('ledger down'), 'ledger down'])(
        'the step lock is released after the rules, and a step that throws (%s) is logged',
        async (thrown) => {
            claimRule();
            completed = [claimable(7)];
            const release = jest.fn();
            const get = ledger.get.bind(ledger);
            let reads = 0;
            jest.spyOn(ledger, 'get').mockImplementation((id) => {
                // the first read is the check for progress; the next ones belong to the step
                if (++reads === 2) throw thrown;
                return get(id);
            });
            await lifecycle({ lock: () => ({ ok: true, release }) }).postClose();
            expect(release).toHaveBeenCalledTimes(1);
            expect(log.error).toHaveBeenCalledWith(expect.stringContaining('scenario step failed: ledger down'), null);
        },
    );

    test('a cancelled pass stops the stage; a listing row with no identity names nothing to run', async () => {
        claimRule();
        completed = [{ title: 'No id' }, null, { ...claimable(7), title: undefined }].filter((row) => row !== null);
        await lifecycle().postClose();
        expect(claimChallengeResources).toHaveBeenCalledTimes(1);

        claimChallengeResources.mockClear();
        cancellation.isCancelled.mockReturnValue(true);
        await lifecycle().postClose();
        expect(claimChallengeResources).not.toHaveBeenCalled();
    });

    test.each([new Error('settings down'), 'settings down'])(
        'a failure of the stage (%s) is logged, never thrown',
        async (thrown) => {
            claimRule();
            settings.getScenarios.mockImplementation(() => {
                throw thrown;
            });
            await expect(lifecycle().postClose()).resolves.toBeUndefined();
            expect(log.error).toHaveBeenCalledWith(
                expect.stringContaining('the post-close stage failed: settings down'),
                null,
            );
        },
    );

    test('a facade without the scenario list means no stage is in use', async () => {
        const facade: { getScenarios?: unknown } = settings;
        const kept = facade.getScenarios;
        facade.getScenarios = undefined;
        try {
            await lifecycle().postClose();
        } finally {
            facade.getScenarios = kept;
        }
        expect(getMyCompletedChallenges).not.toHaveBeenCalled();
    });
});

describe('the reward claims of a rule', () => {
    const run = async (extra: Record<string, unknown> = {}) => {
        scenarios.Plan = postClose([{ type: 'claimChallengeReward' }], extra);
        assigned['7'] = 'Plan';
        seed(7, 'Plan');
        await lifecycle().postClose();
    };

    test('rewards that are not waiting are a skip: the rule is not fired', async () => {
        completed = [claimable(7, 'CLAIMED')];
        await run();
        expect(claimChallengeResources).not.toHaveBeenCalled();
        expect(record().lastError?.message).toContain('not waiting to be claimed');
        expect(record().fired).toEqual({});
    });

    test('a claim that was sent and not confirmed fails the step, to be sent again', async () => {
        completed = [claimable(7)];
        claimChallengeResources.mockResolvedValue(false);
        await run();
        expect(record().lastError?.message).toContain('was not confirmed');
        expect(operations.has('claim', '7')).toBe(false);
    });

    test('a listing that could not be read, or never reached the challenge, defers it', async () => {
        getMyCompletedChallenges.mockRejectedValueOnce(new Error('offline'));
        completed = [claimable(7)];
        // the stage’s own read fails first: nothing reaches the rule
        await run();
        expect(claimChallengeResources).not.toHaveBeenCalled();

        // the stage's read works, the rule's own read throws
        getMyCompletedChallenges.mockResolvedValueOnce([claimable(7)]);
        getMyCompletedChallenges.mockRejectedValueOnce(new Error('offline'));
        await lifecycle().postClose();
        expect(log.warning).toHaveBeenCalledWith(
            expect.stringContaining('could not read completed challenges: offline'),
            null,
        );
        expect(claimChallengeResources).not.toHaveBeenCalled();
        resetClaimThrottle();
        getMyCompletedChallenges.mockRejectedValueOnce('offline');
        await expect(claimChallengeReward('tok', '7', claims())).resolves.toBe('unreadable');
        expect(log.warning).toHaveBeenCalledWith('could not read completed challenges: offline', null);
    });

    test('a listing cut short before the challenge does not show it: the claim waits', async () => {
        const page = (offset: number) =>
            Array.from({ length: 20 }, (_row, index) => claimable(1000 + offset + index, 'CLAIMED'));
        getMyCompletedChallenges.mockImplementation(async (...args: unknown[]) => {
            const start = Number(args[1] ?? 0);
            return invalid(page(start));
        });
        await expect(claimChallengeReward('tok', '7', claims())).resolves.toBe('unreadable');
        completed = [];
        getMyCompletedChallenges.mockImplementation(async () => completed);
        resetClaimThrottle();
        await expect(claimChallengeReward('tok', '7', claims())).resolves.toBe('nothing');
    });

    test('a cancelled claim is deferred', async () => {
        completed = [claimable(7)];
        cancellation.isCancelled.mockReturnValue(true);
        await expect(claimChallengeReward('tok', '7', claims())).resolves.toBe('cancelled');
    });
});

describe('scenario claims and the claim throttle', () => {
    const everyPass = () => {
        scenarios.Plan = postClose([{ type: 'claimChallengeReward' }]);
        assigned['7'] = 'Plan';
        seed(7, 'Plan');
        completed = [claimable(7)];
    };
    const HOUR = 3600 * 1000;

    test('a rule that fires every pass claims no more often than the sweep may', async () => {
        everyPass();
        const base = Date.now();
        const clock = jest.spyOn(Date, 'now');
        try {
            clock.mockReturnValue(base);
            await lifecycle().postClose();
            expect(claimChallengeResources).toHaveBeenCalledTimes(1);

            // passes within the hour: the step waits, nothing is called, nothing is counted as done
            const done = record().lastAction;
            for (const later of [60_000, 30 * 60_000, HOUR - 1]) {
                clock.mockReturnValue(base + later);
                operations = createOperationRecord();
                await lifecycle().postClose();
            }
            expect(claimChallengeResources).toHaveBeenCalledTimes(1);
            expect(record().lastAction).toEqual(done);
            expect(operations.has('claim', '7')).toBe(false);

            // the hour has passed: the next pass claims again
            clock.mockReturnValue(base + HOUR);
            await lifecycle().postClose();
            expect(claimChallengeResources).toHaveBeenCalledTimes(2);
        } finally {
            clock.mockRestore();
        }
    });

    test('a refused claim defers the step with its reason, and does not stop a rule that was not under way', async () => {
        everyPass();
        await lifecycle().postClose();
        await lifecycle().postClose();
        expect(log.warning).toHaveBeenCalledWith(
            expect.stringContaining('waits: claims are sent at most once an hour'),
            null,
        );
        // deferred is no problem to show
        expect(record().lastError).toBeNull();
    });

    test('the throttle is the sweep’s own clock: a claim by either holds the other back, for challenges and missions alike', async () => {
        config.autoClaimPrizes = true;
        completed = [claimable(7)];
        missions = [{ id: 'm1', claim_state: 'CLAIM' }];
        // the sweep claimed: a scenario's claim waits
        await expect(runClaimPass('tok', Date.now(), claims())).resolves.toEqual(
            expect.objectContaining({ ran: true }),
        );
        await expect(claimChallengeReward('tok', '7', claims())).resolves.toBe('throttled');
        await expect(claimMissionReward('tok', 'm1', claims())).resolves.toBe('throttled');
        // a scenario's claim was made: the sweep waits
        resetClaimThrottle();
        claimMissionPrize.mockClear();
        await expect(claimMissionReward('tok', 'm1', claims())).resolves.toBe('claimed');
        await expect(runClaimPass('tok', Date.now(), claims())).resolves.toEqual(
            expect.objectContaining({ ran: false }),
        );
        await expect(claimMissionReward('tok', 'm1', claims())).resolves.toBe('throttled');
        expect(claimMissionPrize).toHaveBeenCalledTimes(1);
    });

    test('an account rule that claims a mission every pass is held to it too', async () => {
        scenarios['Account plan'] = account([{ type: 'claimMissionReward', missionId: 'm1' }]);
        settings.getInstallationScenario.mockReturnValue({
            scenario: 'Account plan',
            executor: 'electron',
            generation: 1,
        });
        settings.installationGeneration.mockReturnValue(1);
        settings.prepareInstallationSnapshot.mockReturnValue({ ok: true, publication: null });
        missions = [{ id: 'm1', claim_state: 'CLAIM' }];
        await lifecycle().installation({ rules: true });
        await lifecycle().installation({ rules: true });
        expect(claimMissionPrize).toHaveBeenCalledTimes(1);
    });
});

describe('the mission claims of a rule', () => {
    test.each([
        ['claimed', [{ id: 'm1', claim_state: 'CLAIM', prizes: [{ type: 'COINS', amount: 5 }] }], true, 'claimed'],
        ['failed', [{ id: 'm1', claim_state: 'CLAIM' }], false, 'failed'],
        ['nothing', [{ id: 'm1', claim_state: 'CLAIMED' }], true, 'nothing'],
        ['unknown', [{ id: 'm2', claim_state: 'CLAIM' }], true, 'unknown'],
        ['unreadable', null, true, 'unreadable'],
    ])('%s', async (_name, list, confirmed, expected) => {
        missions = list;
        claimMissionPrize.mockResolvedValue(confirmed);
        await expect(claimMissionReward('tok', 'm1', claims())).resolves.toBe(expected);
    });

    test('a read that throws is unreadable, and a cancelled claim is cancelled', async () => {
        getMyMissions.mockRejectedValueOnce(new Error('offline'));
        await expect(claimMissionReward('tok', 'm1', claims())).resolves.toBe('unreadable');
        resetClaimThrottle();
        getMyMissions.mockRejectedValueOnce('offline');
        await expect(claimMissionReward('tok', 'm1', claims())).resolves.toBe('unreadable');
        expect(log.warning).toHaveBeenCalledWith('could not read missions: offline', null);
        missions = [{ id: 'm1', claim_state: 'CLAIM' }];
        cancellation.isCancelled.mockReturnValue(true);
        resetClaimThrottle();
        await expect(claimMissionReward('tok', 'm1', claims())).resolves.toBe('cancelled');
    });

    test('an account rule says what happened to an unknown mission', async () => {
        scenarios['Account plan'] = account([{ type: 'claimMissionReward', missionId: 'gone' }]);
        settings.getInstallationScenario.mockReturnValue({
            scenario: 'Account plan',
            executor: 'electron',
            generation: 1,
        });
        settings.installationGeneration.mockReturnValue(1);
        settings.prepareInstallationSnapshot.mockReturnValue({ ok: true, publication: null });
        missions = [{ id: 'm1', claim_state: 'CLAIM' }];
        await lifecycle().installation({ rules: true });
        expect(claimMissionPrize).not.toHaveBeenCalled();
        expect((ledger.get(KEY).state as ScenarioState).lastError?.message).toContain('there is no mission gone');
    });
});

// --- the rule runner ---------------------------------------------------------------------------------------------------

describe('what a confirmed action counts for', () => {
    test('an action its stage does not offer is passed over, never run', async () => {
        // a document that got past validation, or a record left from an older one
        scenarios.Plan = plan({ main: { rules: [rule('r1', [{ type: 'join' }, { type: 'notify', message: 'x' }])] } });
        assigned['7'] = 'Plan';
        const pass = {
            token: 'tok',
            api: {},
            fillDeps: {},
            currency: { strategy: { getBankroll } },
            scenarios: { ledger },
        };
        await runScenarioStep(candidate({ member: { ranking: { entries: [] } } }), NOW, invalid(pass));
        expect(performJoin).not.toHaveBeenCalled();
        expect(record().lastError?.message).toContain('join is not available in the active stage');
    });

    test('a confirmed boost counts down its mission once, and is recorded for the normal automation', async () => {
        scenarios.Plan = plan({ main: { rules: [rule('r1', [{ type: 'boost', entry: { by: 'slot', index: 1 } }])] } });
        assigned['7'] = 'Plan';
        const needs = { join: 0, fill: 0, turbo: 0, boost: 2, vote: 0 };
        const live = candidate({
            member: { boost: { state: 'AVAILABLE' }, ranking: { entries: [{ id: 'a', votes: 1, rank: 1 }] } },
        });
        const pass = {
            token: 'tok',
            api: { applyBoostToEntry: jest.fn(async () => ({ success: true })), getActiveChallenges: jest.fn() },
            fillDeps: {},
            currency: { strategy: { getBankroll } },
            scenarios: { ledger },
            missions: needs,
            operations,
        };
        await runScenarioStep(live, NOW, invalid(pass));
        expect(pass.api.applyBoostToEntry).toHaveBeenCalledTimes(1);
        expect(needs.boost).toBe(1);
        expect(operations.has('boost', '7')).toBe(true);
    });
});

describe('the stage the engine evaluates', () => {
    const { evaluateScenario } =
        require('../../src/ts/core/scenarios/evaluate') as typeof import('../../src/ts/core/scenarios/evaluate');
    const state = { phase: 'main', phaseEnteredAt: NOW, memory: {}, fired: {}, inFlight: null };
    const both = (scope?: string) =>
        plan(
            {
                main: {
                    rules: [
                        rule('plain', [{ type: 'notify', message: 'x' }]),
                        rule('pre', [{ type: 'join' }], { stages: ['preJoin'] }),
                        rule('acct', [{ type: 'notify', message: 'y' }], { stages: ['account'] }),
                    ],
                },
            },
            scope ? { scope } : {},
        );
    const ids = (scenario: ScenarioDocument, stage?: 'preJoin' | 'active' | 'postClose' | 'account') =>
        evaluateScenario({ scenario, state, now: NOW, timezone: 'UTC', ...(stage ? { stage } : {}) }).explain.map(
            (item) => item.ruleId,
        );

    test('without a stage a challenge scenario is its active stage, an installation scenario its account stage', () => {
        expect(ids(both())).toEqual(['plain']);
        // an installation scenario's rules default to its account stage
        expect(ids(both('installation'))).toEqual(['plain', 'acct']);
    });

    test('a named stage tries the rules that run in it only', () => {
        expect(ids(both(), 'preJoin')).toEqual(['pre']);
        expect(ids(both(), 'postClose')).toEqual([]);
        expect(ids(both(), 'account')).toEqual(['acct']);
    });
});

describe('the evidence a stage fetches', () => {
    const scenario = plan({
        main: {
            rules: [
                rule('pre', [{ type: 'join' }], {
                    stages: ['preJoin'],
                    if: [{ type: 'balance', currency: 'coins', op: '>=', value: 1 }],
                }),
                rule('live', [{ type: 'notify', message: 'x' }], {
                    if: [{ type: 'present', value: { kind: 'fact', name: 'photos.hasEligible' } }],
                }),
            ],
        },
    });

    test('only the rules that run in the stage ask for theirs', () => {
        expect([...evidenceNeeded(scenario, 'main', true, 'preJoin')]).toEqual(['bankroll']);
        expect([...evidenceNeeded(scenario, 'main', true, 'active')]).toEqual(['photoScan']);
        expect([...evidenceNeeded(scenario, 'main', true, 'postClose')]).toEqual([]);
    });

    test('with no stage named every rule does, as before', () => {
        expect([...evidenceNeeded(scenario, 'main')].sort()).toEqual(['bankroll', 'photoScan']);
    });
});

// --- the actions added with the remaining selectors, by stage ---------------------------------------------------------

describe('the settings and lifecycle actions of the installation', () => {
    const publication = (phase = 'main') => ({
        revision: 1,
        documentFingerprint: 'f',
        phase,
        phaseEnteredAt: NOW,
        observedAt: NOW,
        validUntil: null,
        bindings: {},
        profile: null,
        generation: 1,
    });
    const own = (actions: object[]) => {
        scenarios['Account plan'] = account(actions);
        settings.getInstallationScenario.mockReturnValue({
            scenario: 'Account plan',
            executor: 'electron',
            generation: 1,
        });
        settings.installationGeneration.mockReturnValue(1);
        settings.prepareInstallationSnapshot.mockImplementation(((_scenario: unknown, at: { phase: string }) => ({
            ok: true,
            publication: publication(at.phase),
        })) as unknown as typeof settings.prepareInstallationSnapshot);
    };
    const installation = () => ledger.get(KEY).state as ScenarioState;
    const prepared = () =>
        settings.prepareInstallationSnapshot.mock.calls.map((call) => (call[1] as ScenarioState).phasePatch);
    const known = (value: unknown) =>
        invalid<ReturnType<typeof settings.readScenarioSetting>>({ state: 'known', value });

    test('setSetting: the patch is checked as the record it would leave, kept in the record, and published again', async () => {
        own([{ type: 'setSetting', key: 'missionJoinEarly', value: true }]);
        await expect(lifecycle().installation({ rules: true })).resolves.toBe('published');
        expect(installation().phasePatch).toEqual({ missionJoinEarly: true });
        expect(installation().published).toBeDefined();
        // before the rules, the check of the record the patch would leave, after the action, and after the phase's end
        expect(prepared().slice(0, 3)).toEqual([undefined, { missionJoinEarly: true }, { missionJoinEarly: true }]);
        expect(installation().lastAction).toMatchObject({ action: 'setSetting', outcome: 'done' });
    });

    test('a patch the installation settings refuse changes nothing, and says why', async () => {
        own([{ type: 'setSetting', key: 'checkFrequencyMax', value: 1 }]);
        settings.prepareInstallationSnapshot.mockImplementation(((_scenario: unknown, at: ScenarioState) =>
            at.phasePatch
                ? { ok: false, key: 'checkFrequencyMax', reason: 'do not hold together' }
                : {
                      ok: true,
                      publication: publication(at.phase),
                  }) as unknown as typeof settings.prepareInstallationSnapshot);
        await lifecycle().installation({ rules: true });
        expect(installation().phasePatch).toBeUndefined();
        expect(installation().lastError?.message).toContain(
            'the setting was not changed: checkFrequencyMax: do not hold together',
        );
        settings.prepareInstallationSnapshot.mockImplementation(((_scenario: unknown, at: ScenarioState) =>
            at.phasePatch
                ? { ok: false, key: null, reason: 'unavailable' }
                : {
                      ok: true,
                      publication: publication(at.phase),
                  }) as unknown as typeof settings.prepareInstallationSnapshot);
        ledger = createMemoryStateLedger();
        await lifecycle().installation({ rules: true });
        expect(installation().lastError?.message).toContain('the setting was not changed: unavailable');
    });

    test('a key a challenge scenario owns is not the installation’s to change', async () => {
        own([{ type: 'setSetting', key: 'autoBoost', value: true }]);
        await lifecycle().installation({ rules: true });
        expect(installation().phasePatch).toBeUndefined();
        expect(installation().lastError?.message).toContain(
            'autoBoost is not a setting an installation scenario can change',
        );
    });

    test('the value of an expression is worked out from the account and the settings it reads', async () => {
        own([{ type: 'setSetting', key: 'currencyReserveKeys', value: { kind: 'fact', name: 'balance.keys' } }]);
        await lifecycle().installation({ rules: true });
        expect(installation().phasePatch).toEqual({ currencyReserveKeys: 5 });

        ledger = createMemoryStateLedger();
        settings.readInstallationSetting.mockReturnValue(known({ kind: 'boolean', value: true }));
        settings.readScenarioSetting.mockReturnValue(known({ kind: 'boolean', value: false }));
        const read = (view: 'base' | 'effective') =>
            own([
                {
                    type: 'setSetting',
                    key: 'missionJoinEarly',
                    value: { kind: 'setting', key: 'missionUseBoosts', view },
                },
            ]);
        read('effective');
        await lifecycle().installation({ rules: true });
        expect(settings.readInstallationSetting).toHaveBeenCalledWith('missionUseBoosts');
        expect(installation().phasePatch).toEqual({ missionJoinEarly: true });

        ledger = createMemoryStateLedger();
        read('base');
        await lifecycle().installation({ rules: true });
        expect(settings.readScenarioSetting).toHaveBeenCalledWith('missionUseBoosts', 'base', null);
        expect(installation().phasePatch).toEqual({ missionJoinEarly: false });
    });

    test('clearSetting takes a patched key back out', async () => {
        own([{ type: 'clearSetting', key: 'missionJoinEarly' }]);
        seed(KEY, 'Account plan', { generation: 1, phasePatch: { missionJoinEarly: true, missionUseBoosts: true } });
        await lifecycle().installation({ rules: true });
        expect(installation().phasePatch).toEqual({ missionUseBoosts: true });
    });

    test('pauseScenario pauses the installation with its progress kept; it sets nothing else', async () => {
        own([
            { type: 'pauseScenario', reason: 'asleep' },
            { type: 'notify', message: 'after' },
        ]);
        const before = { ...config };
        await lifecycle().installation({ rules: true });
        expect(installation().paused).toEqual({ at: expect.any(Number), reason: 'asleep' });
        expect(installation().outbox).toEqual([]);
        expect(installation().inFlight).toEqual({ ruleId: 'r1', actionIndex: 1 });
        expect(config).toEqual(before);
        // paused, the next cycle runs no rule
        await expect(lifecycle().installation({ rules: true })).resolves.toBe('held');
        expect(installation().outbox).toEqual([]);
    });

    test('handoffScenario hands the installation over at the generation it is at, and the runner writes nothing after it', async () => {
        own([
            { type: 'notify', message: 'before' },
            { type: 'handoffScenario', to: 'Next plan' },
        ]);
        settings.requestScenarioHandoff.mockResolvedValue({ ok: true, generation: 2 });
        await lifecycle().installation({ rules: true });
        expect(settings.requestScenarioHandoff).toHaveBeenCalledWith(KEY, 'Next plan', 1, {
            ruleId: 'r1',
            actionIndex: 1,
        });
        expect(installation().fired.r1).toBeUndefined();
    });

    test('a handoff of an installation whose progress cannot be read defers', async () => {
        own([
            { type: 'notify', message: 'before' },
            { type: 'handoffScenario', to: null },
        ]);
        // the stage reads the generation first, with no rule in progress; the action finds none once the rule is under way
        settings.installationGeneration.mockImplementation(() => (ledger.get(KEY).state?.inFlight ? null : 1));
        await lifecycle().installation({ rules: true });
        expect(settings.requestScenarioHandoff).not.toHaveBeenCalled();
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('the saved progress cannot be read'), null);
    });

    test('a handoff the settings refuse stops the rule with the reason and changes nothing', async () => {
        own([{ type: 'handoffScenario', to: 'Next plan' }]);
        settings.requestScenarioHandoff.mockResolvedValue({ ok: false, reason: 'unresolved-spend' });
        await lifecycle().installation({ rules: true });
        expect(installation().lastError?.message).toContain('the handoff was refused (unresolved-spend)');
        expect(installation().fired.r1).toBeUndefined();
    });
});

describe('the settings actions and the normal join before the join', () => {
    const settingsPlan = (actions: object[]) => preJoin(actions);

    test('setSetting patches the candidate’s settings: the record is checked, kept, and the overlay published for the candidate', async () => {
        scenarios.Plan = settingsPlan([
            { type: 'setSetting', key: 'autoJoinMaxCoins', value: { kind: 'fact', name: 'challenge.joinPrice' } },
        ]);
        assigned['7'] = 'Plan';
        config.autoJoin = true;
        await passOver([candidate({ join_coins: 40 })]);
        expect(record().phasePatch).toEqual({ autoJoinMaxCoins: 40 });
        const seen = settings.prepareScenarioSnapshot.mock.calls.map(([id, , state]) => [id, state.phasePatch]);
        expect(seen).toContainEqual(['7', undefined]);
        expect(seen).toContainEqual(['7', { autoJoinMaxCoins: 40 }]);
    });

    test('a candidate’s patch that the settings refuse changes nothing and the join goes on as it would', async () => {
        scenarios.Plan = settingsPlan([{ type: 'setSetting', key: 'autoJoinMaxCoins', value: 10 }]);
        assigned['7'] = 'Plan';
        settings.prepareScenarioSnapshot.mockImplementation((_id, _scenario, state) =>
            state.phasePatch
                ? { ok: false, key: 'autoJoinMaxCoins', reason: 'too low' }
                : invalid({ ok: true, snapshot: { publication: null, readSetting: () => null } }),
        );
        await passOver([candidate()]);
        expect(record().phasePatch).toBeUndefined();
        expect(record().lastError?.message).toContain('the setting was not changed: autoJoinMaxCoins: too low');
    });

    test('useProfile before the join keeps the profile in the record', async () => {
        scenarios.Plan = settingsPlan([{ type: 'useProfile', name: 'Calm' }]);
        assigned['7'] = 'Plan';
        settings.checkPhaseProfile.mockReturnValue({ ok: true, name: 'Calm' });
        await passOver([candidate()]);
        expect(record().phaseProfile).toBe('Calm');
    });

    describe('runAutomation join: the pass’s own decision, under its own policy', () => {
        const normal = () => {
            scenarios.Plan = settingsPlan([{ type: 'runAutomation', operation: 'join' }]);
            assigned['7'] = 'Plan';
        };

        test('joins when the Auto Join policy says so, and is recorded as the candidate’s join', async () => {
            normal();
            config.autoJoin = true;
            await expect(passOver([candidate()])).resolves.toEqual(expect.objectContaining({ joined: 1 }));
            expect(performJoin).toHaveBeenCalledTimes(1);
            expect(record().lastAction).toMatchObject({ action: 'runAutomation', outcome: 'done' });
            expect(operations.has('join', '7')).toBe(true);
        });

        test('with Auto Join off the step completes as not due, says why, and nothing is joined', async () => {
            normal();
            await passOver([candidate()]);
            expect(performJoin).not.toHaveBeenCalled();
            expect(record().lastAction).toMatchObject({ outcome: 'not due: skipped:autojoin-off' });
            expect(record().lastError).toBeNull();
            expect(record().fired.r1).toBeDefined();
        });

        test('the timing window applies to it, where a direct join ignores it', async () => {
            config.autoJoin = true;
            config.autoJoinWithinHoursOfEnd = 1;
            settings.resolveRuleSettingGroup.mockReturnValue({ values: { autoJoinWithinHoursOfEnd: 1 } });
            normal();
            await passOver([candidate()]);
            expect(performJoin).not.toHaveBeenCalled();
            expect(record().lastAction?.outcome).toMatch(/^not due: skipped:/);
            ledger = createMemoryStateLedger();
            scenarios.Plan = settingsPlan([{ type: 'join' }]);
            await expect(passOver([candidate()])).resolves.toEqual(expect.objectContaining({ joined: 1 }));
        });

        test.each([
            ['failed-no-charge', 'the join was not made (failed-no-charge)'],
            ['busy', undefined],
        ])('a join that ends %s is not a policy refusal', async (status, message) => {
            normal();
            config.autoJoin = true;
            performJoin.mockResolvedValue({ status, charged: 0 });
            await passOver([candidate()]);
            expect(record().lastAction).toBeNull();
            if (message) expect(record().lastError?.message).toContain(message);
        });

        test('a join paid for and not completed is retried without paying again, the coins counted', async () => {
            normal();
            config.autoJoin = true;
            performJoin.mockResolvedValue({ status: 'charged-pending-submit', charged: 30 });
            await passOver([candidate({ join_coins: 30 })]);
            expect(record().spent.coins).toBe(30);
            expect(record().inFlight).toMatchObject({ ruleId: 'r1', actionIndex: 0 });
        });

        test('an operation of the active stage is a skip before the join (a stored document is read back without its validation)', async () => {
            scenarios.Plan = settingsPlan([{ type: 'runAutomation', operation: 'boost' }]);
            assigned['7'] = 'Plan';
            await passOver([candidate()]);
            expect(record().lastError?.message).toContain('boost runs while the challenge is active');
        });
    });
});

describe('pause and handoff after the close', () => {
    test('pauseScenario pauses the completed subject’s progress', async () => {
        scenarios.Plan = postClose([{ type: 'pauseScenario', reason: 'done for now' }]);
        assigned['9'] = 'Plan';
        seed(9, 'Plan');
        completed = [claimable(9, 'DONE')];
        await lifecycle().postClose();
        expect(record(9).paused).toEqual({ at: expect.any(Number), reason: 'done for now' });
    });

    test('handoffScenario hands the closed challenge’s progress to the scenario', async () => {
        scenarios.Plan = postClose([{ type: 'handoffScenario', to: 'Next plan' }]);
        assigned['9'] = 'Plan';
        seed(9, 'Plan', { generation: 2 });
        completed = [claimable(9, 'DONE')];
        settings.requestScenarioHandoff.mockResolvedValue({ ok: true, generation: 3 });
        await lifecycle().postClose();
        expect(settings.requestScenarioHandoff).toHaveBeenCalledWith('9', 'Next plan', 2, undefined);
    });
});

describe('a count-1 absolute submit row joins the candidate once it is due', () => {
    type Row =
        | { count: number; state: 'known'; at: number }
        | { count: number; state: 'absent' | 'unknown'; reason: string };
    const admission = (alignment: 'absolute' | 'end' = 'absolute', counts = [1]) =>
        plan({
            main: {
                schedules: {
                    submit: {
                        alignment,
                        rows: counts.map((count) => ({ count, at: { kind: 'fact', name: 'challenge.end' } })),
                    },
                },
            },
        });
    /** What the owner publishes for the phase: the rows its evidence resolved to. */
    const resolved = (rows: Row[], alignment: 'absolute' | 'end' = 'absolute') =>
        settings.prepareScenarioSnapshot.mockReturnValue({
            ok: true,
            snapshot: {
                publication: {
                    revision: 1,
                    documentFingerprint: 'f',
                    phase: 'main',
                    phaseEnteredAt: NOW,
                    observedAt: NOW,
                    validUntil: null,
                    bindings: {},
                    profile: null,
                    schedules: { submit: { alignment, rows } },
                },
                readSetting: () => ({ state: 'unknown', reason: 'test', dependencies: [] }),
            },
        });
    const due: Row = { count: 1, state: 'known', at: NOW - 10 };
    const arrange = (doc: ScenarioDocument = admission()) => {
        scenarios.Plan = doc;
        assigned['7'] = 'Plan';
    };

    test('a due known row joins the candidate while the inherited Auto Join is off, once, through the join action’s path', async () => {
        arrange();
        resolved([due]);
        const result = await passOver([candidate()]);
        expect(result).toEqual({ ran: true, joined: 1, results: [{ id: 7, status: 'joined' }] });
        expect(performJoin).toHaveBeenCalledTimes(1);
        expect(record().fired['@admission']).toBeDefined();
        expect(record().lastAction).toEqual(
            expect.objectContaining({ ruleId: '@admission', action: 'join', outcome: 'done' }),
        );
        expect(operations.has('join', '7')).toBe(true);
    });

    test('a row that is not yet due, unknown or absent does not join and makes no join call', async () => {
        for (const row of [
            { count: 1, state: 'known', at: NOW + 600 } as Row,
            { count: 1, state: 'unknown', reason: 'boost-timeout-malformed' } as Row,
            { count: 1, state: 'absent', reason: 'not-present' } as Row,
        ]) {
            arrange();
            resolved([row]);
            const result = await passOver([candidate()]);
            expect(result.results).toEqual([{ id: 7, status: 'skipped:autojoin-off' }]);
            expect(performJoin).not.toHaveBeenCalled();
        }
    });

    test('only a count-1 row asks for the join: a due row of another count does not', async () => {
        arrange(admission('absolute', [1, 2]));
        resolved([
            { count: 2, state: 'known', at: NOW - 10 },
            { count: 1, state: 'unknown', reason: 'r' },
        ]);
        expect((await passOver([candidate()])).results).toEqual([{ id: 7, status: 'skipped:autojoin-off' }]);
        expect(performJoin).not.toHaveBeenCalled();
    });

    test('an end-aligned schedule never asks for it: the first photo is the join itself', async () => {
        arrange(admission('end'));
        resolved([due], 'end');
        // no phase asks for a pre-join step, so the pass is not even run for it
        await expect(passOver([candidate()])).resolves.toEqual({ ran: false, joined: 0, results: [] });
        expect(performJoin).not.toHaveBeenCalled();
    });

    test('a phase with no such row keeps its behaviour: an absolute schedule of other counts runs no pre-join step', async () => {
        arrange(admission('absolute', [2, 3]));
        resolved([{ count: 2, state: 'known', at: NOW - 10 }]);
        await expect(passOver([candidate()])).resolves.toEqual({ ran: false, joined: 0, results: [] });
        config.autoJoin = true;
        // the Auto Join switch decides it, as today
        expect((await passOver([candidate()])).results).toEqual([{ id: 7, status: 'joined' }]);
    });

    test('a join a rule of the document already made is not made again by the schedule', async () => {
        const doc = admission();
        doc.phases.main.rules = [invalid(rule('r1', [{ type: 'join' }], { stages: ['preJoin'] }))];
        arrange(doc);
        resolved([due]);
        const result = await passOver([candidate()]);
        expect(result.results).toEqual([{ id: 7, status: 'joined' }]);
        expect(performJoin).toHaveBeenCalledTimes(1);
        expect(record().fired['@admission']).toBeUndefined();
    });

    test('a paid join goes through the same decision and performJoin, at the price it was decided at', async () => {
        arrange();
        resolved([due]);
        const result = await passOver([candidate({ join_coins: 80 })]);
        expect(result.results).toEqual([{ id: 7, status: 'joined' }]);
        expect(performJoin).toHaveBeenCalledWith(
            expect.objectContaining({ id: 7 }),
            'tok',
            expect.anything(),
            80,
            expect.objectContaining({ submitOnly: false, coinsBefore: 500, priceCeiling: 80 }),
        );
    });

    test('the scenario’s coin limit and the paid cap apply as they do to a join action without a price limit', async () => {
        arrange({ ...admission(), limits: { coins: 50 } });
        resolved([due]);
        expect((await passOver([candidate({ join_coins: 80 })])).results).toEqual([
            { id: 7, status: 'skipped:over-per-challenge-cap' },
        ]);
        expect(performJoin).not.toHaveBeenCalled();
        config.autoJoinMaxCoins = 0;
        arrange(admission());
        ledger = createMemoryStateLedger();
        expect((await passOver([candidate({ join_coins: 80 })])).results).toEqual([
            { id: 7, status: 'skipped:paid-disabled' },
        ]);
    });

    test('the cycle’s coin budget is shared with the other joins of the pass', async () => {
        arrange();
        assigned['8'] = 'Plan';
        resolved([due]);
        config.autoJoinMaxCoins = 250;
        performJoin.mockResolvedValue({ status: 'joined', charged: 200 });
        const result = await passOver([candidate({ join_coins: 200 }), candidate({ id: 8, join_coins: 150 })]);
        expect(result.results).toEqual([
            { id: 7, status: 'joined' },
            { id: 8, status: 'skipped:over-cycle-budget' },
        ]);
        expect(performJoin).toHaveBeenCalledTimes(1);
    });

    test('a candidate listed twice is joined once; a refused join is tried again next pass', async () => {
        arrange();
        resolved([due]);
        const twice = await passOver([candidate(), candidate()]);
        expect(twice.results.map((item) => item.status)).toEqual(['joined', 'skipped:done-this-pass']);
        expect(performJoin).toHaveBeenCalledTimes(1);

        ledger = createMemoryStateLedger();
        performJoin.mockReset();
        performJoin.mockResolvedValueOnce({ status: 'skipped-no-photo', charged: 0 });
        await passOver([candidate()]);
        performJoin.mockResolvedValueOnce({ status: 'joined', charged: 0 });
        expect((await passOver([candidate()])).results).toEqual([{ id: 7, status: 'joined' }]);
        expect(performJoin).toHaveBeenCalledTimes(2);
    });
});

// --- the autovote control, the Stop fence and an unreadable zone ------------------------------------------------------

describe('the installation’s requests for the voting stages, and the Stop fence', () => {
    const { registerAutovoteControl } =
        require('../../src/ts/core/autovote/control') as typeof import('../../src/ts/core/autovote/control');
    const publication = (phase = 'main') => ({
        revision: 1,
        documentFingerprint: 'f',
        phase,
        phaseEnteredAt: NOW,
        observedAt: NOW,
        validUntil: null,
        bindings: {},
        profile: null,
        generation: 1,
    });
    const own = (actions: object[]) => {
        scenarios['Account plan'] = account(actions);
        settings.getInstallationScenario.mockReturnValue({
            scenario: 'Account plan',
            executor: 'electron',
            generation: 1,
        });
        settings.installationGeneration.mockReturnValue(1);
        settings.prepareInstallationSnapshot.mockImplementation(((_scenario: unknown, at: { phase: string }) => ({
            ok: true,
            publication: publication(at.phase),
        })) as unknown as typeof settings.prepareInstallationSnapshot);
    };
    const installation = () => ledger.get(KEY).state as ScenarioState;
    const control = (
        answer: Awaited<ReturnType<import('../../src/ts/core/autovote/control').AutovoteControl['request']>>,
        admitted = true,
    ) => {
        const request = jest.fn(async () => answer);
        const captured = { epoch: 3, generation: 1 };
        const unregister = registerAutovoteControl({
            mode: () => 'armed',
            capture: () => captured,
            admits: jest.fn(async () => admitted),
            request,
        });
        return { request, captured, unregister };
    };

    test('startAutovote and stopAutovote ask the registered control, bound to the capture the cycle began under', async () => {
        own([{ type: 'startAutovote' }, { type: 'stopAutovote' }]);
        const { request, captured, unregister } = control({ ok: true, mode: 'voting', changed: true });
        try {
            await expect(lifecycle().installation({ rules: true })).resolves.toBe('published');
        } finally {
            unregister();
        }
        expect(request.mock.calls).toEqual([
            [true, captured],
            [false, captured],
        ]);
        expect(installation().fired.r1).toBeDefined();
    });

    test('an obsolete request is retried by a later run: the rule stays at that step', async () => {
        own([{ type: 'startAutovote' }, { type: 'notify', message: 'after' }]);
        const { unregister } = control({ ok: false, reason: 'obsolete' });
        try {
            await lifecycle().installation({ rules: true });
        } finally {
            unregister();
        }
        expect(log.warning).toHaveBeenCalledWith(
            expect.stringContaining('autovote was stopped, so the request was not applied'),
            null,
        );
        // Not finished, and nothing after it ran.
        expect(installation().fired.r1).toBeUndefined();
        expect(installation().outbox?.map((item) => item.message) ?? []).not.toContain('after');
    });

    test.each([
        ['not-armed', 'autovote is not armed'],
        ['unsupported', 'this runtime cannot pause the voting stages'],
    ] as const)('a request the controller refuses as %s is passed over, with its reason', async (reason, message) => {
        // A passed-over step of a rule that has already acted: the rule carries on.
        own([{ type: 'notify', message: 'before' }, { type: 'stopAutovote' }, { type: 'notify', message: 'after' }]);
        const { unregister } = control({ ok: false, reason });
        try {
            await lifecycle().installation({ rules: true });
        } finally {
            unregister();
        }
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining(message), null);
        expect(installation().outbox?.map((item) => item.message)).toContain('after');
    });

    test('the installation’s time zone is captured once for the cycle, whatever the rules republish; one it cannot read runs nothing', async () => {
        own([
            { type: 'notify', message: 'one' },
            { type: 'notify', message: 'two' },
        ]);
        await lifecycle().installation({ rules: true });
        const zoneReads = () =>
            settings.captureInstallationSettings.mock.calls.filter(([keys]) => keys.join() === 'timezone');
        // Published again after each confirmed action, and every one on the same capture.
        expect(settings.prepareInstallationSnapshot.mock.calls.length).toBeGreaterThan(2);
        expect(zoneReads()).toHaveLength(1);

        settings.captureInstallationSettings.mockReturnValueOnce({ ok: false, key: 'timezone', reason: 'expired' });
        await expect(lifecycle().installation({ rules: true })).resolves.toBe('unavailable');
        settings.captureInstallationSettings.mockReturnValueOnce({ ok: false, key: 'timezone', reason: 'expired' });
        await expect(lifecycle().installation({ rules: false })).resolves.toBe('unavailable');
    });

    test('with no controller in this runtime the request is passed over', async () => {
        own([{ type: 'notify', message: 'before' }, { type: 'startAutovote' }, { type: 'notify', message: 'after' }]);
        await lifecycle().installation({ rules: true });
        expect(log.warning).toHaveBeenCalledWith(
            expect.stringContaining('this runtime has no autovote controller'),
            null,
        );
        expect(installation().outbox?.map((item) => item.message)).toContain('after');
    });

    test('a cycle that began before a Stop publishes nothing and runs no account rule', async () => {
        own([{ type: 'notify', message: 'account rule ran' }]);
        const { unregister } = control({ ok: true, mode: 'voting', changed: false }, false);
        try {
            await expect(lifecycle().installation({ rules: true })).resolves.toBe('fenced');
            await expect(lifecycle().installation({ rules: false })).resolves.toBe('fenced');
        } finally {
            unregister();
        }
        expect(settings.prepareInstallationSnapshot).not.toHaveBeenCalled();
        expect(ledger.get(KEY).state).toBeNull();
    });

    test('a zone the installation cannot read holds a candidate’s pre-join rules and a closed challenge’s post-close rules', async () => {
        scenarios.Plan = preJoin([{ type: 'join' }]);
        assigned['7'] = 'Plan';
        settings.captureInstallationSettings.mockReturnValue({ ok: false, key: 'timezone', reason: 'expired' });
        const join = jest.fn(async () => ({ status: 'joined', charged: 0, maybeCharged: 0 }));
        await expect(lifecycle().preJoin.run(candidate(), join)).resolves.toBeNull();
        expect(join).not.toHaveBeenCalled();
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('the pre-join rules wait'), null);
        expect(ledger.get(7).state).toBeNull();

        scenarios.Plan = postClose([{ type: 'notify', message: 'done' }]);
        assigned['9'] = 'Plan';
        seed(9, 'Plan');
        completed = [claimable(9, 'NONE')];
        await lifecycle().postClose();
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('the post-close rules wait'), null);
        expect(record(9).outbox ?? []).toEqual([]);
    });
});
