/**
 * Orchestration tests for the "fill-new" boost/turbo options in
 * fetchChallengesAndVote (src/js/strategies/real/index.js).
 *
 * These verify the wiring only — that when boostFillNew/turboFillNew is on the
 * cycle submits a fresh entry via autoFill.submitNewEntryForAction and then
 * boosts/turbos THAT id, and that it falls back to the existing-entry path when
 * a fresh photo can't be submitted. The picker/submit internals and the turbo
 * decision gates are covered by autoFill.test.js and turboApply.test.js.
 */

jest.mock('../../src/js/strategies/real/activeChallenges', () => ({ getActiveChallenges: jest.fn() }));
jest.mock('../../src/js/api/voting', () => ({ getVoteImages: jest.fn(), submitVotes: jest.fn() }));
jest.mock('../../src/js/strategies/real/applyBoost', () => ({ applyBoost: jest.fn() }));
jest.mock('../../src/js/api/boost', () => ({ applyBoostToEntry: jest.fn() }));
jest.mock('../../src/js/api/turbo', () => ({
    getChallengeTurbo: jest.fn(),
    submitTurboSelection: jest.fn(),
    applyTurbo: jest.fn(),
    TURBO_SELECTION_DELAY_MS: 0,
}));
jest.mock('../../src/js/api/submissions', () => ({ getEligiblePhotos: jest.fn(), submitToChallenge: jest.fn() }));
jest.mock('../../src/js/metadata', () => ({ cleanupStaleMetadata: jest.fn(() => true) }));
// Default order runs all four deadline actions so the boost/turbo wiring tests
// below exercise their runners regardless of timer values. Ordering-specific
// tests override orderDeadlineActions per case.
const ALL_ACTIONS = [
    { action: 'boost', thresholdSec: 0 },
    { action: 'autoFill', thresholdSec: 0 },
    { action: 'turbo', thresholdSec: 0 },
    { action: 'emergencyFill', thresholdSec: 0 },
];
jest.mock('../../src/js/services/VotingLogic', () => ({
    shouldApplyBoost: jest.fn(() => false),
    getEffectiveBoostTime: jest.fn(() => 3600),
    resolveBoostFillNewMode: jest.fn(() => 'no'),
    shouldPlayAutoTurbo: jest.fn(() => false),
    shouldApplyTurbo: jest.fn(() => ({ apply: false, imageId: null, fillNew: false, reason: 'noop' })),
    evaluateVotingDecision: jest.fn(() => ({ shouldVote: false })),
    orderDeadlineActions: jest.fn(() => [
        { action: 'boost', thresholdSec: 0 },
        { action: 'autoFill', thresholdSec: 0 },
        { action: 'turbo', thresholdSec: 0 },
        { action: 'emergencyFill', thresholdSec: 0 },
    ]),
}));
jest.mock('../../src/js/services/autoFill', () => ({
    submitNewEntryForAction: jest.fn(),
    reflectNewEntry: jest.fn(),
    maybeAutoFillChallenge: jest.fn(() => 'disabled'),
    maybeEmergencyFillChallenge: jest.fn(() => 'disabled'),
}));
jest.mock('../../src/js/settings', () => ({ getEffectiveSetting: jest.fn(() => undefined) }));
jest.mock('../../src/js/logger', () => {
    const scoped = {
        startOperation: jest.fn(),
        endOperation: jest.fn(),
        progress: jest.fn(),
        info: jest.fn(),
        warning: jest.fn(),
        success: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    };
    return { withCategory: jest.fn(() => scoped), challengeTag: jest.fn(() => '[challenge]') };
});

const { getActiveChallenges } = require('../../src/js/strategies/real/activeChallenges');
const { applyBoost } = require('../../src/js/strategies/real/applyBoost');
const { applyBoostToEntry } = require('../../src/js/api/boost');
const { applyTurbo } = require('../../src/js/api/turbo');
const votingLogic = require('../../src/js/services/VotingLogic');
const autoFill = require('../../src/js/services/autoFill');
const settings = require('../../src/js/settings');
const { fetchChallengesAndVote } = require('../../src/js/strategies/real');
const { buildChallenge } = require('../helpers/challengeFixtures');

const NOW = () => Math.floor(Date.now() / 1000);
const TOKEN = 'tok';

const makeChallenge = ({ boostState = 'LOCKED', boostTimeout = 0, entries = [{ id: 'existing-1' }] } = {}) =>
    buildChallenge({
        id: '12345',
        title: 'Fill New Challenge',
        close_time: NOW() + 600,
        member: {
            boost: { state: boostState, timeout: boostTimeout },
            ranking: { entries },
        },
    });

