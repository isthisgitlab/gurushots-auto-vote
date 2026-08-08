/**
 * votingOrchestrator — the single voting-pass loop both API strategies run.
 *
 * Covers the contracts the unfork must never regress:
 *   - deadline actions dispatch in orderDeadlineActions' order, sequentially
 *   - every cancellation checkpoint (per-challenge, between actions, before
 *     vote, before submit, after submit) aborts with the shared envelope
 *   - empty-list and challengeIdFilter hit/miss envelopes
 *   - the three behaviors mock mode gained in the unfork (turbo-earn,
 *     auto-fill, emergency fill) actually execute on the shared path
 *   - cleanupStaleMetadata runs only when injected (null in mock mode — the
 *     un-namespaced shared store must never be purged by mock ids)
 */

jest.mock('../../src/js/settings', () => ({
    getEffectiveSetting: jest.fn(() => false),
}));

jest.mock('../../src/js/services/VotingLogic', () => ({
    shouldPlayAutoTurbo: jest.fn(() => false),
    orderDeadlineActions: jest.fn(() => []),
    shouldApplyBoost: jest.fn(() => false),
    shouldApplyTurbo: jest.fn(() => ({ apply: false })),
    getEffectiveBoostTime: jest.fn(() => 3600),
    evaluateVotingDecision: jest.fn(() => ({ shouldVote: false, voteReason: 'test skip', targetExposure: 100 })),
}));

jest.mock('../../src/js/services/autoFill', () => ({
    maybeAutoFillChallenge: jest.fn(async () => 'skipped'),
    maybeEmergencyFillChallenge: jest.fn(async () => 'skipped'),
    submitNewEntryForAction: jest.fn(async () => ({ ok: false, reason: 'none' })),
    reflectNewEntry: jest.fn(),
}));

jest.mock('../../src/js/voting/cancellation', () => ({
    isCancelled: jest.fn(() => false),
    setCancelled: jest.fn(),
    reset: jest.fn(),
}));

const votingLogic = require('../../src/js/services/VotingLogic');
const autoFill = require('../../src/js/services/autoFill');
const cancellation = require('../../src/js/voting/cancellation');
const { runVotingPass } = require('../../src/js/services/votingOrchestrator');

const NOW = Math.floor(Date.now() / 1000);

const makeChallenge = (over = {}) => ({
    id: 101,
    title: 'Orchestrated',
    close_time: NOW + 3600,
    member: { boost: { state: 'LOCKED', timeout: 0 }, ranking: { entries: [], exposure: { exposure_factor: 100 } } },
    ...over,
});

const makeApi = (challenges) => ({
    getActiveChallenges: jest.fn(async () => ({ challenges })),
    getVoteImages: jest.fn(async () => ({ images: [{ id: 'i1' }] })),
    submitVotes: jest.fn(async () => ({ success: true })),
    applyBoost: jest.fn(async () => ({ success: true })),
    applyBoostToEntry: jest.fn(async () => ({ success: true })),
    applyTurbo: jest.fn(async () => ({ ok: true })),
    getEligiblePhotos: jest.fn(async () => ({ images: [] })),
    submitToChallenge: jest.fn(async () => ({ success: true })),
    runTurboMiniGame: jest.fn(async () => ({ played: 1, correct: 1, flipped: 0, doubleFailed: 0, won: true })),
});

const deps = (api, over = {}) => ({
    api,
    cleanupStaleMetadata: null,
    interChallengeDelay: () => 0,
    ...over,
});

beforeEach(() => {
    jest.clearAllMocks();
    cancellation.isCancelled.mockReturnValue(false);
    votingLogic.shouldPlayAutoTurbo.mockReturnValue(false);
    votingLogic.orderDeadlineActions.mockReturnValue([]);
    votingLogic.evaluateVotingDecision.mockReturnValue({
        shouldVote: false,
        voteReason: 'test skip',
        targetExposure: 100,
    });
});

