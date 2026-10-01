/**
 * Unit tests for the real-strategy binder in src/ts/strategies/real/index.ts:
 *   - runTurboMiniGame: the pair-by-pair Turbo mini-game loop (first pick, flip
 *     on a wrong pick, early stop on WON, skip of resolved / malformed battles);
 *   - joinChallenge: the manual single-join wrapper (spendCoins must be `true`
 *     exactly — anything truthy-but-not-true must not spend coins);
 *   - fetchChallengesAndVote: the join and claim pre-step gating and the deps it hands to
 *     the shared runVotingPass (real mode keeps the real cleanupStaleMetadata).
 *
 * Every collaborator is mocked; sleep resolves immediately so no real timer runs.
 */

jest.mock('../../src/ts/strategies/real/activeChallenges', () => ({ getActiveChallenges: jest.fn() }));
jest.mock('../../src/ts/api/voting', () => ({ getVoteImages: jest.fn(), submitVotes: jest.fn() }));
jest.mock('../../src/ts/strategies/real/applyBoost', () => ({ applyBoost: jest.fn() }));
jest.mock('../../src/ts/api/boost', () => ({ applyBoostToEntry: jest.fn() }));
jest.mock('../../src/ts/api/turbo', () => ({
    getChallengeTurbo: jest.fn(),
    submitTurboSelection: jest.fn(),
    applyTurbo: jest.fn(),
    TURBO_SELECTION_DELAY_MS: 1234,
}));
jest.mock('../../src/ts/api/submissions', () => ({
    getEligiblePhotos: jest.fn(),
    getImageData: jest.fn(),
    submitToChallenge: jest.fn(),
}));
jest.mock('../../src/ts/api/tags', () => ({ getCurrentMemberProfile: jest.fn(), searchTagAutocomplete: jest.fn() }));
jest.mock('../../src/ts/api/join', () => ({
    getMemberChallenges: jest.fn(),
    getBankroll: jest.fn(),
    coinsUnlock: jest.fn(),
}));
jest.mock('../../src/ts/metadata', () => ({ cleanupStaleMetadata: jest.fn(() => true) }));
jest.mock('../../src/ts/timing', () => ({
    sleep: jest.fn(() => Promise.resolve()),
    getRandomDelay: jest.fn(() => 3210),
}));
jest.mock('../../src/ts/services/votingOrchestrator', () => ({ runVotingPass: jest.fn() }));
jest.mock('../../src/ts/services/newEntryTracker', () => ({
    createMetadataEntryTracker: jest.fn(() => ({ kind: 'metadata-tracker' })),
}));
jest.mock('../../src/ts/services/joinChallenges', () => ({
    runJoinPass: jest.fn(),
    joinChallengeSingle: jest.fn(),
}));
jest.mock('../../src/ts/services/autoClaim', () => ({ runClaimPass: jest.fn() }));
jest.mock('../../src/ts/services/missions', () => ({
    loadMissionNeeds: jest.fn(async () => null),
    registerMissionNeeds: jest.fn((_token: string, needs: missionsModule.MissionNeeds | null) =>
        needs ? jest.fn() : null,
    ),
}));
jest.mock('../../src/ts/api/rewards', () => ({
    getMyCompletedChallenges: jest.fn(),
    claimChallengeResources: jest.fn(),
    getMyMissions: jest.fn(),
    claimMissionPrize: jest.fn(),
}));
jest.mock('../../src/ts/joinStateStore', () => ({
    joinStateStore: { kind: 'join-state-store' },
    acquireUnlockLock: jest.fn(),
}));

