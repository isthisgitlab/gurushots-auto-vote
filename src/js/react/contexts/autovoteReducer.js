// @ts-check
/**
 * State machine behind AutovoteContext. Pulled out so the React tree stays
 * a thin shell over a transition table and tests/inspection can target the
 * reducer directly without spinning up a Provider.
 */

export const ACTIONS = /** @type {const} */ ({
    START: 'START',
    STOP: 'STOP',
    INCREMENT_CYCLE: 'INCREMENT_CYCLE',
    UPDATE_LAST_RUN: 'UPDATE_LAST_RUN',
    SET_ERROR: 'SET_ERROR',
    SET_NEXT_RUN: 'SET_NEXT_RUN',
});

/**
 * @typedef {object} AutovoteState
 * @property {boolean} running
 * @property {number} cycles
 * @property {string | null} lastRun - locale time string of the last successful cycle
 * @property {number | null} nextRunAt
 * @property {'Stopped' | 'Running' | 'Error'} status
 * @property {'badge-neutral' | 'badge-success' | 'badge-error'} statusClass
 * @property {string | null} error
 */

/**
 * @typedef {{ type: typeof ACTIONS.START }
 *   | { type: typeof ACTIONS.STOP }
 *   | { type: typeof ACTIONS.INCREMENT_CYCLE }
 *   | { type: typeof ACTIONS.UPDATE_LAST_RUN, payload: string }
 *   | { type: typeof ACTIONS.SET_ERROR, payload: string }
 *   | { type: typeof ACTIONS.SET_NEXT_RUN, payload: number | null }} AutovoteAction
 */

/** @type {AutovoteState} */
export const initialState = {
    running: false,
    cycles: 0,
    lastRun: null,
    // Absolute wall-clock ms of the next armed cycle (Date.now()-based), or null
    // when nothing is scheduled. Set from the cadence chain's onScheduled hook;
    // powers the status header's next-action countdown. Only meaningful while
    // running — STOP clears it.
    nextRunAt: null,
    status: 'Stopped',
    statusClass: 'badge-neutral',
    error: null,
};

/**
 * @param {AutovoteState} state
 * @param {AutovoteAction} action
 * @returns {AutovoteState}
 */
export function autovoteReducer(state, action) {
    switch (action.type) {
        case ACTIONS.START:
            return {
                ...state,
                running: true,
                status: 'Running',
                statusClass: 'badge-success',
                error: null,
            };
        case ACTIONS.STOP:
            return {
                ...state,
                running: false,
                nextRunAt: null,
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
        case ACTIONS.SET_ERROR:
            return {
                ...state,
                error: action.payload,
                status: 'Error',
                statusClass: 'badge-error',
            };
        default:
            return state;
    }
}
