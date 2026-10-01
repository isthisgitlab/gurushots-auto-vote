/**
 * Binder wiring test for the voteOnNewEntry entry tracker in src/ts/strategies/real/index.ts.
 *
 * The mock fork of this loop once silently lost auto-fill, emergency fill and
 * turbo-earn wiring, which is the documented reason the shared orchestrator
 * exists — and why the mock binder's `cleanupStaleMetadata: null` is pinned by a
 * test of its own. The entry tracker splits the same way (metadata-backed in real
 * mode, in-memory in mock), so both halves get pinned. This file is the real half;
 * tests/mock/index.test.ts holds the mock half.
 */

jest.mock('../../src/ts/strategies/real/activeChallenges', () => ({ getActiveChallenges: jest.fn() }));
jest.mock('../../src/ts/api/voting', () => ({ getVoteImages: jest.fn(), submitVotes: jest.fn() }));
jest.mock('../../src/ts/strategies/real/applyBoost', () => ({ applyBoost: jest.fn() }));
jest.mock('../../src/ts/api/boost', () => ({ applyBoostToEntry: jest.fn() }));
jest.mock('../../src/ts/api/turbo', () => ({
    getChallengeTurbo: jest.fn(),
    submitTurboSelection: jest.fn(),
    applyTurbo: jest.fn(),
    TURBO_SELECTION_DELAY_MS: 0,
}));
jest.mock('../../src/ts/api/submissions', () => ({ getEligiblePhotos: jest.fn(), submitToChallenge: jest.fn() }));
jest.mock('../../src/ts/metadata', () => ({
    cleanupStaleMetadata: jest.fn(() => true),
    getChallengeEntryIds: jest.fn(() => null),
    setChallengeEntryIds: jest.fn(() => true),
    // newEntryTracker reads its pre-persistence bounds from here; omitting them
    // would leave the caps undefined.
    MAX_TRACKED_ENTRY_IDS: 64,
    MAX_ENTRY_ID_LENGTH: 64,
}));
jest.mock('../../src/ts/services/VotingLogic', () => ({
    shouldApplyBoost: jest.fn(() => false),
    getEffectiveBoostTime: jest.fn(() => 3600),
    shouldPlayAutoTurbo: jest.fn(() => false),
    shouldApplyTurbo: jest.fn(() => ({ apply: false, imageId: null, fillNew: false, reason: 'noop' })),
    evaluateVotingDecision: jest.fn(() => ({ shouldVote: false, voteReason: 'skip', targetExposure: 100 })),
    orderDeadlineActions: jest.fn(() => []),
}));
jest.mock('../../src/ts/services/autoFill', () => ({
    maybeAutoFillChallenge: jest.fn(async () => 'skipped'),
    maybeEmergencyFillChallenge: jest.fn(async () => 'skipped'),
    submitNewEntryForAction: jest.fn(async () => ({ ok: false, reason: 'none' })),
    reflectNewEntry: jest.fn(),
}));
jest.mock('../../src/ts/settings', () => ({ getEffectiveSetting: jest.fn(() => false) }));

const { getActiveChallenges } = jest.mocked(
    require('../../src/ts/strategies/real/activeChallenges') as typeof activeChallengesModule,
);
import metadataModule = require('../../src/ts/metadata');
const metadata = jest.mocked(metadataModule);
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import votingLogicModule = require('../../src/ts/services/VotingLogic');
const votingLogic = jest.mocked(votingLogicModule);
import type * as activeChallengesModule from '../../src/ts/strategies/real/activeChallenges';
import type * as realModule from '../../src/ts/strategies/real';
import type * as challengeFixturesModule from '../helpers/challengeFixtures';
const { fetchChallengesAndVote } = require('../../src/ts/strategies/real') as typeof realModule;
const { buildChallenge } = require('../helpers/challengeFixtures') as typeof challengeFixturesModule;

const NOW = Math.floor(Date.now() / 1000);

const challengeWith = (entryIds: string[]) =>
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

describe('real strategy binder — entry tracker', () => {
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