import logger = require('../../src/ts/logger');
import turboModule = require('../../src/ts/api/turbo');
const turbo = jest.mocked(turboModule);
import timingModule = require('../../src/ts/timing');
const timing = jest.mocked(timingModule);
import metadataModule = require('../../src/ts/metadata');
const metadata = jest.mocked(metadataModule);
import joinModule = require('../../src/ts/api/join');
const join = jest.mocked(joinModule);
import tagsModule = require('../../src/ts/api/tags');
const tags = jest.mocked(tagsModule);
import submissionsModule = require('../../src/ts/api/submissions');
const submissions = jest.mocked(submissionsModule);
const { joinStateStore, acquireUnlockLock } = jest.mocked(
    require('../../src/ts/joinStateStore') as typeof joinStateStoreModule,
);
const { runVotingPass } = jest.mocked(
    require('../../src/ts/services/votingOrchestrator') as typeof votingOrchestratorModule,
);
const { runJoinPass, joinChallengeSingle } = jest.mocked(
    require('../../src/ts/services/joinChallenges') as typeof joinChallengesModule,
);
const { runClaimPass } = jest.mocked(require('../../src/ts/services/autoClaim') as typeof autoClaimModule);
const { loadMissionNeeds, registerMissionNeeds } = jest.mocked(
    require('../../src/ts/services/missions') as typeof missionsModule,
);
import rewardsModule = require('../../src/ts/api/rewards');
const rewards = jest.mocked(rewardsModule);
import main = require('../../src/ts/strategies/real');
import type * as joinStateStoreModule from '../../src/ts/joinStateStore';
import type * as votingOrchestratorModule from '../../src/ts/services/votingOrchestrator';
import type * as joinChallengesModule from '../../src/ts/services/joinChallenges';
import type * as autoClaimModule from '../../src/ts/services/autoClaim';
import type * as missionsModule from '../../src/ts/services/missions';
import type { Challenge } from '../../src/ts/types/gurushots';
import type { CategoryLogger } from '../../src/ts/logger';
import { invalid } from '../helpers/invalid';

const { runTurboMiniGame, joinChallenge, fetchChallengesAndVote } = main;

// A partial challenge: the mini-game reads only its id and title.
const CHALLENGE = invalid<Challenge>({ id: 42, title: 'Turbo Test' });

const scopedWarnings = () =>
    jest
        .mocked(logger.withCategory)
        .mock.results.flatMap((r) => jest.mocked(r.value as CategoryLogger).warning.mock.calls.map((call) => call[0]));

const battle = (overrides = {}) => ({ isSuccess: null, firstImageId: 'f1', secondImageId: 's1', ...overrides });

beforeEach(() => {
    jest.clearAllMocks();
});

describe('module wiring', () => {
    test('builds exactly one metadata-backed entry tracker at load time', () => {
        // clearAllMocks ran after module load, so re-load main in an isolated
        // registry (explicit jest.mock factories are shared with it).
        let isolatedFactory;
        jest.isolateModules(() => {
            isolatedFactory = (
                require('../../src/ts/services/newEntryTracker') as typeof import('../../src/ts/services/newEntryTracker')
            ).createMetadataEntryTracker;
            require('../../src/ts/strategies/real');
        });
        expect(isolatedFactory).toHaveBeenCalledTimes(1);
        expect(isolatedFactory).toHaveBeenCalledWith();
    });

    test('exposes the entry-picking boost and the title-pinned challenge read', () => {
        expect(main.applyBoost).toBe(
            (
                require('../../src/ts/strategies/real/applyBoost') as typeof import('../../src/ts/strategies/real/applyBoost')
            ).applyBoost,
        );
        expect(main.getActiveChallenges).toBe(
            (
                require('../../src/ts/strategies/real/activeChallenges') as typeof import('../../src/ts/strategies/real/activeChallenges')
            ).getActiveChallenges,
        );
    });
});

