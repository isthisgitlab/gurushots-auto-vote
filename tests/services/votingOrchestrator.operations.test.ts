/**
 * The per-pass operation record in the voting pass: what a scenario action already did for a challenge in this cycle (a
 * swap, a fill, a vote) the normal automation does not do again. Every runner is stubbed, so what is asserted is only which
 * of them the pass calls.
 */

jest.mock('../../src/ts/core/settings', () => ({
    scenarioSubjectAvailable: jest.fn(() => true),
    scenarioSubjectReason: jest.fn(() => null),
    consumeChosenPhotos: jest.fn(() => false),
}));
jest.mock('../../src/ts/core/services/VotingLogic', () => ({
    evaluateVotingDecision: jest.fn(() => ({ shouldVote: true, voteReason: 'test', targetExposure: 100 })),
}));
jest.mock('../../src/ts/core/services/currencyAuto', () => ({
    runAutoKey: jest.fn(async () => false),
    runAutoSwap: jest.fn(async () => false),
    runMissionFill: jest.fn(async () => true),
    runAutoExposureFill: jest.fn(async () => true),
}));
jest.mock('../../src/ts/core/services/votingOrchestrator/actionRunners', () => ({
    runDeadlineActions: jest.fn(async () => null),
}));
jest.mock('../../src/ts/core/services/votingOrchestrator/turbo', () => ({ playAutoTurbo: jest.fn(async () => {}) }));
jest.mock('../../src/ts/core/services/votingOrchestrator/newEntries', () => ({
    detectNewEntry: jest.fn(() => ({ hasNewEntry: false })),
    recordEntrySnapshot: jest.fn(),
    describeNewEntryOutcome: jest.fn(() => ''),
}));
jest.mock('../../src/ts/core/services/votingOrchestrator/vote', () => ({
    voteOnChallenge: jest.fn(async () => ({ cancelled: null, voteThrew: false, votePool: null })),
}));
jest.mock('../../src/ts/core/services/votingOrchestrator/missionVotes', () => ({
    missionVoteDecision: jest.fn(() => null),
    planMissionVotes: jest.fn(() => 0),
    resetMissionVoteLog: jest.fn(),
}));
jest.mock('../../src/ts/core/services/votingOrchestrator/manualOnly', () => ({
    isManualOnlyFailClosed: jest.fn(() => false),
    manualOnlyOnLine: jest.fn(() => ''),
    manualOnlyState: jest.fn(() => 'off'),
    manualOnlyUnreadableLine: jest.fn(() => ''),
    pruneManualOnlyLog: jest.fn(),
    resetManualOnlyLog: jest.fn(),
    skipIfManualOnly: jest.fn(() => false),
}));
jest.mock('../../src/ts/core/voting/cancellation', () => ({ isCancelled: jest.fn(() => false) }));

import currencyAutoModule = require('../../src/ts/core/services/currencyAuto');
import voteModule = require('../../src/ts/core/services/votingOrchestrator/vote');
import type * as votingOrchestratorModule from '../../src/ts/core/services/votingOrchestrator';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { MissionNeeds } from '../../src/ts/core/services/missions';
import type { VotingPassDeps } from '../../src/ts/core/types/votingPass';
import { createOperationRecord } from '../../src/ts/core/scenarios/runtime';
import { installHeadlessTestPlatform } from '../helpers/platform';
import { invalid } from '../helpers/invalid';

const currencyAuto = jest.mocked(currencyAutoModule);
const { voteOnChallenge } = jest.mocked(voteModule);
const { runVotingPass } = require('../../src/ts/core/services/votingOrchestrator') as typeof votingOrchestratorModule;

const NOW = Math.floor(Date.now() / 1000);

const deps = (operations?: ReturnType<typeof createOperationRecord>, missions?: MissionNeeds): VotingPassDeps => ({
    api: invalid({
        getActiveChallenges: jest.fn(async () => ({
            challenges: [invalid<Challenge>({ id: 7, title: 'Spring', start_time: NOW - 100, close_time: NOW + 1000 })],
            fetchFailed: false,
        })),
    }),
    cleanupStaleMetadata: null,
    interChallengeDelay: () => 0,
    ...(operations ? { operations } : {}),
    ...(missions ? { missions } : {}),
});

beforeEach(() => {
    jest.clearAllMocks();
    installHeadlessTestPlatform();
});

describe('what the normal automation does for a challenge', () => {
    test('with nothing recorded it swaps, fills before and after the vote, and votes', async () => {
        const needs = { join: 0, fill: 1, turbo: 0, boost: 0, vote: 0 };
        await runVotingPass('tok', null, deps(undefined, needs));
        expect(currencyAuto.runAutoSwap).toHaveBeenCalledTimes(1);
        expect(currencyAuto.runMissionFill).toHaveBeenCalledTimes(1);
        expect(voteOnChallenge).toHaveBeenCalledTimes(1);
        expect(currencyAuto.runAutoExposureFill).toHaveBeenCalledTimes(1);
        // both fills landed, so the fill mission was counted down for each
        expect(needs.fill).toBe(0);
    });

    test('a swap, a fill and a vote a scenario action already did this cycle are not done again', async () => {
        const operations = createOperationRecord();
        operations.mark('swap', '7');
        operations.mark('fill', '7');
        operations.mark('vote', '7');
        const needs = { join: 0, fill: 1, turbo: 0, boost: 0, vote: 0 };
        await expect(runVotingPass('tok', null, deps(operations, needs))).resolves.toEqual(
            expect.objectContaining({ success: true }),
        );
        expect(currencyAuto.runAutoSwap).not.toHaveBeenCalled();
        expect(currencyAuto.runMissionFill).not.toHaveBeenCalled();
        expect(voteOnChallenge).not.toHaveBeenCalled();
        expect(currencyAuto.runAutoExposureFill).not.toHaveBeenCalled();
        // and no fill was counted for work that was not done here
        expect(needs.fill).toBe(1);
    });

    test('what was recorded for another challenge does not hold this one back', async () => {
        const operations = createOperationRecord();
        operations.mark('swap', '8');
        operations.mark('vote', '8');
        await runVotingPass('tok', null, deps(operations));
        expect(currencyAuto.runAutoSwap).toHaveBeenCalledTimes(1);
        expect(voteOnChallenge).toHaveBeenCalledTimes(1);
    });

    test('a pass given no record keeps its own', async () => {
        await expect(runVotingPass('tok', null, deps())).resolves.toEqual(expect.objectContaining({ success: true }));
    });
});
