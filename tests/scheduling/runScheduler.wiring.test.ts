/**
 * Wiring of createScheduler's Node transport into the shared cadence chain:
 * the log callbacks route to the right logger levels, start() is idempotent
 * while running, and the lifecycle accessors reflect state.
 *
 * The chain itself is stubbed here so the callbacks it would invoke can be
 * called directly; the cadence behaviour is covered in runScheduler.test.ts.
 */

jest.mock('../../src/ts/settings', () => ({
    loadSettings: jest.fn(() => ({ checkFrequencyMin: 3, checkFrequencyMax: 3 })),
    getSetting: jest.fn(() => 3),
    getEffectiveSetting: jest.fn(() => 5),
}));

jest.mock('../../src/ts/services/notify/nodeNotify', () => ({
    createNodeDeadlineNotifier: jest.fn(() => jest.fn(async () => {})),
    createNodeScenarioNotifier: jest.fn(() => jest.fn(async () => {})),
}));

let mockChainOpts: ChainOpts | null;
const mockScheduleNext = jest.fn(async () => {});
jest.mock('../../src/ts/scheduling/cadenceChain', () => {
    const actual = jest.requireActual<typeof import('../../src/ts/scheduling/cadenceChain')>(
        '../../src/ts/scheduling/cadenceChain',
    );
    return {
        ...actual,
        createCadenceChain: jest.fn((opts: ChainOpts) => {
            mockChainOpts = opts;
            return { scheduleNext: mockScheduleNext };
        }),
    };
});

import { invalid } from '../helpers/invalid';

import logger = require('../../src/ts/logger');
import settingsModule = require('../../src/ts/settings');
const settings = jest.mocked(settingsModule);
import type * as cadenceChainModule from '../../src/ts/scheduling/cadenceChain';
import type * as runSchedulerModule from '../../src/ts/scheduling/runScheduler';
const { DECISION_ERROR_MESSAGE, formatOversleptMessage } = jest.mocked(
    require('../../src/ts/scheduling/cadenceChain') as typeof cadenceChainModule,
);
const { createScheduler } = require('../../src/ts/scheduling/runScheduler') as typeof runSchedulerModule;

// What createScheduler hands the (stubbed) chain; its fetchChallenges ignores the settings argument.
type ChainOpts = Omit<Parameters<typeof cadenceChainModule.createCadenceChain>[0], 'fetchChallenges'> & {
    fetchChallenges: () => unknown;
};
type CycleResult = Awaited<ReturnType<Parameters<typeof createScheduler>[0]['runVotingCycle']>>;

const log = { info: jest.fn(), warning: jest.fn(), debug: jest.fn(), error: jest.fn(), success: jest.fn() };

beforeEach(() => {
    mockChainOpts = null;
    jest.mocked(logger.withCategory).mockImplementation(() => invalid(log));
});

const make = (cycleResult: CycleResult = invalid({ success: true, challenges: [{ id: 1 }] })) => {
    const runVotingCycle = jest.fn(async () => cycleResult);
    const getActiveChallenges = jest.fn(async () => ({ challenges: [] }));
    const scheduler = createScheduler({ runVotingCycle, getActiveChallenges });
    return { scheduler, runVotingCycle, getActiveChallenges };
};

describe('log callbacks', () => {
    test('decisionError warns with the shared message and keeps details at debug', () => {
        make();
        const err = new Error('boom');
        mockChainOpts!.log.decisionError(err);
        expect(log.warning).toHaveBeenCalledWith(DECISION_ERROR_MESSAGE);
        expect(log.debug).toHaveBeenCalledWith('scheduleNext error details:', err);
    });

    test('overslept warns with the formatted late-timer message', () => {
        make();
        mockChainOpts!.log.overslept!(600_000, 180_000);
        expect(log.warning).toHaveBeenCalledWith(formatOversleptMessage(600_000, 180_000));
    });

    test('cycleError logs an error line plus debug details', () => {
        make();
        const err = new Error('cycle');
        mockChainOpts!.log.cycleError(err);
        expect(log.error).toHaveBeenCalledWith('Error in scheduled voting cycle');
        expect(log.debug).toHaveBeenCalledWith('Full voting cycle error details:', err);
    });

    test('cadence logs the message at info', () => {
        make();
        mockChainOpts!.log.cadence('normal', 'next in 3m');
        expect(log.info).toHaveBeenCalledWith('next in 3m');
    });
});