describe('runTurboMiniGame', () => {
    test('returns an all-zero summary and warns when no battle set is returned', async () => {
        turbo.getChallengeTurbo.mockResolvedValue(null);

        const result = await runTurboMiniGame(CHALLENGE, 'tok');

        expect(result).toEqual({ played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false });
        expect(turbo.getChallengeTurbo).toHaveBeenCalledWith(42, 'tok');
        expect(turbo.submitTurboSelection).not.toHaveBeenCalled();
        expect(scopedWarnings()).toEqual([expect.stringContaining('No turbo battle set returned')]);
    });

    test('skips already-resolved battles and counts malformed pairs as double-failed', async () => {
        turbo.getChallengeTurbo.mockResolvedValue({
            battles: [
                battle({ isSuccess: true }),
                battle({ isSuccess: false }),
                battle({ firstImageId: null }),
                battle({ secondImageId: '' }),
            ],
        });

        const result = await runTurboMiniGame(CHALLENGE, 'tok');

        expect(result).toEqual({ played: 0, correct: 0, flipped: 0, doubleFailed: 2, won: false });
        expect(turbo.submitTurboSelection).not.toHaveBeenCalled();
        expect(timing.sleep).not.toHaveBeenCalled();
    });

    test('a correct first pick counts as correct and paces with the selection delay', async () => {
        turbo.getChallengeTurbo.mockResolvedValue({
            battles: [battle({ firstImageId: 'a1', secondImageId: 'a2' }), battle({ firstImageId: 'b1' })],
        });
        turbo.submitTurboSelection.mockResolvedValue(invalid({ ok: true, state: 'PLAYING' }));

        const result = await runTurboMiniGame(CHALLENGE, 'tok');

        expect(result).toEqual({ played: 2, correct: 2, flipped: 0, doubleFailed: 0, won: false });
        expect(turbo.submitTurboSelection.mock.calls).toEqual([
            [42, 'a1', 'tok'],
            [42, 'b1', 'tok'],
        ]);
        expect(timing.sleep).toHaveBeenCalledTimes(2);
        expect(timing.sleep).toHaveBeenCalledWith(1234);
    });

    test('stops immediately once a first pick reports WON', async () => {
        turbo.getChallengeTurbo.mockResolvedValue({ battles: [battle(), battle({ firstImageId: 'never' })] });
        turbo.submitTurboSelection.mockResolvedValue(invalid({ ok: true, state: 'WON' }));

        const result = await runTurboMiniGame(CHALLENGE, 'tok');

        expect(result).toEqual({ played: 1, correct: 1, flipped: 0, doubleFailed: 0, won: true });
        expect(turbo.submitTurboSelection).toHaveBeenCalledTimes(1);
        expect(timing.sleep).not.toHaveBeenCalled();
    });

    test('flips to the second image after a wrong first pick', async () => {
        turbo.getChallengeTurbo.mockResolvedValue({ battles: [battle({ firstImageId: 'x1', secondImageId: 'x2' })] });
        turbo.submitTurboSelection
            .mockResolvedValueOnce(invalid({ ok: false }))
            .mockResolvedValueOnce(invalid({ ok: true, state: 'PLAYING' }));

        const result = await runTurboMiniGame(CHALLENGE, 'tok');

        expect(result).toEqual({ played: 1, correct: 1, flipped: 1, doubleFailed: 0, won: false });
        expect(turbo.submitTurboSelection.mock.calls).toEqual([
            [42, 'x1', 'tok'],
            [42, 'x2', 'tok'],
        ]);
        // One pause before the flip, one after the battle.
        expect(timing.sleep).toHaveBeenCalledTimes(2);
    });

    test('a flipped pick that reports WON ends the game', async () => {
        turbo.getChallengeTurbo.mockResolvedValue({ battles: [battle(), battle({ firstImageId: 'never' })] });
        turbo.submitTurboSelection
            .mockResolvedValueOnce(invalid({ ok: false }))
            .mockResolvedValueOnce(invalid({ ok: true, state: 'WON' }));

        const result = await runTurboMiniGame(CHALLENGE, 'tok');

        expect(result).toEqual({ played: 1, correct: 1, flipped: 1, doubleFailed: 0, won: true });
        expect(turbo.submitTurboSelection).toHaveBeenCalledTimes(2);
        expect(timing.sleep).toHaveBeenCalledTimes(1);
    });

    test('both picks failing counts double-failed and logs the second error code', async () => {
        turbo.getChallengeTurbo.mockResolvedValue({ battles: [battle()] });
        turbo.submitTurboSelection
            .mockResolvedValueOnce(invalid({ ok: false, errorCode: 'FIRST' }))
            .mockResolvedValueOnce(invalid({ ok: false, errorCode: 'SECOND' }));

        const result = await runTurboMiniGame(CHALLENGE, 'tok');

        expect(result).toEqual({ played: 1, correct: 0, flipped: 0, doubleFailed: 1, won: false });
        expect(scopedWarnings()).toEqual([expect.stringContaining('error_code=SECOND')]);
    });

    test('falls back to the first pick error code when the second has none', async () => {
        turbo.getChallengeTurbo.mockResolvedValue({ battles: [battle()] });
        turbo.submitTurboSelection
            .mockResolvedValueOnce(invalid({ ok: false, errorCode: 'FIRST' }))
            .mockResolvedValueOnce(invalid({ ok: false }));

        await runTurboMiniGame(CHALLENGE, 'tok');

        expect(scopedWarnings()).toEqual([expect.stringContaining('error_code=FIRST')]);
    });

    test('a double failure with no error code at all is counted but not logged', async () => {
        turbo.getChallengeTurbo.mockResolvedValue({ battles: [battle()] });
        turbo.submitTurboSelection.mockResolvedValue(invalid({ ok: false }));

        const result = await runTurboMiniGame(CHALLENGE, 'tok');

        expect(result.doubleFailed).toBe(1);
        expect(scopedWarnings()).toEqual([]);
    });
});

