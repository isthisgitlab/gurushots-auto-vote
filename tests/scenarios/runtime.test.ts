/**
 * The shared confirmed-outcome reducer (scenarios/runtime.ts): pure, so every effect is checked on plain states, and the
 * markers a spend that got no answer leaves are checked to be exactly what the runner contract says.
 */

import {
    OPERATION_OF,
    absorbLeftover,
    applyEffects,
    createOperationRecord,
    finishScenarioRule,
    reduceScenarioOutcome,
    withNotice,
} from '../../src/ts/core/scenarios/runtime';
import type { ReducerStep } from '../../src/ts/core/scenarios/runtime';
import { initialState } from '../../src/ts/core/scenarioStateStore';
import type { ScenarioState, SpendAction } from '../../src/ts/core/types/stores';

const AT = 1_800_000_000;

const base = (over: Partial<ScenarioState> = {}): ScenarioState => ({
    ...initialState('Plan', 'main', AT - 100),
    ...over,
});

const step = (over: Partial<ReducerStep> = {}): ReducerStep => ({
    ruleId: 'r1',
    index: 0,
    actionType: 'fillExposure',
    at: AT,
    timezone: 'UTC',
    committed: false,
    noticeToken: 'tok',
    message: 'r1 → fillExposure: why',
    ...over,
});

const limitOf = (spend: SpendAction) => (spend === 'swap' ? 'swaps' : spend === 'unlockBoost' ? 'keys' : 'fills');

describe('a confirmed action', () => {
    test('moves the rule to its next step and is recorded as the last action', () => {
        const next = reduceScenarioOutcome(base(), step({ index: 2, actionType: 'boost' }), { status: 'done' });
        expect(next.inFlight).toEqual({ ruleId: 'r1', actionIndex: 3 });
        expect(next.lastAction).toEqual({ at: AT, ruleId: 'r1', action: 'boost', outcome: 'done' });
    });

    test('remembers and forgets photos', () => {
        const before = base({ memory: { old: 'x', keep: 'y' } });
        const next = reduceScenarioOutcome(before, step(), { status: 'done', remember: { new: 'z' }, forget: 'old' });
        expect(next.memory).toEqual({ keep: 'y', new: 'z' });
        // the state it was given is not changed
        expect(before.memory).toEqual({ old: 'x', keep: 'y' });
    });

    test('counts a spend once, and the coins a join spent by their amount', () => {
        const spent = reduceScenarioOutcome(base({ spent: { fills: 2 } }), step(), { status: 'done', spent: 'fills' });
        expect(spent.spent).toEqual({ fills: 3 });
        const coins = reduceScenarioOutcome(base({ spent: { coins: 40 } }), step(), { status: 'done', coins: 25 });
        expect(coins.spent.coins).toBe(65);
        const first = reduceScenarioOutcome(base(), step(), { status: 'done', coins: 25 });
        expect(first.spent.coins).toBe(25);
        // a free join adds nothing
        expect(reduceScenarioOutcome(base(), step(), { status: 'done', coins: 0 }).spent.coins).toBeUndefined();
    });

    test('a state with no outbox yet and no counter for the kind gets both', () => {
        const bare = { ...base(), outbox: undefined, spent: {} };
        const next = reduceScenarioOutcome(bare, step(), { status: 'done', notice: 'hi', spent: 'swaps' });
        expect(next.outbox).toEqual([{ id: `${AT}-0-tok`, at: AT, message: 'hi' }]);
        expect(next.spent).toEqual({ swaps: 1 });
    });

    test('leaves a notice in the outbox, under the token it was given', () => {
        const next = reduceScenarioOutcome(base(), step(), { status: 'done', notice: 'hello' });
        expect(next.outbox).toEqual([{ id: `${AT}-0-tok`, at: AT, message: 'hello' }]);
    });
});

