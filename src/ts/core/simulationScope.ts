/**
 * The simulation scope: the one place a simulation (services/scenarioRunner/simulation.ts) borrows the process's settings,
 * progress ledger and clock for a what-if run, and the guards that keep it from touching anything real.
 *
 * It is consulted at exactly three choke points, and each behaves exactly as before when no scope is open:
 *
 *   - `loadSettings` (settings/persistence.ts): the simulated settings, the real configuration with the draft or named
 *     scenario and the subject's assignment applied in memory (`scope.patchSettings`);
 *   - `ledgerFor` (scenarioStateStore.ts): the scope's memory ledger instead of the persisted or the mock one;
 *   - `clockMs` / `clockSec` (here): the virtual clock instead of `Date.now()`, in the places the simulated composition reads it.
 *
 * Two small guards ride along: `sleep` (timing.ts) resolves at once, so the run yields to no timer, and every real store write
 * and the real transport refuse with a SimulationIsolationError (`refuseInSimulation`), which also marks the scope breached.
 *
 * The scope is process-wide, so the run must not yield to another task: a sentinel timer is scheduled when the scope opens,
 * and if it ever fires while the scope is open, something awaited a timer and other code could have run in between — the
 * scope is marked breached and the run's result is discarded. One scope at a time: a second request is refused as busy.
 *
 * Dependency-free on purpose (type-only imports): the settings, the stores and the transport all import it.
 */

import type { ConfigV2 } from './types/config';
import type { ScenarioStateLedger } from './types/votingPass';

/** Why the scope was breached, for the result. */
const ISOLATION_BREACHED = 'simulation-isolation-breached';
const SIMULATION_BUSY = 'simulation-busy';

/** Thrown by every real write path and by the real transport while a simulation scope is open. */
class SimulationIsolationError extends Error {
    readonly refused: string;

    constructor(refused: string) {
        super(`${ISOLATION_BREACHED}: ${refused} is refused while a simulation runs`);
        this.name = 'SimulationIsolationError';
        this.refused = refused;
    }
}

type SimulationScope = {
    /** The virtual clock, in milliseconds. */
    nowMs: () => number;
    /** The memory ledger every scenario read and write of the run goes through. */
    ledger: ScenarioStateLedger;
    /** The real configuration with the simulated scenario and assignment applied (never mutating its argument). */
    patchSettings: (config: ConfigV2) => ConfigV2;
    /** The first thing that breached the scope, or null. */
    breach: SimulationIsolationError | null;
    /** Why the scenario runner halted which subject during the run, in order: the typed signal the result's `halted` is read from. */
    halts: Array<{ subject: string; reason: string }>;
};

let current: SimulationScope | null = null;

/** What a module that keeps process-wide state of the passes registers: saves the state, and answers how to put it back. */
type SaveState = () => () => void;
const savers: SaveState[] = [];

/**
 * Registers a module's process-wide state of the passes (a cache of the last challenge list, a throttle's last time) as one a
 * simulation must not leave changed: the scope saves it when it opens and puts it back when it closes, whatever the run did.
 */
const isolateWhileSimulating = (save: SaveState): void => {
    savers.push(save);
};

const simulationScope = (): SimulationScope | null => current;

/**
 * Tells the open scope that the scenario runner halted `subject` (its record's key: a challenge id, or the installation's), and why. The runner calls this where it records the halt, so a
 * simulation learns of a halt from the runner itself and never from the text of a notice (a notice can be the user's own).
 * Does nothing outside a scope.
 */
const noteSimulatedHalt = (subject: string, reason: string): void => {
    current?.halts.push({ subject, reason });
};

/** The clock of the composition: the virtual one inside a simulation scope, else `Date.now()`. Milliseconds. */
const clockMs = (): number => (current ? current.nowMs() : Date.now());

/** `clockMs` in whole unix seconds. */
const clockSec = (): number => Math.floor(clockMs() / 1000);

/**
 * Refuses a real write or a real request while a simulation scope is open: the scope is marked breached (a caller may swallow
 * the throw) and a SimulationIsolationError is thrown. Does nothing outside a scope.
 *
 * @param what - what was refused, for the error
 */
const refuseInSimulation = (what: string): void => {
    if (!current) return;
    const error = new SimulationIsolationError(what);
    current.breach ??= error;
    throw error;
};

/** Registers a module's `Map` of the passes (a memo keyed by challenge) the same way: its entries are put back when the scope closes. */
const isolateMapWhileSimulating = <V>(map: Map<string, V>): void => {
    isolateWhileSimulating(() => {
        const saved = [...map];
        return () => {
            map.clear();
            for (const [key, value] of saved) map.set(key, value);
        };
    });
};

/** What a run in the scope came to. */
type ScopeResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: typeof SIMULATION_BUSY }
    | { ok: false; error: typeof ISOLATION_BREACHED; breach: SimulationIsolationError };

/**
 * Runs `body` with `scope` open. Refused as busy while another scope is open. The scope is always closed, errors included. A
 * sentinel zero-delay timer is scheduled on opening: when it fires, the body yielded to the event loop, which a simulation
 * never may, so the scope is breached and its result is not returned.
 */
const runInSimulationScope = async <T>(scope: SimulationScope, body: () => Promise<T>): Promise<ScopeResult<T>> => {
    if (current) return { ok: false, error: SIMULATION_BUSY };
    current = scope;
    const restores = savers.map((save) => save());
    const sentinel = setTimeout(() => {
        scope.breach ??= new SimulationIsolationError('a yield to the event loop');
    }, 0);
    try {
        const value = await body();
        if (scope.breach) return { ok: false, error: ISOLATION_BREACHED, breach: scope.breach };
        return { ok: true, value };
    } catch (error) {
        if (error instanceof SimulationIsolationError) return { ok: false, error: ISOLATION_BREACHED, breach: error };
        throw error;
    } finally {
        clearTimeout(sentinel);
        for (const restore of restores.reverse()) restore();
        current = null;
    }
};

export {
    ISOLATION_BREACHED,
    noteSimulatedHalt,
    SIMULATION_BUSY,
    SimulationIsolationError,
    clockMs,
    clockSec,
    isolateMapWhileSimulating,
    isolateWhileSimulating,
    refuseInSimulation,
    runInSimulationScope,
    simulationScope,
};
export type { SimulationScope };
