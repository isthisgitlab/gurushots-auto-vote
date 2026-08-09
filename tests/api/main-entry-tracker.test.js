/**
 * Binder wiring test for the voteOnNewEntry entry tracker in src/js/api/main.js.
 *
 * The mock fork of this loop once silently lost auto-fill, emergency fill and
 * turbo-earn wiring, which is the documented reason the shared orchestrator
 * exists — and why the mock binder's `cleanupStaleMetadata: null` is pinned by a
 * test of its own. The entry tracker splits the same way (metadata-backed in real
 * mode, in-memory in mock), so both halves get pinned. This file is the real half;
 * tests/mock/index.test.js holds the mock half.
 */

jest.mock('../../src/js/api/challenges', () => ({ getActiveChallenges: jest.fn() }));
jest.mock('../../src/js/api/voting', () => ({ getVoteImages: jest.fn(), submitVotes: jest.fn() }));
jest.mock('../../src/js/api/boost', () => ({ applyBoost: jest.fn(), applyBoostToEntry: jest.fn() }));
jest.mock('../../src/js/api/turbo', () => ({
    getChallengeTurbo: jest.fn(),
    submitTurboSelection: jest.fn(),
    applyTurbo: jest.fn(),
    TURBO_SELECTION_DELAY_MS: 0,
}));
jest.mock('../../src/js/api/submissions', () => ({ getEligiblePhotos: jest.fn(), submitToChallenge: jest.fn() }));
jest.mock('../../src/js/metadata', () => ({
    cleanupStaleMetadata: jest.fn(() => true),
    getChallengeEntryIds: jest.fn(() => null),
    setChallengeEntryIds: jest.fn(() => true),
}));
jest.mock('../../src/js/services/VotingLogic', () => ({
    shouldApplyBoost: jest.fn(() => false),
    getEffectiveBoostTime: jest.fn(() => 3600),
    shouldPlayAutoTurbo: jest.fn(() => false),
    shouldApplyTurbo: jest.fn(() => ({ apply: false, imageId: null, fillNew: false, reason: 'noop' })),
    evaluateVotingDecision: jest.fn(() => ({ shouldVote: false, voteReason: 'skip', targetExposure: 100 })),
    orderDeadlineActions: jest.fn(() => []),
}));
jest.mock('../../src/js/services/autoFill', () => ({
    maybeAutoFillChallenge: jest.fn(async () => 'skipped'),
    maybeEmergencyFillChallenge: jest.fn(async () => 'skipped'),
    submitNewEntryForAction: jest.fn(async () => ({ ok: false, reason: 'none' })),
    reflectNewEntry: jest.fn(),
}));
jest.mock('../../src/js/settings', () => ({ getEffectiveSetting: jest.fn(() => false) }));

const { getActiveChallenges } = require('../../src/js/api/challenges');
const metadata = require('../../src/js/metadata');
const settings = require('../../src/js/settings');
const votingLogic = require('../../src/js/services/VotingLogic');
const { fetchChallengesAndVote } = require('../../src/js/api/main');
const { buildChallenge } = require('../helpers/challengeFixtures');

const NOW = Math.floor(Date.now() / 1000);

const challengeWith = (entryIds) =>
    buildChallenge({
        id: 5150,
        title: 'Real Binder',
        close_time: NOW + 3600,
        member: {
            boost: { state: 'LOCKED', timeout: 0 },
            ranking: { entries: entryIds.map((id) => ({ id })), exposure: { exposure_factor: 100 } },
        },
    });

beforeEach(() => {
    jest.clearAllMocks();
    settings.getEffectiveSetting.mockImplementation(() => false);
    getActiveChallenges.mockResolvedValue({ challenges: [challengeWith(['a'])] });
});

describe('api/main binder — entry tracker', () => {
    test('reads and writes snapshots through metadata.json when the setting is on', () => {
        settings.getEffectiveSetting.mockImplementation((key) => key === 'voteOnNewEntry');

        return fetchChallengesAndVote('tok').then((result) => {
            expect(result.success).toBe(true);
            expect(metadata.getChallengeEntryIds).toHaveBeenCalledWith('5150');
            expect(metadata.setChallengeEntryIds).toHaveBeenCalledWith('5150', ['a']);
        });
    });

    test('a stored snapshot missing an entry forces the vote', async () => {
        settings.getEffectiveSetting.mockImplementation((key) => key === 'voteOnNewEntry');
        metadata.getChallengeEntryIds.mockReturnValue([]);
        getActiveChallenges.mockResolvedValue({ challenges: [challengeWith(['a'])] });

        await fetchChallengesAndVote('tok');

        expect(votingLogic.evaluateVotingDecision).toHaveBeenCalledWith(expect.anything(), expect.any(Number), {
            hasNewEntry: true,
        });
    });

    test('touches metadata for snapshots only when the setting is on', async () => {
        await fetchChallengesAndVote('tok');

        expect(metadata.getChallengeEntryIds).not.toHaveBeenCalled();
        expect(metadata.setChallengeEntryIds).not.toHaveBeenCalled();
        // The pre-existing stale-metadata cleanup is unrelated and still runs.
        expect(metadata.cleanupStaleMetadata).toHaveBeenCalled();
    });
});