beforeEach(() => {
    jest.clearAllMocks();
    settings.getEffectiveSetting.mockReturnValue(undefined);
    votingLogic.shouldApplyBoost.mockReturnValue(false);
    votingLogic.shouldPlayAutoTurbo.mockReturnValue(false);
    votingLogic.shouldApplyTurbo.mockReturnValue({ apply: false, imageId: null, fillNew: false, reason: 'noop' });
    votingLogic.evaluateVotingDecision.mockReturnValue({ shouldVote: false });
    votingLogic.orderDeadlineActions.mockReturnValue(ALL_ACTIONS);
    votingLogic.resolveBoostFillNewMode.mockReturnValue('no');
});

describe('fetchChallengesAndVote — boost fill-new', () => {
    // `mode` mirrors votingLogic.resolveBoostFillNewMode's result: 'always'
    // (boostFillNew), 'conflict' (boostFillNewOnConflict + sole entry turboed),
    // or 'no'. VotingLogic is mocked here, so drive the resolved mode directly.
    const setup = ({ mode }) => {
        const challenge = makeChallenge({ boostState: 'AVAILABLE', boostTimeout: NOW() + 120 });
        getActiveChallenges.mockResolvedValue({ challenges: [challenge] });
        votingLogic.shouldApplyBoost.mockReturnValue(true);
        votingLogic.resolveBoostFillNewMode.mockReturnValue(mode);
        return challenge;
    };

    test('submits a fresh photo and boosts that id', async () => {
        setup({ mode: 'always' });
        autoFill.submitNewEntryForAction.mockResolvedValue({ ok: true, imageId: 'fresh-99', reason: 'submitted' });
        applyBoostToEntry.mockResolvedValue({ success: true });

        await fetchChallengesAndVote(TOKEN);

        expect(autoFill.submitNewEntryForAction).toHaveBeenCalledTimes(1);
        expect(applyBoostToEntry).toHaveBeenCalledWith('12345', 'fresh-99', TOKEN);
        expect(applyBoost).not.toHaveBeenCalled();
    });

    test('falls back to applyBoost when a fresh photo cannot be submitted (always mode)', async () => {
        setup({ mode: 'always' });
        autoFill.submitNewEntryForAction.mockResolvedValue({ ok: false, imageId: null, reason: 'no-slots' });
        applyBoost.mockResolvedValue({ success: true });

        await fetchChallengesAndVote(TOKEN);

        expect(autoFill.submitNewEntryForAction).toHaveBeenCalledTimes(1);
        expect(applyBoost).toHaveBeenCalledTimes(1);
        expect(applyBoostToEntry).not.toHaveBeenCalled();
    });

    test('uses the existing-entry path when fill-new is off', async () => {
        setup({ mode: 'no' });
        applyBoost.mockResolvedValue({ success: true });

        await fetchChallengesAndVote(TOKEN);

        expect(autoFill.submitNewEntryForAction).not.toHaveBeenCalled();
        expect(applyBoost).toHaveBeenCalledTimes(1);
        expect(applyBoostToEntry).not.toHaveBeenCalled();
    });

    test('submits a fresh photo and boosts it in conflict mode', async () => {
        setup({ mode: 'conflict' });
        autoFill.submitNewEntryForAction.mockResolvedValue({ ok: true, imageId: 'fresh-c1', reason: 'submitted' });
        applyBoostToEntry.mockResolvedValue({ success: true });

        await fetchChallengesAndVote(TOKEN);

        expect(autoFill.submitNewEntryForAction).toHaveBeenCalledTimes(1);
        expect(applyBoostToEntry).toHaveBeenCalledWith('12345', 'fresh-c1', TOKEN);
        expect(applyBoost).not.toHaveBeenCalled();
    });

    test('does NOT fall back to applyBoost in conflict mode when the fresh photo fails', async () => {
        // The sole existing entry is turboed, so applyBoost would just fail with
        // "only entry already has Turbo" — conflict mode skips it entirely.
        setup({ mode: 'conflict' });
        autoFill.submitNewEntryForAction.mockResolvedValue({ ok: false, imageId: null, reason: 'no-slots' });

        await fetchChallengesAndVote(TOKEN);

        expect(autoFill.submitNewEntryForAction).toHaveBeenCalledTimes(1);
        expect(applyBoost).not.toHaveBeenCalled();
        expect(applyBoostToEntry).not.toHaveBeenCalled();
    });

    test('skips (no applyBoost) in conflict mode when the challenge left the active list', async () => {
        setup({ mode: 'conflict' });
        autoFill.submitNewEntryForAction.mockResolvedValue({ ok: false, imageId: null, reason: 'challenge-gone' });

        await fetchChallengesAndVote(TOKEN);

        expect(applyBoost).not.toHaveBeenCalled();
        expect(applyBoostToEntry).not.toHaveBeenCalled();
    });
});

