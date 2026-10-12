/**
 * The scenario runner inside the voting pass: starting a challenge's plan,
 * executing rule actions over the existing primitives, commit/resume
 * semantics, the per-pass and goto-loop guards, and failure recording.
 */

jest.mock('../../src/ts/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warning: jest.fn(), success: jest.fn() };
    return {
        withCategory: jest.fn(() => category),
        challengeTag: jest.fn((c: { id?: string | number } | null | undefined) => `[${c?.id}]`),
        __category: category,
    };
});
jest.mock('../../src/ts/settings', () => ({
    getEffectiveSetting: jest.fn(),
    getScenario: jest.fn(),
    getSetting: jest.fn(() => 'UTC'),
}));
jest.mock('../../src/ts/services/currencyActions', () => ({
    withSpendLock: jest.fn(async (spend: () => Promise<unknown>) => ({ busy: false, value: await spend() })),
    previewSwap: jest.fn(),
    swapEntry: jest.fn(),
    unlockBoostWithKey: jest.fn(),
    fillExposure: jest.fn(),
}));
jest.mock('../../src/ts/services/autoFill', () => {
    const actual = jest.requireActual<typeof import('../../src/ts/services/autoFill/challengeState')>(
        '../../src/ts/services/autoFill/challengeState',
    );
    return {
        submitNewEntryForAction: jest.fn(),
        refreshChallengeState: jest.fn(async () => 'refreshed'),
        reflectNewEntry: actual.reflectNewEntry,
        reflectEntryFlag: actual.reflectEntryFlag,
        getSlotsRemaining: actual.getSlotsRemaining,
    };
});
jest.mock('../../src/ts/runtime', () => ({
    isCapacitor: jest.fn(() => false),
    isHeadlessService: jest.fn(() => false),
}));
jest.mock('../../src/ts/services/NativeAutovoteBridge', () => ({ isAvailable: jest.fn(() => false) }));

import loggerModule = require('../../src/ts/logger');
const logger = jest.mocked(loggerModule);
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import currencyActionsModule = require('../../src/ts/services/currencyActions');
const currencyActions = jest.mocked(currencyActionsModule);
import autoFillModule = require('../../src/ts/services/autoFill');
const autoFill = jest.mocked(autoFillModule);
import runtimeModule = require('../../src/ts/runtime');
const runtime = jest.mocked(runtimeModule);
import nativeAutovoteModule = require('../../src/ts/services/NativeAutovoteBridge');
const nativeAutovote = jest.mocked(nativeAutovoteModule);
import type * as scenarioRunnerModule from '../../src/ts/services/scenarioRunner';
import type * as ruleModule from '../../src/ts/services/scenarioRunner/rule';
import type * as supportModule from '../../src/ts/services/scenarioRunner/support';
import type * as scenarioStateStoreModule from '../../src/ts/scenarioStateStore';
import type { Challenge, ChallengeMember, MemberRanking, RankingEntry } from '../../src/ts/types/gurushots';
import type { ScenarioDocument } from '../../src/ts/settings/scenarioSchema';
import type { CategoryLogger } from '../../src/ts/logger';
import type { VotingPassApi } from '../../src/ts/types/votingPass';
import type { CurrencyPassDeps } from '../../src/ts/services/currencyAuto';
import type { SwapBackLedger } from '../../src/ts/services/currencyActions';
import { invalid } from '../helpers/invalid';
const { runScenarioStep, backgroundServiceOwnsScenarios } =
    require('../../src/ts/services/scenarioRunner') as typeof scenarioRunnerModule;
const { runRule } = require('../../src/ts/services/scenarioRunner/rule') as typeof ruleModule;
const { lockedCurrencySpend } = require('../../src/ts/services/scenarioRunner/support') as typeof supportModule;
const { createMemoryStateLedger, createStateLedger, initialState } =
    require('../../src/ts/scenarioStateStore') as typeof scenarioStateStoreModule;

type CategoryMock = {
    [K in 'info' | 'error' | 'debug' | 'warning' | 'success']: jest.MockedFunction<CategoryLogger[K]>;
};
const log = (logger as typeof logger & { __category: CategoryMock }).__category;
const NOW = Math.floor(Date.now() / 1000);

// The member tree every test reads; the rest of a Challenge the runner never touches.
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
            boost: { state: 'AVAILABLE' },
            turbo: { state: 'WON' },
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
const rule = (id: string, actions: object[], extra = {}) => ({ id, do: actions, ...extra });
const single = (actions: object[], extra = {}, scenarioExtra = {}) =>
    plan({ main: { rules: [rule('r1', actions, extra)] } }, scenarioExtra);

type TestPass = {
    token: string;
    api: jest.Mocked<
        Pick<
            VotingPassApi,
            | 'getActiveChallenges'
            | 'submitToChallenge'
            | 'applyBoostToEntry'
            | 'applyTurbo'
            | 'getVoteImages'
            | 'submitVotes'
        >
    >;
    fillDeps: object;
    currency: {
        strategy: jest.Mocked<Pick<CurrencyPassDeps['strategy'], 'getBankroll'>>;
        swapLedger?: jest.Mocked<Pick<SwapBackLedger, 'onSwapped'>>;
    };
    scenarios: {
        ledger: ReturnType<typeof createMemoryStateLedger>;
        lock?: (challengeId: string) => { ok: boolean; release: () => void };
    };
};

let ledger: ReturnType<typeof createMemoryStateLedger>;
let pass: TestPass;
let assigned: string;

const setup = (scenario: ScenarioDocument) => {
    settings.getScenario.mockReturnValue(scenario);
};

const run = async (c = challenge()) => {
    await runScenarioStep(c, NOW, invalid(pass));
    return c;
};

const state = () => ledger.get(7).state!;

beforeEach(() => {
    jest.clearAllMocks();
    ledger = createMemoryStateLedger();
    assigned = 'Plan';
    settings.getEffectiveSetting.mockImplementation((key) => (key === 'scenario' ? assigned : 0));
    pass = {
        token: 'tok',
        api: {
            getActiveChallenges: jest.fn(),
            submitToChallenge: jest.fn<
                ReturnType<VotingPassApi['submitToChallenge']>,
                Parameters<VotingPassApi['submitToChallenge']>
            >(async () => invalid({ ok: true })),
            applyBoostToEntry: jest.fn<
                ReturnType<VotingPassApi['applyBoostToEntry']>,
                Parameters<VotingPassApi['applyBoostToEntry']>
            >(async () => ({ success: true })),
            applyTurbo: jest.fn<ReturnType<VotingPassApi['applyTurbo']>, Parameters<VotingPassApi['applyTurbo']>>(
                async () => invalid({ ok: true }),
            ),
            getVoteImages: jest.fn<
                ReturnType<VotingPassApi['getVoteImages']>,
                Parameters<VotingPassApi['getVoteImages']>
            >(async () => invalid({ images: [] })),
            submitVotes: jest.fn<ReturnType<VotingPassApi['submitVotes']>, Parameters<VotingPassApi['submitVotes']>>(
                async () => ({ success: true }),
            ),
        },
        fillDeps: {},
        currency: {
            strategy: {
                getBankroll: jest.fn<
                    ReturnType<CurrencyPassDeps['strategy']['getBankroll']>,
                    Parameters<CurrencyPassDeps['strategy']['getBankroll']>
                >(async () => ({ keys: 5, swaps: 5, fills: 5, coins: 0 })),
            },
        },
        scenarios: { ledger },
    };
});

describe('when nothing runs', () => {
    test('no scenario deps, a host that defers, no assignment, or an unknown scenario', async () => {
        setup(single([{ type: 'fillExposure' }]));
        await runScenarioStep(challenge(), NOW, invalid({ ...pass, scenarios: null }));
        await runScenarioStep(challenge(), NOW, invalid({ ...pass, scenarios: { ledger, enabled: () => false } }));
        assigned = '';
        await run();
        expect(ledger.get(7).state).toBeNull();

        assigned = 'Missing';
        settings.getScenario.mockReturnValue(null);
        await run();
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('"Missing", which does not exist'), null);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('unreadable state halts the challenge without starting over', async () => {
        setup(single([{ type: 'fillExposure' }]));
        const broken = createMemoryStateLedger();
        const epoch = { all: 0, gen: 0 };
        for (const corrupt of ['file', 'record', 'unloaded'] as const) {
            jest.spyOn(broken, 'get').mockReturnValue({ corrupt, state: null, epoch });
            await runScenarioStep(challenge(), NOW, invalid({ ...pass, scenarios: { ledger: broken } }));
        }
        // What is said names the reset that helps: every challenge's, or this challenge's.
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('scenario-reset --all'), null);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('scenario-reset --challenge=7'), null);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('not loaded yet'), null);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('a thrown non-Error is logged as-is', async () => {
        settings.getScenario.mockImplementation(() => {
            throw 'plain';
        });
        await run();
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('failed: plain'), null);
    });

    test('a throw inside is logged, never propagated', async () => {
        settings.getScenario.mockImplementation(() => {
            throw new Error('boom');
        });
        await expect(run()).resolves.toBeDefined();
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('boom'), null);
    });
});

