/**
 * The deadline runners and the pass's record of what was done (votingOrchestrator/actionRunners.ts): a Boost, Turbo or submit a
 * scenario action already did for the challenge this cycle is not done again by the normal automation, what the normal
 * runners do is recorded, and `runDeadlineOperation` runs one of them once for the `runAutomation` scenario action. The
 * runners themselves are stubbed: only which of them run, and what is recorded, is asserted.
 */

jest.mock('../../src/ts/core/logger', () => {
    const category = {
        info: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        success: jest.fn(),
        endOperation: jest.fn(),
    };
    return {
        withCategory: jest.fn(() => category),
        challengeTag: jest.fn((c: { id?: string | number } | null | undefined) => `[${c?.id}]`),
    };
});
jest.mock('../../src/ts/core/services/VotingLogic', () => ({
    orderDeadlineActions: jest.fn(),
    describeDeadlineActions: jest.fn(() => ({ boostPinSubmits: false })),
}));
jest.mock('../../src/ts/core/services/votingOrchestrator/boost', () => ({ runBoost: jest.fn() }));
jest.mock('../../src/ts/core/services/votingOrchestrator/turbo', () => ({ runTurboApply: jest.fn() }));
jest.mock('../../src/ts/core/services/votingOrchestrator/boostPinSubmit', () => ({
    submitBoostPinnedPhoto: jest.fn(),
}));
jest.mock('../../src/ts/core/services/autoFill', () => ({
    resolveAutoSubmitDue: jest.fn(() => ({ due: false })),
    createFinalEligibility: jest.fn(),
    maybeAutoFillChallenge: jest.fn(async () => 'skipped'),
    maybeEmergencyFillChallenge: jest.fn(async () => 'skipped'),
    getSlotsRemaining: jest.fn(),
}));
jest.mock('../../src/ts/core/voting/cancellation', () => ({ isCancelled: jest.fn(() => false) }));

import votingLogicModule = require('../../src/ts/core/services/VotingLogic');
import boostModule = require('../../src/ts/core/services/votingOrchestrator/boost');
import turboModule = require('../../src/ts/core/services/votingOrchestrator/turbo');
import pinSubmitModule = require('../../src/ts/core/services/votingOrchestrator/boostPinSubmit');
import autoFillModule = require('../../src/ts/core/services/autoFill');
import cancellationModule = require('../../src/ts/core/voting/cancellation');
import type * as actionRunnersModule from '../../src/ts/core/services/votingOrchestrator/actionRunners';
import type { Challenge } from '../../src/ts/core/types/gurushots';
import type { PassContext } from '../../src/ts/core/services/votingOrchestrator/context';
import { createOperationRecord } from '../../src/ts/core/scenarios/runtime';
import { invalid } from '../helpers/invalid';

const votingLogic = jest.mocked(votingLogicModule);
const { runBoost } = jest.mocked(boostModule);
const { runTurboApply } = jest.mocked(turboModule);
const { submitBoostPinnedPhoto } = jest.mocked(pinSubmitModule);
const autoFill = jest.mocked(autoFillModule);
const cancellation = jest.mocked(cancellationModule);
const { runDeadlineActions, runDeadlineOperation } =
    require('../../src/ts/core/services/votingOrchestrator/actionRunners') as typeof actionRunnersModule;

const NOW = Math.floor(Date.now() / 1000);
const challenge = invalid<Challenge>({ id: 7, title: 'Spring', close_time: NOW + 600 });

let operations: ReturnType<typeof createOperationRecord>;
const passOf = (record: typeof operations | undefined = operations) =>
    invalid<PassContext>({
        token: 'tok',
        api: {},
        fillDeps: {},
        entryAges: null,
        missions: null,
        allChallenges: [challenge],
        ...(record ? { operations: record } : {}),
    });
const order = (...actions: string[]) =>
    votingLogic.orderDeadlineActions.mockReturnValue(invalid(actions.map((action) => ({ action }))));

beforeEach(() => {
    jest.clearAllMocks();
    operations = createOperationRecord();
    cancellation.isCancelled.mockReturnValue(false);
    runBoost.mockResolvedValue(false);
    runTurboApply.mockResolvedValue(false);
    autoFill.maybeAutoFillChallenge.mockResolvedValue('skipped');
    autoFill.maybeEmergencyFillChallenge.mockResolvedValue('skipped');
    autoFill.resolveAutoSubmitDue.mockReturnValue(invalid({ due: false }));
    votingLogic.describeDeadlineActions.mockReturnValue(invalid({ boostPinSubmits: false }));
});

