/**
 * runSuspendBoosts / runSuspendBoost: the boost decision a device going to sleep
 * applies — runBoost's own target rule and skips, minus anything that cannot
 * finish before the sleep (a new photo submit).
 */

jest.mock('../../src/ts/settings', () => ({
    getEffectiveSetting: jest.fn(() => false),
}));

jest.mock('../../src/ts/services/VotingLogic', () => ({
    isWithinEmergencyWindow: jest.fn(() => false),
    resolveBoostFillNewMode: jest.fn(() => 'no'),
    pickBoostEntry: jest.fn(() => null),
    getBoostHoldUntil: jest.fn(() => null),
}));

jest.mock('../../src/ts/services/autoFill', () => ({
    submitNewEntryForAction: jest.fn(async () => ({ ok: false, reason: 'none' })),
    reflectNewEntry: jest.fn(),
    reflectEntryFlag: jest.fn(),
}));

import logger = require('../../src/ts/logger');
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import votingLogicModule = require('../../src/ts/services/VotingLogic');
const votingLogic = jest.mocked(votingLogicModule);
import autoFillModule = require('../../src/ts/services/autoFill');
const autoFill = jest.mocked(autoFillModule);
import type * as boostModule from '../../src/ts/services/votingOrchestrator/boost';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type * as entryAgeStoreModule from '../../src/ts/entryAgeStore';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { VotingPassApi } from '../../src/ts/types/votingPass';
import { invalid } from '../helpers/invalid';
const { runSuspendBoosts } = require('../../src/ts/services/votingOrchestrator/boost') as typeof boostModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;
const { createMemoryEntryAgeLedger } = require('../../src/ts/entryAgeStore') as typeof entryAgeStoreModule;

const NOW = Math.floor(Date.now() / 1000);

const log = {
    info: jest.fn<void, unknown[]>(),
    error: jest.fn<void, unknown[]>(),
    debug: jest.fn<void, unknown[]>(),
    startOperation: jest.fn<void, unknown[]>(),
    endOperation: jest.fn<void, unknown[]>(),
};
const messages = (level: keyof typeof log) =>
    log[level].mock.calls.map((c) => c.filter((a: unknown) => typeof a === 'string').join(' | '));

const timed = (id = 101) =>
    buildChallenge({
        id,
        title: 'Orchestrated',
        close_time: NOW + 3600,
        member: {
            boost: { state: 'AVAILABLE', timeout: NOW + 600 },
            ranking: { entries: [{ id: 'e1' }], exposure: { exposure_factor: 100 } },
        },
    });
const keyed = () =>
    buildChallenge({
        id: 102,
        title: 'Keyed',
        close_time: NOW + 3600,
        member: { boost: { state: 'AVAILABLE_KEY' }, ranking: { entries: [{ id: 'e1' }] } },
    });
const used = () =>
    buildChallenge({ id: 103, title: 'Used', close_time: NOW + 3600, member: { boost: { state: 'USED' } } });

const makeApi = () => ({
    applyBoost: jest.fn(async () => ({ success: true })),
    applyBoostToEntry: jest.fn(async () => ({ success: true })),
    getActiveChallenges: jest.fn(),
});
type Api = ReturnType<typeof makeApi>;

const run = (
    challenges: Challenge[],
    api: Api,
    entryAges: ReturnType<typeof createMemoryEntryAgeLedger> | null = null,
) => runSuspendBoosts(challenges, 'tok', { api: invalid<VotingPassApi>(api), entryAges });

beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(logger.withCategory).mockImplementation(() => invalid(log));
    settings.getEffectiveSetting.mockImplementation((key) => key === 'autoBoost');
    votingLogic.isWithinEmergencyWindow.mockReturnValue(false);
    votingLogic.resolveBoostFillNewMode.mockReturnValue('no');
    votingLogic.pickBoostEntry.mockReturnValue(invalid({ id: 'e1' }));
    votingLogic.getBoostHoldUntil.mockReturnValue(null);
    autoFill.submitNewEntryForAction.mockResolvedValue(invalid({ ok: false, reason: 'none' }));
});

