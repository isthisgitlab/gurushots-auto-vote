/**
 * Branch coverage for the per-action runners inside runVotingPass that the
 * main orchestrator suite reaches only on its primary paths: boost
 * availability shapes, the three boost fill-new fallbacks, turbo apply
 * fallbacks, non-Error throws surfacing verbatim, and metadata-cleanup
 * failure reporting.
 */

jest.mock('../../src/js/settings', () => ({
    getEffectiveSetting: jest.fn(() => false),
}));

jest.mock('../../src/js/services/VotingLogic', () => ({
    shouldPlayAutoTurbo: jest.fn(() => false),
    isTurboEarnSaved: jest.fn(() => false),
    orderDeadlineActions: jest.fn(() => []),
    shouldApplyBoost: jest.fn(() => false),
    resolveBoostFillNewMode: jest.fn(() => 'no'),
    pickBoostEntry: jest.fn(() => null),
    getBoostHoldUntil: jest.fn(() => null),
    shouldApplyTurbo: jest.fn(() => ({ apply: false })),
    getEffectiveBoostTime: jest.fn(() => 600),
    getEffectiveKeyUnlockedBoostTime: jest.fn(() => 900),
    evaluateVotingDecision: jest.fn(() => ({ shouldVote: false, voteReason: 'test skip', targetExposure: 100 })),
}));

jest.mock('../../src/js/services/autoFill', () => ({
    maybeAutoFillChallenge: jest.fn(async () => 'skipped'),
    maybeEmergencyFillChallenge: jest.fn(async () => 'skipped'),
    submitNewEntryForAction: jest.fn(async () => ({ ok: false, reason: 'none' })),
    reflectNewEntry: jest.fn(),
    reflectEntryFlag: jest.fn(),
}));

jest.mock('../../src/js/voting/cancellation', () => ({
    isCancelled: jest.fn(() => false),
    setCancelled: jest.fn(),
    reset: jest.fn(),
}));

import logger = require('../../src/js/logger');
import settingsModule = require('../../src/js/settings');
const settings = jest.mocked(settingsModule);
import votingLogicModule = require('../../src/js/services/VotingLogic');
const votingLogic = jest.mocked(votingLogicModule);
import autoFillModule = require('../../src/js/services/autoFill');
const autoFill = jest.mocked(autoFillModule);
import type * as votingOrchestratorModule from '../../src/js/services/votingOrchestrator';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type * as entryAgeStoreModule from '../../src/js/entryAgeStore';
import type { Challenge } from '../../src/js/types/gurushots';
import type { VotingPassDeps } from '../../src/js/types/votingPass';
import { invalid } from '../helpers/invalid';
const { runVotingPass } = require('../../src/js/services/votingOrchestrator') as typeof votingOrchestratorModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;
const { createMemoryEntryAgeLedger } = require('../../src/js/entryAgeStore') as typeof entryAgeStoreModule;

const NOW = Math.floor(Date.now() / 1000);

// One shared category sink so every log line is assertable.
const log = {
    info: jest.fn<void, unknown[]>(),
    error: jest.fn<void, unknown[]>(),
    debug: jest.fn<void, unknown[]>(),
    success: jest.fn<void, unknown[]>(),
    warning: jest.fn<void, unknown[]>(),
    startOperation: jest.fn<void, unknown[]>(),
    endOperation: jest.fn<void, unknown[]>(),
    progress: jest.fn<void, unknown[]>(),
};
const messages = (level: keyof typeof log) =>
    log[level].mock.calls.map((c) => c.filter((a: unknown) => typeof a === 'string').join(' | '));