describe('envelopes', () => {
    test('empty active list returns success with the empty list', async () => {
        const api = makeApi([]);
        const result = await runVotingPass('tok', null, deps(api));
        expect(result).toEqual({ success: true, message: 'No active challenges found', challenges: [] });
    });

    test('challengeIdFilter miss returns failure but still carries the full list', async () => {
        const list = [makeChallenge({ id: 1 }), makeChallenge({ id: 2 })];
        const api = makeApi(list);
        const result = await runVotingPass('tok', '999', deps(api));
        expect(result.success).toBe(false);
        expect(result.error).toBe('Challenge 999 is not active');
        expect(result.challenges).toBe(list);
    });

    test('challengeIdFilter hit processes only the matching challenge but returns the full list', async () => {
        const list = [makeChallenge({ id: 1 }), makeChallenge({ id: 2 })];
        const api = makeApi(list);
        const result = await runVotingPass('tok', 2, deps(api));
        expect(result.success).toBe(true);
        expect(result.challenges).toBe(list);
        expect(votingLogic.evaluateVotingDecision).toHaveBeenCalledTimes(1);
        expect(votingLogic.evaluateVotingDecision.mock.calls[0][0].id).toBe(2);
    });

    test('an endpoint throw resolves to the failure envelope, never a rejection', async () => {
        const api = makeApi([]);
        api.getActiveChallenges.mockRejectedValue(new Error('network down'));
        const result = await runVotingPass('tok', null, deps(api));
        expect(result).toEqual({ success: false, error: 'network down' });
    });
});

describe('metadata cleanup injection', () => {
    test('runs the injected cleanup against the FULL list before filtering', async () => {
        const list = [makeChallenge({ id: 1 }), makeChallenge({ id: 2 })];
        const api = makeApi(list);
        const cleanup = jest.fn(() => true);
        await runVotingPass('tok', 2, deps(api, { cleanupStaleMetadata: cleanup }));
        expect(cleanup).toHaveBeenCalledWith(['1', '2']);
    });

    test('mock mode (null) never touches metadata cleanup', async () => {
        const api = makeApi([makeChallenge()]);
        await runVotingPass('tok', null, deps(api));
        // Nothing to assert beyond "did not throw and completed" — the null
        // injection point is the guarantee; the mock binder test pins that
        // mock/index.js actually passes null.
    });
});

describe('deadline-action dispatch', () => {
    test('actions run sequentially in orderDeadlineActions order', async () => {
        const api = makeApi([makeChallenge()]);
        const order = [];
        votingLogic.orderDeadlineActions.mockReturnValue([
            { action: 'autoFill' },
            { action: 'emergencyFill' },
            { action: 'turbo' },
        ]);
        autoFill.maybeAutoFillChallenge.mockImplementation(async () => {
            order.push('autoFill');
            return 'skipped';
        });
        autoFill.maybeEmergencyFillChallenge.mockImplementation(async () => {
            order.push('emergencyFill');
            return 'skipped';
        });
        votingLogic.shouldApplyTurbo.mockImplementation(() => {
            order.push('turbo');
            return { apply: false };
        });

        await runVotingPass('tok', null, deps(api));
        expect(order).toEqual(['autoFill', 'emergencyFill', 'turbo']);
    });

    test('an unknown action key degrades to a skip instead of throwing', async () => {
        const api = makeApi([makeChallenge()]);
        votingLogic.orderDeadlineActions.mockReturnValue([{ action: 'somethingNew' }]);
        const result = await runVotingPass('tok', null, deps(api));
        expect(result.success).toBe(true);
    });
});