describe('one process at a time per challenge', () => {
    const lockWith = (ok: boolean) => {
        const release = jest.fn();
        const lock = jest.fn((_challengeId: string) => ({ ok, release }));
        pass.scenarios = { ledger, lock };
        return { release, lock };
    };

    test('the step runs under the lock of its challenge that the pass is given, released when it ends', async () => {
        const { release, lock } = lockWith(true);
        currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
        setup(single([{ type: 'fillExposure' }]));
        await run();
        expect(lock).toHaveBeenCalledWith('7');
        expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
        expect(release).toHaveBeenCalledTimes(1);
    });

    test('a pass with no lock to give (mock mode) runs the step all the same', async () => {
        currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
        setup(single([{ type: 'fillExposure' }]));
        await run();
        expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
    });

    test('while another process holds it, nothing runs and nothing is written this pass', async () => {
        const { release } = lockWith(false);
        setup(single([{ type: 'fillExposure' }]));
        await run();
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
        expect(ledger.get(7).state).toBeNull();
        expect(release).not.toHaveBeenCalled();
        expect(log.debug).toHaveBeenCalledWith(
            expect.stringContaining('another process is running its scenario'),
            null,
        );
    });

    test('a lock the app cannot make at all is a warning every pass, not the debug line of a lock that is held', async () => {
        pass.scenarios = { ledger, lock: () => ({ ok: false, release: jest.fn(), unavailable: true }) };
        setup(single([{ type: 'fillExposure' }]));
        await run();
        await run();
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
        const said = log.warning.mock.calls.filter(([message]) =>
            String(message).includes('cannot create its lock files'),
        );
        expect(said).toHaveLength(2);
        expect(log.debug).not.toHaveBeenCalledWith(expect.stringContaining('another process is running'), null);
    });

    test('a lock another process keeps holding turns from a debug line into a warning, and starts over when it is had', async () => {
        const holder = { held: true };
        pass.scenarios = { ledger, lock: () => ({ ok: !holder.held, release: jest.fn() }) };
        setup(plan({ main: {} }));
        // (Its own challenge: the count of passes is kept per challenge across tests.)
        const challengeSeven = { ...challenge(), id: 99 };
        const held = () => log.warning.mock.calls.filter(([m]) => String(m).includes('passes in a row')).length;
        await run(challengeSeven);
        await run(challengeSeven);
        expect(held()).toBe(0);
        await run(challengeSeven);
        expect(held()).toBe(1);
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('(3 passes in a row)'), null);
        // Had once, the count starts over.
        holder.held = false;
        await run(challengeSeven);
        holder.held = true;
        await run(challengeSeven);
        await run(challengeSeven);
        expect(held()).toBe(1);
    });

    test('two passes at once spend once: the second finds the lock held and skips the challenge', async () => {
        const held = new Set<string>();
        pass.scenarios = {
            ledger,
            lock: (id) => {
                if (held.has(id)) return { ok: false, release: () => {} };
                held.add(id);
                return { ok: true, release: () => held.delete(id) };
            },
        };
        let finish!: () => void;
        currencyActions.fillExposure.mockImplementationOnce(
            () => new Promise((resolve) => (finish = () => resolve(invalid({ ok: true })))),
        );
        setup(single([{ type: 'fillExposure' }]));
        const first = run();
        await Promise.resolve();
        await run();
        finish();
        await first;
        expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
        expect(held.size).toBe(0);
    });

    describe('a lock that went stale while the process slept may have been taken over: it is asked about right before a spend', () => {
        test('a lock this process no longer owns spends nothing, writes no marker, and says so', async () => {
            const held = jest.fn(() => false);
            pass.scenarios = { ledger, lock: () => ({ ok: true, release: jest.fn(), held }) };
            currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
            setup(single([{ type: 'fillExposure' }]));
            await run();
            expect(held).toHaveBeenCalledTimes(1);
            expect(currencyActions.fillExposure).not.toHaveBeenCalled();
            expect(state().inFlight).toBeNull();
            expect(log.warning).toHaveBeenCalledWith(
                expect.stringContaining("lock of this challenge's steps was lost"),
                null,
            );
        });

        test('a lock that is still owned spends, once per spend', async () => {
            const held = jest.fn(() => true);
            pass.scenarios = { ledger, lock: () => ({ ok: true, release: jest.fn(), held }) };
            currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
            setup(single([{ type: 'fillExposure' }]));
            await run();
            expect(held).toHaveBeenCalledTimes(1);
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
        });

        test('two runners over one state file, the lock taken over from the first while it waited: one spend is sent', async () => {
            const store = { raw: null as string | null };
            const shared = {
                readRaw: () => store.raw,
                writeRaw: (data: string) => {
                    store.raw = data;
                },
            };
            const ledgerA = createStateLedger(shared);
            const ledgerB = createStateLedger(shared);
            // The first runner is held up on its balance read, as a machine is when it sleeps.
            let wake!: () => void;
            const asleep = new Promise<void>((resolve) => (wake = resolve));
            const bankroll = { keys: 5, swaps: 5, fills: 5, coins: 0 };
            const passFor = (
                own: typeof ledgerA,
                getBankroll: () => Promise<typeof bankroll>,
            ): Parameters<typeof runScenarioStep>[2] =>
                invalid({
                    ...pass,
                    scenarios: { ledger: own, lock: () => ({ ok: true, release: jest.fn() }) },
                    currency: { strategy: { getBankroll: jest.fn(getBankroll) } },
                });
            currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
            setup(single([{ type: 'fillExposure' }]));

            const first = runScenarioStep(
                challenge(),
                NOW,
                passFor(ledgerA, async () => {
                    await asleep;
                    return bankroll;
                }),
            );
            // Another process takes the step over and finishes it.
            await runScenarioStep(
                challenge(),
                NOW,
                passFor(ledgerB, async () => bankroll),
            );
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
            wake();
            await first;

            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
            expect(log.warning).toHaveBeenCalledWith(
                expect.stringContaining('was changed by another process meanwhile'),
                null,
            );
            // What the second runner recorded stands: the rule fired once.
            expect(ledgerB.get(7).state!.fired.r1).toBeDefined();
            expect(ledgerB.get(7).state!.spent.fills).toBe(1);
        });
    });

    test('the lock is released when the step fails', async () => {
        const { release } = lockWith(true);
        setup(single([{ type: 'fillExposure' }]));
        jest.spyOn(ledger, 'get').mockImplementationOnce(() => {
            throw new Error('boom');
        });
        await run();
        expect(release).toHaveBeenCalledTimes(1);
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('boom'), null);
    });
});