const withBoost = (boost: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    buildChallenge({
        id: 101,
        title: 'Orchestrated',
        close_time: NOW + 3600,
        member: { boost, ranking: { entries: [], exposure: { exposure_factor: 100 } } },
        ...extra,
    });

const makeApi = (challenges: Challenge[]) => ({
    getActiveChallenges: jest.fn(async () => ({ challenges })),
    getVoteImages: jest.fn(async () => ({ images: [{ id: 'i1' }] })),
    submitVotes: jest.fn(async () => ({ success: true })),
    applyBoost: jest.fn(async () => ({ success: true })),
    applyBoostToEntry: jest.fn(async () => ({ success: true })),
    applyTurbo: jest.fn(async () => ({ ok: true })),
    runTurboMiniGame: jest.fn(async () => ({ played: 1 })),
});

const run = (api: ReturnType<typeof makeApi>, over: Partial<VotingPassDeps> = {}) =>
    runVotingPass('tok', null, {
        api: invalid(api),
        cleanupStaleMetadata: null,
        interChallengeDelay: () => 0,
        ...over,
    });

beforeEach(() => {
    jest.mocked(logger.withCategory).mockImplementation(() => invalid(log));
    settings.getEffectiveSetting.mockImplementation(() => false);
    votingLogic.orderDeadlineActions.mockReturnValue([]);
    votingLogic.shouldApplyBoost.mockReturnValue(false);
    votingLogic.resolveBoostFillNewMode.mockReturnValue('no');
    votingLogic.pickBoostEntry.mockReturnValue(null);
    votingLogic.getBoostHoldUntil.mockReturnValue(null);
    votingLogic.shouldApplyTurbo.mockReturnValue(invalid({ apply: false }));
    votingLogic.shouldPlayAutoTurbo.mockReturnValue(false);
    votingLogic.evaluateVotingDecision.mockReturnValue(
        invalid({
            shouldVote: false,
            voteReason: 'test skip',
            targetExposure: 100,
        }),
    );
    autoFill.submitNewEntryForAction.mockResolvedValue(invalid({ ok: false, reason: 'none' }));
});

describe('runBoost — availability and readiness', () => {
    beforeEach(() => votingLogic.orderDeadlineActions.mockReturnValue(invalid([{ action: 'boost' }])));

    test('a challenge with no member subtree is a silent no-op, not a crash', async () => {
        const api = makeApi([buildChallenge({ id: 101, member: undefined, close_time: NOW + 60 })]);
        const result = await run(api);
        expect(result.success).toBe(true);
        expect(votingLogic.shouldApplyBoost).not.toHaveBeenCalled();
        expect(messages('error')).toEqual([]);
    });

    test('AVAILABLE without a timeout is treated as key-unlocked in the not-ready message', async () => {
        const api = makeApi([withBoost({ state: 'AVAILABLE', timeout: 0 })]);
        await run(api);
        expect(messages('info')).toEqual(
            expect.arrayContaining([expect.stringMatching(/Boost not ready - .* until challenge ends \(needs ≤ 15m/)]),
        );
    });

    test('a timer-based boost not yet due reports its own threshold', async () => {
        const api = makeApi([withBoost({ state: 'AVAILABLE', timeout: NOW + 7200 })]);
        await run(api);
        expect(messages('info')).toEqual(
            expect.arrayContaining([expect.stringMatching(/Boost not ready - .* until deadline \(threshold: 10m\)/)]),
        );
    });

    test('key-unlocked apply with autoBoost on: no emergency note, key-unlocked success suffix', async () => {
        settings.getEffectiveSetting.mockImplementation((key) => key === 'autoBoost');
        votingLogic.shouldApplyBoost.mockReturnValue(true);
        const api = makeApi([withBoost({ state: 'AVAILABLE_KEY' })]);
        await run(api);
        expect(api.applyBoost).toHaveBeenCalledTimes(1);
        expect(messages('info').some((m) => m.includes('Emergency Fill window'))).toBe(false);
        expect(messages('startOperation')).toEqual(
            expect.arrayContaining([
                expect.stringContaining('Applying boost to challenge Orchestrated (key-unlocked)'),
            ]),
        );
        expect(messages('endOperation')).toEqual(
            expect.arrayContaining([expect.stringMatching(/Boost applied successfully \(.* until challenge ends\)/)]),
        );
    });

    test('a falsy applyBoost result leaves the failure log to applyBoost (no success line)', async () => {
        votingLogic.shouldApplyBoost.mockReturnValue(true);
        const api = makeApi([withBoost({ state: 'AVAILABLE', timeout: NOW + 60 })]);
        api.applyBoost.mockResolvedValue(invalid(null));
        await run(api);
        expect(messages('endOperation').some((m) => m.includes('Boost applied successfully'))).toBe(false);
    });

    test('a non-Error throw is surfaced verbatim on the boost operation', async () => {
        votingLogic.shouldApplyBoost.mockReturnValue(true);
        const api = makeApi([withBoost({ state: 'AVAILABLE', timeout: NOW + 60 })]);
        api.applyBoost.mockRejectedValue('rate limited');
        await run(api);
        expect(log.endOperation).toHaveBeenCalledWith('boost-101', null, 'rate limited');
    });
});

describe('runBoost — fill-new fallbacks', () => {
    beforeEach(() => {
        votingLogic.orderDeadlineActions.mockReturnValue(invalid([{ action: 'boost' }]));
        votingLogic.shouldApplyBoost.mockReturnValue(true);
    });

    test('fresh entry submitted but boosting it fails → closes the outer operation, no fallback', async () => {
        votingLogic.resolveBoostFillNewMode.mockReturnValue('always');
        autoFill.submitNewEntryForAction.mockResolvedValue({ ok: true, imageId: 'new1', reason: 'submitted' });
        const api = makeApi([withBoost({ state: 'AVAILABLE', timeout: NOW + 60 })]);
        api.applyBoostToEntry.mockResolvedValue(invalid(null));
        await run(api);
        expect(autoFill.reflectNewEntry).toHaveBeenCalledWith(expect.anything(), 'new1');
        expect(autoFill.reflectEntryFlag).not.toHaveBeenCalled();
        expect(api.applyBoost).not.toHaveBeenCalled();
        expect(log.endOperation).toHaveBeenCalledWith('boost-101', null, 'boost apply to fresh entry failed');
    });

    test('fresh entry boosted → flag reflected on it', async () => {
        votingLogic.resolveBoostFillNewMode.mockReturnValue('always');
        autoFill.submitNewEntryForAction.mockResolvedValue({ ok: true, imageId: 'new1', reason: 'submitted' });
        const api = makeApi([withBoost({ state: 'AVAILABLE', timeout: NOW + 60 })]);
        await run(api);
        expect(api.applyBoostToEntry).toHaveBeenCalledWith('101', 'new1', 'tok');
        expect(autoFill.reflectEntryFlag).toHaveBeenCalledWith(expect.anything(), 'new1', 'boosted');
    });

    test('conflict mode with no fresh photo skips the boost entirely', async () => {
        votingLogic.resolveBoostFillNewMode.mockReturnValue('conflict');
        autoFill.submitNewEntryForAction.mockResolvedValue(invalid({ ok: false, reason: 'no-eligible' }));
        const api = makeApi([withBoost({ state: 'AVAILABLE', timeout: NOW + 60 })]);
        await run(api);
        expect(api.applyBoost).not.toHaveBeenCalled();
        expect(log.startOperation).not.toHaveBeenCalledWith('boost-101', expect.anything());
        expect(messages('info')).toEqual(
            expect.arrayContaining([
                expect.stringContaining(
                    'boost fill-new unavailable (no-eligible); only entry already has Turbo — boost skipped',
                ),
            ]),
        );
    });

    test('a challenge that left the active list skips the boost', async () => {
        votingLogic.resolveBoostFillNewMode.mockReturnValue('always');
        autoFill.submitNewEntryForAction.mockResolvedValue(invalid({ ok: false, reason: 'challenge-gone' }));
        const api = makeApi([withBoost({ state: 'AVAILABLE', timeout: NOW + 60 })]);
        await run(api);
        expect(api.applyBoost).not.toHaveBeenCalled();
        expect(messages('info')).toEqual(
            expect.arrayContaining([expect.stringContaining('challenge left the active list — boost skipped')]),
        );
    });

    test('always mode with no fresh photo falls back to boosting the configured entry', async () => {
        votingLogic.resolveBoostFillNewMode.mockReturnValue('always');
        autoFill.submitNewEntryForAction.mockResolvedValue(invalid({ ok: false, reason: 'no-slots' }));
        const api = makeApi([withBoost({ state: 'AVAILABLE', timeout: NOW + 60 })]);
        await run(api);
        expect(api.applyBoost).toHaveBeenCalledTimes(1);
        expect(messages('info')).toEqual(
            expect.arrayContaining([
                expect.stringContaining('boost fill-new unavailable (no-slots); boosting existing entry'),
            ]),
        );
    });
});

describe('runBoost — fresh-entry hold', () => {
    const withEntries = (ids: string[]) =>
        withBoost(
            { state: 'AVAILABLE_KEY' },
            { member: { boost: { state: 'AVAILABLE_KEY' }, ranking: { entries: ids.map((id) => ({ id })) } } },
        );

    beforeEach(() => {
        votingLogic.orderDeadlineActions.mockReturnValue(invalid([{ action: 'boost' }]));
        votingLogic.shouldApplyBoost.mockReturnValue(true);
    });

    test('holds a boost whose target entered too recently and marks the release instant for the scheduler', async () => {
        const entryAges = createMemoryEntryAgeLedger();
        entryAges.observe(withEntries(['old']), NOW - 600);
        votingLogic.pickBoostEntry.mockReturnValue({ id: 'fresh' });
        votingLogic.getBoostHoldUntil.mockReturnValue(NOW + 150);
        const api = makeApi([withEntries(['old', 'fresh'])]);
        // The pass reads the clock itself; pinned to NOW so a slow full-suite run
        // crossing a second boundary cannot make "entered at" differ from NOW.
        const clock = jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
        let result: Awaited<ReturnType<typeof run>>;
        try {
            result = await run(api, { entryAges });
        } finally {
            clock.mockRestore();
        }
        expect(votingLogic.getBoostHoldUntil).toHaveBeenCalledWith(expect.anything(), NOW, NOW);
        expect(api.applyBoost).not.toHaveBeenCalled();
        expect(result.challenges![0].boostHoldUntil).toBe(NOW + 150);
        expect(messages('info')).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/Boost held .* photo fresh entered the challenge too recently/),
            ]),
        );
    });

    test('fill-new submits once, holds, then boosts that same photo on a later pass', async () => {
        const entryAges = createMemoryEntryAgeLedger();
        votingLogic.resolveBoostFillNewMode.mockReturnValue('always');
        autoFill.submitNewEntryForAction.mockResolvedValue({ ok: true, imageId: 'new1', reason: 'submitted' });
        votingLogic.getBoostHoldUntil.mockReturnValue(NOW + 150);
        const first = makeApi([withEntries(['e1'])]);
        await run(first, { entryAges });
        expect(first.applyBoostToEntry).not.toHaveBeenCalled();
        expect(entryAges.pending('101')).toBe('new1');

        // The listing lags the submit: the pending photo is missing from one poll.
        autoFill.submitNewEntryForAction.mockClear();
        await run(makeApi([withEntries(['e1'])]), { entryAges });
        expect(autoFill.submitNewEntryForAction).not.toHaveBeenCalled();
        expect(entryAges.pending('101')).toBe('new1');

        votingLogic.getBoostHoldUntil.mockReturnValue(null);
        const second = makeApi([withEntries(['e1', 'new1'])]);
        await run(second, { entryAges });
        expect(autoFill.submitNewEntryForAction).not.toHaveBeenCalled();
        expect(second.applyBoostToEntry).toHaveBeenCalledWith('101', 'new1', 'tok');
        expect(entryAges.pending('101')).toBeNull();
    });

    test('no target entry, or no ledger, never holds', async () => {
        votingLogic.getBoostHoldUntil.mockReturnValue(NOW + 150);
        const api = makeApi([withEntries(['e1'])]);
        await run(api, { entryAges: createMemoryEntryAgeLedger() });
        await run(api);
        expect(votingLogic.getBoostHoldUntil).not.toHaveBeenCalled();
        expect(api.applyBoost).toHaveBeenCalledTimes(2);
    });
});

