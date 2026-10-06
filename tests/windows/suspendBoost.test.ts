/**
 * windows/suspendBoost: on device sleep, applies the boosts auto-vote would
 * apply within 30 min, through the API strategy, and never throws.
 */

import type * as suspendBoostModule from '../../src/ts/windows/suspendBoost';
import type * as quitGuardModule from '../../src/ts/windows/quitGuard';
import type * as settingsModule from '../../src/ts/settings';
import type * as apiFactoryModule from '../../src/ts/apiFactory';
import type * as VotingLogicModule from '../../src/ts/services/VotingLogic';
import type { CategoryLogger } from '../../src/ts/logger';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { SuspendBoostOutcome } from '../../src/ts/services/votingOrchestrator/boost';
import { invalid } from '../helpers/invalid';

type Describe = NonNullable<
    NonNullable<Parameters<typeof suspendBoostModule.applyImminentBoostsOnSuspend>[0]>['describeDeadlineActions']
>;

jest.mock('../../src/ts/logger', () => {
    const cat = { info: jest.fn(), warning: jest.fn(), error: jest.fn() };
    return {
        withCategory: jest.fn(() => cat),
        challengeTag: (c: { id: number; title: string }) => `[Challenge ${c.id}: ${c.title}]`,
        cat,
    };
});
jest.mock('../../src/ts/settings', () => ({
    loadSettings: jest.fn(),
    getSetting: jest.fn(),
    getEffectiveSetting: jest.fn(),
}));
jest.mock('../../src/ts/apiFactory', () => ({ getApiStrategy: jest.fn() }));
jest.mock('../../src/ts/services/VotingLogic', () => ({ describeDeadlineActions: jest.fn() }));

const TOKEN = 'secret-token-123';
const NOW = 1_000_000;
const boostChallenge = (id: number, title: string) =>
    invalid<Challenge>({ id, title, member: { boost: { state: 'AVAILABLE', timeout: NOW + 3600 } } });

let suspend: typeof suspendBoostModule;
let guard: typeof quitGuardModule;
let settings: jest.Mocked<typeof settingsModule>;
let applyBoostsOnSuspend: jest.MockedFunction<
    (c: readonly Challenge[], token: string) => Promise<PromiseSettledResult<SuspendBoostOutcome>[]>
>;
let cat: {
    info: jest.MockedFunction<CategoryLogger['info']>;
    warning: jest.MockedFunction<CategoryLogger['warning']>;
    error: jest.MockedFunction<CategoryLogger['error']>;
};

const settle = (
    ...outcomes: Array<SuspendBoostOutcome | Error | string>
): PromiseSettledResult<SuspendBoostOutcome>[] =>
    outcomes.map((o) =>
        typeof o === 'string' && ['applied', 'unconfirmed', 'skipped'].includes(o)
            ? { status: 'fulfilled', value: o as SuspendBoostOutcome }
            : { status: 'rejected', reason: o },
    );

// Boost due-at per challenge id.
const dueIn: Record<number, number> = { 1: 600, 2: 1800, 3: 1860, 4: 60 };
const describe_: Describe = (c) => ({ actions: [{ action: 'boost', dueAt: NOW + dueIn[c.id as number] }] });

const run = (over: NonNullable<Parameters<typeof suspendBoostModule.applyImminentBoostsOnSuspend>[0]> = {}) =>
    suspend.applyImminentBoostsOnSuspend({
        now: NOW,
        describeDeadlineActions: describe_,
        ...over,
    });

const loggedText = () => JSON.stringify([cat.info.mock.calls, cat.warning.mock.calls, cat.error.mock.calls]);

beforeEach(() => {
    jest.resetModules();
    suspend = require('../../src/ts/windows/suspendBoost') as typeof suspend;
    guard = require('../../src/ts/windows/quitGuard') as typeof guard;
    settings = jest.mocked(require('../../src/ts/settings') as typeof settingsModule);
    cat = (require('../../src/ts/logger') as { cat: typeof cat }).cat;
    const apiFactory = jest.mocked(require('../../src/ts/apiFactory') as typeof apiFactoryModule);
    applyBoostsOnSuspend = jest.fn(async (challenges: readonly Challenge[], _token: string) =>
        settle(...challenges.map(() => 'applied' as const)),
    );
    apiFactory.getApiStrategy.mockReturnValue(invalid({ applyBoostsOnSuspend }));
    settings.getSetting.mockImplementation((key) => key === 'autovoteRunning');
    settings.getEffectiveSetting.mockReturnValue(true);
    settings.loadSettings.mockReturnValue(invalid({ token: TOKEN, mock: false }));
    guard.rememberChallenges([boostChallenge(1, 'One'), boostChallenge(2, 'Two'), boostChallenge(3, 'Three')], false);
});

