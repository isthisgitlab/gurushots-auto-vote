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
const { buildChallenge } = require('../helpers/challengeFixtures');

const NOW = Math.floor(Date.now() / 1000);

const makeChallenge = (over = {}) =>
    buildChallenge({
        id: 101,
        title: 'Orchestrated',
        close_time: NOW + 3600,
        member: {
            boost: { state: 'LOCKED', timeout: 0 },
            ranking: { entries: [], exposure: { exposure_factor: 100 } },
        },
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

    // Exactly-once reflection contract: submitNewEntryForAction deliberately
    // does NOT reflect internally (pinned in tests/services/autoFill.test.js)
    // — the orchestrator is the one and only place that reflects a successful
    // fill-new. If reflection ever moved inside submitNewEntryForAction these
    // sites would reflect twice, duplicating the entry in
    // challenge.member.ranking.entries and corrupting getSlotsRemaining plus
    // boost/turbo entry selection for the rest of the pass.
    test('boost fill-new success → reflectNewEntry called exactly once with the submitted id', async () => {
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
        autoFill.submitNewEntryForAction.mockResolvedValueOnce({ ok: true, imageId: 'fresh-1', reason: 'submitted' });
        settings.getEffectiveSetting.mockImplementation((key) => key === 'boostFillNew');
        try {
            await runVotingPass('tok', null, deps(api));
            expect(autoFill.reflectNewEntry).toHaveBeenCalledTimes(1);
            expect(autoFill.reflectNewEntry).toHaveBeenCalledWith(challenge, 'fresh-1');
            expect(api.applyBoostToEntry).toHaveBeenCalledWith('101', 'fresh-1', 'tok');
        } finally {
            settings.getEffectiveSetting.mockImplementation(() => false);
        }
    });

    test('turbo fill-new success → reflectNewEntry called exactly once with the submitted id', async () => {
        const challenge = makeChallenge();
        const api = makeApi([challenge]);
        votingLogic.orderDeadlineActions.mockReturnValue([{ action: 'turbo' }]);
        votingLogic.shouldApplyTurbo.mockReturnValue({ apply: true, fillNew: true, imageId: null });
        autoFill.submitNewEntryForAction.mockResolvedValueOnce({ ok: true, imageId: 'fresh-2', reason: 'submitted' });
        await runVotingPass('tok', null, deps(api));
        expect(autoFill.reflectNewEntry).toHaveBeenCalledTimes(1);
        expect(autoFill.reflectNewEntry).toHaveBeenCalledWith(challenge, 'fresh-2');
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

describe('voteOnNewEntry — gate, arm, record', () => {
    const settings = require('../../src/js/settings');

    /** Minimal in-memory tracker with call spies, matching the deps contract. */
    const makeTracker = (seed = {}) => {
        const store = new Map(Object.entries(seed));
        return {
            get: jest.fn((id) => (store.has(id) ? store.get(id) : null)),
            set: jest.fn((id, ids) => store.set(id, [...ids])),
            store,
        };
    };

    /** A challenge carrying real entry objects, since detection reads their ids. */
    const withEntries = (ids) =>
        makeChallenge({
            member: {
                boost: { state: 'LOCKED', timeout: 0 },
                ranking: { entries: ids.map((id) => ({ id })), exposure: { exposure_factor: 100 } },
            },
        });

    /** The gate reads voteOnNewEntry off settings; everything else stays false. */
    const enableSetting = (value = true) =>
        settings.getEffectiveSetting.mockImplementation((key) => (key === 'voteOnNewEntry' ? value : false));

    const lastDecisionOptions = () => votingLogic.evaluateVotingDecision.mock.calls.at(-1)?.[2];

    beforeEach(() => {
        settings.getEffectiveSetting.mockImplementation(() => false);
    });

    test('setting off: the tracker is never read or written', async () => {
        const api = makeApi([withEntries(['a'])]);
        const tracker = makeTracker();

        await runVotingPass('tok', null, deps(api, { entryTracker: tracker }));

        expect(tracker.get).not.toHaveBeenCalled();
        expect(tracker.set).not.toHaveBeenCalled();
        expect(lastDecisionOptions()).toEqual({ hasNewEntry: false });
    });

    test('no entryTracker injected: feature is inert even with the setting on', async () => {
        enableSetting();
        const api = makeApi([withEntries(['a'])]);

        const result = await runVotingPass('tok', null, deps(api));

        expect(result.success).toBe(true);
        expect(lastDecisionOptions()).toEqual({ hasNewEntry: false });
    });

    test('first sight records a baseline and does not force a vote', async () => {
        enableSetting();
        const api = makeApi([withEntries(['a', 'b'])]);
        const tracker = makeTracker();

        await runVotingPass('tok', null, deps(api, { entryTracker: tracker }));

        expect(lastDecisionOptions()).toEqual({ hasNewEntry: false });
        expect(tracker.set).toHaveBeenCalledWith('101', ['a', 'b']);
    });

    test('an entry added between passes is detected on the next pass', async () => {
        enableSetting();
        const api = makeApi([withEntries(['a', 'b'])]);
        const tracker = makeTracker({ 101: ['a'] });

        await runVotingPass('tok', null, deps(api, { entryTracker: tracker }));

        expect(lastDecisionOptions()).toEqual({ hasNewEntry: true });
        expect(tracker.set).toHaveBeenCalledWith('101', ['a', 'b']);
    });

    test('an entry added by auto-fill within the same pass is detected in that pass', async () => {
        // The whole reason detection runs after the deadline runners: reflectNewEntry
        // mutates the shared challenge object, so the fill lands before the decision.
        enableSetting();
        const challenge = withEntries(['a']);
        const api = makeApi([challenge]);
        const tracker = makeTracker({ 101: ['a'] });
        votingLogic.orderDeadlineActions.mockReturnValue([{ action: 'autoFill', thresholdSec: 900 }]);
        autoFill.maybeAutoFillChallenge.mockImplementation(async (c) => {
            c.member.ranking.entries.push({ id: 'fresh' });
            return 'submitted';
        });

        await runVotingPass('tok', null, deps(api, { entryTracker: tracker }));

        expect(lastDecisionOptions()).toEqual({ hasNewEntry: true });
        expect(tracker.set).toHaveBeenCalledWith('101', ['a', 'fresh']);
    });

    test('a reordered entries array is not a new entry and does not fire', async () => {
        enableSetting();
        const api = makeApi([withEntries(['b', 'a'])]);
        const tracker = makeTracker({ 101: ['a', 'b'] });

        await runVotingPass('tok', null, deps(api, { entryTracker: tracker }));

        expect(lastDecisionOptions()).toEqual({ hasNewEntry: false });
    });

    test('a challenge with no usable entries array is skipped entirely', async () => {
        enableSetting();
        const challenge = makeChallenge();
        challenge.member.ranking.entries = undefined;
        const api = makeApi([challenge]);
        const tracker = makeTracker();

        await runVotingPass('tok', null, deps(api, { entryTracker: tracker }));

        expect(tracker.get).not.toHaveBeenCalled();
        expect(tracker.set).not.toHaveBeenCalled();
    });

    test('a forced vote that throws leaves the snapshot unwritten so the next pass retries', async () => {
        enableSetting();
        const api = makeApi([withEntries(['a', 'b'])]);
        api.submitVotes.mockRejectedValue(new Error('network went away'));
        const tracker = makeTracker({ 101: ['a'] });
        votingLogic.evaluateVotingDecision.mockReturnValue({
            shouldVote: true,
            voteReason: 'new entry detected',
            targetExposure: 100,
            forcedByNewEntry: true,
        });

        const result = await runVotingPass('tok', null, deps(api, { entryTracker: tracker }));

        expect(result.success).toBe(true);
        expect(tracker.set).not.toHaveBeenCalled();
        expect(tracker.store.get('101')).toEqual(['a']); // still armed
    });

    test('a NON-forced vote that throws still records the snapshot', async () => {
        // Organic eligibility recurs by itself next cycle — there is no trigger to
        // preserve, so holding the snapshot back would only re-fire pointlessly.
        enableSetting();
        const api = makeApi([withEntries(['a', 'b'])]);
        api.submitVotes.mockRejectedValue(new Error('network went away'));
        const tracker = makeTracker({ 101: ['a'] });
        votingLogic.evaluateVotingDecision.mockReturnValue({
            shouldVote: true,
            voteReason: 'below threshold',
            targetExposure: 100,
            forcedByNewEntry: false,
        });

        await runVotingPass('tok', null, deps(api, { entryTracker: tracker }));

        expect(tracker.set).toHaveBeenCalledWith('101', ['a', 'b']);
    });

    test('"no vote images" on a forced decision still records', async () => {
        // Not a throw: treating it as failure would force a getVoteImages call every
        // cycle forever on a challenge that never has any.
        enableSetting();
        const api = makeApi([withEntries(['a', 'b'])]);
        api.getVoteImages.mockResolvedValue({ images: null });
        const tracker = makeTracker({ 101: ['a'] });
        votingLogic.evaluateVotingDecision.mockReturnValue({
            shouldVote: true,
            voteReason: 'new entry detected',
            targetExposure: 100,
            forcedByNewEntry: true,
        });

        await runVotingPass('tok', null, deps(api, { entryTracker: tracker }));

        expect(tracker.set).toHaveBeenCalledWith('101', ['a', 'b']);
    });

    test('a blocked decision consumes the trigger and does not vote', async () => {
        enableSetting();
        const api = makeApi([withEntries(['a', 'b'])]);
        const tracker = makeTracker({ 101: ['a'] });
        votingLogic.evaluateVotingDecision.mockReturnValue({
            shouldVote: false,
            voteReason: 'boost-only mode enabled',
            targetExposure: 100,
            forcedByNewEntry: false,
        });

        await runVotingPass('tok', null, deps(api, { entryTracker: tracker }));

        expect(api.submitVotes).not.toHaveBeenCalled();
        expect(tracker.set).toHaveBeenCalledWith('101', ['a', 'b']);
    });

    test('disable then re-enable fires exactly one catch-up vote, then goes quiet', async () => {
        const tracker = makeTracker();

        // Pass 1 — enabled, establishes the baseline.
        enableSetting();
        await runVotingPass('tok', null, deps(makeApi([withEntries(['a'])]), { entryTracker: tracker }));
        expect(tracker.store.get('101')).toEqual(['a']);

        // Pass 2 — disabled. Entries change, but nothing is read or written, so the
        // stored snapshot goes stale.
        enableSetting(false);
        tracker.set.mockClear();
        await runVotingPass('tok', null, deps(makeApi([withEntries(['a', 'b'])]), { entryTracker: tracker }));
        expect(tracker.set).not.toHaveBeenCalled();
        expect(tracker.store.get('101')).toEqual(['a']);

        // Pass 3 — re-enabled against the stale baseline: one catch-up fire.
        enableSetting();
        await runVotingPass('tok', null, deps(makeApi([withEntries(['a', 'b'])]), { entryTracker: tracker }));
        expect(lastDecisionOptions()).toEqual({ hasNewEntry: true });

        // Pass 4 — snapshot is current again, so it stays quiet.
        await runVotingPass('tok', null, deps(makeApi([withEntries(['a', 'b'])]), { entryTracker: tracker }));
        expect(lastDecisionOptions()).toEqual({ hasNewEntry: false });
    });

    test('a transient empty entries array does not overwrite a good baseline', async () => {
        // A partial/degraded poll must not poison the snapshot: recording [] would
        // make the unchanged entries look brand new on the very next poll.
        enableSetting();
        const tracker = makeTracker({ 101: ['a', 'b'] });

        await runVotingPass('tok', null, deps(makeApi([withEntries([])]), { entryTracker: tracker }));
        expect(tracker.set).not.toHaveBeenCalled();
        expect(tracker.store.get('101')).toEqual(['a', 'b']);

        // Next poll returns the same entries as before — nothing new.
        await runVotingPass('tok', null, deps(makeApi([withEntries(['a', 'b'])]), { entryTracker: tracker }));
        expect(lastDecisionOptions()).toEqual({ hasNewEntry: false });
    });

    test('a brand-new challenge with zero entries still records an empty baseline', async () => {
        enableSetting();
        const tracker = makeTracker();

        await runVotingPass('tok', null, deps(makeApi([withEntries([])]), { entryTracker: tracker }));

        expect(tracker.set).toHaveBeenCalledWith('101', []);
    });

    test('cancellation right after a successful forced vote still records', async () => {
        // The vote landed, so the trigger is spent. Bailing without recording would
        // re-force the identical vote on the next pass.
        enableSetting();
        const api = makeApi([withEntries(['a', 'b'])]);
        const tracker = makeTracker({ 101: ['a'] });
        votingLogic.evaluateVotingDecision.mockReturnValue({
            shouldVote: true,
            voteReason: 'new entry detected',
            targetExposure: 100,
            forcedByNewEntry: true,
        });
        // false at: per-challenge, pre-vote, pre-submit; then true after submission.
        cancellation.isCancelled
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValue(true);

        await runVotingPass('tok', null, deps(api, { entryTracker: tracker }));

        expect(api.submitVotes).toHaveBeenCalled();
        expect(tracker.set).toHaveBeenCalledWith('101', ['a', 'b']);
    });

    test('tracks each challenge in a multi-challenge pass independently', async () => {
        enableSetting();
        const first = withEntries(['a']);
        const second = makeChallenge({
            id: 202,
            member: {
                boost: { state: 'LOCKED', timeout: 0 },
                ranking: { entries: [{ id: 'x' }, { id: 'y' }], exposure: { exposure_factor: 100 } },
            },
        });
        const api = makeApi([first, second]);
        const tracker = makeTracker({ 101: ['a'], 202: ['x'] });

        await runVotingPass('tok', null, deps(api, { entryTracker: tracker }));

        // 101 unchanged, 202 gained an entry — the decisions must not bleed together.
        const options = votingLogic.evaluateVotingDecision.mock.calls.map((c) => c[2]);
        expect(options).toEqual([{ hasNewEntry: false }, { hasNewEntry: true }]);
        expect(tracker.set).toHaveBeenCalledWith('101', ['a']);
        expect(tracker.set).toHaveBeenCalledWith('202', ['x', 'y']);
    });

    test('a single-challenge filtered run tracks only the filtered challenge', async () => {
        enableSetting();
        const first = withEntries(['a', 'b']);
        const second = makeChallenge({
            id: 202,
            member: {
                boost: { state: 'LOCKED', timeout: 0 },
                ranking: { entries: [{ id: 'x' }], exposure: { exposure_factor: 100 } },
            },
        });
        const tracker = makeTracker({ 101: ['a'], 202: ['x'] });

        await runVotingPass('tok', 101, deps(makeApi([first, second]), { entryTracker: tracker }));

        expect(tracker.set).toHaveBeenCalledTimes(1);
        expect(tracker.set).toHaveBeenCalledWith('101', ['a', 'b']);
    });

    test('a per-challenge override behaves the same as the global default', async () => {
        // The gate reads the EFFECTIVE value, so an override flip must be equivalent.
        const tracker = makeTracker({ 101: ['a'] });
        settings.getEffectiveSetting.mockImplementation((key, challengeId) =>
            key === 'voteOnNewEntry' ? challengeId === '101' : false,
        );

        await runVotingPass('tok', null, deps(makeApi([withEntries(['a', 'b'])]), { entryTracker: tracker }));

        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('voteOnNewEntry', '101');
        expect(lastDecisionOptions()).toEqual({ hasNewEntry: true });
    });
});

describe('per-challenge clock', () => {
    // `now` used to be captured once, before the loop, and reused for every challenge's
    // deadline actions and voting decision. A pass can run for minutes (2-5s inter-challenge
    // delay, retries, paginated library walks), so every challenge after the first was judged
    // against a clock stuck in the past — missing windows that opened mid-pass.
    test('re-reads the clock for each challenge instead of freezing it for the pass', async () => {
        const api = makeApi([makeChallenge({ id: 1 }), makeChallenge({ id: 2 })]);
        const base = Date.now();
        let tick = 0;
        const spy = jest.spyOn(Date, 'now').mockImplementation(() => base + tick++ * 60_000);

        await runVotingPass('tok', null, deps(api));

        const observed = votingLogic.evaluateVotingDecision.mock.calls.map((call) => call[1]);
        expect(observed).toHaveLength(2);
        expect(observed[1]).toBeGreaterThan(observed[0]);

        spy.mockRestore();
    });
});
