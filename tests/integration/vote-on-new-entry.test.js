/**
 * End-to-end integration for the `voteOnNewEntry` feature.
 *
 * The unit suites each mock the layer below them — tests/services/voteOnNewEntry
 * mocks settings, and tests/services/votingOrchestrator mocks VotingLogic — so the
 * seam where the REAL orchestrator, the REAL rule engine and the REAL tracker meet
 * is only covered here. That seam is where the feature would silently die: the
 * orchestrator has to pass `hasNewEntry` in the exact shape the rule engine reads,
 * and hand `forcedByNewEntry` back out in the shape the retry rule reads.
 *
 * Only `settings` (to drive the gate) and the API endpoints are stubbed.
 */

jest.mock('../../src/js/settings');

const settings = require('../../src/js/settings');
const { runVotingPass } = require('../../src/js/services/votingOrchestrator');
const { createMemoryEntryTracker } = require('../../src/js/services/newEntryTracker');
const { buildChallenge } = require('../helpers/challengeFixtures');

const NOW = Math.floor(Date.now() / 1000);

/** Exposure sits ABOVE the trigger, so only a new entry can produce a vote. */
const challengeWith = (entryIds) =>
    buildChallenge({
        id: 4242,
        title: 'Integration Challenge',
        type: 'regular',
        start_time: NOW - 3600,
        close_time: NOW + 7200,
        max_photo_submits: 4,
        member: {
            boost: { state: 'LOCKED', timeout: 0 },
            turbo: { state: 'NONE' },
            ranking: { entries: entryIds.map((id) => ({ id })), exposure: { exposure_factor: 100 } },
        },
    });

const makeApi = (challenge) => ({
    getActiveChallenges: jest.fn(async () => ({ challenges: [challenge] })),
    getVoteImages: jest.fn(async () => ({ images: [{ id: 'i1' }] })),
    submitVotes: jest.fn(async () => ({ success: true })),
    applyBoost: jest.fn(async () => ({ success: true })),
    applyBoostToEntry: jest.fn(async () => ({ success: true })),
    applyTurbo: jest.fn(async () => ({ ok: true })),
    getEligiblePhotos: jest.fn(async () => []),
    submitToChallenge: jest.fn(async () => ({ ok: true })),
    runTurboMiniGame: jest.fn(async () => ({ played: 0, correct: 0, flipped: 0, doubleFailed: 0, won: false })),
});

const SETTING_DEFAULTS = {
    voteOnNewEntry: true,
    onlyBoost: false,
    voteOnlyInLastMinute: false,
    exposure: 90,
    exposureTarget: 0,
    lastMinuteThreshold: 10,
    lastHourExposure: 40,
    lastHourExposureTarget: 0,
    useLastHourExposure: false,
    useScheduledFill: false,
    scheduledFillReplaces: false,
    scheduledFillTime: '',
    scheduledFillBeforeEnd: 0,
    scheduledFillWindowMinutes: 60,
    autoFill: false,
    emergencyFill: 0,
    autoBoost: false,
    useTurbo: false,
    autoTurbo: false,
    boostFillNew: false,
    turboFillNew: false,
    boostTime: 3600,
    turboTime: 3600,
    timezone: 'UTC',
};

const mockSettings = (overrides = {}) => {
    settings.getEffectiveSetting = jest.fn((key) => ({ ...SETTING_DEFAULTS, ...overrides })[key]);
};

const deps = (api, entryTracker) => ({
    api,
    cleanupStaleMetadata: null,
    interChallengeDelay: () => 0,
    entryTracker,
});

beforeEach(() => {
    jest.clearAllMocks();
    mockSettings();
});

describe('voteOnNewEntry end-to-end through the real rule engine', () => {
    test('first pass baselines silently, second pass votes once on the new entry', async () => {
        const tracker = createMemoryEntryTracker();

        // Pass 1: exposure 100% is above the 90% trigger, and there is no baseline,
        // so nothing should vote.
        const first = makeApi(challengeWith(['a']));
        await runVotingPass('tok', null, deps(first, tracker));
        expect(first.submitVotes).not.toHaveBeenCalled();

        // Pass 2: a second entry appeared. Exposure still reads 100%, so ONLY the
        // new-entry rule can produce this vote.
        const second = makeApi(challengeWith(['a', 'b']));
        await runVotingPass('tok', null, deps(second, tracker));
        expect(second.submitVotes).toHaveBeenCalledTimes(1);
        // Sentinel exposureTarget 0 resolves to the exposure trigger.
        expect(second.submitVotes).toHaveBeenCalledWith(expect.anything(), 'tok', 90);

        // Pass 3: nothing new — quiet again.
        const third = makeApi(challengeWith(['a', 'b']));
        await runVotingPass('tok', null, deps(third, tracker));
        expect(third.submitVotes).not.toHaveBeenCalled();
    });

    test('an explicit exposureTarget becomes the forced ceiling', async () => {
        mockSettings({ exposureTarget: 100 });
        const tracker = createMemoryEntryTracker();

        await runVotingPass('tok', null, deps(makeApi(challengeWith(['a'])), tracker));
        const api = makeApi(challengeWith(['a', 'b']));
        await runVotingPass('tok', null, deps(api, tracker));

        expect(api.submitVotes).toHaveBeenCalledWith(expect.anything(), 'tok', 100);
    });

    test('a failed forced vote is retried on the following pass', async () => {
        const tracker = createMemoryEntryTracker();
        await runVotingPass('tok', null, deps(makeApi(challengeWith(['a'])), tracker));

        const failing = makeApi(challengeWith(['a', 'b']));
        failing.submitVotes.mockRejectedValue(new Error('offline'));
        await runVotingPass('tok', null, deps(failing, tracker));
        expect(failing.submitVotes).toHaveBeenCalledTimes(1);

        // Same entries, no new photo — but the trigger is still armed.
        const retry = makeApi(challengeWith(['a', 'b']));
        await runVotingPass('tok', null, deps(retry, tracker));
        expect(retry.submitVotes).toHaveBeenCalledTimes(1);

        // ...and now it is disarmed.
        const quiet = makeApi(challengeWith(['a', 'b']));
        await runVotingPass('tok', null, deps(quiet, tracker));
        expect(quiet.submitVotes).not.toHaveBeenCalled();
    });

    test('the setting off means a new entry changes nothing', async () => {
        mockSettings({ voteOnNewEntry: false });
        const tracker = createMemoryEntryTracker();

        await runVotingPass('tok', null, deps(makeApi(challengeWith(['a'])), tracker));
        const api = makeApi(challengeWith(['a', 'b']));
        await runVotingPass('tok', null, deps(api, tracker));

        expect(api.submitVotes).not.toHaveBeenCalled();
    });

    test('onlyBoost still blocks, and consumes the trigger', async () => {
        const tracker = createMemoryEntryTracker();
        await runVotingPass('tok', null, deps(makeApi(challengeWith(['a'])), tracker));

        mockSettings({ onlyBoost: true });
        const blocked = makeApi(challengeWith(['a', 'b']));
        await runVotingPass('tok', null, deps(blocked, tracker));
        expect(blocked.submitVotes).not.toHaveBeenCalled();

        // Trigger consumed: turning onlyBoost back off does not produce a late vote.
        mockSettings({ onlyBoost: false });
        const after = makeApi(challengeWith(['a', 'b']));
        await runVotingPass('tok', null, deps(after, tracker));
        expect(after.submitVotes).not.toHaveBeenCalled();
    });
});
