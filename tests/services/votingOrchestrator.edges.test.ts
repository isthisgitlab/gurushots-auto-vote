/**
 * Branch coverage for the per-action runners inside runVotingPass that the
 * main orchestrator suite reaches only on its primary paths: boost
 * availability shapes, the three boost fill-new fallbacks, turbo apply
 * fallbacks, non-Error throws surfacing verbatim, and metadata-cleanup
 * failure reporting.
 */

jest.mock('../../src/ts/settings', () => ({
    getEffectiveSetting: jest.fn(() => false),
}));

jest.mock('../../src/ts/services/VotingLogic', () => ({
    shouldPlayAutoTurbo: jest.fn(() => false),
    isTurboEarnSaved: jest.fn(() => false),
    orderDeadlineActions: jest.fn(() => []),
    shouldApplyBoost: jest.fn(() => false),
    isWithinEmergencyWindow: jest.fn(() => false),
    resolveBoostFillNewMode: jest.fn(() => 'no'),
    pickBoostEntry: jest.fn(() => null),
    getBoostHoldUntil: jest.fn(() => null),
    shouldApplyTurbo: jest.fn(() => ({ apply: false })),
    getEffectiveBoostTime: jest.fn(() => 600),
    getEffectiveKeyUnlockedBoostTime: jest.fn(() => 900),
    evaluateVotingDecision: jest.fn(() => ({ shouldVote: false, voteReason: 'test skip', targetExposure: 100 })),
}));

jest.mock('../../src/ts/services/autoFill', () => ({
    maybeAutoFillChallenge: jest.fn(async () => 'skipped'),
    maybeEmergencyFillChallenge: jest.fn(async () => 'skipped'),
    submitNewEntryForAction: jest.fn(async () => ({ ok: false, reason: 'none' })),
    reflectNewEntry: jest.fn(),
    reflectEntryFlag: jest.fn(),
}));

jest.mock('../../src/ts/voting/cancellation', () => ({
    isCancelled: jest.fn(() => false),
    setCancelled: jest.fn(),
    reset: jest.fn(),
}));

import logger = require('../../src/ts/logger');
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import votingLogicModule = require('../../src/ts/services/VotingLogic');
const votingLogic = jest.mocked(votingLogicModule);
import autoFillModule = require('../../src/ts/services/autoFill');
const autoFill = jest.mocked(autoFillModule);
import cancellationModule = require('../../src/ts/voting/cancellation');
const cancellation = jest.mocked(cancellationModule);
import type * as votingOrchestratorModule from '../../src/ts/services/votingOrchestrator';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
import type * as entryAgeStoreModule from '../../src/ts/entryAgeStore';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { VotingPassDeps } from '../../src/ts/types/votingPass';
import { invalid } from '../helpers/invalid';
const { runVotingPass, resetMissionVoteLog } =
    require('../../src/ts/services/votingOrchestrator') as typeof votingOrchestratorModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;
const { createMemoryEntryAgeLedger } = require('../../src/ts/entryAgeStore') as typeof entryAgeStoreModule;

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
    submitVotes: jest.fn(async (..._args: unknown[]) => ({ success: true })),
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
    votingLogic.isWithinEmergencyWindow.mockReturnValue(false);
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

