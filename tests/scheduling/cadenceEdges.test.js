/**
 * Edge coverage for the cadence helpers: untitled challenges log under their
 * id, candidates that are already past (or later than the current best) are
 * not chosen, unreadable close times are skipped, and non-array scheduled-fill
 * lists are treated as empty.
 */

const {
    soonestFinalWindowTopUpStart,
    soonestBoostPrefillStart,
    calculateNextThresholdEntry,
} = require('../../src/js/scheduling/thresholdWindow');
const { soonestScheduledStart } = require('../../src/js/scheduling/scheduledFill');

const NOW = 1_700_000_000;

describe('soonestFinalWindowTopUpStart', () => {
    const cfg = async () => ({ enabled: true, leadSec: 900, durationSec: 3600 });

    test('picks the earliest future start and falls back to the id for a missing title', async () => {
        const eligible = [
            { id: 7, close_time: NOW + 20_000 }, // start NOW + 15_500
            { id: 8, title: 'Later', close_time: NOW + 30_000 }, // later than the best → not chosen
            { id: 9, title: 'Past', close_time: NOW + 100 }, // start already past
        ];
        await expect(soonestFinalWindowTopUpStart(eligible, NOW, cfg)).resolves.toEqual({
            challengeId: 7,
            challengeTitle: 'challenge 7',
            startTime: NOW + 20_000 - 4500,
            leadMin: 15,
        });
    });
});

describe('soonestBoostPrefillStart', () => {
    const cfg = async () => ({ enabled: true, leadSec: 600, boostTimeSec: 600, keyUnlockedBoostTimeSec: 900 });
    const keyBoost = { member: { boost: { state: 'AVAILABLE_KEY' } } };

    test('skips an unreadable close_time and a start already past; untitled falls back to the id', async () => {
        const eligible = [
            { id: 1, close_time: 'soon', ...keyBoost },
            { id: 2, close_time: NOW + 1000, ...keyBoost }, // start NOW - 500 → past
            { id: 3, close_time: NOW + 10_000, ...keyBoost },
            { id: 4, title: 'Later', close_time: NOW + 20_000, ...keyBoost },
        ];
        await expect(soonestBoostPrefillStart(eligible, NOW, cfg)).resolves.toEqual({
            challengeId: 3,
            challengeTitle: 'challenge 3',
            startTime: NOW + 10_000 - 1500,
            leadMin: 10,
        });
    });
});

describe('calculateNextThresholdEntry', () => {
    test('an untitled challenge is reported under its id', async () => {
        const challenges = [{ id: 55, title: '', close_time: NOW + 7200, start_time: NOW - 60 }];
        const entry = await calculateNextThresholdEntry(challenges, NOW, () => 10);
        expect(entry).toEqual(
            expect.objectContaining({ challengeId: 55, challengeTitle: 'challenge 55', entryTime: NOW + 7200 - 600 }),
        );
    });
});

describe('soonestScheduledStart', () => {
    test('non-array lists are treated as empty (no candidate)', async () => {
        const challenges = [{ id: 1, close_time: NOW + 7200, start_time: NOW - 60 }];
        const resolve = async () => ({ enabled: true, timesOfDay: '08:00', beforeEndSecs: 3600 });
        await expect(soonestScheduledStart(challenges, NOW, resolve, 'UTC')).resolves.toBeNull();
    });

    test('an untitled challenge with a before-end entry falls back to its id', async () => {
        const challenges = [{ id: 2, close_time: NOW + 7200, start_time: NOW - 60 }];
        const resolve = async () => ({ enabled: true, timesOfDay: [], beforeEndSecs: [3600] });
        await expect(soonestScheduledStart(challenges, NOW, resolve, 'UTC')).resolves.toEqual({
            challengeId: 2,
            challengeTitle: 'challenge 2',
            startTime: NOW + 3600,
            form: 'before-end',
        });
    });
});

describe('createCadenceChain transport fallbacks', () => {
    const { createCadenceChain } = require('../../src/js/scheduling/cadenceChain');
    const { MS_PER_MINUTE } = require('../../src/js/scheduling/randomDelay');

    const makeDeps = (overrides = {}) => {
        let timer = null;
        return {
            isRunning: () => true,
            getTimer: () => timer,
            setTimer: (handle) => {
                timer = handle;
            },
            loadSettings: () => ({ checkFrequencyMin: 3, checkFrequencyMax: 3, timezone: 'UTC' }),
            fetchChallenges: jest.fn(async () => ({ challenges: [] })),
            resolveLastMinuteCheckMinutes: jest.fn(() => 1),
            resolveThreshold: jest.fn(() => 10),
            resolveScheduledFill: jest.fn(() => ({ enabled: false, timesOfDay: [], beforeEndSecs: [] })),
            runCycle: jest.fn(async () => true),
            log: { cadence: jest.fn(), decisionError: jest.fn(), cycleError: jest.fn() },
            onScheduled: jest.fn(),
            ...overrides,
        };
    };

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('a fetch that resolves to nothing is treated as an empty list (normal cadence, no error)', async () => {
        const deps = makeDeps({ fetchChallenges: jest.fn(async () => null) });
        await createCadenceChain(deps).scheduleNext(null);
        expect(deps.fetchChallenges).toHaveBeenCalledTimes(1);
        expect(deps.log.decisionError).not.toHaveBeenCalled();
        expect(deps.onScheduled).toHaveBeenCalledWith(3 * MS_PER_MINUTE);
    });

    test('an unreadable last-minute cadence falls back to 1 minute', async () => {
        const deps = makeDeps({ resolveLastMinuteCheckMinutes: jest.fn(() => 'often') });
        const inWindow = {
            id: 2,
            title: 'In Window',
            type: 'regular',
            close_time: Math.floor(Date.now() / 1000) + 120,
        };
        await createCadenceChain(deps).scheduleNext([inWindow]);
        expect(deps.log.decisionError).not.toHaveBeenCalled();
        expect(deps.onScheduled).toHaveBeenCalledWith(MS_PER_MINUTE);
    });
});

describe('overslept hook rejection', () => {
    const { createCadenceChain } = require('../../src/js/scheduling/cadenceChain');
    const { MS_PER_MINUTE } = require('../../src/js/scheduling/randomDelay');

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    test('an async-rejecting overslept log is swallowed and the cycle still runs', async () => {
        let timer = null;
        const overslept = jest.fn(() => Promise.reject(new Error('ipc gone')));
        const runCycle = jest.fn(async () => true);
        const chain = createCadenceChain({
            isRunning: () => true,
            getTimer: () => timer,
            setTimer: (h) => {
                timer = h;
            },
            loadSettings: () => ({ checkFrequencyMin: 3, checkFrequencyMax: 3, timezone: 'UTC' }),
            fetchChallenges: async () => ({ challenges: [] }),
            resolveLastMinuteCheckMinutes: () => 1,
            resolveThreshold: () => 10,
            resolveScheduledFill: () => ({ enabled: false, timesOfDay: [], beforeEndSecs: [] }),
            runCycle,
            log: { cadence: jest.fn(), decisionError: jest.fn(), cycleError: jest.fn(), overslept },
        });
        await chain.scheduleNext([]);
        jest.setSystemTime(Date.now() + 50 * MS_PER_MINUTE); // suspend: clock jumps, timer does not fire
        await jest.advanceTimersByTimeAsync(3 * MS_PER_MINUTE);
        for (let i = 0; i < 20; i++) await Promise.resolve();
        expect(overslept).toHaveBeenCalledTimes(1);
        expect(runCycle).toHaveBeenCalledTimes(1);
    });
});