describe('a step that did not go through', () => {
    test('a skipped step of a committed rule is passed over: the rule carries on past it', () => {
        const next = reduceScenarioOutcome(base(), step({ index: 1, committed: true }), {
            status: 'skipped',
            message: 'nothing to do',
        });
        expect(next.inFlight).toEqual({ ruleId: 'r1', actionIndex: 2 });
        expect(next.lastError).toEqual({ at: AT, message: 'r1 → fillExposure: why' });
    });

    test('a skipped step of a rule that has not gone through yet stops it, with no marker', () => {
        const next = reduceScenarioOutcome(base({ inFlight: null }), step(), { status: 'skipped', message: 'x' });
        expect(next.inFlight).toBeNull();
        expect(next.lastError).toEqual({ at: AT, message: 'r1 → fillExposure: why' });
    });

    test('a deferred step is no problem to show, but a committed rule resumes at it', () => {
        const next = reduceScenarioOutcome(
            base({ lastError: { at: 1, message: 'old' } }),
            step({ index: 1, committed: true }),
            {
                status: 'deferred',
                message: 'busy',
            },
        );
        expect(next.lastError).toEqual({ at: 1, message: 'old' });
        expect(next.inFlight).toEqual({ ruleId: 'r1', actionIndex: 1 });
    });

    test('a failed spend is counted and the rule resumes at its step', () => {
        const next = reduceScenarioOutcome(base(), step({ index: 3 }), {
            status: 'failed',
            message: 'f',
            spent: 'fills',
        });
        expect(next.spent).toEqual({ swaps: 0, keys: 0, fills: 1 });
        expect(next.inFlight).toEqual({ ruleId: 'r1', actionIndex: 3 });
    });

    test('a join that is paid for, or possibly paid for, resumes at its step and counts its coins', () => {
        const paid = reduceScenarioOutcome(base(), step({ index: 1 }), {
            status: 'failed',
            message: 'f',
            coins: 30,
            resume: true,
        });
        expect(paid.spent.coins).toBe(30);
        expect(paid.inFlight).toEqual({ ruleId: 'r1', actionIndex: 1 });
        // paid in an earlier pass: no coins to count, the step is still the one to resume at
        const earlier = reduceScenarioOutcome(base(), step({ index: 1 }), {
            status: 'failed',
            message: 'f',
            coins: 0,
            resume: true,
        });
        expect(earlier.spent.coins).toBeUndefined();
        expect(earlier.inFlight).toEqual({ ruleId: 'r1', actionIndex: 1 });
    });

    test('a spend that got no answer is marked unclear, with when; the same outcome again keeps the first time', () => {
        const first = reduceScenarioOutcome(base(), step({ index: 1 }), {
            status: 'failed',
            message: 'f',
            unclear: 'fillExposure',
            spent: 'fills',
        });
        expect(first.inFlight).toEqual({ ruleId: 'r1', actionIndex: 1, unclear: ['fillExposure'], unclearAt: AT });
        const again = reduceScenarioOutcome(first, step({ index: 1, at: AT + 60, committed: true }), {
            status: 'failed',
            message: 'f',
            unclear: 'fillExposure',
        });
        expect(again.inFlight).toEqual({ ruleId: 'r1', actionIndex: 1, unclear: ['fillExposure'], unclearAt: AT });
        // another type is added to the marker
        const other = reduceScenarioOutcome(again, step({ index: 1, at: AT + 90, committed: true }), {
            status: 'failed',
            message: 'f',
            unclear: 'swap',
        });
        expect(other.inFlight).toEqual({
            ruleId: 'r1',
            actionIndex: 1,
            unclear: ['fillExposure', 'swap'],
            unclearAt: AT + 90,
        });
    });

    test('a retry that came from a pending marker keeps its type in `lost`, once', () => {
        const next = reduceScenarioOutcome(base(), step({ index: 1, committed: true }), {
            status: 'failed',
            message: 'f',
            unclear: 'swap',
            origin: 'pending',
        });
        expect(next.inFlight).toEqual({
            ruleId: 'r1',
            actionIndex: 1,
            unclear: ['swap'],
            unclearAt: AT,
            lost: ['swap'],
        });
        const again = reduceScenarioOutcome(next, step({ index: 1, committed: true }), {
            status: 'failed',
            message: 'f',
            unclear: 'swap',
            origin: 'pending',
        });
        expect(again.inFlight?.lost).toEqual(['swap']);
    });

    test('a marker that holds nothing unclear leaves the step with no unclear markers', () => {
        const next = reduceScenarioOutcome(base(), step({ committed: true }), { status: 'failed', message: 'f' });
        expect(next.inFlight).toEqual({ ruleId: 'r1', actionIndex: 0 });
        expect(next.lastError).toEqual({ at: AT, message: 'r1 → fillExposure: why' });
    });

    test('a halted rule is recorded as fired with the action it stopped after, and carries no marker', () => {
        const next = reduceScenarioOutcome(base({ inFlight: { ruleId: 'r1', actionIndex: 1 } }), step({ index: 1 }), {
            status: 'failed',
            message: 'f',
            unclear: 'fillExposure',
            halt: true,
            origin: 'pending',
        });
        expect(next.inFlight).toBeNull();
        expect(next.fired.r1).toEqual(
            expect.objectContaining({ at: AT, unclearHalt: 'fillExposure', haltOrigin: 'pending' }),
        );
    });
});