describe('runTurboApply fallbacks', () => {
    beforeEach(() => votingLogic.orderDeadlineActions.mockReturnValue(invalid([{ action: 'turbo' }])));

    const challengeWithEntries = (entries: Array<{ id: string }>) =>
        withBoost({ state: 'LOCKED', timeout: 0 }, { member: { ranking: { entries } } });

    test('useTurbo on and fill-new off: applies to the picked entry with no emergency note', async () => {
        settings.getEffectiveSetting.mockImplementation((key) => key === 'useTurbo');
        votingLogic.shouldApplyTurbo.mockReturnValue(invalid({ apply: true, fillNew: false, imageId: 'e1' }));
        const api = makeApi([challengeWithEntries([{ id: 'e1' }])]);
        await run(api);
        expect(api.applyTurbo).toHaveBeenCalledWith(101, 'e1', 'tok');
        expect(autoFill.submitNewEntryForAction).not.toHaveBeenCalled();
        expect(messages('info').some((m) => m.includes('Emergency Fill window'))).toBe(false);
        expect(autoFill.reflectEntryFlag).toHaveBeenCalledWith(expect.anything(), 'e1', 'turbo');
    });

    test('fill-new unavailable with a fallback entry applies turbo to that entry', async () => {
        votingLogic.shouldApplyTurbo.mockReturnValue(invalid({ apply: true, fillNew: true, imageId: 'e1' }));
        autoFill.submitNewEntryForAction.mockResolvedValue(invalid({ ok: false, reason: 'no-slots' }));
        const api = makeApi([challengeWithEntries([{ id: 'e1' }])]);
        await run(api);
        expect(api.applyTurbo).toHaveBeenCalledWith(101, 'e1', 'tok');
        expect(messages('info')).toEqual(
            expect.arrayContaining([
                expect.stringContaining('turbo fill-new unavailable (no-slots); applying to existing entry'),
            ]),
        );
    });

    test('fill-new unavailable on an empty challenge says there is no entry at all', async () => {
        votingLogic.shouldApplyTurbo.mockReturnValue(invalid({ apply: true, fillNew: true, imageId: null }));
        const api = makeApi([buildChallenge({ id: 101, close_time: NOW + 60, member: { ranking: undefined } })]);
        await run(api);
        expect(api.applyTurbo).not.toHaveBeenCalled();
        expect(messages('info')).toEqual(
            expect.arrayContaining([expect.stringContaining('there is no existing entry — turbo skipped')]),
        );
    });

    test('an ok=false apply closes the operation as failed and does not flag the entry', async () => {
        votingLogic.shouldApplyTurbo.mockReturnValue(invalid({ apply: true, fillNew: false, imageId: 'e1' }));
        const api = makeApi([challengeWithEntries([{ id: 'e1' }])]);
        api.applyTurbo.mockResolvedValue({ ok: false });
        await run(api);
        expect(log.endOperation).toHaveBeenCalledWith('turbo-apply-101', null, 'Apply request returned ok=false');
        expect(autoFill.reflectEntryFlag).not.toHaveBeenCalled();
    });

    test('a non-Error throw is surfaced verbatim on the turbo operation', async () => {
        votingLogic.shouldApplyTurbo.mockReturnValue(invalid({ apply: true, fillNew: false, imageId: 'e1' }));
        const api = makeApi([challengeWithEntries([{ id: 'e1' }])]);
        api.applyTurbo.mockRejectedValue('server busy');
        await run(api);
        expect(log.endOperation).toHaveBeenCalledWith('turbo-apply-101', null, 'server busy');
    });
});