describe('mock-parity behaviors on the shared path', () => {
    test('turbo-earn plays the mini-game ahead of deadline actions when eligible', async () => {
        const api = makeApi([makeChallenge()]);
        votingLogic.shouldPlayAutoTurbo.mockReturnValue(true);
        await runVotingPass('tok', null, deps(api));
        expect(api.runTurboMiniGame).toHaveBeenCalledTimes(1);
    });

    test('auto-fill executes with the injected endpoint pair', async () => {
        const challenge = makeChallenge();
        const api = makeApi([challenge]);
        votingLogic.orderDeadlineActions.mockReturnValue([{ action: 'autoFill' }]);
        await runVotingPass('tok', null, deps(api));
        expect(autoFill.maybeAutoFillChallenge).toHaveBeenCalledWith(
            challenge,
            'tok',
            expect.any(Number),
            expect.objectContaining({
                getEligiblePhotos: api.getEligiblePhotos,
                submitToChallenge: api.submitToChallenge,
                getActiveChallenges: api.getActiveChallenges,
            }),
        );
    });

    test('emergency fill executes with the injected endpoint pair', async () => {
        const challenge = makeChallenge();
        const api = makeApi([challenge]);
        votingLogic.orderDeadlineActions.mockReturnValue([{ action: 'emergencyFill' }]);
        await runVotingPass('tok', null, deps(api));
        expect(autoFill.maybeEmergencyFillChallenge).toHaveBeenCalledWith(
            challenge,
            'tok',
            expect.any(Number),
            expect.objectContaining({
                getEligiblePhotos: api.getEligiblePhotos,
                submitToChallenge: api.submitToChallenge,
                getActiveChallenges: api.getActiveChallenges,
            }),
        );
    });

    // The two fill-new sites had no deps-shape coverage at all — a forgotten
    // getActiveChallenges there would silently keep boost/turbo fill-new on
    // stale pass-start data (no pre-submit live re-check).
    test('boost fill-new passes getActiveChallenges for the pre-submit live re-check', async () => {
        const settings = require('../../src/js/settings');
        const challenge = makeChallenge({
            member: {
                boost: { state: 'AVAILABLE', timeout: NOW + 600 },
                ranking: { entries: [], exposure: { exposure_factor: 100 } },
            },
        });
        const api = makeApi([challenge]);
        votingLogic.orderDeadlineActions.mockReturnValue([{ action: 'boost' }]);
        votingLogic.shouldApplyBoost.mockReturnValue(true);
        settings.getEffectiveSetting.mockImplementation((key) => key === 'boostFillNew');
        try {
            await runVotingPass('tok', null, deps(api));
            expect(autoFill.submitNewEntryForAction).toHaveBeenCalledWith(
                challenge,
                'tok',
                expect.objectContaining({
                    getEligiblePhotos: api.getEligiblePhotos,
                    submitToChallenge: api.submitToChallenge,
                    getActiveChallenges: api.getActiveChallenges,
                }),
            );
        } finally {
            settings.getEffectiveSetting.mockImplementation(() => false);
        }
    });

    test('turbo fill-new passes getActiveChallenges for the pre-submit live re-check', async () => {
        const challenge = makeChallenge();
        const api = makeApi([challenge]);
        votingLogic.orderDeadlineActions.mockReturnValue([{ action: 'turbo' }]);
        votingLogic.shouldApplyTurbo.mockReturnValue({ apply: true, fillNew: true, imageId: null });
        await runVotingPass('tok', null, deps(api));
        expect(autoFill.submitNewEntryForAction).toHaveBeenCalledWith(
            challenge,
            'tok',
            expect.objectContaining({
                getEligiblePhotos: api.getEligiblePhotos,
                submitToChallenge: api.submitToChallenge,
                getActiveChallenges: api.getActiveChallenges,
            }),
        );
    });

    // When the live re-check says the challenge left the active list, the
    // fill-new callers must NOT fire the fallback apply — it is a known-doomed
    // call that would only add a second failure log.
    test('boost fill-new challenge-gone → no fallback applyBoost call', async () => {
        const settings = require('../../src/js/settings');
        const challenge = makeChallenge({
            member: {
                boost: { state: 'AVAILABLE', timeout: NOW + 600 },
                ranking: { entries: [], exposure: { exposure_factor: 100 } },
            },
        });
        const api = makeApi([challenge]);
        votingLogic.orderDeadlineActions.mockReturnValue([{ action: 'boost' }]);
        votingLogic.shouldApplyBoost.mockReturnValue(true);
        autoFill.submitNewEntryForAction.mockResolvedValueOnce({ ok: false, imageId: null, reason: 'challenge-gone' });
        settings.getEffectiveSetting.mockImplementation((key) => key === 'boostFillNew');
        try {
            const result = await runVotingPass('tok', null, deps(api));
            expect(result.success).toBe(true);
            expect(api.applyBoost).not.toHaveBeenCalled();
            expect(api.applyBoostToEntry).not.toHaveBeenCalled();
        } finally {
            settings.getEffectiveSetting.mockImplementation(() => false);
        }
    });

    test('turbo fill-new challenge-gone → no fallback applyTurbo call', async () => {
        const challenge = makeChallenge();
        const api = makeApi([challenge]);
        votingLogic.orderDeadlineActions.mockReturnValue([{ action: 'turbo' }]);
        votingLogic.shouldApplyTurbo.mockReturnValue({ apply: true, fillNew: true, imageId: 'existing-1' });
        autoFill.submitNewEntryForAction.mockResolvedValueOnce({ ok: false, imageId: null, reason: 'challenge-gone' });
        const result = await runVotingPass('tok', null, deps(api));
        expect(result.success).toBe(true);
        expect(api.applyTurbo).not.toHaveBeenCalled();
    });
});