describe('uncertain auto-fill action protection', () => {
    const ledgerWithUncertain = () => {
        const ledger = createMemoryEntryAgeLedger();
        ledger.markUncertain(withBoost({ state: 'AVAILABLE_KEY' }), 'e1', NOW);
        return ledger;
    };

    test('skips key-unlocked Boost on an uncertain entry', async () => {
        settings.getEffectiveSetting.mockImplementation((key) => key === 'protectUncertainAutoFills');
        votingLogic.orderDeadlineActions.mockReturnValue(invalid([{ action: 'boost' }]));
        votingLogic.shouldApplyBoost.mockReturnValue(true);
        votingLogic.pickBoostEntry.mockReturnValue(invalid({ id: 'e1' }));
        const api = makeApi([
            withBoost(
                { state: 'AVAILABLE_KEY' },
                { member: { boost: { state: 'AVAILABLE_KEY' }, ranking: { entries: [{ id: 'e1' }] } } },
            ),
        ]);
        await run(api, { entryAges: ledgerWithUncertain() });
        expect(api.applyBoost).not.toHaveBeenCalled();
    });

    test('allows expiring Boost and emergency Boost on an uncertain entry', async () => {
        settings.getEffectiveSetting.mockImplementation((key) => key === 'protectUncertainAutoFills');
        votingLogic.orderDeadlineActions.mockReturnValue(invalid([{ action: 'boost' }]));
        votingLogic.shouldApplyBoost.mockReturnValue(true);
        votingLogic.pickBoostEntry.mockReturnValue(invalid({ id: 'e1' }));
        const timer = makeApi([
            withBoost(
                { state: 'AVAILABLE', timeout: NOW + 60 },
                { member: { boost: { state: 'AVAILABLE', timeout: NOW + 60 }, ranking: { entries: [{ id: 'e1' }] } } },
            ),
        ]);
        await run(timer, { entryAges: ledgerWithUncertain() });
        expect(timer.applyBoost).toHaveBeenCalledTimes(1);

        votingLogic.isWithinEmergencyWindow.mockReturnValue(true);
        const emergency = makeApi([
            withBoost(
                { state: 'AVAILABLE_KEY' },
                { member: { boost: { state: 'AVAILABLE_KEY' }, ranking: { entries: [{ id: 'e1' }] } } },
            ),
        ]);
        await run(emergency, { entryAges: ledgerWithUncertain() });
        expect(emergency.applyBoost).toHaveBeenCalledTimes(1);
    });

    test('skips Turbo on an uncertain entry unless in the emergency window', async () => {
        settings.getEffectiveSetting.mockImplementation((key) => key === 'protectUncertainAutoFills');
        votingLogic.orderDeadlineActions.mockReturnValue(invalid([{ action: 'turbo' }]));
        votingLogic.shouldApplyTurbo.mockReturnValue(invalid({ apply: true, fillNew: false, imageId: 'e1' }));
        const challenge = withBoost({ state: 'LOCKED' }, { member: { ranking: { entries: [{ id: 'e1' }] } } });
        const api = makeApi([challenge]);
        await run(api, { entryAges: ledgerWithUncertain() });
        expect(api.applyTurbo).not.toHaveBeenCalled();
        votingLogic.isWithinEmergencyWindow.mockReturnValue(true);
        await run(api, { entryAges: ledgerWithUncertain() });
        expect(api.applyTurbo).toHaveBeenCalledTimes(1);
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

describe('vote mission', () => {
    const open = (id: number, extra: Record<string, unknown> = {}) =>
        buildChallenge({
            id,
            title: `Mission ${id}`,
            type: 'regular',
            start_time: NOW - 3600,
            close_time: NOW + 3600,
            member: {
                boost: { state: 'LOCKED', timeout: 0 },
                ranking: { entries: [], exposure: { exposure_factor: 40 } },
            },
            ...extra,
        });
    const waiting = { shouldVote: false, voteReason: 'below threshold', targetExposure: 100 };
    const withVotes = (vote: number) => ({ missions: { join: 0, fill: 0, turbo: 0, vote } });
    const decide = (byId: (id: number) => Record<string, unknown>) =>
        votingLogic.evaluateVotingDecision.mockImplementation((challenge) => invalid(byId(Number(challenge?.id))));
    const quotaLine = (left: number) =>
        `🗳️ Vote mission: ${left} left — no challenge can take votes now (all full, flash or held by your settings); retrying next cycle`;

    beforeEach(() => {
        resetMissionVoteLog();
        decide(() => waiting);
    });

    test('votes on a threshold-wait up to 100%, capped at the quota', async () => {
        const api = makeApi([open(1)]);
        const result = await run(api, withVotes(50));
        expect(result.success).toBe(true);
        expect(api.submitVotes).toHaveBeenCalledTimes(1);
        expect(api.submitVotes).toHaveBeenCalledWith(
            expect.objectContaining({ images: expect.any(Array) }),
            'tok',
            100,
            50,
        );
        expect(messages('info')).toContain(
            '[Challenge 1: Mission 1] Starting voting process - vote mission: 50 left at cycle start — voting on up to 50 photos',
        );
        expect(messages('info')).toContain('[Challenge 1: Mission 1] Submitting votes for 1 images');
        expect(log.warning).not.toHaveBeenCalled();
    });

    test('the log shows the smaller of the pool and the cap', async () => {
        const api = makeApi([open(1)]);
        api.getVoteImages.mockResolvedValue({ images: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
        await run(api, withVotes(2));
        expect(messages('info')).toContain('[Challenge 1: Mission 1] Submitting votes for 2 images');
    });

    test('splits the votes still needed over the challenges that can take them, rounding up', async () => {
        const api = makeApi([open(1), open(2), open(3)]);
        await run(api, withVotes(100));
        expect(api.submitVotes).toHaveBeenCalledTimes(3);
        for (const call of api.submitVotes.mock.calls) expect(call[3]).toBe(34);
    });

    test('a blocked challenge neither gets mission votes nor takes a share', async () => {
        decide((id) => (id === 1 ? { ...waiting, blocked: true } : waiting));
        const api = makeApi([open(1), open(2)]);
        await run(api, withVotes(60));
        expect(api.submitVotes).toHaveBeenCalledTimes(1);
        expect(api.submitVotes.mock.calls[0][3]).toBe(60);
        expect(api.getVoteImages).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), 'tok');
    });

    test.each([
        ['flash', { type: 'flash' }],
        ['full', { member: { ranking: { exposure: { exposure_factor: 100 } } } }],
        ['not started', { start_time: NOW + 60 }],
        ['closed', { close_time: NOW - 60 }],
    ])('a %s challenge gets no mission votes and the pass logs the zero quota once', async (_name, extra) => {
        const api = makeApi([open(1, extra), open(2, extra)]);
        await run(api, withVotes(30));
        expect(api.submitVotes).not.toHaveBeenCalled();
        expect(messages('info').filter((m) => m === quotaLine(30))).toHaveLength(1);
    });

    test('every challenge blocked → the zero-quota line', async () => {
        decide(() => ({ ...waiting, blocked: true }));
        const api = makeApi([open(1)]);
        await run(api, withVotes(7));
        expect(api.submitVotes).not.toHaveBeenCalled();
        expect(messages('info')).toContain(quotaLine(7));
        expect(jest.mocked(logger.withCategory)).toHaveBeenCalledWith('voting');
    });

    test('a challenge the normal rules already vote on takes no share of the split', async () => {
        decide((id) => (id === 1 ? { shouldVote: true, voteReason: 'low', targetExposure: 80 } : waiting));
        const api = makeApi([open(1), open(2)]);
        await run(api, withVotes(60));
        expect(api.submitVotes).toHaveBeenCalledTimes(2);
        expect(api.submitVotes).toHaveBeenNthCalledWith(1, expect.any(Object), 'tok', 80, undefined);
        expect(api.submitVotes).toHaveBeenNthCalledWith(2, expect.any(Object), 'tok', 100, 60);
    });

    test('the zero-quota line is logged once per stall, however the count moves', async () => {
        decide(() => ({ ...waiting, blocked: true }));
        const api = makeApi([open(1)]);
        await run(api, withVotes(7));
        await run(api, withVotes(7));
        await run(api, withVotes(6));
        expect(messages('info').filter((m) => m.startsWith('🗳️ Vote mission'))).toEqual([quotaLine(7)]);
    });

    test.each([
        ['a cycle with a quota', () => decide(() => waiting), 6],
        [
            'normal voting covering the mission',
            () => decide(() => ({ shouldVote: true, voteReason: 'low', targetExposure: 80 })),
            6,
        ],
        ['no vote mission', () => undefined, 0],
    ])('%s ends the stall, so the next one is reported again', async (_name, between, left) => {
        const stalled = () => decide(() => ({ ...waiting, blocked: true }));
        const api = makeApi([open(1)]);
        stalled();
        await run(api, withVotes(6));
        between();
        await run(api, withVotes(left));
        stalled();
        await run(api, withVotes(5));
        expect(messages('info').filter((m) => m.startsWith('🗳️ Vote mission'))).toEqual([quotaLine(6), quotaLine(5)]);
    });

    test('a single-challenge run leaves the stall state untouched', async () => {
        decide(() => ({ ...waiting, blocked: true }));
        const api = makeApi([open(1)]);
        await run(api, withVotes(6));
        await runVotingPass('tok', 1, {
            api: invalid(api),
            cleanupStaleMetadata: null,
            interChallengeDelay: () => 0,
            ...withVotes(4),
        });
        await run(api, withVotes(3));
        expect(messages('info').filter((m) => m.startsWith('🗳️ Vote mission'))).toEqual([quotaLine(6)]);
    });

    test('a challenge the normal rule already votes on gets no mission top-up', async () => {
        decide(() => ({ shouldVote: true, voteReason: 'low', targetExposure: 80 }));
        const api = makeApi([open(1)]);
        await run(api, withVotes(50));
        expect(api.submitVotes).toHaveBeenCalledTimes(1);
        expect(api.submitVotes).toHaveBeenCalledWith(expect.any(Object), 'tok', 80, undefined);
        expect(messages('info').filter((m) => /vote mission/i.test(m))).toEqual([]);
    });

    test('when every candidate votes normally the mission logs no stall line', async () => {
        decide(() => ({ shouldVote: true, voteReason: 'low', targetExposure: 80 }));
        const api = makeApi([open(1), open(2)]);
        await run(api, withVotes(50));
        expect(api.submitVotes).toHaveBeenCalledTimes(2);
        for (const call of api.submitVotes.mock.calls) expect(call[3]).toBeUndefined();
        expect(messages('info').filter((m) => /vote mission/i.test(m))).toEqual([]);
    });

    test('a per-card run never does mission votes', async () => {
        const api = makeApi([open(1), open(2)]);
        const result = await runVotingPass('tok', 1, {
            api: invalid(api),
            cleanupStaleMetadata: null,
            interChallengeDelay: () => 0,
            ...withVotes(50),
        });
        expect(result.success).toBe(true);
        expect(votingLogic.evaluateVotingDecision).toHaveBeenCalledTimes(1);
        expect(api.submitVotes).not.toHaveBeenCalled();
        expect(messages('info')).not.toContain(quotaLine(50));
    });

    test('without a vote mission nothing is scanned: one decision per challenge', async () => {
        const api = makeApi([open(1), open(2)]);
        await run(api, withVotes(0));
        await run(api);
        expect(votingLogic.evaluateVotingDecision).toHaveBeenCalledTimes(4);
        expect(api.submitVotes).not.toHaveBeenCalled();
        expect(messages('info')).not.toContainEqual(expect.stringContaining('Vote mission'));
    });

    test('a null challenge and one whose decision throws do not stop the pass', async () => {
        decide((id) => {
            if (id === 2) throw new Error('malformed');
            return waiting;
        });
        const api = makeApi([invalid<Challenge>(null), open(2), open(3)]);
        const result = await run(api, withVotes(40));
        expect(result.success).toBe(true);
        expect(api.submitVotes).toHaveBeenCalledTimes(1);
        expect(api.submitVotes.mock.calls[0][3]).toBe(40);
        expect(api.getVoteImages).toHaveBeenCalledWith(expect.objectContaining({ id: 3 }), 'tok');
    });

    test('a cancel during the mission vote ends the pass', async () => {
        const api = makeApi([open(1), open(2)]);
        api.submitVotes.mockImplementation(async () => {
            cancellation.isCancelled.mockReturnValue(true);
            return { success: true };
        });
        try {
            const result = await run(api, withVotes(10));
            expect(result).toEqual(expect.objectContaining({ success: false, message: 'Voting cancelled by user' }));
            expect(api.submitVotes).toHaveBeenCalledTimes(1);
        } finally {
            cancellation.isCancelled.mockReturnValue(false);
        }
    });

    test('a mission vote that throws is closed as a failure and the pass continues', async () => {
        const api = makeApi([open(1), open(2)]);
        api.getVoteImages.mockRejectedValueOnce(new Error('images down'));
        const result = await run(api, withVotes(10));
        expect(result.success).toBe(true);
        expect(log.endOperation).toHaveBeenCalledWith('vote-1', null, 'images down');
        expect(api.submitVotes).toHaveBeenCalledTimes(1);
    });

    describe('new-entry log line', () => {
        const withNewEntry = () => {
            settings.getEffectiveSetting.mockImplementation((key) => key === 'voteOnNewEntry');
            const tracker = { get: jest.fn(() => ['a']), set: jest.fn() };
            const entries = [{ id: 'a' }, { id: 'b' }];
            const challenge = open(1, { member: { ranking: { entries, exposure: { exposure_factor: 40 } } } });
            return { tracker, challenge };
        };

        test('reflects the mission vote that actually runs', async () => {
            const { tracker, challenge } = withNewEntry();
            await run(makeApi([challenge]), { ...withVotes(10), entryTracker: tracker });
            expect(messages('info')).toContain(
                '[Challenge 1: Mission 1] New entry detected — voting for the vote mission',
            );
        });

        test('says not voting when no mission vote applies', async () => {
            const { tracker, challenge } = withNewEntry();
            await run(makeApi([challenge]), { entryTracker: tracker });
            expect(messages('info')).toContain('[Challenge 1: Mission 1] New entry detected — not voting this cycle');
        });
    });
});