describe('emergency fill and turbo mini-game', () => {
    test('a submitted emergency fill is logged', async () => {
        votingLogic.orderDeadlineActions.mockReturnValue(invalid([{ action: 'emergencyFill' }]));
        autoFill.maybeEmergencyFillChallenge.mockResolvedValueOnce('submitted');
        await run(makeApi([withBoost({ state: 'LOCKED', timeout: 0 })]));
        expect(messages('info')).toEqual(
            expect.arrayContaining([expect.stringContaining('emergencyFill: entries submitted near deadline')]),
        );
    });

    test('a turbo mini-game Error is reported by message and the pass continues', async () => {
        votingLogic.shouldPlayAutoTurbo.mockReturnValue(true);
        const api = makeApi([withBoost({ state: 'LOCKED', timeout: 0 })]);
        api.runTurboMiniGame.mockRejectedValue(new Error('game crashed'));
        const result = await run(api);
        expect(result.success).toBe(true);
        expect(log.endOperation).toHaveBeenCalledWith('turbo-earn-101', null, 'game crashed');
    });

    test('a turbo mini-game non-Error throw is reported verbatim', async () => {
        votingLogic.shouldPlayAutoTurbo.mockReturnValue(true);
        const api = makeApi([withBoost({ state: 'LOCKED', timeout: 0 })]);
        api.runTurboMiniGame.mockRejectedValue('nope');
        await run(api);
        expect(log.endOperation).toHaveBeenCalledWith('turbo-earn-101', null, 'nope');
    });
});

