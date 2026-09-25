/**
 * The scenario boundary in the shared cadence math: soonestScenarioWake and
 * computeNextCycleDelayMs's 'scenario' mode.
 */

const { soonestScenarioWake, computeNextCycleDelayMs } = require('../../src/js/scheduling/thresholdWindow');

const NOW = 1_800_000_000;

const scenario = {
    name: 'Plan',
    version: 1,
    start: 'main',
    phases: {
        main: { rules: [{ id: 'r1', if: [{ type: 'inPhaseFor', min: '10m' }], do: [{ type: 'fillExposure' }] }] },
        later: { rules: [{ id: 'r2', if: [{ type: 'inPhaseFor', min: '2m' }], do: [{ type: 'fillExposure' }] }] },
    },
};

const challenge = (id, overrides = {}) => ({
    id,
    title: `C${id}`,
    start_time: NOW - 3600,
    close_time: NOW + 86400,
    ...overrides,
});

describe('soonestScenarioWake', () => {
    test('the soonest wake across challenges; a plan not started yet is judged from its start phase', async () => {
        const resolve = jest.fn(async (id) =>
            id === '1'
                ? { scenario, state: null, timezone: 'UTC' }
                : {
                      scenario,
                      state: { phase: 'later', phaseEnteredAt: NOW - 60, fired: {}, memory: {} },
                      timezone: 'UTC',
                  },
        );
        await expect(soonestScenarioWake([challenge(1), challenge(2)], NOW, resolve)).resolves.toEqual({
            challengeId: 2,
            challengeTitle: 'C2',
            startTime: NOW + 60,
            phase: 'later',
        });
        await expect(soonestScenarioWake([challenge(1)], NOW, resolve)).resolves.toEqual(
            expect.objectContaining({ challengeId: 1, startTime: NOW + 600, phase: 'main' }),
        );
    });

    test('skips closed challenges, no-scenario challenges, throwing resolvers and nothing-pending plans', async () => {
        const resolve = jest.fn((id) => {
            if (id === '2') return null;
            if (id === '3') throw new Error('boom');
            return { scenario: { ...scenario, phases: { main: {} } }, state: null, timezone: 'UTC' };
        });
        const list = [challenge(1), challenge(2), challenge(3), challenge(4, { close_time: NOW - 1 })];
        await expect(soonestScenarioWake(list, NOW, resolve)).resolves.toBeNull();
        expect(resolve).not.toHaveBeenCalledWith('4');
        await expect(soonestScenarioWake(null, NOW, resolve)).resolves.toBeNull();
    });
});

describe('computeNextCycleDelayMs — scenario boundary', () => {
    const base = {
        resolveThreshold: () => 10,
        normalDelayMs: 30 * 60_000,
        lastMinuteCheckMinutes: 1,
        minGapMs: 5000,
    };

    test('caps the wait to the scenario wake and reports it', async () => {
        const result = await computeNextCycleDelayMs([challenge(1)], NOW, {
            ...base,
            resolveScenarioWake: () => ({ scenario, state: null, timezone: 'UTC' }),
        });
        expect(result.mode).toBe('scenario');
        expect(result.delayMs).toBe(600_000);
        expect(result.nextScenarioWake).toEqual(expect.objectContaining({ challengeId: 1 }));
    });

    test('without the resolver there is no scenario boundary', async () => {
        const result = await computeNextCycleDelayMs([challenge(1)], NOW, base);
        expect(result.mode).toBe('normal');
        expect(result.nextScenarioWake).toBeNull();
    });

    test('the last-minute early return reports no scenario wake', async () => {
        const result = await computeNextCycleDelayMs([challenge(1, { close_time: NOW + 60 })], NOW, {
            ...base,
            resolveScenarioWake: () => ({ scenario, state: null, timezone: 'UTC' }),
        });
        expect(result.mode).toBe('last-minute');
        expect(result.nextScenarioWake).toBeNull();
    });
});
