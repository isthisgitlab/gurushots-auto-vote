/**
 * The scenario runner inside the voting pass: starting a challenge's plan,
 * executing rule actions over the existing primitives, commit/resume
 * semantics, the per-pass and goto-loop guards, and failure recording.
 */

jest.mock('../../src/js/logger', () => {
    const category = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warning: jest.fn(), success: jest.fn() };
    return { withCategory: jest.fn(() => category), challengeTag: jest.fn((c) => `[${c?.id}]`), __category: category };
});
jest.mock('../../src/js/settings', () => ({
    getEffectiveSetting: jest.fn(),
    getScenario: jest.fn(),
    getSetting: jest.fn(() => 'UTC'),
}));
jest.mock('../../src/js/services/currencyActions', () => ({
    withSpendLock: jest.fn(async (spend) => ({ busy: false, value: await spend() })),
    previewSwap: jest.fn(),
    swapEntry: jest.fn(),
    unlockBoostWithKey: jest.fn(),
    fillExposure: jest.fn(),
}));
jest.mock('../../src/js/services/autoFill', () => {
    const actual = jest.requireActual('../../src/js/services/autoFill/challengeState');
    return {
        submitNewEntryForAction: jest.fn(),
        refreshChallengeState: jest.fn(async () => 'refreshed'),
        reflectNewEntry: actual.reflectNewEntry,
        reflectEntryFlag: actual.reflectEntryFlag,
        getSlotsRemaining: actual.getSlotsRemaining,
    };
});
jest.mock('../../src/js/runtime', () => ({
    isCapacitor: jest.fn(() => false),
    isHeadlessService: jest.fn(() => false),
}));
jest.mock('../../src/js/services/NativeAutovoteBridge', () => ({ isAvailable: jest.fn(() => false) }));

const logger = require('../../src/js/logger');
const settings = require('../../src/js/settings');
const currencyActions = require('../../src/js/services/currencyActions');
const autoFill = require('../../src/js/services/autoFill');
const runtime = require('../../src/js/runtime');
const nativeAutovote = require('../../src/js/services/NativeAutovoteBridge');
const { runScenarioStep, backgroundServiceOwnsScenarios } = require('../../src/js/services/scenarioRunner');
const { createMemoryStateLedger, initialState } = require('../../src/js/scenarioStateStore');

const log = logger.__category;
const NOW = Math.floor(Date.now() / 1000);