describe('applyImminentBoostsOnSuspend — no-ops', () => {
    test('does nothing while auto-vote is stopped, however often it sleeps', async () => {
        settings.getSetting.mockReturnValue(false);
        await run();
        await run();
        expect(applyBoostsOnSuspend).not.toHaveBeenCalled();
        expect(settings.loadSettings).not.toHaveBeenCalled();
    });

    test('does nothing when no boost is due within 30 min', async () => {
        await run({ describeDeadlineActions: () => ({ actions: [{ action: 'boost', dueAt: NOW + 3600 }] }) });
        expect(applyBoostsOnSuspend).not.toHaveBeenCalled();
    });

    test('a boost due at exactly 30 min is applied, one due at 31 min is not', async () => {
        await run();
        expect(applyBoostsOnSuspend.mock.calls[0][0].map((c) => c.id)).toEqual([1, 2]);
    });

    test('does nothing without a token', async () => {
        settings.loadSettings.mockReturnValue(invalid({ token: '', mock: false }));
        await run();
        expect(applyBoostsOnSuspend).not.toHaveBeenCalled();
        expect(cat.info).not.toHaveBeenCalled();
    });

    test('a list fetched under the other mock setting is not acted on, and says why (never the token)', async () => {
        settings.loadSettings.mockReturnValue(invalid({ token: TOKEN, mock: true }));
        await run();
        expect(applyBoostsOnSuspend).not.toHaveBeenCalled();
        expect(cat.info).toHaveBeenCalledWith(
            'Boost on sleep skipped — the remembered challenge list is from the other mode (mock/real)',
            null,
        );
        expect(loggedText()).not.toContain(TOKEN);
    });

    test('with no remembered list nothing is sent and nothing is logged', async () => {
        guard.resetQuitGuard();
        await run();
        expect(applyBoostsOnSuspend).not.toHaveBeenCalled();
        expect(cat.info).not.toHaveBeenCalled();
    });

    test('a mock-mode list is acted on in mock mode', async () => {
        guard.rememberChallenges([boostChallenge(1, 'One')], true);
        settings.loadSettings.mockReturnValue(invalid({ token: TOKEN, mock: true }));
        await run();
        expect(applyBoostsOnSuspend).toHaveBeenCalledTimes(1);
    });

    test('the emergency-only case (no boost row because autoBoost is off) is not selected', async () => {
        await run({ describeDeadlineActions: () => ({ actions: [{ action: 'autoFill', dueAt: NOW + 60 }] }) });
        expect(applyBoostsOnSuspend).not.toHaveBeenCalled();
    });

    test('the default describeDeadlineActions is VotingLogic.describeDeadlineActions and the default clock is real', async () => {
        const votingLogic = jest.mocked(require('../../src/ts/services/VotingLogic') as typeof VotingLogicModule);
        votingLogic.describeDeadlineActions.mockReturnValue(
            invalid({ actions: [{ action: 'boost', dueAt: Math.floor(Date.now() / 1000) + 60 }] }),
        );
        guard.resetQuitGuard();
        const soon = invalid<Challenge>({
            id: 1,
            title: 'One',
            member: { boost: { state: 'AVAILABLE_KEY' } },
        });
        guard.rememberChallenges([soon], false);
        await suspend.applyImminentBoostsOnSuspend();
        expect(applyBoostsOnSuspend).toHaveBeenCalledWith([soon], TOKEN);
    });
});

