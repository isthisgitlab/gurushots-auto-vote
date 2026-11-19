/**
 * The simulation scope (core/simulationScope.ts): the three choke points it is consulted at (the settings, the progress ledger,
 * the clock), its guards (one scope at a time, no yield to the event loop, every real write and the real transport refused,
 * always closed), and the state of the passes it puts back.
 */

import axiosModule = require('axios');
import type { AxiosRequestConfig } from 'axios';
import { installHeadlessStore, removeHeadlessStore } from '../helpers/headlessStore';
import { invalid } from '../helpers/invalid';
import settings = require('../../src/ts/core/settings');
import storageModule = require('../../src/ts/core/settings/storage');
import type * as scopeModule from '../../src/ts/core/simulationScope';
import type * as scenarioStateStoreModule from '../../src/ts/core/scenarioStateStore';
import type * as apiClientModule from '../../src/ts/core/api/api-client';
import type * as joinStateStoreModule from '../../src/ts/core/joinStateStore';
import type * as timingModule from '../../src/ts/core/timing';
import type { ConfigV2 } from '../../src/ts/core/types/config';

// tests/setup.ts replaces axios with a bare jest.fn().
const axios: jest.Mock<Promise<unknown>, [config: AxiosRequestConfig]> = invalid(axiosModule);

const {
    ISOLATION_BREACHED,
    SIMULATION_BUSY,
    SimulationIsolationError,
    clockMs,
    clockSec,
    isolateMapWhileSimulating,
    isolateWhileSimulating,
    refuseInSimulation,
    runInSimulationScope,
    simulationScope,
} = require('../../src/ts/core/simulationScope') as typeof scopeModule;
const { createMemoryStateLedger, ledgerFor, mockScenarioStateLedger, scenarioStateLedger } =
    require('../../src/ts/core/scenarioStateStore') as typeof scenarioStateStoreModule;
const { makePostRequest, postOnce } = require('../../src/ts/core/api/api-client') as typeof apiClientModule;
const { acquireUnlockLock } = require('../../src/ts/core/joinStateStore') as typeof joinStateStoreModule;
const { sleep } = require('../../src/ts/core/timing') as typeof timingModule;

const scopeOf = (overrides: Partial<scopeModule.SimulationScope> = {}): scopeModule.SimulationScope => ({
    nowMs: () => 5_000_000,
    ledger: createMemoryStateLedger(),
    patchSettings: (config) => config,
    breach: null,
    halts: [],
    ...overrides,
});

beforeEach(() => {
    installHeadlessStore();
});

afterEach(() => {
    jest.restoreAllMocks();
    removeHeadlessStore();
});

describe('one simulation at a time', () => {
    test('a second request while one runs is refused as busy, and the first is untouched', async () => {
        const release: { now: () => void } = { now: () => {} };
        const first = runInSimulationScope(
            scopeOf(),
            () =>
                new Promise<number>((resolve) => {
                    release.now = () => resolve(1);
                }),
        );
        const second = await runInSimulationScope(scopeOf(), async () => 2);
        expect(second).toEqual({ ok: false, error: SIMULATION_BUSY });
        expect(SIMULATION_BUSY).toBe('simulation-busy');
        release.now();
        expect(await first).toEqual({ ok: true, value: 1 });
        expect(simulationScope()).toBeNull();
    });
});