describe('a state that cannot be written down is never run on', () => {
    // The calls of ledger.set a pass makes: the start of the plan, the vote sample, then for a spend its write-ahead
    // marker and its result, and for any other step its result.
    const failAfter = (writes: number) => {
        const real = ledger.set.bind(ledger);
        let calls = 0;
        jest.spyOn(ledger, 'set').mockImplementation((id, next) => (++calls <= writes ? real(id, next) : 'failed'));
    };

    test('a plan that cannot be started is not run', async () => {
        failAfter(0);
        setup(single([{ type: 'fillExposure' }]));
        await run();
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('a vote sample that cannot be written stops the step before any rule', async () => {
        failAfter(1);
        setup(single([{ type: 'fillExposure' }]));
        await run();
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });

    test('a spend whose marker could not be written down first is not made', async () => {
        failAfter(2);
        currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
        setup(single([{ type: 'fillExposure' }]));
        await run();
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
        expect(state().inFlight).toBeNull();
    });

    test('a step that landed and could not be written down is the last of its rule: the next one could spend too', async () => {
        failAfter(3);
        currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
        currencyActions.unlockBoostWithKey.mockResolvedValue(invalid({ ok: true }));
        setup(single([{ type: 'fillExposure' }, { type: 'unlockBoost' }]));
        await run();
        expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
    });

    test('a rule that finished and could not be written down is not followed by another in the same pass', async () => {
        failAfter(4);
        currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
        currencyActions.unlockBoostWithKey.mockResolvedValue(invalid({ ok: true }));
        setup(
            plan({ main: { rules: [rule('r1', [{ type: 'fillExposure' }]), rule('r2', [{ type: 'unlockBoost' }])] } }),
        );
        await run();
        expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
    });

    test('a skipped step of a committed rule that could not be written down ends the rule there', async () => {
        failAfter(5);
        currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
        currencyActions.unlockBoostWithKey.mockResolvedValueOnce({ ok: false, outcome: 'no-balance' });
        setup(single([{ type: 'fillExposure' }, { type: 'unlockBoost' }, { type: 'fillExposure' }]));
        await run();
        expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
        expect(currencyActions.unlockBoostWithKey).toHaveBeenCalledTimes(1);
    });
});

describe('a spend is written down before it is made, so that a result that is never written is not spent again', () => {
    const unclear = { ok: false, outcome: 'unclear' } as const;

    // Two processes over one file: each has its own ledger (and so its own memory), and neither knows what the other
    // kept in memory.
    const processes = () => {
        let raw: string | null = null;
        const store = {
            readRaw: () => raw,
            writeRaw: (data: string) => {
                raw = data;
            },
        };
        return { first: createStateLedger(store), second: createStateLedger(store) };
    };
    const runIn = async (inLedger: typeof ledger, c: Challenge, extra: object = {}) => {
        await runScenarioStep(c, NOW, invalid({ ...pass, scenarios: { ledger: inLedger, ...extra } }));
        return c;
    };
    const lockedBoost = () => {
        const c = challenge();
        c.member.boost!.state = 'LOCKED';
        return c;
    };

    test('the marker is in the file while the spend is made, and gone once its result is written', async () => {
        let during: unknown = null;
        currencyActions.fillExposure.mockImplementationOnce(async () => {
            during = state().inFlight;
            return invalid({ ok: true });
        });
        setup(single([{ type: 'fillExposure' }, { type: 'fillExposure' }]));
        await run();
        expect(during).toEqual({ ruleId: 'r1', actionIndex: 0, pending: 'fillExposure' });
        expect(state().inFlight).toBeNull();
    });

    test('a step that spends nothing has no marker', async () => {
        let during: unknown = 'not read';
        pass.api.applyBoostToEntry.mockImplementationOnce(async () => {
            during = state().inFlight;
            return { success: true };
        });
        setup(single([{ type: 'boost', entry: { by: 'fewestVotes' } }]));
        await run();
        expect(during).toBeNull();
    });

    test('a refused spend leaves no marker behind: it was not made', async () => {
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'balance-unknown' });
        setup(single([{ type: 'fillExposure' }]));
        await run();
        expect(state().inFlight).toBeNull();
    });

    test('a process that spent and could not write the result: the next one, in another process, does not spend again', async () => {
        const { first, second } = processes();
        currencyActions.unlockBoostWithKey.mockResolvedValue(invalid({ ok: true }));
        setup(single([{ type: 'unlockBoost' }, { type: 'boost', entry: { by: 'fewestVotes' } }]));
        // The start, the sample and the marker are written; the result is not (the lock was busy, the process died).
        const real = first.set.bind(first);
        let writes = 0;
        jest.spyOn(first, 'set').mockImplementation((id, next) => (++writes <= 3 ? real(id, next) : 'failed'));
        const c = lockedBoost();
        await runIn(first, c);
        expect(currencyActions.unlockBoostWithKey).toHaveBeenCalledTimes(1);
        expect(second.get(7).state!.inFlight).toEqual({ ruleId: 'r1', actionIndex: 0, pending: 'unlockBoost' });

        // The next process looks at the live challenge, which shows the key went through: it goes on, and spends nothing.
        c.member.boost!.state = 'AVAILABLE_KEY';
        await runIn(second, c);
        expect(currencyActions.unlockBoostWithKey).toHaveBeenCalledTimes(1);
        expect(pass.api.applyBoostToEntry).toHaveBeenCalledTimes(1);
        expect(second.get(7).state!.fired.r1).toBeDefined();
    });

    test('…and when the live challenge does not show it, it stops that rule rather than spend: stopped, held for the phase', async () => {
        const { first, second } = processes();
        currencyActions.unlockBoostWithKey.mockResolvedValue(invalid({ ok: true }));
        setup(single([{ type: 'unlockBoost' }]));
        const real = first.set.bind(first);
        let writes = 0;
        jest.spyOn(first, 'set').mockImplementation((id, next) => (++writes <= 3 ? real(id, next) : 'failed'));
        const c = lockedBoost();
        await runIn(first, c);
        c.member.boost!.state = 'LOCKED';
        await runIn(second, c);
        await runIn(second, c);
        expect(currencyActions.unlockBoostWithKey).toHaveBeenCalledTimes(1);
        expect(second.get(7).state!.fired.r1.unclearHalt).toBe('unlockBoost');
        expect(second.get(7).state!.inFlight).toBeNull();
    });

    test('a marker left by a crash is read as a spend that got no answer: the same step, looked at, never repeated', async () => {
        const c = lockedBoost();
        setup(single([{ type: 'unlockBoost' }]));
        ledger.set(7, {
            ...initialState('Plan', 'main', NOW),
            inFlight: { ruleId: 'r1', actionIndex: 0, pending: 'unlockBoost' },
        });
        await run(c);
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
        expect(state().fired.r1.unclearHalt).toBe('unlockBoost');
        expect(state().lastError!.message).toContain(
            'the app did not record whether the boost unlock was sent or what came of it',
        );
        expect(state().fired.r1.haltOrigin).toBe('pending');
    });

    test('a marker of a step the scenario has since changed to another is kept beside the new one, counted once', async () => {
        const original = single([{ type: 'unlockBoost' }]);
        setup(single([{ type: 'fillExposure' }]));
        ledger.set(7, {
            ...initialState('Plan', 'main', NOW),
            inFlight: { ruleId: 'r1', actionIndex: 0, pending: 'unlockBoost' },
        });
        currencyActions.fillExposure.mockResolvedValueOnce(unclear);
        await run();
        // The key's marker is not overwritten by the fill's: both stay, and both are counted (the key's now, the
        // fill's as it got no answer).
        expect(state().inFlight).toEqual({
            ruleId: 'r1',
            actionIndex: 0,
            unclear: ['unlockBoost', 'fillExposure'],
            lost: ['unlockBoost'],
            unclearAt: expect.any(Number),
        });
        expect(state().spent).toEqual(expect.objectContaining({ keys: 1, fills: 1 }));

        // The edit is reverted: the key is looked at (the live boost does not show it), never spent again, and is
        // not counted a second time.
        setup(original);
        const c = lockedBoost();
        await run(c);
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
        expect(state().fired.r1.unclearHalt).toBe('unlockBoost');
        // The app did not know about the key, GuruShots was not asked: the halt says which.
        expect(state().fired.r1.haltOrigin).toBe('pending');
        expect(state().spent.keys).toBe(1);
    });

    test('a marker that already says when its spends got no answer keeps that time when another is absorbed', async () => {
        setup(single([{ type: 'fillExposure' }]));
        ledger.set(7, {
            ...initialState('Plan', 'main', NOW),
            inFlight: { ruleId: 'r1', actionIndex: 0, unclear: ['swap'], unclearAt: NOW - 500, pending: 'unlockBoost' },
        });
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'balance-unknown' });
        await run();
        expect(state().inFlight).toEqual({
            ruleId: 'r1',
            actionIndex: 0,
            unclear: ['swap', 'unlockBoost'],
            lost: ['unlockBoost'],
            unclearAt: NOW - 500,
        });
    });

    test('a count that the state has not started for that spend starts at one', async () => {
        setup(single([{ type: 'fillExposure' }]));
        ledger.set(7, {
            ...initialState('Plan', 'main', NOW),
            spent: {},
            inFlight: { ruleId: 'r1', actionIndex: 0, pending: 'unlockBoost' },
        });
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'balance-unknown' });
        await run();
        expect(state().spent).toEqual({ keys: 1 });
    });

    test('a refused fill leaves the older marker where it was', async () => {
        setup(single([{ type: 'fillExposure' }]));
        ledger.set(7, {
            ...initialState('Plan', 'main', NOW),
            inFlight: { ruleId: 'r1', actionIndex: 0, pending: 'unlockBoost' },
        });
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'balance-unknown' });
        await run();
        expect(state().inFlight).toEqual({
            ruleId: 'r1',
            actionIndex: 0,
            unclear: ['unlockBoost'],
            lost: ['unlockBoost'],
            unclearAt: expect.any(Number),
        });
        expect(state().spent.keys).toBe(1);
    });

    test('an edit into a step that spends nothing and fails keeps the marker too: reverted, the key is not spent again', async () => {
        const original = single([{ type: 'unlockBoost' }]);
        setup(single([{ type: 'boost', entry: { by: 'fewestVotes' } }]));
        ledger.set(7, {
            ...initialState('Plan', 'main', NOW),
            inFlight: { ruleId: 'r1', actionIndex: 0, pending: 'unlockBoost' },
        });
        pass.api.applyBoostToEntry.mockResolvedValueOnce(null);
        const c = lockedBoost();
        c.member.boost!.state = 'AVAILABLE';
        await run(c);
        expect(state().inFlight).toEqual(
            expect.objectContaining({ ruleId: 'r1', actionIndex: 0, unclear: ['unlockBoost'] }),
        );
        expect(state().inFlight).not.toHaveProperty('pending');
        expect(state().spent.keys).toBe(1);
        setup(original);
        await run(lockedBoost());
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
        expect(state().spent.keys).toBe(1);
    });

    test('a spend recovered from its marker is counted: the limit holds across a crash, landed or not', async () => {
        for (const landed of [true, false]) {
            await ledger.remove(7);
            const { first, second } = processes();
            currencyActions.unlockBoostWithKey.mockResolvedValue(invalid({ ok: true }));
            setup({ ...single([{ type: 'unlockBoost' }]), limits: { keys: 1 } });
            const real = first.set.bind(first);
            let writes = 0;
            jest.spyOn(first, 'set').mockImplementation((id, next) => (++writes <= 3 ? real(id, next) : 'failed'));
            const c = lockedBoost();
            await runIn(first, c);
            expect(currencyActions.unlockBoostWithKey).toHaveBeenCalled();
            currencyActions.unlockBoostWithKey.mockClear();
            c.member.boost!.state = landed ? 'AVAILABLE_KEY' : 'LOCKED';
            await runIn(second, c);
            expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
            expect(second.get(7).state!.spent.keys).toBe(1);
            // The pass after that: the limit holds, whether the rule is held back (it was stopped) or free to run
            // again (it went on), so no further key is spent.
            await runIn(second, c);
            expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
            expect(second.get(7).state!.spent.keys).toBe(1);
        }
    });

    test.each([
        ['the scenario’s limit', { ...single([{ type: 'unlockBoost' }]), limits: { keys: 0 } }],
        [
            'a missing photo to swap in',
            single([{ type: 'swap', entry: { by: 'mostVotes' }, with: { memory: 'held' } }]),
        ],
    ])('a spend its own checks refuse leaves no marker, and writes nothing about it: %s', async (_name, doc) => {
        setup(doc);
        const set = jest.spyOn(ledger, 'set');
        await run();
        expect(set.mock.calls.filter(([, written]) => written.inFlight?.pending !== undefined)).toEqual([]);
        expect(state().inFlight).toBeNull();
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
        expect(currencyActions.swapEntry).not.toHaveBeenCalled();
    });

    test('a swap whose photo a selector chooses is written down after the preview, just before the swap', async () => {
        const order: string[] = [];
        currencyActions.previewSwap.mockImplementationOnce(async () => {
            order.push('preview');
            return invalid({ ok: true, candidate: { id: 'n1', member_id: 'm' } });
        });
        jest.spyOn(ledger, 'set').mockImplementation((id, next) => {
            if (next.inFlight?.pending !== undefined) order.push('marker');
            return createMemoryStateLedger().set(id, next);
        });
        currencyActions.swapEntry.mockImplementationOnce(async () => {
            order.push('swap');
            return { ok: true, outcome: 'ok' };
        });
        setup(single([{ type: 'swap', entry: { by: 'mostVotes' }, with: 'best' }]));
        await run();
        expect(order).toEqual(['preview', 'marker', 'swap']);
    });

    test('a preview that is refused leaves no marker: nothing was spent, and nothing is said to have been', async () => {
        currencyActions.previewSwap.mockResolvedValueOnce(invalid({ ok: false, outcome: 'no-alternative' }));
        const set = jest.spyOn(ledger, 'set');
        setup(single([{ type: 'swap', entry: { by: 'mostVotes' }, with: 'best' }]));
        await run();
        expect(set.mock.calls.filter(([, written]) => written.inFlight?.pending !== undefined)).toEqual([]);
        expect(currencyActions.swapEntry).not.toHaveBeenCalled();
        expect(state().inFlight).toBeNull();
    });

    test('a spend that has no way to write its marker is never made: a missing writer is not permission', async () => {
        const doc = single([{ type: 'fillExposure' }]);
        const request = jest.fn<Promise<{ ok: boolean; outcome: string }>, []>(async () => ({
            ok: true,
            outcome: 'ok',
        }));
        for (const beforeSpend of [null, () => false]) {
            const refused = await lockedCurrencySpend(
                'fillExposure',
                invalid({ challenge: challenge(), scenario: doc, beforeSpend }),
                (send) => send(request),
            );
            expect(refused).toMatchObject({
                status: 'deferred',
                message: expect.stringContaining('could not be written down first'),
            });
        }
        expect(request).not.toHaveBeenCalled();
    });

    test('a spend’s request serves once: a second call is refused, with no second marker and no second request', async () => {
        const beforeSpend = jest.fn(() => true);
        const request = jest.fn<Promise<{ ok: boolean; outcome: string }>, []>(async () => ({
            ok: true,
            outcome: 'ok',
        }));
        const second: unknown[] = [];
        const done = await lockedCurrencySpend(
            'fillExposure',
            invalid({ challenge: challenge(), scenario: single([{ type: 'fillExposure' }]), beforeSpend }),
            async (send) => {
                const first = await send(request);
                second.push(await send(request));
                return first;
            },
        );
        expect(done).toBeNull();
        expect(second).toEqual([{ ok: false, outcome: expect.any(String) }]);
        expect(beforeSpend).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledTimes(1);
    });

    test('the marker is written inside the spend lock, after the spend’s own checks, just before the request', async () => {
        const order: string[] = [];
        currencyActions.withSpendLock.mockImplementationOnce(async (spend) => {
            order.push('lock');
            return { busy: false, value: await spend() };
        });
        jest.spyOn(ledger, 'set').mockImplementation((id, next) => {
            if (next.inFlight?.pending !== undefined) order.push('marker');
            return createMemoryStateLedger().set(id, next);
        });
        currencyActions.fillExposure.mockImplementationOnce(async () => {
            order.push('request');
            return invalid({ ok: true });
        });
        setup(single([{ type: 'fillExposure' }]));
        await run();
        expect(order).toEqual(['lock', 'marker', 'request']);
    });

    test('a spend whose lock another holds leaves no marker either: it was not made', async () => {
        currencyActions.withSpendLock.mockImplementationOnce(async () => ({ busy: true, value: null }));
        const set = jest.spyOn(ledger, 'set');
        setup(single([{ type: 'fillExposure' }]));
        await run();
        expect(set.mock.calls.filter(([, written]) => written.inFlight?.pending !== undefined)).toEqual([]);
        expect(currencyActions.fillExposure).not.toHaveBeenCalled();
    });
});

