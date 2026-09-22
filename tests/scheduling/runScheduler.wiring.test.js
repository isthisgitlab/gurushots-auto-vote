/**
 * Wiring of createScheduler's Node transport into the shared cadence chain:
 * the log callbacks route to the right logger levels, start() is idempotent
 * while running, and the lifecycle accessors reflect state.
 *
 * The chain itself is stubbed here so the callbacks it would invoke can be
 * called directly; the cadence behaviour is covered in runScheduler.test.js.
 */

jest.mock('../../src/js/settings', () => ({
    loadSettings: jest.fn(() => ({ checkFrequencyMin: 3, checkFrequencyMax: 3 })),
    getSetting: jest.fn(() => 3),
    getEffectiveSetting: jest.fn(() => 5),
}));

jest.mock('../../src/js/services/notify/nodeNotify', () => ({
    createNodeDeadlineNotifier: jest.fn(() => jest.fn()),
}));

let mockChainOpts;
const mockScheduleNext = jest.fn(async () => {});
jest.mock('../../src/js/scheduling/cadenceChain', () => {
    const actual = jest.requireActual('../../src/js/scheduling/cadenceChain');
    return {
        ...actual,
        createCadenceChain: jest.fn((opts) => {
            mockChainOpts = opts;
            return { scheduleNext: mockScheduleNext };
        }),
    };
});

const logger = require('../../src/js/logger');
const settings = require('../../src/js/settings');
const { DECISION_ERROR_MESSAGE, formatOversleptMessage } = require('../../src/js/scheduling/cadenceChain');
const { createScheduler } = require('../../src/js/scheduling/runScheduler');

const log = { info: jest.fn(), warning: jest.fn(), debug: jest.fn(), error: jest.fn(), success: jest.fn() };

beforeEach(() => {
    mockChainOpts = null;
    logger.withCategory.mockImplementation(() => log);
});

const make = (cycleResult = { success: true, challenges: [{ id: 1 }] }) => {
    const runVotingCycle = jest.fn(async () => cycleResult);
    const getActiveChallenges = jest.fn(async () => ({ challenges: [] }));
    const scheduler = createScheduler({ runVotingCycle, getActiveChallenges });
    return { scheduler, runVotingCycle, getActiveChallenges };
};

describe('log callbacks', () => {
    test('decisionError warns with the shared message and keeps details at debug', () => {
        make();
        const err = new Error('boom');
        mockChainOpts.log.decisionError(err);
        expect(log.warning).toHaveBeenCalledWith(DECISION_ERROR_MESSAGE);
        expect(log.debug).toHaveBeenCalledWith('scheduleNext error details:', err);
    });

    test('overslept warns with the formatted late-timer message', () => {
        make();
        mockChainOpts.log.overslept(600_000, 180_000);
        expect(log.warning).toHaveBeenCalledWith(formatOversleptMessage(600_000, 180_000));
    });

    test('cycleError logs an error line plus debug details', () => {
        make();
        const err = new Error('cycle');
        mockChainOpts.log.cycleError(err);
        expect(log.error).toHaveBeenCalledWith('Error in scheduled voting cycle');
        expect(log.debug).toHaveBeenCalledWith('Full voting cycle error details:', err);
    });

    test('cadence logs the message at info', () => {
        make();
        mockChainOpts.log.cadence('normal', 'next in 3m');
        expect(log.info).toHaveBeenCalledWith('next in 3m');
    });
});

describe('transport deps', () => {
    test('settings and fetch passthroughs, and runCycle unwraps the challenge list', async () => {
        const { runVotingCycle, getActiveChallenges } = make({ success: true, challenges: ['x'] });
        expect(mockChainOpts.loadSettings()).toEqual({ checkFrequencyMin: 3, checkFrequencyMax: 3 });
        await mockChainOpts.fetchChallenges();
        expect(getActiveChallenges).toHaveBeenCalledTimes(1);
        expect(mockChainOpts.resolveLastMinuteCheckMinutes()).toBe(5);
        expect(settings.getEffectiveSetting).toHaveBeenCalledWith('lastMinuteCheckFrequency', 'global');
        await expect(mockChainOpts.runCycle()).resolves.toEqual(['x']);
        expect(runVotingCycle).toHaveBeenCalledWith(1);
    });

    test('a legacy boolean cycle result yields no list (forces a fresh fetch)', async () => {
        make(true);
        await expect(mockChainOpts.runCycle()).resolves.toBeUndefined();
    });

    test('timer accessors round-trip the handle', () => {
        make();
        expect(mockChainOpts.getTimer()).toBeNull();
        mockChainOpts.setTimer(42);
        expect(mockChainOpts.getTimer()).toBe(42);
    });
});

describe('lifecycle', () => {
    afterEach(() => jest.useRealTimers());

    test('start runs one initial cycle, hands its list to the chain, and is idempotent while running', async () => {
        const { scheduler, runVotingCycle } = make({ success: true, challenges: ['c'] });
        expect(scheduler.isRunning()).toBe(false);
        expect(scheduler.getCycleCount()).toBe(0);

        await scheduler.start();
        expect(scheduler.isRunning()).toBe(true);
        expect(mockChainOpts.isRunning()).toBe(true);
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
        mockChainOpts.setTimer(setTimeout(fired, 1000));

        scheduler.stop();
        expect(scheduler.isRunning()).toBe(false);
        expect(mockChainOpts.getTimer()).toBeNull();
        jest.advanceTimersByTime(2000);
        expect(fired).not.toHaveBeenCalled();
    });
});