describe('the three choke points', () => {
    test('the settings are the real ones with the scope applied inside it, and exactly the real ones outside', async () => {
        const real = settings.loadSettings();
        const patched = scopeOf({
            patchSettings: (config: ConfigV2) => ({ ...config, scenarios: { Draft: { name: 'Draft' } } }),
        });
        const inside = await runInSimulationScope(patched, async () => settings.loadSettings().scenarios);
        expect(inside).toEqual({ ok: true, value: { Draft: { name: 'Draft' } } });
        expect(settings.loadSettings()).toEqual(real);
        expect(settings.getScenario('Draft')).toBeNull();
    });

    test('the progress ledger is the scope’s memory ledger inside it, whatever the mode, and the real ones outside', async () => {
        const scope = scopeOf();
        const inside = await runInSimulationScope(scope, async () => [
            ledgerFor(false) === scope.ledger,
            ledgerFor(true) === scope.ledger,
        ]);
        expect(inside).toEqual({ ok: true, value: [true, true] });
        expect(ledgerFor(false)).toBe(scenarioStateLedger);
        expect(ledgerFor(true)).toBe(mockScenarioStateLedger);
    });

    test('the clock is the virtual one inside it, and Date.now outside', async () => {
        jest.spyOn(Date, 'now').mockReturnValue(1_234_567_000);
        expect([clockMs(), clockSec()]).toEqual([1_234_567_000, 1_234_567]);
        const inside = await runInSimulationScope(scopeOf({ nowMs: () => 5_000_500 }), async () => [
            clockMs(),
            clockSec(),
        ]);
        expect(inside).toEqual({ ok: true, value: [5_000_500, 5_000] });
        expect(clockMs()).toBe(1_234_567_000);
    });
});

describe('no yield to the event loop', () => {
    test('a run that waits for a timer breaches the scope, and its result is not returned', async () => {
        const scope = scopeOf();
        const run = await runInSimulationScope(scope, async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return 'late';
        });
        expect(run).toMatchObject({ ok: false, error: ISOLATION_BREACHED });
        expect(scope.breach).toBeInstanceOf(SimulationIsolationError);
        expect(scope.breach?.refused).toBe('a yield to the event loop');
        expect(simulationScope()).toBeNull();
    });

    test('a run that never yields is not breached, and its sentinel timer is cleared', async () => {
        const timers = jest.spyOn(globalThis, 'setTimeout');
        const cleared = jest.spyOn(globalThis, 'clearTimeout');
        const scope = scopeOf();
        expect(await runInSimulationScope(scope, async () => 'on time')).toEqual({ ok: true, value: 'on time' });
        expect(timers.mock.calls.map((call) => call[1])).toEqual([0]);
        expect(cleared).toHaveBeenCalledTimes(1);
        expect(scope.breach).toBeNull();
    });

    test('inside the scope a sleep is over at once, without a timer; outside it is a timer', async () => {
        const timers = jest.spyOn(globalThis, 'setTimeout');
        await runInSimulationScope(scopeOf(), async () => {
            await sleep(60_000);
            return null;
        });
        expect(timers.mock.calls.map((call) => call[1])).toEqual([0]);
        timers.mockClear();
        await sleep(1);
        expect(timers.mock.calls.map((call) => call[1])).toEqual([1]);
    });
});