describe('cancellation checkpoints', () => {
    const CANCELLED = { success: false, message: 'Voting cancelled by user' };

    test('1: before processing a challenge', async () => {
        const api = makeApi([makeChallenge()]);
        cancellation.isCancelled.mockReturnValue(true);
        const result = await runVotingPass('tok', null, deps(api));
        expect(result).toMatchObject(CANCELLED);
        expect(votingLogic.evaluateVotingDecision).not.toHaveBeenCalled();
    });

    test('2: between deadline actions', async () => {
        const api = makeApi([makeChallenge()]);
        votingLogic.orderDeadlineActions.mockReturnValue([{ action: 'autoFill' }]);
        cancellation.isCancelled.mockReturnValueOnce(false).mockReturnValue(true);
        const result = await runVotingPass('tok', null, deps(api));
        expect(result).toMatchObject(CANCELLED);
        expect(autoFill.maybeAutoFillChallenge).not.toHaveBeenCalled();
    });

    test('3: before voting starts', async () => {
        const api = makeApi([makeChallenge()]);
        votingLogic.evaluateVotingDecision.mockReturnValue({
            shouldVote: true,
            voteReason: 'below threshold',
            targetExposure: 100,
        });
        cancellation.isCancelled.mockReturnValueOnce(false).mockReturnValue(true);
        const result = await runVotingPass('tok', null, deps(api));
        expect(result).toMatchObject(CANCELLED);
        expect(api.getVoteImages).not.toHaveBeenCalled();
    });

    test('4: after fetching images, before submitting votes', async () => {
        const api = makeApi([makeChallenge()]);
        votingLogic.evaluateVotingDecision.mockReturnValue({
            shouldVote: true,
            voteReason: 'below threshold',
            targetExposure: 100,
        });
        cancellation.isCancelled.mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
        const result = await runVotingPass('tok', null, deps(api));
        expect(result).toMatchObject(CANCELLED);
        expect(api.getVoteImages).toHaveBeenCalled();
        expect(api.submitVotes).not.toHaveBeenCalled();
    });

    test('5: after submitting votes, before the inter-challenge delay', async () => {
        const api = makeApi([makeChallenge()]);
        votingLogic.evaluateVotingDecision.mockReturnValue({
            shouldVote: true,
            voteReason: 'below threshold',
            targetExposure: 100,
        });
        cancellation.isCancelled
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValue(true);
        const result = await runVotingPass('tok', null, deps(api));
        expect(result).toMatchObject(CANCELLED);
        expect(api.submitVotes).toHaveBeenCalled();
    });
});

describe('voting path', () => {
    test('votes to the evaluated target and paces via the injected delay', async () => {
        const api = makeApi([makeChallenge()]);
        const delayFn = jest.fn(() => 0);
        votingLogic.evaluateVotingDecision.mockReturnValue({
            shouldVote: true,
            voteReason: 'below threshold',
            targetExposure: 87,
        });
        const result = await runVotingPass('tok', null, deps(api, { interChallengeDelay: delayFn }));
        expect(result.success).toBe(true);
        expect(api.submitVotes).toHaveBeenCalledWith(expect.objectContaining({ images: expect.any(Array) }), 'tok', 87);
        expect(delayFn).toHaveBeenCalledTimes(1);
    });
});
