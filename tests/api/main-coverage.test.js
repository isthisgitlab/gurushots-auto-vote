/**
 * Unit tests for the real-strategy binder in src/js/api/main.js:
 *   - runTurboMiniGame: the pair-by-pair Turbo mini-game loop (first pick, flip
 *     on a wrong pick, early stop on WON, skip of resolved / malformed battles);
 *   - joinChallenge: the manual single-join wrapper (spendCoins must be `true`
 *     exactly — anything truthy-but-not-true must not spend coins);
 *   - fetchChallengesAndVote: the join pre-step gating and the deps it hands to
 *     the shared runVotingPass (real mode keeps the real cleanupStaleMetadata).
 *
 * Every collaborator is mocked; sleep resolves immediately so no real timer runs.
 */

jest.mock('../../src/js/api/challenges', () => ({ getActiveChallenges: jest.fn() }));
jest.mock('../../src/js/api/voting', () => ({ getVoteImages: jest.fn(), submitVotes: jest.fn() }));
jest.mock('../../src/js/api/boost', () => ({ applyBoost: jest.fn(), applyBoostToEntry: jest.fn() }));
jest.mock('../../src/js/api/turbo', () => ({
    getChallengeTurbo: jest.fn(),
    submitTurboSelection: jest.fn(),
    applyTurbo: jest.fn(),
    TURBO_SELECTION_DELAY_MS: 1234,
}));
jest.mock('../../src/js/api/submissions', () => ({
    getEligiblePhotos: jest.fn(),
    getImageData: jest.fn(),
    submitToChallenge: jest.fn(),
}));
jest.mock('../../src/js/api/tags', () => ({ getCurrentMemberProfile: jest.fn(), searchTagAutocomplete: jest.fn() }));
jest.mock('../../src/js/api/join', () => ({
    getMemberChallenges: jest.fn(),
    getBankroll: jest.fn(),
    coinsUnlock: jest.fn(),
}));
jest.mock('../../src/js/metadata', () => ({ cleanupStaleMetadata: jest.fn(() => true) }));
jest.mock('../../src/js/timing', () => ({
    sleep: jest.fn(() => Promise.resolve()),
    getRandomDelay: jest.fn(() => 3210),
}));
jest.mock('../../src/js/services/votingOrchestrator', () => ({ runVotingPass: jest.fn() }));
jest.mock('../../src/js/services/newEntryTracker', () => ({
    createMetadataEntryTracker: jest.fn(() => ({ kind: 'metadata-tracker' })),
}));
jest.mock('../../src/js/services/joinChallenges', () => ({
    runJoinPass: jest.fn(),
    joinChallengeSingle: jest.fn(),
}));
jest.mock('../../src/js/joinStateStore', () => ({
    joinStateStore: { kind: 'join-state-store' },
    acquireUnlockLock: jest.fn(),
}));

const logger = require('../../src/js/logger');
const turbo = require('../../src/js/api/turbo');
const timing = require('../../src/js/timing');
const metadata = require('../../src/js/metadata');
const join = require('../../src/js/api/join');
const tags = require('../../src/js/api/tags');
const submissions = require('../../src/js/api/submissions');
const { joinStateStore, acquireUnlockLock } = require('../../src/js/joinStateStore');
const { runVotingPass } = require('../../src/js/services/votingOrchestrator');
const { runJoinPass, joinChallengeSingle } = require('../../src/js/services/joinChallenges');
const main = require('../../src/js/api/main');

const { runTurboMiniGame, joinChallenge, fetchChallengesAndVote } = main;

const CHALLENGE = { id: 42, title: 'Turbo Test' };