describe('the scope is always closed', () => {
    test('an error of the body closes it and is rethrown', async () => {
        await expect(
            runInSimulationScope(scopeOf(), async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(simulationScope()).toBeNull();
        expect(await runInSimulationScope(scopeOf(), async () => 1)).toEqual({ ok: true, value: 1 });
    });

    test('a refusal that escapes the body closes it and is a breach, not an error', async () => {
        const run = await runInSimulationScope(scopeOf(), async () => {
            refuseInSimulation('a store write');
            return 1;
        });
        expect(run).toMatchObject({ ok: false, error: ISOLATION_BREACHED });
        expect(run.ok === false && run.error === ISOLATION_BREACHED && run.breach.refused).toBe('a store write');
        expect(simulationScope()).toBeNull();
    });

    test('a refusal the body swallowed still breaches the scope: the first one is kept', async () => {
        const scope = scopeOf();
        const run = await runInSimulationScope(scope, async () => {
            for (const what of ['first', 'second']) {
                try {
                    refuseInSimulation(what);
                } catch {
                    // swallowed, as a step that logs and goes on would
                }
            }
            return 'went on';
        });
        expect(run).toMatchObject({ ok: false, error: ISOLATION_BREACHED });
        expect(scope.breach?.refused).toBe('first');
    });

    test('outside a scope a refusal does nothing', () => {
        expect(() => refuseInSimulation('anything')).not.toThrow();
    });
});

/** Runs `attempt` inside a scope: whether it threw the isolation error, and what the scope said. */
const insideScope = async (attempt: () => unknown) => {
    const scope = scopeOf();
    let refused: unknown = null;
    await runInSimulationScope(scope, async () => {
        try {
            await attempt();
        } catch (error) {
            refused = error;
        }
        return null;
    });
    return { refused, breach: scope.breach };
};

describe('every real write and the real transport refuse inside the scope, and work outside it', () => {
    const stores: Array<[string, () => unknown]> = [
        [
            'a JSON store writeRaw',
            () => storageModule.createJsonStore({ fileName: 'sim-a.json', prefKey: 'sim-a' }).writeRaw('{}'),
        ],
        [
            'a JSON store updateNow',
            () => storageModule.createJsonStore({ fileName: 'sim-b.json', prefKey: 'sim-b' }).updateNow(() => '{}'),
        ],
        [
            'a JSON store updateThrough',
            () => storageModule.createJsonStore({ fileName: 'sim-c.json', prefKey: 'sim-c' }).updateThrough(() => '{}'),
        ],
        ['the settings write', () => storageModule.storage.write('{}')],
        ['the settings writeRaw', () => storageModule.storage.writeRaw('{}')],
        ['the settings writeIfAbsent', () => storageModule.storage.writeIfAbsent('{}')],
        ['the settings quarantineRaw', () => storageModule.storage.quarantineRaw('{}')],
        ['the legacy settings write', () => storageModule.legacyStorage.write('{}')],
        ['a lock file', () => acquireUnlockLock('sim-lock').release()],
    ];

    test.each(stores)('%s', async (_name, attempt) => {
        const inside = await insideScope(attempt);
        expect(inside.refused).toBeInstanceOf(SimulationIsolationError);
        expect(inside.breach).toBe(inside.refused);
        // Outside the scope the same call goes through.
        await expect(Promise.resolve().then(attempt)).resolves.not.toThrow();
    });

    test('the real scenario ledger (its store) refuses a write inside the scope', async () => {
        const inside = await insideScope(() => scenarioStateLedger.removeAll());
        expect(inside.refused ?? inside.breach).toBeInstanceOf(SimulationIsolationError);
    });

    test.each([
        ['makePostRequest', () => makePostRequest('https://example.invalid/a', {}, 'a=1')],
        ['postOnce', () => postOnce('https://example.invalid/b', {}, 'b=1')],
    ])('the real transport: %s', async (_name, request) => {
        axios.mockClear();
        const inside = await insideScope(request);
        expect(inside.refused).toBeInstanceOf(SimulationIsolationError);
        expect(inside.breach).toBe(inside.refused);
        expect(axios).not.toHaveBeenCalled();
        // Outside the scope the request is made.
        axios.mockResolvedValue({ status: 200, data: { success: true }, headers: {} });
        await request();
        expect(axios).toHaveBeenCalled();
    });
});

describe('the state of the passes is put back', () => {
    test('a registered state is saved when the scope opens and restored when it closes, errors included', async () => {
        let value = 'real';
        isolateWhileSimulating(() => {
            const saved = value;
            return () => {
                value = saved;
            };
        });
        await runInSimulationScope(scopeOf(), async () => {
            value = 'simulated';
            return null;
        });
        expect(value).toBe('real');
        await expect(
            runInSimulationScope(scopeOf(), async () => {
                value = 'simulated again';
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        expect(value).toBe('real');
    });

    test('a registered map gets its entries back', async () => {
        const memos = new Map([['kept', 1]]);
        isolateMapWhileSimulating(memos);
        await runInSimulationScope(scopeOf(), async () => {
            memos.delete('kept');
            memos.set('made', 2);
            return null;
        });
        expect([...memos]).toEqual([['kept', 1]]);
    });
});