describe('fetchChallengesAndVote — turbo fill-new', () => {
    test('submits a fresh photo and turbos that id', async () => {
        getActiveChallenges.mockResolvedValue({ challenges: [makeChallenge()] });
        votingLogic.shouldApplyTurbo.mockReturnValue({ apply: true, imageId: null, fillNew: true, reason: 'fill-new' });
        autoFill.submitNewEntryForAction.mockResolvedValue({ ok: true, imageId: 'fresh-turbo', reason: 'submitted' });
        applyTurbo.mockResolvedValue({ ok: true });

        await fetchChallengesAndVote(TOKEN);

        expect(autoFill.submitNewEntryForAction).toHaveBeenCalledTimes(1);
        expect(applyTurbo).toHaveBeenCalledWith('12345', 'fresh-turbo', TOKEN);
    });

    test('falls back to the existing entry id when a fresh photo cannot be submitted', async () => {
        getActiveChallenges.mockResolvedValue({ challenges: [makeChallenge()] });
        votingLogic.shouldApplyTurbo.mockReturnValue({
            apply: true,
            imageId: 'existing-1',
            fillNew: true,
            reason: 'fill-new',
        });
        autoFill.submitNewEntryForAction.mockResolvedValue({ ok: false, imageId: null, reason: 'no-eligible' });
        applyTurbo.mockResolvedValue({ ok: true });

        await fetchChallengesAndVote(TOKEN);

        expect(applyTurbo).toHaveBeenCalledWith('12345', 'existing-1', TOKEN);
    });

    test('skips turbo when fill-new cannot submit and there is no existing entry', async () => {
        getActiveChallenges.mockResolvedValue({ challenges: [makeChallenge()] });
        votingLogic.shouldApplyTurbo.mockReturnValue({ apply: true, imageId: null, fillNew: true, reason: 'fill-new' });
        autoFill.submitNewEntryForAction.mockResolvedValue({ ok: false, imageId: null, reason: 'no-slots' });

        await fetchChallengesAndVote(TOKEN);

        expect(applyTurbo).not.toHaveBeenCalled();
    });
});

describe('fetchChallengesAndVote — timer-ordered actions', () => {
    test('runs auto-fill before turbo when orderDeadlineActions ranks auto-fill first', async () => {
        getActiveChallenges.mockResolvedValue({ challenges: [makeChallenge()] });
        votingLogic.orderDeadlineActions.mockReturnValue([
            { action: 'autoFill', thresholdSec: 900 },
            { action: 'turbo', thresholdSec: 720 },
            { action: 'emergencyFill', thresholdSec: 300 },
            { action: 'boost', thresholdSec: -Infinity },
        ]);
        votingLogic.shouldApplyTurbo.mockReturnValue({
            apply: true,
            imageId: 'existing-1',
            fillNew: false,
            reason: 'eligible',
        });
        applyTurbo.mockResolvedValue({ ok: true });

        await fetchChallengesAndVote(TOKEN);

        expect(autoFill.maybeAutoFillChallenge).toHaveBeenCalled();
        expect(applyTurbo).toHaveBeenCalledWith('12345', 'existing-1', TOKEN);
        // votingOrchestrator dispatches in the order orderDeadlineActions returns.
        expect(autoFill.maybeAutoFillChallenge.mock.invocationCallOrder[0]).toBeLessThan(
            applyTurbo.mock.invocationCallOrder[0],
        );
    });

    test('runs turbo before auto-fill when orderDeadlineActions ranks turbo first', async () => {
        getActiveChallenges.mockResolvedValue({ challenges: [makeChallenge()] });
        votingLogic.orderDeadlineActions.mockReturnValue([
            { action: 'turbo', thresholdSec: 1200 },
            { action: 'autoFill', thresholdSec: 900 },
            { action: 'emergencyFill', thresholdSec: 300 },
            { action: 'boost', thresholdSec: -Infinity },
        ]);
        votingLogic.shouldApplyTurbo.mockReturnValue({
            apply: true,
            imageId: 'existing-1',
            fillNew: false,
            reason: 'eligible',
        });
        applyTurbo.mockResolvedValue({ ok: true });

        await fetchChallengesAndVote(TOKEN);

        // Guard the comparison: both must have actually run, else invocationCallOrder[0]
        // is undefined and the toBeLessThan check would pass vacuously.
        expect(applyTurbo).toHaveBeenCalled();
        expect(autoFill.maybeAutoFillChallenge).toHaveBeenCalled();
        expect(applyTurbo.mock.invocationCallOrder[0]).toBeLessThan(
            autoFill.maybeAutoFillChallenge.mock.invocationCallOrder[0],
        );
    });
});