describe('joinChallenge', () => {
    test('forwards to joinChallengeSingle with the shared join deps', async () => {
        joinChallengeSingle.mockResolvedValue(invalid({ status: 'joined' }));

        const result = await joinChallenge(7, true, 'tok');

        expect(result).toEqual({ status: 'joined' });
        expect(joinChallengeSingle).toHaveBeenCalledWith(
            7,
            'tok',
            expect.objectContaining({
                getMemberChallenges: join.getMemberChallenges,
                getBankroll: join.getBankroll,
                coinsUnlock: join.coinsUnlock,
                submitToChallenge: submissions.submitToChallenge,
                getEligiblePhotos: submissions.getEligiblePhotos,
                getCurrentMemberProfile: tags.getCurrentMemberProfile,
                searchTagAutocomplete: tags.searchTagAutocomplete,
                joinStateStore,
                acquireUnlockLock,
            }),
            { spendCoins: true },
        );
    });

    test.each(invalid<boolean[]>([false, 'true', 1, undefined]))(
        'spendCoins=%p is never treated as consent to spend',
        async (flag) => {
            await joinChallenge('7', flag, 'tok');

            expect(joinChallengeSingle).toHaveBeenCalledWith('7', 'tok', expect.any(Object), { spendCoins: false });
        },
    );
});