describe('a finished rule', () => {
    test('is recorded as fired, with the phase clock it began under', () => {
        const start = base({ phase: 'main', phaseEnteredAt: AT - 500 });
        const next = finishScenarioRule(
            { ...start, inFlight: { ruleId: 'r1', actionIndex: 2 } },
            { ruleId: 'r1', startState: start, gotoPhase: null, skippedStep: null, at: AT, timezone: 'UTC' },
        );
        expect(next.inFlight).toBeNull();
        expect(next.fired.r1).toEqual(expect.objectContaining({ at: AT, phaseEnteredAt: AT - 500 }));
        expect(next.phase).toBe('main');
        expect(next.lastError).toBeNull();
    });

    test('takes the phase change that was waiting for it, entered now', () => {
        const start = base();
        const next = finishScenarioRule(start, {
            ruleId: 'r1',
            startState: start,
            gotoPhase: 'next',
            skippedStep: { at: AT, message: 'skipped one' },
            at: AT,
            timezone: 'UTC',
        });
        expect(next.phase).toBe('next');
        expect(next.phaseEnteredAt).toBe(AT);
        expect(next.lastError).toEqual({ at: AT, message: 'skipped one' });
    });

    test('a goto to the phase it is in changes nothing', () => {
        const start = base({ phase: 'main', phaseEnteredAt: AT - 5 });
        const next = finishScenarioRule(start, {
            ruleId: 'r1',
            startState: start,
            gotoPhase: 'main',
            skippedStep: null,
            at: AT,
            timezone: 'UTC',
        });
        expect(next.phaseEnteredAt).toBe(AT - 5);
    });
});

describe('a pending marker the step now running is not for', () => {
    const pending = (over = {}) => base({ inFlight: { ruleId: 'r1', actionIndex: 1, pending: 'swap', ...over } });

    test('becomes an unclear, counted one', () => {
        const next = absorbLeftover({ ...pending(), spent: {} }, 'fillExposure', AT, limitOf);
        expect(next.spent).toEqual({ swaps: 1 });
        expect(next.inFlight).toEqual({
            ruleId: 'r1',
            actionIndex: 1,
            lost: ['swap'],
            unclear: ['swap'],
            unclearAt: AT,
        });
    });

    test('keeps the time an earlier one was marked at, and adds to the lists', () => {
        const next = absorbLeftover(
            pending({ unclear: ['unlockBoost'], lost: ['unlockBoost'], unclearAt: 5 }),
            undefined,
            AT,
            limitOf,
        );
        expect(next.inFlight).toEqual({
            ruleId: 'r1',
            actionIndex: 1,
            lost: ['unlockBoost', 'swap'],
            unclear: ['unlockBoost', 'swap'],
            unclearAt: 5,
        });
    });

    test('is left alone when the step is its own spend, or there is none', () => {
        const own = pending();
        expect(absorbLeftover(own, 'swap', AT, limitOf)).toBe(own);
        const none = base();
        expect(absorbLeftover(none, 'swap', AT, limitOf)).toBe(none);
    });
});

describe('notices', () => {
    test('only the newest twenty within a day are kept', () => {
        let state = base({ outbox: [{ id: 'old', at: AT - 2 * 86400, message: 'stale' }] });
        for (let index = 0; index < 22; index++) state = withNotice(state, `n${index}`, AT, `t${index}`);
        expect(state.outbox).toHaveLength(20);
        expect(state.outbox?.[0].message).toBe('n2');
        expect(state.outbox?.some((item) => item.id === 'old')).toBe(false);
    });

    test('applyEffects without a notice leaves the outbox alone', () => {
        expect(applyEffects(base(), {}, AT, 'tok').outbox).toEqual([]);
    });
});

describe('the per-pass operation record', () => {
    test('remembers what was done for which subject, kind by kind', () => {
        const record = createOperationRecord();
        expect(record.has('join', '7')).toBe(false);
        record.mark('join', '7');
        expect(record.has('join', '7')).toBe(true);
        expect(record.has('join', '8')).toBe(false);
        expect(record.has('claim', '7')).toBe(false);
    });

    test('names the operation each action performs, and none for the rest', () => {
        expect(OPERATION_OF.join).toBe('join');
        expect(OPERATION_OF.claimChallengeReward).toBe('claim');
        expect(OPERATION_OF.claimMissionReward).toBe('claim');
        expect(OPERATION_OF.enterPhoto).toBe('submit');
        expect(OPERATION_OF.fillExposure).toBe('fill');
        expect(OPERATION_OF.unlockBoost).toBeUndefined();
        expect(OPERATION_OF.notify).toBeUndefined();
    });
});