describe('metadata cleanup outcomes', () => {
    test('a false cleanup result is reported as a warning', async () => {
        const cleanup = jest.fn(() => false);
        const result = await run(makeApi([withBoost({ state: 'LOCKED', timeout: 0 })]), {
            cleanupStaleMetadata: cleanup,
        });
        expect(result.success).toBe(true);
        expect(log.warning).toHaveBeenCalledWith('Failed to cleanup stale metadata', null);
    });

    test('a throwing cleanup is contained and the pass still runs', async () => {
        const boom = new Error('fs');
        const cleanup = jest.fn(() => {
            throw boom;
        });
        const result = await run(makeApi([withBoost({ state: 'LOCKED', timeout: 0 })]), {
            cleanupStaleMetadata: cleanup,
        });
        expect(result.success).toBe(true);
        expect(log.warning).toHaveBeenCalledWith('Error during metadata cleanup:', boom);
        expect(votingLogic.evaluateVotingDecision).toHaveBeenCalledTimes(1);
    });
});

describe('non-Error throws on the vote and pass level', () => {
    test('a vote throw without a message is reported verbatim', async () => {
        votingLogic.evaluateVotingDecision.mockReturnValue(
            invalid({ shouldVote: true, voteReason: 'r', targetExposure: 100 }),
        );
        const api = makeApi([withBoost({ state: 'LOCKED', timeout: 0 })]);
        api.getVoteImages.mockRejectedValue('images down');
        const result = await run(api);
        expect(result.success).toBe(true);
        expect(log.endOperation).toHaveBeenCalledWith('vote-101', null, 'images down');
    });

    test('a pass-level non-Error throw yields the generic failure envelope', async () => {
        const api = makeApi([]);
        api.getActiveChallenges.mockRejectedValue('');
        const result = await run(api);
        expect(result).toEqual({ success: false, error: 'Voting process failed' });
        // An empty rejection must still close the operation as failed, not completed.
        expect(log.endOperation).toHaveBeenCalledWith('voting-process', null, 'unknown error');
    });
});