describe('a result that cannot be written is written once more', () => {
    // Fails the writes numbered in `failing`, counting from the first of the pass.
    const failing = (...numbers: number[]) => {
        const real = ledger.set.bind(ledger);
        let calls = 0;
        const set = jest
            .spyOn(ledger, 'set')
            .mockImplementation((id, next) => (numbers.includes(++calls) ? 'failed' : real(id, next)));
        return set;
    };

    test('a short hold of the lock after a spend that landed does not stop the rule', async () => {
        // 1 start, 2 sample, 3 marker, 4 the result of the fill (fails), 5 its second try, 6 marker, 7 result…
        failing(4);
        currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
        currencyActions.unlockBoostWithKey.mockResolvedValue(invalid({ ok: true }));
        setup(single([{ type: 'fillExposure' }, { type: 'unlockBoost' }]));
        await run();
        expect(currencyActions.unlockBoostWithKey).toHaveBeenCalledTimes(1);
        expect(state().fired.r1).toBeDefined();
    });

    test('one that does not come right is the last of the rule, and the log says the next pass may stop it needlessly', async () => {
        failing(4, 5);
        currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
        setup(single([{ type: 'fillExposure' }, { type: 'unlockBoost' }]));
        await run();
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('may stop this rule needlessly'), null);
    });

    test('one whose second try finds the progress was reset meanwhile is not a failed write to warn about', async () => {
        const real = ledger.set.bind(ledger);
        let calls = 0;
        jest.spyOn(ledger, 'set').mockImplementation((id, next) => {
            calls += 1;
            if (calls === 4) return 'failed';
            return calls === 5 ? 'refused' : real(id, next);
        });
        currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
        setup(single([{ type: 'fillExposure' }, { type: 'unlockBoost' }]));
        await run();
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
        expect(log.warning).not.toHaveBeenCalledWith(expect.stringContaining('may stop this rule needlessly'), null);
    });

    test('the same for the state a step that stopped its rule leaves: once more, and said when it still fails', async () => {
        // 1 start, 2 sample, 3 marker, 4 the stop (fails), 5 its second try.
        failing(4);
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'balance-unknown' });
        setup(single([{ type: 'fillExposure' }]));
        await run();
        expect(state().lastError!.message).toContain('balance-unknown');
        expect(log.warning).not.toHaveBeenCalledWith(expect.stringContaining('may stop this rule needlessly'), null);

        jest.restoreAllMocks();
        await ledger.remove(7);
        failing(4, 5);
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'balance-unknown' });
        await run();
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('may stop this rule needlessly'), null);
    });
});

describe('a rule resumed past its first step without any marker (the state was edited by hand)', () => {
    test('stops at the failing step, with the marker of where it stands', async () => {
        currencyActions.unlockBoostWithKey.mockResolvedValueOnce({ ok: false, outcome: 'api-failed' });
        const doc = single([{ type: 'fillExposure' }, { type: 'unlockBoost' }]);
        setup(doc);
        const state = { ...initialState('Plan', 'main', NOW), epoch: ledger.get(7).epoch };
        const validated = { ...doc.phases.main.rules![0], id: 'r1' };
        const outcome = await runRule(
            { ruleId: 'r1', rule: invalid(validated), startIndex: 1 },
            invalid({ challenge: challenge(), challengeId: '7', scenario: doc, timezone: 'UTC', pass, ledger }),
            state,
        );
        expect(outcome.completed).toBe(false);
        expect(outcome.state.inFlight).toEqual({ ruleId: 'r1', actionIndex: 1 });
    });
});

describe('a reset made while a step runs is not undone by it', () => {
    test.each([
        ['of its challenge', () => ledger.remove(7)],
        ['of every challenge', () => ledger.removeAll()],
    ])('a reset %s', async (_name, reset) => {
        currencyActions.fillExposure.mockImplementationOnce(async () => {
            reset();
            return invalid({ ok: true });
        });
        currencyActions.unlockBoostWithKey.mockResolvedValue(invalid({ ok: true }));
        setup(single([{ type: 'fillExposure' }, { type: 'unlockBoost' }]));
        const real = ledger.set.bind(ledger);
        const answers: string[] = [];
        jest.spyOn(ledger, 'set').mockImplementation((id, next) => {
            const answer = real(id, next);
            answers.push(answer);
            return answer;
        });
        await run();
        // The step that was running stops at its first write: nothing more is spent, and nothing comes back.
        expect(currencyActions.unlockBoostWithKey).not.toHaveBeenCalled();
        expect(ledger.get(7).state).toBeNull();
        // A write that was refused for a reset is not tried again, and is not a reason to say the rule may stop needlessly.
        expect(answers.filter((answer) => answer === 'refused')).toHaveLength(1);
        expect(log.warning).not.toHaveBeenCalledWith(expect.stringContaining('may stop this rule needlessly'), null);
    });
});