const scopedWarnings = () =>
    logger.withCategory.mock.results.flatMap((r) => r.value.warning.mock.calls.map((call) => call[0]));

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
            isolatedFactory = require('../../src/js/services/newEntryTracker').createMetadataEntryTracker;
            require('../../src/js/api/main');
        });
        expect(isolatedFactory).toHaveBeenCalledTimes(1);
        expect(isolatedFactory).toHaveBeenCalledWith();
    });

    test('re-exports applyBoostToEntry from the boost module', () => {
        expect(main.applyBoostToEntry).toBe(require('../../src/js/api/boost').applyBoostToEntry);
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
        turbo.submitTurboSelection.mockResolvedValue({ ok: true, state: 'PLAYING' });

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
        turbo.submitTurboSelection.mockResolvedValue({ ok: true, state: 'WON' });

        const result = await runTurboMiniGame(CHALLENGE, 'tok');

        expect(result).toEqual({ played: 1, correct: 1, flipped: 0, doubleFailed: 0, won: true });
        expect(turbo.submitTurboSelection).toHaveBeenCalledTimes(1);
        expect(timing.sleep).not.toHaveBeenCalled();
    });

    test('flips to the second image after a wrong first pick', async () => {
        turbo.getChallengeTurbo.mockResolvedValue({ battles: [battle({ firstImageId: 'x1', secondImageId: 'x2' })] });
        turbo.submitTurboSelection
            .mockResolvedValueOnce({ ok: false })
            .mockResolvedValueOnce({ ok: true, state: 'PLAYING' });

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
            .mockResolvedValueOnce({ ok: false })
            .mockResolvedValueOnce({ ok: true, state: 'WON' });

        const result = await runTurboMiniGame(CHALLENGE, 'tok');

        expect(result).toEqual({ played: 1, correct: 1, flipped: 1, doubleFailed: 0, won: true });
        expect(turbo.submitTurboSelection).toHaveBeenCalledTimes(2);
        expect(timing.sleep).toHaveBeenCalledTimes(1);
    });

    test('both picks failing counts double-failed and logs the second error code', async () => {
        turbo.getChallengeTurbo.mockResolvedValue({ battles: [battle()] });
        turbo.submitTurboSelection
            .mockResolvedValueOnce({ ok: false, errorCode: 'FIRST' })
            .mockResolvedValueOnce({ ok: false, errorCode: 'SECOND' });

        const result = await runTurboMiniGame(CHALLENGE, 'tok');

        expect(result).toEqual({ played: 1, correct: 0, flipped: 0, doubleFailed: 1, won: false });
        expect(scopedWarnings()).toEqual([expect.stringContaining('error_code=SECOND')]);
    });

    test('falls back to the first pick error code when the second has none', async () => {
        turbo.getChallengeTurbo.mockResolvedValue({ battles: [battle()] });
        turbo.submitTurboSelection
            .mockResolvedValueOnce({ ok: false, errorCode: 'FIRST' })
            .mockResolvedValueOnce({ ok: false });

        await runTurboMiniGame(CHALLENGE, 'tok');

        expect(scopedWarnings()).toEqual([expect.stringContaining('error_code=FIRST')]);
    });

    test('a double failure with no error code at all is counted but not logged', async () => {
        turbo.getChallengeTurbo.mockResolvedValue({ battles: [battle()] });
        turbo.submitTurboSelection.mockResolvedValue({ ok: false });

        const result = await runTurboMiniGame(CHALLENGE, 'tok');

        expect(result.doubleFailed).toBe(1);
        expect(scopedWarnings()).toEqual([]);
    });
});

describe('joinChallenge', () => {
    test('forwards to joinChallengeSingle with the shared join deps', async () => {
        joinChallengeSingle.mockResolvedValue({ status: 'joined' });

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

    test.each([false, 'true', 1, undefined])('spendCoins=%p is never treated as consent to spend', async (flag) => {
        await joinChallenge('7', flag, 'tok');

        expect(joinChallengeSingle).toHaveBeenCalledWith('7', 'tok', expect.any(Object), { spendCoins: false });
    });
});

describe('fetchChallengesAndVote', () => {
    beforeEach(() => {
        runVotingPass.mockResolvedValue({ success: true, challenges: [] });
        runJoinPass.mockResolvedValue(undefined);
    });

    test('runs the join pre-step before voting on a full pass', async () => {
        const order = [];
        runJoinPass.mockImplementation(async () => order.push('join'));
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
        );
    });

    test('skips the join pre-step for a single-challenge run', async () => {
        await fetchChallengesAndVote('tok', null, 99);

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
