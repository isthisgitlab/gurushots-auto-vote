/**
 * The what-if scenario timeline: jumps between the engine's wake-ups,
 * chains rules and phases like the runner, and says why it stopped.
 */

const { simulateScenario, MAX_EVENTS } = require('../../src/js/scenarios/simulate');
const { initialState } = require('../../src/js/scenarioStateStore');
const { epochForWallTime } = require('../../src/js/scheduling/wallClock');

jest.mock('../../src/js/logger', () => ({ withCategory: jest.fn(() => ({ error: jest.fn() })) }));

const TZ = 'Europe/Riga';
const at = (d, hh, mm) => epochForWallTime(2026, 9, d, hh, mm, TZ);
const NOW = at(25, 12, 0);
const challenge = (close = at(28, 20, 0)) => ({
    id: 7,
    start_time: NOW - 86400,
    close_time: close,
    member: { ranking: { entries: [] } },
});
const plan = (phases, start = 'main') => ({ name: 'Plan', version: 1, start, phases });
const run = (scenario, overrides = {}) =>
    simulateScenario({
        scenario,
        state: initialState('Plan', scenario.start, NOW),
        challenge: challenge(),
        now: NOW,
        timezone: TZ,
        ...overrides,
    });

test('a daily rule fires each morning until the close', () => {
    const scenario = plan({
        main: {
            rules: [
                {
                    id: 'morning',
                    repeat: 'oncePerDay',
                    if: [{ type: 'dailyWindow', from: '06:00', to: '08:00' }],
                    do: [{ type: 'enterPhoto', photo: 'best' }],
                },
            ],
        },
    });
    const result = run(scenario);
    expect(result.events.map((e) => e.at)).toEqual([at(26, 6, 0), at(27, 6, 0), at(28, 6, 0)]);
    expect(result.events[0]).toEqual({
        at: at(26, 6, 0),
        phase: 'main',
        ruleId: 'morning',
        label: 'morning',
        actions: ['enterPhoto'],
        toPhase: null,
    });
    // The next morning falls after the close, so the timeline ends there.
    expect(result).toEqual(
        expect.objectContaining({ stoppedBecause: 'closed', stoppedAt: at(28, 20, 0), halted: null }),
    );
});

test('phases chain in one pass, memory placeholders let later rules run, and timed phases follow', () => {
    const scenario = plan({
        main: {
            rules: [
                {
                    id: 'out',
                    label: 'Hold it',
                    repeat: 'once',
                    do: [
                        {
                            type: 'swap',
                            entry: { by: 'mostVotes' },
                            with: 'best',
                            rememberRemoved: 'held',
                            rememberAdded: 'filler',
                        },
                        { type: 'remember', slot: 'top', entry: { by: 'bestRank' } },
                        { type: 'forget', slot: 'top' },
                        { type: 'goto', phase: 'wait' },
                    ],
                },
            ],
        },
        wait: {
            rules: [
                {
                    id: 'check',
                    if: [{ type: 'memorySet', slot: 'held' }],
                    repeat: 'oncePerPhase',
                    do: [{ type: 'notify', message: 'held' }],
                },
                { id: 'back', if: [{ type: 'inPhaseFor', min: '4m' }], do: [{ type: 'goto', phase: 'done' }] },
            ],
        },
        done: {},
    });
    const result = run(scenario);
    expect(result.events.map((e) => [e.ruleId, e.at - NOW, e.toPhase])).toEqual([
        ['out', 0, 'wait'],
        ['check', 0, null],
        ['back', 240, 'done'],
    ]);
    // "done" has no rules: nothing more is time-based.
    expect(result.stoppedBecause).toBe('idle');
});

test('a goto loop within one pass stops, and a plan that only waits on data goes idle', () => {
    const loop = plan(
        {
            a: { rules: [{ id: 'toB', do: [{ type: 'goto', phase: 'b' }] }] },
            b: { rules: [{ id: 'toA', repeat: 'once', do: [{ type: 'goto', phase: 'a' }] }] },
        },
        'a',
    );
    const result = run(loop);
    expect(result.events.map((e) => e.ruleId)).toEqual(['toB', 'toA']);

    const waiting = plan({
        main: {
            rules: [{ id: 'r', if: [{ type: 'entries', op: '>', value: 3 }], do: [{ type: 'notify', message: 'x' }] }],
        },
    });
    expect(run(waiting)).toEqual(expect.objectContaining({ events: [], stoppedBecause: 'idle', stoppedAt: NOW }));
});

test('a challenge without a close, or already closed, is "closed"', () => {
    const waiting = plan({ main: {} });
    expect(run(waiting, { challenge: challenge(Number.NaN) }).stoppedBecause).toBe('closed');
    expect(run(waiting, { challenge: challenge(NOW - 1) }).stoppedBecause).toBe('closed');
});

test('a halt stops the timeline with its reason', () => {
    const result = run(plan({ main: {} }), { state: initialState('Plan', 'gone', NOW) });
    expect(result).toEqual(
        expect.objectContaining({ stoppedBecause: 'halted', halted: expect.stringContaining('no longer exists') }),
    );
});

test('an endless plan is cut at the event limit, and a very long idle-free plan at the step limit', () => {
    const always = plan({
        main: {
            rules: [
                { id: 'r', if: [{ type: 'inPhaseFor', min: 0 }], do: [{ type: 'notify', message: 'x' }] },
                {
                    id: 'tick',
                    if: [{ type: 'dailyWindow', from: '00:00', to: '00:01' }],
                    do: [{ type: 'notify', message: 'y' }],
                },
            ],
        },
    });
    const result = run(always, { challenge: challenge(NOW + 400 * 86400) });
    expect(result.events).toHaveLength(MAX_EVENTS);
    expect(result.stoppedBecause).toBe('limit');

    const quiet = plan({
        main: {
            rules: [
                {
                    id: 'never',
                    if: [
                        { type: 'dailyWindow', from: '03:00', to: '03:01' },
                        { type: 'entries', op: '>', value: 9 },
                    ],
                    do: [{ type: 'notify', message: 'z' }],
                },
            ],
        },
    });
    const long = run(quiet, { challenge: challenge(NOW + 400 * 86400) });
    expect(long).toEqual(expect.objectContaining({ events: [], stoppedBecause: 'limit' }));
});