describe('starting a plan', () => {
    test('a challenge without state starts in the start phase', async () => {
        setup(plan({ main: {} }));
        await run();
        expect(state()).toEqual(expect.objectContaining({ scenario: 'Plan', phase: 'main', phaseEnteredAt: NOW }));
    });

    test("every pass samples the entries' votes for the speed conditions", async () => {
        setup(plan({ main: {} }));
        await run();
        expect(state().history).toEqual({ a: [[NOW, 10]], b: [[NOW, 3]] });
    });

    test('state from another scenario is replaced; the same scenario (any casing) is kept', async () => {
        setup(plan({ main: {} }));
        ledger.set(7, initialState('Other', 'x', 1));
        await run();
        expect(state().scenario).toBe('Plan');
        ledger.set(7, { ...initialState('PLAN', 'main', 5), memory: { held: 'z' } });
        await run();
        expect(state().memory).toEqual({ held: 'z' });
    });
});

describe('actions', () => {
    describe('enterPhoto', () => {
        test('best: submits through the fill path and remembers the photo', async () => {
            autoFill.submitNewEntryForAction.mockResolvedValue({
                ok: true,
                imageId: invalid<string>(99),
                reason: 'submitted',
            });
            setup(single([{ type: 'enterPhoto', photo: 'best', remember: 'fresh' }]));
            const c = await run();
            expect(c.member.ranking.entries.map((e) => e.id)).toContain('99');
            expect(state().memory).toEqual({ fresh: '99' });
            expect(state().fired.r1).toEqual(expect.objectContaining({ phaseEnteredAt: NOW }));
            expect(state().lastAction).toEqual(expect.objectContaining({ ruleId: 'r1', action: 'enterPhoto' }));
        });

        test.each([
            ['no-slots', 'no free entry slot'],
            ['challenge-gone', 'no longer active'],
            ['no-eligible', 'no eligible photo to enter'],
            ['no-chosen', 'no chosen photo can be entered'],
            ['fetch-error', 'no photo was entered (fetch-error)'],
        ])('best: %s', async (reason, message) => {
            autoFill.submitNewEntryForAction.mockResolvedValue({ ok: false, imageId: null, reason });
            setup(single([{ type: 'enterPhoto', photo: 'best' }]));
            await run();
            expect(state().lastError!.message).toContain(message);
            expect(state().inFlight).toBeNull();
            expect(state().fired).toEqual({});
        });

        test('remembered photo: entered as a new entry', async () => {
            setup(single([{ type: 'enterPhoto', photo: { memory: 'held' } }]));
            ledger.set(7, { ...initialState('Plan', 'main', NOW), memory: { held: 'p9' } });
            const c = await run();
            expect(pass.api.submitToChallenge).toHaveBeenCalledWith(7, ['p9'], 'tok');
            expect(c.member.ranking.entries.map((e) => e.id)).toContain('p9');
        });

        test.each([
            ['an empty memory slot', {}, null, 'memory slot "held" is empty'],
            ['a challenge that left', { held: 'p9' }, 'gone', 'no longer active'],
            ['a full challenge', { held: 'p9' }, 'full', 'no free entry slot'],
            ['a photo already entered', { held: 'a' }, null, 'photo a is already entered'],
            ['a refused submit', { held: 'p9' }, 'refused', 'could not be entered'],
        ])('remembered photo: %s', async (label, memory, mode, message) => {
            setup(single([{ type: 'enterPhoto', photo: { memory: 'held' } }]));
            ledger.set(7, { ...initialState('Plan', 'main', NOW), memory });
            if (mode === 'gone') autoFill.refreshChallengeState.mockResolvedValueOnce('gone');
            if (mode === 'refused') pass.api.submitToChallenge.mockResolvedValueOnce(invalid({ ok: false }));
            const c = challenge();
            if (mode === 'full') c.max_photo_submits = 2;
            await run(c);
            expect(state().lastError!.message).toContain(message);
        });
    });

    describe('swap', () => {
        const swapRule = (extra = {}) => single([{ type: 'swap', entry: { by: 'mostVotes' }, with: 'best', ...extra }]);

        beforeEach(() => {
            currencyActions.previewSwap.mockResolvedValue(
                invalid({ ok: true, candidate: { id: 'n1', member_id: 'm' } }),
            );
            currencyActions.swapEntry.mockResolvedValue({ ok: true, outcome: 'ok' });
        });

        test('best: previews, swaps, reflects the entry, remembers and counts the spend', async () => {
            setup(swapRule({ rememberRemoved: 'held', rememberAdded: 'filler' }));
            const c = await run();
            expect(currencyActions.previewSwap).toHaveBeenCalledWith(7, 'a', 'tok', expect.any(Object));
            expect(currencyActions.swapEntry).toHaveBeenCalledWith(
                7,
                'a',
                'n1',
                'tok',
                expect.objectContaining({ ledger: null }),
            );
            expect(c.member.ranking.entries[0]).toEqual({ id: 'n1', member_id: 'm' });
            expect(c.member.ranking.swaps).toEqual([{ id: 'a' }]);
            expect(state().memory).toEqual({ held: 'a', filler: 'n1' });
            expect(state().spent.swaps).toBe(1);
        });

        test('counts spends from a state without counters, and falls back to the app timezone default', async () => {
            settings.getSetting.mockReturnValueOnce('');
            setup({ ...swapRule(), limits: { swaps: 3 } });
            ledger.set(7, { ...initialState('Plan', 'main', NOW), spent: {} });
            await run();
            expect(state().spent.swaps).toBe(1);
        });

        test('a swapped-back photo inherits the owner of the replaced entry, or none', async () => {
            setup(single([{ type: 'swap', entry: { by: 'fewestVotes' }, with: { memory: 'held' } }]));
            ledger.set(7, { ...initialState('Plan', 'main', NOW), memory: { held: 'orig' } });
            const c = challenge();
            delete c.member.ranking.entries[1].member_id;
            await run(c);
            expect(c.member.ranking.entries[1]).toEqual({ id: 'orig', member_id: '' });
        });

        test('remembered photo: swapped back in without a preview; a missing swaps list is created', async () => {
            pass.currency.swapLedger = { onSwapped: jest.fn() };
            setup(single([{ type: 'swap', entry: { by: 'fewestVotes' }, with: { memory: 'held' } }]));
            ledger.set(7, { ...initialState('Plan', 'main', NOW), memory: { held: 'orig' } });
            const c = challenge();
            delete c.member.ranking.swaps;
            await run(c);
            expect(currencyActions.previewSwap).not.toHaveBeenCalled();
            expect(currencyActions.swapEntry).toHaveBeenCalledWith(
                7,
                'b',
                'orig',
                'tok',
                expect.objectContaining({ ledger: pass.currency.swapLedger }),
            );
            expect(c.member.ranking.swaps).toEqual([{ id: 'b' }]);
        });

        test.each([
            ['an empty memory slot', { with: { memory: 'held' } }, {}, 'memory slot "held" is empty', null],
            ['a challenge that left', {}, {}, 'no longer active', 'gone'],
            [
                'no matching entry',
                { entry: { by: 'memory', slot: 'x' } },
                { x: 'zz' },
                'no entry matches the swap target',
                null,
            ],
            [
                'a replacement already entered',
                { with: { memory: 'held' } },
                { held: 'b' },
                'photo b is already entered',
                null,
            ],
            ['a refused preview', {}, {}, 'swap was refused (no-alternative)', 'preview'],
            ['a refused swap', {}, {}, 'swap was refused (api-failed)', 'swap'],
            ['a swap that got no answer', {}, {}, 'swap may have gone through (GuruShots gave no answer)', 'unclear'],
            ['a refused swap without an outcome', {}, {}, 'swap was refused (no response)', 'bare'],
        ])('%s', async (label, extra, memory, message, mode) => {
            setup(swapRule(extra));
            ledger.set(7, { ...initialState('Plan', 'main', NOW), memory });
            if (mode === 'gone') autoFill.refreshChallengeState.mockResolvedValueOnce('gone');
            if (mode === 'preview')
                currencyActions.previewSwap.mockResolvedValueOnce({ ok: false, outcome: 'no-alternative' });
            if (mode === 'swap') currencyActions.swapEntry.mockResolvedValueOnce({ ok: false, outcome: 'api-failed' });
            if (mode === 'unclear') currencyActions.swapEntry.mockResolvedValueOnce({ ok: false, outcome: 'unclear' });
            if (mode === 'bare') currencyActions.swapEntry.mockResolvedValueOnce(invalid({ ok: false }));
            await run();
            expect(state().lastError!.message).toContain(message);
        });

        test('the scenario limit and the user reserve stop a swap', async () => {
            setup(swapRule());
            settings.getScenario.mockReturnValue({ ...swapRule(), limits: { swaps: 1 } });
            ledger.set(7, { ...initialState('Plan', 'main', NOW), spent: { swaps: 1, keys: 0, fills: 0 } });
            await run();
            expect(state().lastError!.message).toContain("scenario's swaps limit of 1 is reached");

            settings.getScenario.mockReturnValue(swapRule());
            settings.getEffectiveSetting.mockImplementation((key) => (key === 'scenario' ? 'Plan' : 5));
            await run();
            expect(state().lastError!.message).toContain('swaps reserve would be crossed');
            expect(currencyActions.swapEntry).not.toHaveBeenCalled();
        });

        test('a busy spend lock defers without recording an error', async () => {
            currencyActions.withSpendLock.mockResolvedValueOnce({ busy: true });
            setup(swapRule());
            await run();
            expect(state().lastError).toBeNull();
            expect(state().fired).toEqual({});
        });
    });

    describe('boost and turbo', () => {
        test('boost applies to the selected entry and uses up the boost', async () => {
            setup(single([{ type: 'boost', entry: { by: 'bestRank' } }]));
            const c = await run();
            expect(pass.api.applyBoostToEntry).toHaveBeenCalledWith(7, 'a', 'tok');
            expect(c.member.ranking.entries[0].boosted).toBe(true);
            expect(c.member.boost!.state).toBe('USED');
        });

        test('turbo applies a won turbo', async () => {
            setup(single([{ type: 'turbo', entry: { by: 'worstRank' } }]));
            const c = await run();
            expect(pass.api.applyTurbo).toHaveBeenCalledWith(7, 'b', 'tok');
            expect(c.member.ranking.entries[1].turbo).toBe(true);
            expect(c.member.turbo!.state).toBe('USED');
        });

        test.each([
            ['boost', 'unavailable', 'the boost is not available (LOCKED)'],
            ['boost', 'unknown', 'the boost is not available (unknown)'],
            ['boost', 'no-target', 'no entry matches the boost target'],
            ['boost', 'refused', 'was refused'],
            ['boost', 'gone', 'no longer active'],
            ['turbo', 'unavailable', 'no won turbo to apply (FREE)'],
            ['turbo', 'unknown', 'no won turbo to apply (unknown)'],
            ['turbo', 'no-target', 'no entry matches the turbo target'],
            ['turbo', 'refused', 'was refused'],
            ['turbo', 'gone', 'no longer active'],
        ])('%s: %s', async (type, mode, message) => {
            const entry = mode === 'no-target' ? { by: 'memory', slot: 'x' } : { by: 'bestRank' };
            const actions: object[] = [{ type, entry }];
            if (mode === 'no-target') actions.push({ type: 'remember', slot: 'x', entry: { by: 'bestRank' } });
            setup(single(actions));
            const c = challenge();
            if (mode === 'unavailable') {
                c.member.boost!.state = 'LOCKED';
                c.member.turbo!.state = 'FREE';
            }
            if (mode === 'unknown') {
                delete c.member.boost;
                delete c.member.turbo;
            }
            if (mode === 'refused') {
                pass.api.applyBoostToEntry.mockResolvedValueOnce(null);
                pass.api.applyTurbo.mockResolvedValueOnce(invalid({ ok: false }));
            }
            if (mode === 'gone') autoFill.refreshChallengeState.mockResolvedValueOnce('gone');
            await run(c);
            expect(state().lastError!.message).toContain(message);
        });
    });

    describe('key and fill spends', () => {
        test('unlockBoost spends a key and makes the boost available', async () => {
            currencyActions.unlockBoostWithKey.mockResolvedValue(invalid({ ok: true }));
            setup(single([{ type: 'unlockBoost' }]));
            const c = await run();
            expect(c.member.boost).toEqual({ state: 'AVAILABLE_KEY', timeout: null });
            expect(state().spent.keys).toBe(1);
        });

        test('a MISSED boost condition can unlock and apply the boost', async () => {
            currencyActions.unlockBoostWithKey.mockResolvedValue(invalid({ ok: true }));
            setup(
                single([{ type: 'unlockBoost' }, { type: 'boost', entry: { by: 'bestRank' } }], {
                    if: [{ type: 'boostState', in: ['MISSED'] }],
                }),
            );
            const c = challenge();
            c.member.boost = { state: 'MISSED' };
            await run(c);
            expect(currencyActions.unlockBoostWithKey).toHaveBeenCalledWith(7, 'tok', expect.any(Object));
            expect(pass.api.applyBoostToEntry).toHaveBeenCalledWith(7, 'a', 'tok');
            expect(c.member.boost?.state).toBe('USED');
            expect(state().spent.keys).toBe(1);
        });

        test('fillExposure spends a fill and raises exposure', async () => {
            currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
            setup(single([{ type: 'fillExposure' }]));
            const c = await run();
            expect(c.member.ranking.exposure!.exposure_factor).toBe(100);
            expect(state().spent.fills).toBe(1);
        });

        test.each<[string, 'unlockBoostWithKey' | 'fillExposure', string]>([
            ['unlockBoost', 'unlockBoostWithKey', 'keys'],
            ['fillExposure', 'fillExposure', 'fills'],
        ])('%s: refused, and stopped by its limit', async (type, method, limitKey) => {
            currencyActions[method].mockResolvedValue({ ok: false, outcome: 'no-balance' });
            setup(single([{ type }]));
            await run();
            expect(state().lastError!.message).toContain(`${type} was refused (no-balance)`);

            settings.getScenario.mockReturnValue(single([{ type }], {}, { limits: { [limitKey]: 0 } }));
            await run();
            expect(state().lastError!.message).toContain(`${limitKey} limit of 0`);
        });
    });

    describe('vote, remember, forget', () => {
        test('vote votes to the target exposure', async () => {
            setup(single([{ type: 'vote', toExposure: 80 }]));
            await run();
            expect(pass.api.submitVotes).toHaveBeenCalledWith({ images: [] }, 'tok', 80);
            expect(state().fired.r1).toBeDefined();
        });

        test.each<[string, 'getVoteImages' | 'submitVotes', null | undefined, string]>([
            ['no vote images', 'getVoteImages', null, 'vote images could not be loaded'],
            ['a refused submit', 'submitVotes', undefined, 'votes could not be submitted'],
        ])('vote: %s', async (label, method, value, message) => {
            // The checker cannot pair each row's value with its method's resolved type.
            pass.api[method].mockResolvedValueOnce(invalid(value));
            setup(single([{ type: 'vote', toExposure: 80 }]));
            await run();
            expect(state().lastError!.message).toContain(message);
        });

        test('remember and forget memory slots', async () => {
            setup(
                single([
                    { type: 'remember', slot: 'top', entry: { by: 'bestRank' } },
                    { type: 'remember', slot: 'low', entry: { by: 'fewestVotes' } },
                    { type: 'forget', slot: 'low' },
                ]),
            );
            await run();
            expect(state().memory).toEqual({ top: 'a' });
        });

        test('notify leaves a notice in the outbox, keeping the newest within a day', async () => {
            setup(single([{ type: 'notify', message: 'Held photo is out' }]));
            const old = Array.from({ length: 25 }, (_, i) => ({
                id: `o${i}`,
                at: NOW - (i < 5 ? 2 * 86400 : 60),
                message: 'x',
            }));
            ledger.set(7, { ...initialState('Plan', 'main', NOW), outbox: old });
            await run();
            const { outbox } = state();
            expect(outbox).toHaveLength(20);
            expect(outbox!.at(-1)).toEqual(
                expect.objectContaining({ message: 'Held photo is out', at: expect.any(Number) }),
            );
        });

        test('a state from before the outbox existed still takes a notice', async () => {
            setup(single([{ type: 'notify', message: 'hi' }]));
            const legacy = initialState('Plan', 'main', NOW);
            delete legacy.outbox;
            ledger.set(7, legacy);
            await run();
            expect(state().outbox).toHaveLength(1);
        });

        test('remember with no matching entry is skipped', async () => {
            setup(single([{ type: 'remember', slot: 'top', entry: { by: 'boosted' } }]));
            await run();
            expect(state().lastError!.message).toContain('no entry matches');
        });
    });
});

