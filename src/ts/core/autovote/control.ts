/**
 * The autovote controller as a scenario's installation actions reach it (`startAutovote`, `stopAutovote`): one registered
 * control per process, set by whoever owns the chain here (the CLI scheduler, a headless loop) and read by the lifecycle
 * coordinator once per cycle. Dependency-free on purpose (type-only imports).
 *
 * A request is bound to the Stop capture taken when the cycle began (`capture`): a Stop that lands while the cycle runs makes
 * every request of that cycle obsolete, and a user Run after it does not make them current again.
 */

import type { RunCapture } from '../scheduling/cadenceChain/types';
import type { VotingStagesResult } from './types';

type AutovoteControl = {
    /** The capture a request made now is created under. */
    capture: () => RunCapture;
    /** Whether a request or publication that holds `captured` is still current: no full Stop came after it. */
    admits: (captured: RunCapture) => Promise<boolean>;
    /** Turns the voting stages on or off under the armed chain. Never creates a chain, never lifts a Stop. */
    request: (on: boolean, captured: RunCapture) => Promise<VotingStagesResult>;
};

let current: AutovoteControl | null = null;

/** Registers the control of this process; the returned function unregisters it (only while it is still the registered one). */
const registerAutovoteControl = (control: AutovoteControl): (() => void) => {
    current = control;
    return () => {
        if (current === control) current = null;
    };
};

const currentAutovoteControl = (): AutovoteControl | null => current;

export { registerAutovoteControl, currentAutovoteControl };
export type { AutovoteControl };