describe('fetchChallengesAndVote', () => {
    beforeEach(() => {
        runVotingPass.mockResolvedValue({ success: true, challenges: [] });
        runJoinPass.mockResolvedValue(invalid(undefined));
        runClaimPass.mockResolvedValue(invalid(undefined));
    });

    test('runs the claim pre-step after join and before voting, with the rewards endpoints', async () => {
        const order: string[] = [];
        runJoinPass.mockImplementation(invalid(async () => order.push('join')));
        runClaimPass.mockImplementation(invalid(async () => order.push('claim')));
        runVotingPass.mockImplementation(async () => {
            order.push('vote');
            return { success: true };
        });

        await fetchChallengesAndVote('tok');

        expect(order).toEqual(['join', 'claim', 'vote']);
        expect(runClaimPass).toHaveBeenCalledWith('tok', expect.any(Number), {
            getMyCompletedChallenges: rewards.getMyCompletedChallenges,
            claimChallengeResources: rewards.claimChallengeResources,
            getMyMissions: rewards.getMyMissions,
            claimMissionPrize: rewards.claimMissionPrize,
        });
    });

    test('skips the claim pre-step for a single-challenge run', async () => {
        await fetchChallengesAndVote('tok', 99);

        expect(runClaimPass).not.toHaveBeenCalled();
    });

    test.each([
        ['an Error', new Error('boom'), 'boom'],
        ['a non-Error value', 'plain failure', 'plain failure'],
    ])('a claim pass that throws %s is logged and voting still runs', async (_label, thrown, expected) => {
        runClaimPass.mockRejectedValue(thrown);

        const result = await fetchChallengesAndVote('tok');

        expect(result).toEqual({ success: true, challenges: [] });
        expect(runVotingPass).toHaveBeenCalledTimes(1);
        expect(scopedWarnings()).toEqual([`claim pass errored (voting continues): ${expected}`]);
    });

    test('runs the join pre-step before voting on a full pass', async () => {
        const order: string[] = [];
        runJoinPass.mockImplementation(invalid(async () => order.push('join')));
        runVotingPass.mockImplementation(async () => {
            order.push('vote');
            return { success: true };
        });

        const result = await fetchChallengesAndVote('tok');

        expect(result).toEqual({ success: true });
        expect(order).toEqual(['join', 'vote']);
        expect(runJoinPass).toHaveBeenCalledWith(
            'tok',
            expect.any(Number),
            expect.objectContaining({ joinStateStore }),
            null,
        );
    });

    test('reads the missions once and hands the same needs to the join pre-step and the pass', async () => {
        const needs = { join: 2, fill: 0, turbo: 1, vote: 0 };
        loadMissionNeeds.mockResolvedValueOnce(needs);
        const unregister = jest.fn();
        registerMissionNeeds.mockReturnValueOnce(unregister);
        runVotingPass.mockResolvedValue({ success: true });

        await fetchChallengesAndVote('tok');

        expect(loadMissionNeeds).toHaveBeenCalledTimes(1);
        expect(loadMissionNeeds).toHaveBeenCalledWith('tok', expect.any(Number), {
            getMyMissions: rewards.getMyMissions,
        });
        expect(runJoinPass.mock.calls[0][3]).toBe(needs);
        expect(runVotingPass.mock.calls[0][2].missions).toBe(needs);
        expect(runVotingPass.mock.calls[0][2].refreshMissionNeeds).toBeNull();
        expect(registerMissionNeeds).toHaveBeenCalledWith('tok', needs);
        expect(registerMissionNeeds.mock.invocationCallOrder[0]).toBeLessThan(runJoinPass.mock.invocationCallOrder[0]!);
        expect(unregister).toHaveBeenCalledTimes(1);
    });

    test('headless Android passes a live mission refresh to the voting pass', async () => {
        const original = Object.getOwnPropertyDescriptor(globalThis, '__GS_HEADLESS__');
        Object.assign(globalThis, { __GS_HEADLESS__: true });
        loadMissionNeeds
            .mockResolvedValueOnce({ join: 0, fill: 0, turbo: 1, vote: 0 })
            .mockResolvedValueOnce({ join: 0, fill: 0, turbo: 0, vote: 0 });
        try {
            await fetchChallengesAndVote('tok');
            const refresh = runVotingPass.mock.calls.at(-1)![2].refreshMissionNeeds;
            expect(refresh).toEqual(expect.any(Function));
            await expect(refresh?.()).resolves.toMatchObject({ turbo: 0 });
            expect(loadMissionNeeds).toHaveBeenLastCalledWith('tok', expect.any(Number), {
                getMyMissions: rewards.getMyMissions,
            });
        } finally {
            if (original) Object.defineProperty(globalThis, '__GS_HEADLESS__', original);
            else Reflect.deleteProperty(globalThis, '__GS_HEADLESS__');
        }
    });

    test('skips the join pre-step for a single-challenge run', async () => {
        await fetchChallengesAndVote('tok', 99);

        expect(runJoinPass).not.toHaveBeenCalled();
        expect(runVotingPass).toHaveBeenCalledWith('tok', 99, expect.any(Object));
    });

    test.each([
        ['an Error', new Error('boom'), 'boom'],
        ['a non-Error value', 'plain failure', 'plain failure'],
    ])('a join pass that throws %s is logged and voting still runs', async (_label, thrown, expected) => {
        runJoinPass.mockRejectedValue(thrown);

        const result = await fetchChallengesAndVote('tok');

        expect(result).toEqual({ success: true, challenges: [] });
        expect(runVotingPass).toHaveBeenCalledTimes(1);
        expect(scopedWarnings()).toEqual([`join pass errored (voting continues): ${expected}`]);
    });

    test('hands runVotingPass the real api surface, real metadata cleanup and entry tracker', async () => {
        await fetchChallengesAndVote('tok');

        const [token, filter, deps] = runVotingPass.mock.calls[0];
        expect(token).toBe('tok');
        expect(filter).toBeNull();
        // Real mode must keep the real cleanup — only the mock binder passes null.
        expect(deps.cleanupStaleMetadata).toBe(metadata.cleanupStaleMetadata);
        expect(deps.entryTracker).toEqual({ kind: 'metadata-tracker' });
        expect(deps.api.runTurboMiniGame).toBe(runTurboMiniGame);
        expect(deps.api.getCurrentMemberProfile).toBe(tags.getCurrentMemberProfile);
        expect(deps.api.searchTagAutocomplete).toBe(tags.searchTagAutocomplete);
        expect(deps.api.getImageData).toBe(submissions.getImageData);
        expect(Object.keys(deps.api).sort()).toEqual(
            [
                'applyBoost',
                'applyBoostToEntry',
                'applyTurbo',
                'getActiveChallenges',
                'getCurrentMemberProfile',
                'getEligiblePhotos',
                'getImageData',
                'getVoteImages',
                'runTurboMiniGame',
                'searchTagAutocomplete',
                'submitToChallenge',
                'submitVotes',
            ].sort(),
        );
    });

    test('inter-challenge delay is a random 2-5s spacing', async () => {
        await fetchChallengesAndVote('tok');

        const { interChallengeDelay } = runVotingPass.mock.calls[0][2];
        expect(interChallengeDelay()).toBe(3210);
        expect(timing.getRandomDelay).toHaveBeenCalledWith(2000, 5000);
    });
});