const challenge = () => ({
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

const plan = (phases, extra = {}) => ({ name: 'Plan', version: 1, start: 'main', phases, ...extra });
const rule = (id, actions, extra = {}) => ({ id, do: actions, ...extra });
const single = (actions, extra = {}, scenarioExtra = {}) =>
    plan({ main: { rules: [rule('r1', actions, extra)] } }, scenarioExtra);

let ledger;
let pass;
let assigned;

const setup = (scenario) => {
    settings.getScenario.mockReturnValue(scenario);
};

const run = async (c = challenge()) => {
    await runScenarioStep(c, NOW, pass);
    return c;
};

const state = () => ledger.get(7).state;

beforeEach(() => {
    jest.clearAllMocks();
    ledger = createMemoryStateLedger();
    assigned = 'Plan';
    settings.getEffectiveSetting.mockImplementation((key) => (key === 'scenario' ? assigned : 0));
    pass = {
        token: 'tok',
        api: {
            getActiveChallenges: jest.fn(),
            submitToChallenge: jest.fn(async () => ({ ok: true })),
            applyBoostToEntry: jest.fn(async () => ({ success: true })),
            applyTurbo: jest.fn(async () => ({ ok: true })),
            getVoteImages: jest.fn(async () => ({ images: [] })),
            submitVotes: jest.fn(async () => ({ success: true })),
        },
        fillDeps: {},
        currency: { strategy: { getBankroll: jest.fn(async () => ({ keys: 5, swaps: 5, fills: 5, coins: 0 })) } },
        scenarios: { ledger },
    };
});

describe('when nothing runs', () => {
    test('no scenario deps, a host that defers, no assignment, or an unknown scenario', async () => {
        setup(single([{ type: 'fillExposure' }]));
        await runScenarioStep(challenge(), NOW, { ...pass, scenarios: null });
        await runScenarioStep(challenge(), NOW, { ...pass, scenarios: { ledger, enabled: () => false } });
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
        jest.spyOn(broken, 'get').mockReturnValue({ corrupt: true, state: null });
        await runScenarioStep(challenge(), NOW, { ...pass, scenarios: { ledger: broken } });
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('unreadable'), null);
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

describe('starting a plan', () => {
    test('a challenge without state starts in the start phase', async () => {
        setup(plan({ main: {} }));
        await run();
        expect(state()).toEqual(expect.objectContaining({ scenario: 'Plan', phase: 'main', phaseEnteredAt: NOW }));
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
            autoFill.submitNewEntryForAction.mockResolvedValue({ ok: true, imageId: 99, reason: 'submitted' });
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
            ['fetch-error', 'no photo was entered (fetch-error)'],
        ])('best: %s', async (reason, message) => {
            autoFill.submitNewEntryForAction.mockResolvedValue({ ok: false, imageId: null, reason });
            setup(single([{ type: 'enterPhoto', photo: 'best' }]));
            await run();
            expect(state().lastError.message).toContain(message);
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
            if (mode === 'refused') pass.api.submitToChallenge.mockResolvedValueOnce({ ok: false });
            const c = challenge();
            if (mode === 'full') c.max_photo_submits = 2;
            await run(c);
            expect(state().lastError.message).toContain(message);
        });
    });

    describe('swap', () => {
        const swapRule = (extra = {}) => single([{ type: 'swap', entry: { by: 'mostVotes' }, with: 'best', ...extra }]);

        beforeEach(() => {
            currencyActions.previewSwap.mockResolvedValue({ ok: true, candidate: { id: 'n1', member_id: 'm' } });
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
            ['a refused swap without an outcome', {}, {}, 'swap was refused (no response)', 'bare'],
        ])('%s', async (label, extra, memory, message, mode) => {
            setup(swapRule(extra));
            ledger.set(7, { ...initialState('Plan', 'main', NOW), memory });
            if (mode === 'gone') autoFill.refreshChallengeState.mockResolvedValueOnce('gone');
            if (mode === 'preview')
                currencyActions.previewSwap.mockResolvedValueOnce({ ok: false, outcome: 'no-alternative' });
            if (mode === 'swap') currencyActions.swapEntry.mockResolvedValueOnce({ ok: false, outcome: 'api-failed' });
            if (mode === 'bare') currencyActions.swapEntry.mockResolvedValueOnce({ ok: false });
            await run();
            expect(state().lastError.message).toContain(message);
        });

        test('the scenario limit and the user reserve stop a swap', async () => {
            setup(swapRule());
            settings.getScenario.mockReturnValue({ ...swapRule(), limits: { swaps: 1 } });
            ledger.set(7, { ...initialState('Plan', 'main', NOW), spent: { swaps: 1, keys: 0, fills: 0 } });
            await run();
            expect(state().lastError.message).toContain("scenario's swaps limit of 1 is reached");

            settings.getScenario.mockReturnValue(swapRule());
            settings.getEffectiveSetting.mockImplementation((key) => (key === 'scenario' ? 'Plan' : 5));
            await run();
            expect(state().lastError.message).toContain('swaps reserve would be crossed');
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
            expect(c.member.boost.state).toBe('USED');
        });

        test('turbo applies a won turbo', async () => {
            setup(single([{ type: 'turbo', entry: { by: 'worstRank' } }]));
            const c = await run();
            expect(pass.api.applyTurbo).toHaveBeenCalledWith(7, 'b', 'tok');
            expect(c.member.ranking.entries[1].turbo).toBe(true);
            expect(c.member.turbo.state).toBe('USED');
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
            const actions = [{ type, entry }];
            if (mode === 'no-target') actions.push({ type: 'remember', slot: 'x', entry: { by: 'bestRank' } });
            setup(single(actions));
            const c = challenge();
            if (mode === 'unavailable') {
                c.member.boost.state = 'LOCKED';
                c.member.turbo.state = 'FREE';
            }
            if (mode === 'unknown') {
                delete c.member.boost;
                delete c.member.turbo;
            }
            if (mode === 'refused') {
                pass.api.applyBoostToEntry.mockResolvedValueOnce(null);
                pass.api.applyTurbo.mockResolvedValueOnce({ ok: false });
            }
            if (mode === 'gone') autoFill.refreshChallengeState.mockResolvedValueOnce('gone');
            await run(c);
            expect(state().lastError.message).toContain(message);
        });
    });

    describe('key and fill spends', () => {
        test('unlockBoost spends a key and makes the boost available', async () => {
            currencyActions.unlockBoostWithKey.mockResolvedValue({ ok: true });
            setup(single([{ type: 'unlockBoost' }]));
            const c = await run();
            expect(c.member.boost).toEqual({ state: 'AVAILABLE_KEY', timeout: null });
            expect(state().spent.keys).toBe(1);
        });

        test('fillExposure spends a fill and raises exposure', async () => {
            currencyActions.fillExposure.mockResolvedValue({ ok: true });
            setup(single([{ type: 'fillExposure' }]));
            const c = await run();
            expect(c.member.ranking.exposure.exposure_factor).toBe(100);
            expect(state().spent.fills).toBe(1);
        });

        test.each([
            ['unlockBoost', 'unlockBoostWithKey', 'keys'],
            ['fillExposure', 'fillExposure', 'fills'],
        ])('%s: refused, and stopped by its limit', async (type, method, limitKey) => {
            currencyActions[method].mockResolvedValue({ ok: false, outcome: 'no-balance' });
            setup(single([{ type }]));
            await run();
            expect(state().lastError.message).toContain(`${type} was refused (no-balance)`);

            settings.getScenario.mockReturnValue(single([{ type }], {}, { limits: { [limitKey]: 0 } }));
            await run();
            expect(state().lastError.message).toContain(`${limitKey} limit of 0`);
        });
    });

    describe('vote, remember, forget', () => {
        test('vote votes to the target exposure', async () => {
            setup(single([{ type: 'vote', toExposure: 80 }]));
            await run();
            expect(pass.api.submitVotes).toHaveBeenCalledWith({ images: [] }, 'tok', 80);
            expect(state().fired.r1).toBeDefined();
        });

        test.each([
            ['no vote images', 'getVoteImages', null, 'vote images could not be loaded'],
            ['a refused submit', 'submitVotes', undefined, 'votes could not be submitted'],
        ])('vote: %s', async (label, method, value, message) => {
            pass.api[method].mockResolvedValueOnce(value);
            setup(single([{ type: 'vote', toExposure: 80 }]));
            await run();
            expect(state().lastError.message).toContain(message);
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

        test('remember with no matching entry is skipped', async () => {
            setup(single([{ type: 'remember', slot: 'top', entry: { by: 'boosted' } }]));
            await run();
            expect(state().lastError.message).toContain('no entry matches');
        });
    });
});

describe('rule execution', () => {
    test('a phase change takes effect when the rule finishes', async () => {
        currencyActions.fillExposure.mockResolvedValue({ ok: true });
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
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: true });
        currencyActions.unlockBoostWithKey.mockResolvedValueOnce({ ok: false, outcome: 'api-failed' });
        setup(single([{ type: 'fillExposure' }, { type: 'unlockBoost' }]));
        await run();
        expect(state().inFlight).toEqual({ ruleId: 'r1', actionIndex: 1 });
        expect(state().spent.fills).toBe(1);

        currencyActions.unlockBoostWithKey.mockResolvedValueOnce({ ok: true });
        await run();
        expect(currencyActions.fillExposure).toHaveBeenCalledTimes(1);
        expect(state()).toEqual(expect.objectContaining({ inFlight: null, lastError: null }));
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
        c.member.boost.state = 'USED';
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
        currencyActions.unlockBoostWithKey.mockResolvedValue({ ok: true });
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'no-balance' });
        setup(single([{ type: 'unlockBoost' }, { type: 'fillExposure' }, { type: 'goto', phase: 'main' }]));
        await run();
        expect(state()).toEqual(expect.objectContaining({ inFlight: null }));
        expect(state().lastError.message).toContain('fillExposure was refused (no-balance)');

        ledger.remove(7);
        currencyActions.fillExposure.mockResolvedValueOnce({ ok: false, outcome: 'balance-unknown' });
        await run();
        expect(state().inFlight).toEqual({ ruleId: 'r1', actionIndex: 1 });
    });

    test('a skip before anything landed does not use up a once rule', async () => {
        setup(single([{ type: 'boost', entry: { by: 'bestRank' } }], { repeat: 'once' }));
        const c = challenge();
        c.member.boost.state = 'LOCKED';
        await run(c);
        expect(state().fired).toEqual({});
        await run();
        expect(pass.api.applyBoostToEntry).toHaveBeenCalledTimes(1);
        expect(state().fired.r1).toBeDefined();
    });

    test('an always rule fires once per pass even when its conditions still hold', async () => {
        currencyActions.fillExposure.mockResolvedValue({ ok: true });
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
        expect(first.message).toContain('no longer exists');
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
        currencyActions.fillExposure.mockResolvedValue({ ok: true });
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