describe('what the normal deadline runners do is recorded', () => {
    test('a boost, a turbo and a submit that were done are recorded for the challenge', async () => {
        order('boost', 'autoSubmit', 'turbo');
        runBoost.mockResolvedValue(true);
        runTurboApply.mockResolvedValue(true);
        autoFill.maybeAutoFillChallenge.mockResolvedValue('submitted');
        await expect(runDeadlineActions(challenge, NOW, passOf())).resolves.toBeNull();
        expect(['boost', 'turbo', 'submit'].map((kind) => operations.has(kind as 'boost', '7'))).toEqual([
            true,
            true,
            true,
        ]);
        expect(operations.has('boost', '8')).toBe(false);
    });

    test('a runner that did nothing records nothing', async () => {
        order('boost', 'turbo', 'autoSubmit', 'emergencySubmit');
        await runDeadlineActions(challenge, NOW, passOf());
        expect(['boost', 'turbo', 'submit'].some((kind) => operations.has(kind as 'boost', '7'))).toBe(false);
    });

    test('the Auto-Submit does not hold the Emergency Submit back: one record is read before either runs', async () => {
        order('autoSubmit', 'emergencySubmit');
        autoFill.maybeAutoFillChallenge.mockResolvedValue('submitted');
        autoFill.maybeEmergencyFillChallenge.mockResolvedValue('submitted');
        await runDeadlineActions(challenge, NOW, passOf());
        expect(autoFill.maybeAutoFillChallenge).toHaveBeenCalledTimes(1);
        expect(autoFill.maybeEmergencyFillChallenge).toHaveBeenCalledTimes(1);
        expect(operations.has('submit', '7')).toBe(true);
    });

    test('the photo pinned for Boost, submitted at Auto-Submit time, is a submit too', async () => {
        order('autoSubmit');
        autoFill.resolveAutoSubmitDue.mockReturnValue(invalid({ due: true, authorization: 'a' }));
        votingLogic.describeDeadlineActions.mockReturnValue(invalid({ boostPinSubmits: true }));
        submitBoostPinnedPhoto.mockResolvedValue(invalid({ kind: 'submitted', target: { imageId: 'p' } }));
        await runDeadlineActions(challenge, NOW, passOf());
        expect(autoFill.maybeAutoFillChallenge).not.toHaveBeenCalled();
        expect(operations.has('submit', '7')).toBe(true);
    });

    test('a pass with no record runs the same runners', async () => {
        order('boost', 'turbo');
        runBoost.mockResolvedValue(true);
        await expect(runDeadlineActions(challenge, NOW, passOf(undefined))).resolves.toBeNull();
        expect(runBoost).toHaveBeenCalledTimes(1);
        expect(runTurboApply).toHaveBeenCalledTimes(1);
    });
});

describe('what a scenario already did is not done again', () => {
    test('a boost, a turbo and a submit recorded for the challenge run none of their runners', async () => {
        order('boost', 'autoSubmit', 'turbo', 'emergencySubmit');
        operations.mark('boost', '7');
        operations.mark('turbo', '7');
        operations.mark('submit', '7');
        await expect(runDeadlineActions(challenge, NOW, passOf())).resolves.toBeNull();
        expect(runBoost).not.toHaveBeenCalled();
        expect(runTurboApply).not.toHaveBeenCalled();
        expect(autoFill.maybeAutoFillChallenge).not.toHaveBeenCalled();
        expect(autoFill.maybeEmergencyFillChallenge).not.toHaveBeenCalled();
    });

    test('each kind is held back on its own, and another challenge’s record holds nothing back', async () => {
        order('boost', 'turbo', 'autoSubmit');
        operations.mark('boost', '7');
        operations.mark('turbo', '8');
        await runDeadlineActions(challenge, NOW, passOf());
        expect(runBoost).not.toHaveBeenCalled();
        expect(runTurboApply).toHaveBeenCalledTimes(1);
        expect(autoFill.maybeAutoFillChallenge).toHaveBeenCalledTimes(1);
    });
});

describe('the loop itself', () => {
    test('an action no runner is registered for is passed over', async () => {
        order('mystery', 'boost');
        await expect(runDeadlineActions(challenge, NOW, passOf())).resolves.toBeNull();
        expect(runBoost).toHaveBeenCalledTimes(1);
    });

    test('a cancelled pass stops between actions', async () => {
        order('boost', 'turbo');
        cancellation.isCancelled.mockReturnValue(true);
        const result = await runDeadlineActions(challenge, NOW, passOf());
        expect(result).toMatchObject({ success: false, message: 'Voting cancelled by user' });
        expect(runBoost).not.toHaveBeenCalled();
    });
});

describe('one operation, run once for a scenario action', () => {
    test('boost and turbo answer whether the runner did them', async () => {
        runBoost.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        await expect(runDeadlineOperation('boost', challenge, NOW, passOf())).resolves.toBe(true);
        await expect(runDeadlineOperation('boost', challenge, NOW, passOf())).resolves.toBe(false);
        runTurboApply.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
        await expect(runDeadlineOperation('turbo', challenge, NOW, passOf())).resolves.toBe(true);
        await expect(runDeadlineOperation('turbo', challenge, NOW, passOf())).resolves.toBe(false);
        expect(runBoost).toHaveBeenCalledWith(expect.objectContaining({ challenge, token: 'tok', now: NOW }));
    });

    test('submit is the Auto-Submit, then the Emergency Submit net, and stops at the first that submitted', async () => {
        autoFill.maybeAutoFillChallenge.mockResolvedValue('submitted');
        await expect(runDeadlineOperation('submit', challenge, NOW, passOf())).resolves.toBe(true);
        expect(autoFill.maybeEmergencyFillChallenge).not.toHaveBeenCalled();

        autoFill.maybeAutoFillChallenge.mockResolvedValue('skipped');
        autoFill.maybeEmergencyFillChallenge.mockResolvedValue('submitted');
        await expect(runDeadlineOperation('submit', challenge, NOW, passOf())).resolves.toBe(true);

        autoFill.maybeEmergencyFillChallenge.mockResolvedValue('skipped');
        await expect(runDeadlineOperation('submit', challenge, NOW, passOf())).resolves.toBe(false);
    });
});