describe('applyImminentBoostsOnSuspend — Boost Before Sleep setting', () => {
    test('off for every challenge sends nothing and logs each one', async () => {
        settings.getEffectiveSetting.mockReturnValue(false);
        await run();
        expect(applyBoostsOnSuspend).not.toHaveBeenCalled();
        expect(cat.info.mock.calls.map(([message]) => message)).toEqual([
            'Boost Before Sleep is off for [Challenge 1: One] — boost left for its set time',
            'Boost Before Sleep is off for [Challenge 2: Two] — boost left for its set time',
        ]);
    });

    test('off for one challenge withholds only that one and credits results to the rest', async () => {
        settings.getEffectiveSetting.mockImplementation((key, id) => key !== 'boostOnSleep' || id !== '1');
        await run();
        expect(applyBoostsOnSuspend.mock.calls[0][0].map((c) => c.id)).toEqual([2]);
        const messages = cat.info.mock.calls.map(([message]) => message);
        expect(messages).toContain('Boost Before Sleep is off for [Challenge 1: One] — boost left for its set time');
        expect(messages).not.toContain(
            'Boost Before Sleep is off for [Challenge 2: Two] — boost left for its set time',
        );
        expect(messages.filter((m) => m.startsWith('Device is going to sleep'))).toEqual([
            'Device is going to sleep — trying to boost [Challenge 2: Two] now, 30m before it was due',
        ]);
        // Challenge 2 landed and was marked applied; challenge 1 was never sent, so it is still open.
        expect(guard.imminentBoostChallenges(NOW, describe_, 1800).map((b) => b.challenge.id)).toEqual([1]);
    });

    test('the setting is read with the challenge id', async () => {
        await run();
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('boostOnSleep', '1');
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('boostOnSleep', '2');
    });

    test('the quit guard still lists a boost due within 60 min with the setting off — the filter lives only here', async () => {
        settings.getEffectiveSetting.mockReturnValue(false);
        await run();
        expect(applyBoostsOnSuspend).not.toHaveBeenCalled();
        const listed = guard.imminentBoostChallenges(NOW, describe_, 3600).map((b) => b.challenge.id);
        expect(listed).toEqual([1, 2, 3]);
    });
});

describe('applyImminentBoostsOnSuspend — re-entrancy', () => {
    test('a suspend while a batch is pending sends nothing; once it settles the next one runs', async () => {
        let release: (r: PromiseSettledResult<SuspendBoostOutcome>[]) => void = () => {};
        applyBoostsOnSuspend.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
        const first = run();
        await run();
        expect(applyBoostsOnSuspend).toHaveBeenCalledTimes(1);

        release(settle('skipped', 'skipped'));
        await first;
        await run();
        expect(applyBoostsOnSuspend).toHaveBeenCalledTimes(2);
    });

    test('the flag is released after the strategy rejects', async () => {
        applyBoostsOnSuspend.mockRejectedValueOnce(new Error('offline'));
        await expect(run()).resolves.toBeUndefined();
        await run();
        expect(applyBoostsOnSuspend).toHaveBeenCalledTimes(2);
    });
});