describe('runSuspendBoosts — target rule', () => {
    test('boosts the Boost Entry through applyBoost and reports applied', async () => {
        const api = makeApi();
        const challenge = timed();
        expect(await run([challenge], api)).toEqual([{ status: 'fulfilled', value: 'applied' }]);
        expect(api.applyBoost).toHaveBeenCalledWith(challenge, 'tok');
        expect(messages('startOperation')).toEqual([
            'boost-101 | Applying boost to challenge [Challenge 101: Orchestrated]',
        ]);
        expect(messages('endOperation').join()).toContain('Boost applied successfully');
    });

    test('a key-unlocked boost is boosted too', async () => {
        const api = makeApi();
        expect(await run([keyed()], api)).toEqual([{ status: 'fulfilled', value: 'applied' }]);
        expect(messages('startOperation')[0]).toContain('(key-unlocked)');
    });

    test('a challenge without an open boost is skipped untouched', async () => {
        const api = makeApi();
        expect(await run([used()], api)).toEqual([{ status: 'fulfilled', value: 'skipped' }]);
        expect(messages('info')).toContain(
            '[Challenge 103: Used] boost no longer available — nothing to send before sleep',
        );
        expect(api.applyBoost).not.toHaveBeenCalled();
    });

    test('a pending fill-new photo is boosted via boostFreshEntry and its marker cleared', async () => {
        const api = makeApi();
        const ledger = createMemoryEntryAgeLedger();
        const challenge = timed();
        ledger.markPending(challenge, 'p1', NOW - 3600);
        const clear = jest.spyOn(ledger, 'clearPending');
        expect(await run([challenge], api, ledger)).toEqual([{ status: 'fulfilled', value: 'applied' }]);
        expect(api.applyBoostToEntry).toHaveBeenCalledWith('101', 'p1', 'tok');
        expect(api.applyBoost).not.toHaveBeenCalled();
        expect(autoFill.reflectEntryFlag).toHaveBeenCalledWith(challenge, 'p1', 'boosted');
        expect(clear).toHaveBeenCalledWith(101, expect.any(Number));
    });

    test('fill-new with no pending photo boosts the existing entry, says why, and never submits', async () => {
        votingLogic.resolveBoostFillNewMode.mockReturnValue('always');
        const api = makeApi();
        expect(await run([timed()], api)).toEqual([{ status: 'fulfilled', value: 'applied' }]);
        expect(autoFill.submitNewEntryForAction).not.toHaveBeenCalled();
        expect(api.applyBoost).toHaveBeenCalledTimes(1);
        expect(messages('info')).toContain(
            '[Challenge 101: Orchestrated] boost fill-new is on, but a new photo cannot be submitted before sleep; boosting existing entry',
        );
    });

    test('no usable entry (the only entry has Turbo): skipped with a reason, applyBoost never called', async () => {
        votingLogic.resolveBoostFillNewMode.mockReturnValue('conflict');
        votingLogic.pickBoostEntry.mockReturnValue(null);
        const api = makeApi();
        expect(await run([timed()], api)).toEqual([{ status: 'fulfilled', value: 'skipped' }]);
        expect(api.applyBoost).not.toHaveBeenCalled();
        expect(api.applyBoostToEntry).not.toHaveBeenCalled();
        expect(messages('info').join()).toContain(
            '[Challenge 101: Orchestrated] no entry can take the boost (only entry already has Turbo) — boost skipped',
        );
    });
});

describe('runSuspendBoosts — skips shared with runBoost', () => {
    test('a photo too new to boost holds the boost: skipped', async () => {
        votingLogic.getBoostHoldUntil.mockReturnValue(NOW + 300);
        const api = makeApi();
        const ledger = createMemoryEntryAgeLedger();
        const challenge = timed();
        expect(await run([challenge], api, ledger)).toEqual([{ status: 'fulfilled', value: 'skipped' }]);
        expect(api.applyBoost).not.toHaveBeenCalled();
        expect(messages('info').join()).toContain('Boost held');
    });

    describe('an uncertain auto-submitted photo', () => {
        const uncertain = () => {
            const ledger = createMemoryEntryAgeLedger();
            ledger.markUncertain(keyed(), 'e1', NOW);
            return ledger;
        };

        test('is skipped for a key-unlocked boost outside the emergency window', async () => {
            settings.getEffectiveSetting.mockImplementation(
                (key) => key === 'autoBoost' || key === 'protectUncertainAutoFills',
            );
            const api = makeApi();
            expect(await run([keyed()], api, uncertain())).toEqual([{ status: 'fulfilled', value: 'skipped' }]);
            expect(api.applyBoost).not.toHaveBeenCalled();
            expect(messages('info').join()).toContain('auto-Boost skipped for uncertain auto-submitted photo e1');
        });

        test('is boosted inside the emergency window', async () => {
            settings.getEffectiveSetting.mockImplementation(
                (key) => key === 'autoBoost' || key === 'protectUncertainAutoFills',
            );
            votingLogic.isWithinEmergencyWindow.mockReturnValue(true);
            const api = makeApi();
            expect(await run([keyed()], api, uncertain())).toEqual([{ status: 'fulfilled', value: 'applied' }]);
        });
    });
});

describe('runSuspendBoosts — outcomes', () => {
    test('a falsy applyBoost result is unconfirmed, not applied', async () => {
        const api = makeApi();
        api.applyBoost.mockResolvedValue(invalid(null));
        expect(await run([timed()], api)).toEqual([{ status: 'fulfilled', value: 'unconfirmed' }]);
    });

    test('a throwing applyBoost is unconfirmed and closes the operation with its reason', async () => {
        const api = makeApi();
        api.applyBoost.mockRejectedValue(new Error('network down'));
        expect(await run([timed()], api)).toEqual([{ status: 'fulfilled', value: 'unconfirmed' }]);
        expect(log.endOperation).toHaveBeenCalledWith('boost-101', null, 'network down');
    });

    test('every challenge runs at once and one rejection does not stop the others', async () => {
        votingLogic.pickBoostEntry.mockImplementation((challenge) => {
            if (challenge.id === 101) throw new Error('bad payload');
            return invalid({ id: 'e1' });
        });
        const api = makeApi();
        const results = await run([timed(), keyed()], api);
        expect(results[0]).toMatchObject({
            status: 'rejected',
            reason: expect.objectContaining({ message: 'bad payload' }),
        });
        expect(results[1]).toEqual({ status: 'fulfilled', value: 'applied' });
    });

    test('runs over the given entry-age ledger, and without one', async () => {
        const api = makeApi();
        const ledger = createMemoryEntryAgeLedger();
        const pending = jest.spyOn(ledger, 'pending');
        await run([timed()], api, ledger);
        expect(pending).toHaveBeenCalledWith('101');
        expect(await run([timed()], api)).toEqual([{ status: 'fulfilled', value: 'applied' }]);
    });
});
