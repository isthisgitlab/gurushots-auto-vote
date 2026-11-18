/**
 * State machine behind AutovoteContext. Pulled out so the React tree stays
 * a thin shell over a transition table and tests/inspection can target the
 * reducer directly without spinning up a Provider.
 */

import type { AdmitRefusal, StopResult } from './runGate';

/**
 * What the controller is doing, apart from `running` (the voting stages). `stopped`: no chain, nothing unattended. `armed`:
 * the chain runs for the selected installation scenario while the voting stages are paused. `voting`: the ordinary pass.
 * `running` is false in `armed` mode, so nothing may read full Stop from `running` alone.
 */
export type ExecutionMode = 'stopped' | 'armed' | 'voting';

export const ACTIONS = {
    START: 'START',
    STOP: 'STOP',
    INCREMENT_CYCLE: 'INCREMENT_CYCLE',
    UPDATE_LAST_RUN: 'UPDATE_LAST_RUN',
    SET_ERROR: 'SET_ERROR',
    SET_NEXT_RUN: 'SET_NEXT_RUN',
    SET_PENDING_START: 'SET_PENDING_START',
    SET_EXECUTION_MODE: 'SET_EXECUTION_MODE',
    SET_STOP_RESULT: 'SET_STOP_RESULT',
    SET_STOP_EPOCH: 'SET_STOP_EPOCH',
    SET_START_REFUSAL: 'SET_START_REFUSAL',
} as const;

export interface AutovoteState {
    /** Whether the voting stages are on. False while `armed` (see `executionMode`). */
    running: boolean;
    executionMode: ExecutionMode;
    /** The Stop epoch last acknowledged (read from the fence or recorded by this controller), or null where none is known. */
    stopEpoch: number | null;
    /** What the last full Stop came to, or null when none was given. */
    lastStop: StopResult | null;
    /** Why the last Run / Resume was not admitted, or null. */
    startRefusal: AdmitRefusal | null;
    cycles: number;
    /** locale time string of the last successful cycle */
    lastRun: string | null;
    nextRunAt: number | null;
    /** Unix ms an auto-resume held at launch will start, or null when none is pending */
    pendingStartAt: number | null;
    status: 'Stopped' | 'Running' | 'Error';
    statusClass: 'badge-neutral' | 'badge-success' | 'badge-error';
    error: string | null;
}

export type AutovoteAction =
    | { type: typeof ACTIONS.START }
    | { type: typeof ACTIONS.STOP }
    | { type: typeof ACTIONS.INCREMENT_CYCLE }
    | { type: typeof ACTIONS.UPDATE_LAST_RUN; payload: string }
    | { type: typeof ACTIONS.SET_ERROR; payload: string }
    | { type: typeof ACTIONS.SET_NEXT_RUN; payload: number | null }
    | { type: typeof ACTIONS.SET_PENDING_START; payload: number | null }
    | { type: typeof ACTIONS.SET_EXECUTION_MODE; payload: Exclude<ExecutionMode, 'stopped'> }
    | { type: typeof ACTIONS.SET_STOP_RESULT; payload: StopResult }
    | { type: typeof ACTIONS.SET_STOP_EPOCH; payload: number | null }
    | { type: typeof ACTIONS.SET_START_REFUSAL; payload: AdmitRefusal | null };

export const initialState: AutovoteState = {
    running: false,
    executionMode: 'stopped',
    stopEpoch: null,
    lastStop: null,
    startRefusal: null,
    cycles: 0,
    lastRun: null,
    // Absolute wall-clock ms of the next armed cycle (Date.now()-based), or null
    // when nothing is scheduled. Set from the cadence chain's onScheduled hook;
    // powers the status header's next-action countdown. Only meaningful while
    // running — STOP clears it.
    nextRunAt: null,
    // Set while the startup hold (scheduling/startupDelay.ts) delays an auto-resume;
    // START and STOP clear it.
    pendingStartAt: null,
    status: 'Stopped',
    statusClass: 'badge-neutral',
    error: null,
};

export function autovoteReducer(state: AutovoteState, action: AutovoteAction): AutovoteState {
    switch (action.type) {
        case ACTIONS.START:
            return {
                ...state,
                running: true,
                executionMode: 'voting',
                startRefusal: null,
                pendingStartAt: null,
                status: 'Running',
                statusClass: 'badge-success',
                error: null,
            };
        case ACTIONS.STOP:
            return {
                ...state,
                running: false,
                executionMode: 'stopped',
                nextRunAt: null,
                pendingStartAt: null,
                status: 'Stopped',
                statusClass: 'badge-neutral',
            };
        case ACTIONS.INCREMENT_CYCLE:
            return {
                ...state,
                cycles: state.cycles + 1,
                status: 'Running',
                statusClass: 'badge-success',
                error: null,
            };
        case ACTIONS.UPDATE_LAST_RUN:
            return {
                ...state,
                lastRun: action.payload,
            };
        case ACTIONS.SET_NEXT_RUN:
            return {
                ...state,
                nextRunAt: action.payload,
            };
        case ACTIONS.SET_PENDING_START:
            return {
                ...state,
                pendingStartAt: action.payload,
            };
        case ACTIONS.SET_EXECUTION_MODE:
            return {
                ...state,
                executionMode: action.payload,
                running: action.payload === 'voting',
                startRefusal: null,
            };
        case ACTIONS.SET_STOP_RESULT:
            return { ...state, lastStop: action.payload };
        case ACTIONS.SET_STOP_EPOCH:
            return { ...state, stopEpoch: action.payload };
        case ACTIONS.SET_START_REFUSAL:
            return { ...state, startRefusal: action.payload };
        case ACTIONS.SET_ERROR:
            return {
                ...state,
                error: action.payload,
                status: 'Error',
                statusClass: 'badge-error',
            };
        default:
            // Every action type has its case (checked here); one outside the
            // union at runtime leaves the state as it is.
            action satisfies never;
            return state;
    }
}