describe('rule execution', () => {
    test('a phase change takes effect when the rule finishes', async () => {
        currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
        setup(
            plan({
                main: { rules: [rule('go', [{ type: 'goto', phase: 'next' }, { type: 'fillExposure' }])] },
                next: {},
            }),
        );
        await run();
        expect(state()).toEqual(
            expect.objectContaining({ phase: 'next', phaseEnteredAt: expect.any(Number), inFlight: null }),
        );
        expect(log.info).toHaveBeenCalledWith(expect.stringContaining('phase main → next'), null);
    });

    test('a goto to the current phase changes nothing', async () => {
        setup(single([{ type: 'goto', phase: 'main' }], { repeat: 'once' }));
        await run();
        expect(state().phaseEnteredAt).toBe(NOW);
        expect(state().fired.r1).toBeDefined();
    });

    test('after a first action lands, a failure keeps the rule and resumes at the failed action', async () => {
        currencyActions.fillExposure.mockResolvedValueOnce(invalid({ ok: true }));
        currencyActions.unlockBoostWithKey.mockResolvedValueOnce({ ok: false, outcome: 'api-failed' });
        setup(single([{ type: 'fillExposure' }, { type: 'unlockBoost' }]));
        await run();
        expect(state().inFlight).toEqual({ ruleId: 'r1', actionIndex: 1 });
        expect(state().spent.fills).toBe(1);

        currencyActions.unlockBoostWithKey.mockResolvedValueOnce(invalid({ ok: true }));
        await run();
        expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
        expect(state()).toEqual(expect.objectContaining({ inFlight: null, lastError: null }));
    });

    test('a step whose spend got no answer is a failure to resume at (the live re-read guards the repeat), not a skip', async () => {
        currencyActions.fillExposure.mockResolvedValueOnce(invalid({ ok: true }));
        currencyActions.unlockBoostWithKey.mockResolvedValueOnce({ ok: false, outcome: 'unclear' });
        setup(single([{ type: 'fillExposure' }, { type: 'unlockBoost' }]));
        await run();
        expect(state().inFlight).toEqual({
            ruleId: 'r1',
            actionIndex: 1,
            unclear: ['unlockBoost'],
            unclearAt: expect.any(Number),
        });
        expect(state().lastError!.message).toContain('the boost unlock may have gone through');
        expect(state().lastError!.message).not.toContain('refused');
    });

    test('a spend that got no answer counts toward the limit, and is never spent again', async () => {
        currencyActions.unlockBoostWithKey.mockResolvedValueOnce({ ok: false, outcome: 'unclear' });
        setup(single([{ type: 'unlockBoost' }]));
        settings.getScenario.mockReturnValue({ ...single([{ type: 'unlockBoost' }]), limits: { keys: 1 } });
        await run();
        expect(state().spent.keys).toBe(1);
        // The boost is still locked, so the live challenge does not show the key went through: it is not repeated.
        await run();
        expect(currencyActions.unlockBoostWithKey).toHaveBeenCalledTimes(1);
        expect(state().spent.keys).toBe(1);
        expect(state().inFlight).toBeNull();
        expect(state().lastError!.message).toContain('may have gone through earlier, so it is not repeated');
    });

    test('a spend that got no answer marks the step on the rule in flight, where an ordinary refusal does not', async () => {
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'unclear' });
        setup(single([{ type: 'fillExposure' }]));
        await run();
        expect(state().inFlight).toEqual({
            ruleId: 'r1',
            actionIndex: 0,
            unclear: ['fillExposure'],
            unclearAt: expect.any(Number),
        });
        expect(state().lastError).toEqual({
            at: expect.any(Number),
            message:
                'r1 → fillExposure: the exposure fill may have gone through (GuruShots gave no answer); it will be checked again next cycle, not spent again',
        });
        // An ordinary refusal carries no such marker.
        await ledger.remove(7);
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'balance-unknown' });
        await run();
        expect(state().inFlight).toBeNull();
    });

    describe('the retry of a spend that got no answer never spends again', () => {
        const unclear = { ok: false, outcome: 'unclear' } as const;

        test('the live challenge shows the boost unlocked: the step is passed over and the rule goes on to the boost', async () => {
            currencyActions.unlockBoostWithKey.mockResolvedValueOnce(unclear);
            setup(single([{ type: 'unlockBoost' }, { type: 'boost', entry: { by: 'fewestVotes' } }]));
            const c = challenge();
            c.member.boost!.state = 'LOCKED';
            await run(c);
            expect(state().inFlight).toEqual({
                ruleId: 'r1',
                actionIndex: 0,
                unclear: ['unlockBoost'],
                unclearAt: expect.any(Number),
            });
            expect(pass.api.applyBoostToEntry).not.toHaveBeenCalled();

            c.member.boost!.state = 'AVAILABLE_KEY';
            await run(c);
            expect(currencyActions.unlockBoostWithKey).toHaveBeenCalledTimes(1);
            expect(pass.api.applyBoostToEntry).toHaveBeenCalledTimes(1);
            expect(state().inFlight).toBeNull();
            expect(state().fired.r1).toBeDefined();
            expect(state().spent.keys).toBe(1);
        });

        test('a swap that did not land is not repeated, and the fill after it is not spent either', async () => {
            currencyActions.previewSwap.mockResolvedValue(
                invalid({ ok: true, candidate: { id: 'n1', member_id: 'm' } }),
            );
            currencyActions.swapEntry.mockResolvedValueOnce(unclear);
            setup(
                single(
                    [{ type: 'swap', entry: { by: 'mostVotes' }, with: { memory: 'held' } }, { type: 'fillExposure' }],
                    {},
                    {
                        limits: { swaps: 1 },
                    },
                ),
            );
            ledger.set(7, { ...initialState('Plan', 'main', NOW), memory: { held: 'n1' } });
            const c = challenge();
            await run(c);
            expect(state().spent.swaps).toBe(1);
            await run(c);
            // n1 is not among the entries: it did not land, and nothing is spent on either step.
            expect(currencyActions.swapEntry).toHaveBeenCalledTimes(1);
            expect(currencyActions.fillExposure).not.toHaveBeenCalled();
            expect(state().inFlight).toBeNull();
            expect(state().spent.swaps).toBe(1);
        });

        test.each([
            ['and what it brought in is remembered', { rememberAdded: 'added' }, { held: 'n1', added: 'n1' }],
            ['and nothing is remembered that was not asked', {}, { held: 'n1' }],
        ])('a swap that landed is passed over, %s', async (_name, extra, memory) => {
            currencyActions.swapEntry.mockResolvedValueOnce(unclear);
            setup(
                single([
                    { type: 'swap', entry: { by: 'mostVotes' }, with: { memory: 'held' }, ...extra },
                    { type: 'fillExposure' },
                ]),
            );
            ledger.set(7, { ...initialState('Plan', 'main', NOW), memory: { held: 'n1' } });
            const c = challenge();
            await run(c);
            c.member.ranking.entries[0] = { id: 'n1', member_id: 'm' };
            currencyActions.fillExposure.mockResolvedValueOnce(invalid({ ok: true }));
            await run(c);
            expect(currencyActions.swapEntry).toHaveBeenCalledTimes(1);
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
            expect(state().memory).toEqual(memory);
        });

        test('a swap whose replacement a selector chooses cannot be shown to have landed: it stops, and is not repeated', async () => {
            currencyActions.previewSwap.mockResolvedValue(
                invalid({ ok: true, candidate: { id: 'n1', member_id: 'm' } }),
            );
            currencyActions.swapEntry.mockResolvedValueOnce(unclear);
            setup(single([{ type: 'swap', entry: { by: 'mostVotes' }, with: 'best' }, { type: 'fillExposure' }]));
            const c = challenge();
            await run(c);
            // Even with the candidate among the entries by now, the selector's choice is not known again.
            c.member.ranking.entries[0] = { id: 'n1', member_id: 'm' };
            await run(c);
            expect(currencyActions.swapEntry).toHaveBeenCalledTimes(1);
            expect(currencyActions.previewSwap).toHaveBeenCalledTimes(1);
            expect(currencyActions.fillExposure).not.toHaveBeenCalled();
            expect(state().inFlight).toBeNull();
        });

        // A rule that went on after an unclear spend must not run again from its first step: its landed steps and
        // the spend itself would be repeated, with no limit to stop them.
        describe.each([
            ['a once rule', { repeat: 'once' }],
            ['a rule with no repeat limit (every pass)', {}],
        ])('%s, stopped after an unclear spend, is not fired again on the third pass', (_name, extra) => {
            test('nothing it did or may have done is done again', async () => {
                currencyActions.previewSwap.mockResolvedValue(
                    invalid({ ok: true, candidate: { id: 'n1', member_id: 'm' } }),
                );
                currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
                currencyActions.swapEntry.mockResolvedValueOnce(unclear);
                setup(
                    single(
                        [{ type: 'fillExposure' }, { type: 'swap', entry: { by: 'mostVotes' }, with: 'best' }],
                        extra,
                    ),
                );
                const c = challenge();
                await run(c); // the fill goes through, the swap gets no answer
                expect(state().inFlight).toEqual({
                    ruleId: 'r1',
                    actionIndex: 1,
                    unclear: ['swap'],
                    unclearAt: expect.any(Number),
                });
                await run(c); // the retry cannot show the swap landed (a selector chose it): the rule stops
                expect(state().inFlight).toBeNull();
                expect(state().fired.r1).toEqual(expect.objectContaining({ unclearHalt: 'swap' }));
                await run(c); // and stays stopped
                await run(c);
                expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
                expect(currencyActions.swapEntry).toHaveBeenCalledTimes(1);
                expect(currencyActions.previewSwap).toHaveBeenCalledTimes(1);
            });
        });

        test('a rule with no repeat limit runs again once its phase is entered again, not before', async () => {
            currencyActions.fillExposure.mockResolvedValueOnce(unclear).mockResolvedValue(invalid({ ok: true }));
            setup(single([{ type: 'fillExposure' }]));
            const c = challenge();
            await run(c);
            // The exposure is not full: the retry cannot show it landed, so the rule stops.
            await run(c);
            expect(state().fired.r1.unclearHalt).toBe('fillExposure');
            await run(c);
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
            ledger.set(7, { ...state(), phaseEnteredAt: state().phaseEnteredAt + 100 });
            await run(c);
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(2);
        });

        test('an edit that halts the scenario and is then reverted does not turn the step into an ordinary spend', async () => {
            currencyActions.unlockBoostWithKey.mockResolvedValue(invalid({ ok: true }));
            currencyActions.unlockBoostWithKey.mockResolvedValueOnce(unclear);
            const original = single([{ type: 'unlockBoost' }, { type: 'boost', entry: { by: 'fewestVotes' } }]);
            setup(original);
            const c = challenge();
            c.member.boost!.state = 'LOCKED';
            await run(c);
            expect(state().inFlight).toEqual({
                ruleId: 'r1',
                actionIndex: 0,
                unclear: ['unlockBoost'],
                unclearAt: expect.any(Number),
            });
            // The rule is edited away: the scenario halts, and what it says of the halt replaces lastError.
            setup(plan({ main: { rules: [rule('renamed', [{ type: 'fillExposure' }])] } }));
            await run(c);
            expect(state().lastError!.message).toContain('no longer matches');
            expect(state().inFlight).toEqual({
                ruleId: 'r1',
                actionIndex: 0,
                unclear: ['unlockBoost'],
                unclearAt: expect.any(Number),
            });
            // Reverted: the retry still only looks, and the key is not spent again.
            setup(original);
            c.member.boost!.state = 'AVAILABLE_KEY';
            await run(c);
            expect(currencyActions.unlockBoostWithKey).toHaveBeenCalledTimes(1);
            expect(pass.api.applyBoostToEntry).toHaveBeenCalledTimes(1);
            expect(state().inFlight).toBeNull();
        });

        test('a step of another type in its place that fails keeps the marker: reverted, the key is not spent again', async () => {
            currencyActions.unlockBoostWithKey.mockResolvedValue(invalid({ ok: true }));
            currencyActions.unlockBoostWithKey.mockResolvedValueOnce(unclear);
            currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'balance-unknown' });
            const original = single([{ type: 'unlockBoost' }, { type: 'boost', entry: { by: 'fewestVotes' } }]);
            setup(original);
            const c = challenge();
            c.member.boost!.state = 'LOCKED';
            await run(c);
            const markedAt = state().inFlight!.unclearAt!;
            expect(markedAt).toEqual(expect.any(Number));
            // The first step is edited into a fill, which fails: it is not the spend that got no answer, so the
            // marker is not its to drop.
            setup(single([{ type: 'fillExposure' }, { type: 'boost', entry: { by: 'fewestVotes' } }]));
            await run(c);
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
            // ...nor the time it was marked at.
            expect(state().inFlight).toEqual({
                ruleId: 'r1',
                actionIndex: 0,
                unclear: ['unlockBoost'],
                unclearAt: markedAt,
            });
            // Reverted: the retry still only looks, and the key is not spent a second time.
            setup(original);
            c.member.boost!.state = 'AVAILABLE_KEY';
            await run(c);
            expect(currencyActions.unlockBoostWithKey).toHaveBeenCalledTimes(1);
            expect(pass.api.applyBoostToEntry).toHaveBeenCalledTimes(1);
            expect(state().inFlight).toBeNull();
        });

        test('a failure of another step of the rule does not carry a marker that was not on it', async () => {
            currencyActions.fillExposure.mockResolvedValueOnce(invalid({ ok: true }));
            currencyActions.unlockBoostWithKey.mockResolvedValueOnce({ ok: false, outcome: 'api-failed' });
            setup(single([{ type: 'fillExposure' }, { type: 'unlockBoost' }]));
            await run();
            expect(state().inFlight).toEqual({ ruleId: 'r1', actionIndex: 1 });
        });

        test('a fill shows landed once the exposure is full, and a challenge that is gone stops the rule', async () => {
            currencyActions.fillExposure.mockResolvedValueOnce(unclear);
            setup(single([{ type: 'fillExposure' }, { type: 'unlockBoost' }]));
            const c = challenge();
            await run(c);
            c.member.ranking.exposure = { exposure_factor: 100 };
            currencyActions.unlockBoostWithKey.mockResolvedValueOnce(invalid({ ok: true }));
            await run(c);
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
            expect(currencyActions.unlockBoostWithKey).toHaveBeenCalledTimes(1);

            await ledger.remove(7);
            currencyActions.fillExposure.mockResolvedValueOnce(unclear);
            const d = challenge();
            await run(d);
            autoFill.refreshChallengeState.mockResolvedValueOnce('gone');
            await run(d);
            expect(currencyActions.fillExposure).toHaveBeenCalledTimes(2);
            expect(state().inFlight).toBeNull();
        });
    });

    test('a committed rule passes over a permanently skipped step and still reaches its goto', async () => {
        currencyActions.swapEntry.mockResolvedValue({ ok: true, outcome: 'ok' });
        setup(
            plan({
                holding: {
                    rules: [
                        rule('comeback', [
                            { type: 'swap', entry: { by: 'fewestVotes' }, with: { memory: 'held' } },
                            { type: 'boost', entry: { by: 'memory', slot: 'held' } },
                            { type: 'goto', phase: 'pulse' },
                        ]),
                    ],
                },
                pulse: {},
            }),
        );
        ledger.set(7, { ...initialState('Plan', 'holding', NOW), memory: { held: 'orig' } });
        const c = challenge();
        c.member.boost!.state = 'USED';
        await run(c);
        expect(state()).toEqual(
            expect.objectContaining({
                phase: 'pulse',
                inFlight: null,
                lastError: expect.objectContaining({
                    message: expect.stringContaining('the boost is not available (USED)'),
                }),
            }),
        );
        expect(state().fired.comeback).toBeDefined();
        expect(state().spent.swaps).toBe(1);
    });

    test('a permanent spend refusal is passed over; a transient one resumes at that step', async () => {
        currencyActions.unlockBoostWithKey.mockResolvedValue(invalid({ ok: true }));
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'no-balance' });
        setup(single([{ type: 'unlockBoost' }, { type: 'fillExposure' }, { type: 'goto', phase: 'main' }]));
        await run();
        expect(state()).toEqual(expect.objectContaining({ inFlight: null }));
        expect(state().lastError!.message).toContain('fillExposure was refused (no-balance)');

        await ledger.remove(7);
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'balance-unknown' });
        await run();
        expect(state().inFlight).toEqual({ ruleId: 'r1', actionIndex: 1 });
    });

    test('a skip before anything landed does not use up a once rule', async () => {
        setup(single([{ type: 'boost', entry: { by: 'bestRank' } }], { repeat: 'once' }));
        const c = challenge();
        c.member.boost!.state = 'LOCKED';
        await run(c);
        expect(state().fired).toEqual({});
        await run();
        expect(pass.api.applyBoostToEntry).toHaveBeenCalledTimes(1);
        expect(state().fired.r1).toBeDefined();
    });

    test('an always rule fires once per pass even when its conditions still hold', async () => {
        currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
        setup(single([{ type: 'fillExposure' }]));
        await run();
        expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
        await run();
        expect(currencyActions.fillExposure).toHaveBeenCalledTimes(2);
    });

    test('rules chain across phases in one pass, and a goto loop stops', async () => {
        setup(
            plan({
                main: { rules: [rule('toB', [{ type: 'goto', phase: 'b' }])] },
                b: { rules: [rule('toMain', [{ type: 'goto', phase: 'main' }])] },
            }),
        );
        await run();
        expect(state().phase).toBe('main');
        expect(log.warning).toHaveBeenCalledWith(expect.stringContaining('came back to phase main'), null);
    });

    test('a halted challenge records its error once', async () => {
        setup(plan({ main: {} }));
        ledger.set(7, initialState('Plan', 'removed', NOW));
        await run();
        const first = state().lastError;
        expect(first!.message).toContain('no longer exists');
        expect(state().outbox).toEqual([expect.objectContaining({ message: expect.stringContaining('Halted:') })]);
        await run();
        expect(state().lastError).toEqual(first);
    });

    test('a scenario that compares balances reads the bankroll', async () => {
        const balance = { type: 'balance', currency: 'swaps', op: '>', value: 100 };
        setup(
            single([{ type: 'fillExposure' }], {
                if: [{ type: 'any', of: [{ type: 'not', condition: { type: 'all', of: [balance] } }] }],
            }),
        );
        currencyActions.fillExposure.mockResolvedValue(invalid({ ok: true }));
        await run();
        expect(pass.currency.strategy.getBankroll).toHaveBeenCalled();
        expect(currencyActions.fillExposure).toHaveBeenCalled();
    });

    test('a scenario without balance conditions never reads the bankroll for evaluation', async () => {
        setup(single([{ type: 'goto', phase: 'main' }], { if: [{ type: 'entries', op: '>', value: 0 }] }));
        await run();
        expect(pass.currency.strategy.getBankroll).not.toHaveBeenCalled();
    });
});

describe('backgroundServiceOwnsScenarios', () => {
    test('only the Android app WebView with the native service defers', () => {
        expect(backgroundServiceOwnsScenarios()).toBe(false);
        runtime.isCapacitor.mockReturnValue(true);
        nativeAutovote.isAvailable.mockReturnValue(true);
        expect(backgroundServiceOwnsScenarios()).toBe(true);
        runtime.isHeadlessService.mockReturnValue(true);
        expect(backgroundServiceOwnsScenarios()).toBe(false);
    });
});