describe('transport deps', () => {
    test('settings and fetch passthroughs, and runCycle unwraps the challenge list', async () => {
        const { runVotingCycle, getActiveChallenges } = make(invalid({ success: true, challenges: ['x'] }));
        expect(mockChainOpts!.loadSettings()).toEqual({ checkFrequencyMin: 3, checkFrequencyMax: 3 });
        await mockChainOpts!.fetchChallenges();
        expect(getActiveChallenges).toHaveBeenCalledTimes(1);
        expect(mockChainOpts!.resolveLastMinuteCheckMinutes()).toBe(5);
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('lastMinuteCheckFrequency', 'global');
        await expect(mockChainOpts!.runCycle()).resolves.toEqual(['x']);
        expect(runVotingCycle).toHaveBeenCalledWith(1);
    });

    test('a legacy boolean cycle result yields no list (forces a fresh fetch)', async () => {
        make(invalid(true));
        await expect(mockChainOpts!.runCycle()).resolves.toBeUndefined();
    });

    test('timer accessors round-trip the handle', () => {
        make();
        expect(mockChainOpts!.getTimer()).toBeNull();
        mockChainOpts!.setTimer(invalid(42));
        expect(mockChainOpts!.getTimer()).toBe(42);
    });
});

describe('lifecycle', () => {
    afterEach(() => jest.useRealTimers());

    test('start runs one initial cycle, hands its list to the chain, and is idempotent while running', async () => {
        const { scheduler, runVotingCycle } = make(invalid({ success: true, challenges: ['c'] }));
        expect(scheduler.isRunning()).toBe(false);
        expect(scheduler.getCycleCount()).toBe(0);

        await scheduler.start();
        expect(scheduler.isRunning()).toBe(true);
        expect(mockChainOpts!.isRunning()).toBe(true);
        expect(scheduler.getCycleCount()).toBe(1);
        expect(mockScheduleNext).toHaveBeenCalledWith(['c'], expect.any(Number));

        await scheduler.start(); // already running → no second cycle
        expect(runVotingCycle).toHaveBeenCalledTimes(1);
        expect(scheduler.getCycleCount()).toBe(1);
    });

    test('stop clears an armed timer and flips isRunning', async () => {
        jest.useFakeTimers();
        const { scheduler } = make();
        await scheduler.start();
        const fired = jest.fn();
        mockChainOpts!.setTimer(setTimeout(fired, 1000));

        scheduler.stop();
        expect(scheduler.isRunning()).toBe(false);
        expect(mockChainOpts!.getTimer()).toBeNull();
        jest.advanceTimersByTime(2000);
        expect(fired).not.toHaveBeenCalled();
    });
});

describe('notifications', () => {
    test('each cycle feeds both the deadline and the scenario notifier', async () => {
        const nodeNotify = jest.mocked(
            require('../../src/ts/services/notify/nodeNotify') as typeof import('../../src/ts/services/notify/nodeNotify'),
        );
        const { createScheduler } = require('../../src/ts/scheduling/runScheduler') as typeof runSchedulerModule;
        createScheduler({ runVotingCycle: jest.fn(), getActiveChallenges: jest.fn() });
        const deadlines = nodeNotify.createNodeDeadlineNotifier.mock.results.at(-1)!.value as ReturnType<
            typeof nodeNotify.createNodeDeadlineNotifier
        >;
        const scenarios = nodeNotify.createNodeScenarioNotifier.mock.results.at(-1)!.value as ReturnType<
            typeof nodeNotify.createNodeScenarioNotifier
        >;
        await mockChainOpts!.onCycleChallenges!(invalid([{ id: 1 }]), 1000);
        expect(deadlines).toHaveBeenCalledWith([{ id: 1 }], 1000);
        expect(scenarios).toHaveBeenCalledWith([{ id: 1 }]);
    });
});