describe('applyImminentBoostsOnSuspend — outcomes', () => {
    test('hands the selected challenges and the stored token to the strategy and logs how early each goes', async () => {
        await run();
        expect(applyBoostsOnSuspend).toHaveBeenCalledWith(expect.any(Array), TOKEN);
        expect(cat.info).toHaveBeenCalledWith(
            'Device is going to sleep — trying to boost [Challenge 1: One] now, 10m before it was due',
            null,
        );
        expect(cat.info).toHaveBeenCalledWith(
            'Device is going to sleep — trying to boost [Challenge 2: Two] now, 30m before it was due',
            null,
        );
    });

    test('a boost already due says so instead of a clamped "0m"', async () => {
        await run({
            describeDeadlineActions: (c) => ({ actions: [{ action: 'boost', dueAt: NOW - (c.id === 1 ? 5 : 0) }] }),
        });
        expect(cat.info).toHaveBeenCalledWith(
            'Device is going to sleep — trying to boost [Challenge 1: One] now (already due)',
            null,
        );
        expect(cat.info).toHaveBeenCalledWith(
            'Device is going to sleep — trying to boost [Challenge 2: Two] now (already due)',
            null,
        );
    });

    test('marks a landed boost applied, so neither the quit guard nor a later suspend counts it', async () => {
        applyBoostsOnSuspend.mockResolvedValueOnce(settle('applied', 'skipped'));
        await run();
        // Challenge 1 was marked used; challenge 2 (skipped) is still open.
        expect(guard.imminentBoostChallenges(NOW, describe_, 1800).map((b) => b.challenge.id)).toEqual([2]);
        await run();
        expect(applyBoostsOnSuspend.mock.calls[1][0].map((c) => c.id)).toEqual([2]);
    });

    test('a skipped outcome logs that no boost was sent, as info', async () => {
        applyBoostsOnSuspend.mockResolvedValueOnce(settle('skipped', 'applied'));
        await run();
        expect(cat.info).toHaveBeenCalledWith('[Challenge 1: One] boost not sent before sleep — skipped', null);
        expect(cat.info).not.toHaveBeenCalledWith('[Challenge 2: Two] boost not sent before sleep — skipped', null);
    });

    test('a null result reads "not confirmed", never "failed"', async () => {
        applyBoostsOnSuspend.mockResolvedValueOnce(settle('unconfirmed', 'skipped'));
        await run();
        expect(cat.warning).toHaveBeenCalledWith(
            '[Challenge 1: One] boost not confirmed before sleep — the next pass after wake shows whether it landed',
            null,
        );
        expect(loggedText().toLowerCase()).not.toContain('failed');
        expect(guard.imminentBoostChallenges(NOW, describe_, 1800).map((b) => b.challenge.id)).toEqual([1, 2]);
    });

    test('one rejection does not stop the others and is logged by its failure text', async () => {
        applyBoostsOnSuspend.mockResolvedValueOnce(settle(new Error('rate limited'), 'applied'));
        await run();
        expect(cat.error).toHaveBeenCalledWith('[Challenge 1: One] boost before sleep errored: rate limited', null);
        expect(guard.imminentBoostChallenges(NOW, describe_, 1800).map((b) => b.challenge.id)).toEqual([1]);
    });

    test('a non-Error rejection is logged as text', async () => {
        applyBoostsOnSuspend.mockResolvedValueOnce([
            { status: 'rejected', reason: undefined },
            { status: 'fulfilled', value: 'skipped' },
        ]);
        await run();
        expect(cat.error).toHaveBeenCalledWith('[Challenge 1: One] boost before sleep errored: unknown error', null);
    });

    test('the token string appears in none of the new module logger calls', async () => {
        applyBoostsOnSuspend.mockResolvedValueOnce(settle('unconfirmed', new Error('boom')));
        await run();
        applyBoostsOnSuspend.mockRejectedValueOnce(new Error('offline'));
        await run();
        expect(
            cat.info.mock.calls.length + cat.warning.mock.calls.length + cat.error.mock.calls.length,
        ).toBeGreaterThan(3);
        expect(loggedText()).not.toContain(TOKEN);
    });
});

describe('applyImminentBoostsOnSuspend — never throws', () => {
    test('a throwing describeDeadlineActions is caught and logged', async () => {
        await expect(
            run({
                describeDeadlineActions: () => {
                    throw new Error('bad challenge');
                },
            }),
        ).resolves.toBeUndefined();
        expect(cat.error).toHaveBeenCalledWith('Boost on sleep could not run: bad challenge', null);
    });

    test('a throwing auto-vote state read is caught inside the module, logged, and releases the flag', async () => {
        settings.getSetting.mockImplementationOnce(() => {
            throw new Error('settings unreadable');
        });
        await expect(run()).resolves.toBeUndefined();
        expect(cat.error).toHaveBeenCalledWith('Boost on sleep could not run: settings unreadable', null);
        expect(applyBoostsOnSuspend).not.toHaveBeenCalled();
        await run();
        expect(applyBoostsOnSuspend).toHaveBeenCalledTimes(1);
    });

    test('a throwing loadSettings is caught, logged, and releases the flag', async () => {
        settings.loadSettings.mockImplementationOnce(() => {
            throw new Error('corrupt settings');
        });
        await expect(run()).resolves.toBeUndefined();
        expect(cat.error).toHaveBeenCalledWith('Boost on sleep could not run: corrupt settings', null);
        await run();
        expect(applyBoostsOnSuspend).toHaveBeenCalledTimes(1);
    });
});
