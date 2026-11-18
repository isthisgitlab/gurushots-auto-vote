import { invalid } from '../helpers/invalid';
import { autovoteReducer, initialState, ACTIONS } from '../../src/ts/core/autovote/state';

/**
 * The nextRunAt slice powers the status header's next-action countdown. It is
 * set from the cadence chain's onScheduled hook (SET_NEXT_RUN) and MUST clear
 * on STOP so a stopped autovote never shows a stale countdown.
 */
describe('autovoteReducer — nextRunAt', () => {
    test('initialState starts with nextRunAt null', () => {
        expect(initialState.nextRunAt).toBeNull();
    });

    test('SET_NEXT_RUN stores the timestamp and can clear it to null', () => {
        const set = autovoteReducer(initialState, { type: ACTIONS.SET_NEXT_RUN, payload: 12345 });
        expect(set.nextRunAt).toBe(12345);
        const cleared = autovoteReducer(set, { type: ACTIONS.SET_NEXT_RUN, payload: null });
        expect(cleared.nextRunAt).toBeNull();
    });

    test('STOP clears a pending nextRunAt', () => {
        const running = autovoteReducer(initialState, { type: ACTIONS.START });
        const withNext = autovoteReducer(running, { type: ACTIONS.SET_NEXT_RUN, payload: 555 });
        expect(withNext.nextRunAt).toBe(555);
        const stopped = autovoteReducer(withNext, { type: ACTIONS.STOP });
        expect(stopped.nextRunAt).toBeNull();
        expect(stopped.running).toBe(false);
    });
});

describe('autovoteReducer — pendingStartAt', () => {
    test('initialState has no pending start', () => {
        expect(initialState.pendingStartAt).toBeNull();
    });

    test('SET_PENDING_START stores the resume time and can clear it', () => {
        const set = autovoteReducer(initialState, { type: ACTIONS.SET_PENDING_START, payload: 9000 });
        expect(set).toMatchObject({ pendingStartAt: 9000, running: false, status: 'Stopped' });
        expect(autovoteReducer(set, { type: ACTIONS.SET_PENDING_START, payload: null }).pendingStartAt).toBeNull();
    });

    test('START and STOP clear it', () => {
        const pending = autovoteReducer(initialState, { type: ACTIONS.SET_PENDING_START, payload: 9000 });
        expect(autovoteReducer(pending, { type: ACTIONS.START }).pendingStartAt).toBeNull();
        expect(autovoteReducer(pending, { type: ACTIONS.STOP }).pendingStartAt).toBeNull();
    });
});

describe('autovoteReducer — cycle recovery', () => {
    test('clears a transient error when the next voting cycle succeeds', () => {
        const running = autovoteReducer(initialState, { type: ACTIONS.START });
        const failed = autovoteReducer(running, { type: ACTIONS.SET_ERROR, payload: 'API request failed' });

        const recovered = autovoteReducer(failed, { type: ACTIONS.INCREMENT_CYCLE });

        expect(recovered).toMatchObject({
            running: true,
            cycles: 1,
            status: 'Running',
            statusClass: 'badge-success',
            error: null,
        });
    });
});

describe('autovoteReducer — other transitions', () => {
    test('UPDATE_LAST_RUN stores the timestamp string', () => {
        expect(autovoteReducer(initialState, { type: ACTIONS.UPDATE_LAST_RUN, payload: '12:00:00' }).lastRun).toBe(
            '12:00:00',
        );
    });

    test('SET_ERROR flags the error status', () => {
        expect(autovoteReducer(initialState, { type: ACTIONS.SET_ERROR, payload: 'nope' })).toMatchObject({
            error: 'nope',
            status: 'Error',
            statusClass: 'badge-error',
        });
    });

    test('an unknown action returns the same state object', () => {
        expect(autovoteReducer(initialState, invalid({ type: 'NOPE' }))).toBe(initialState);
    });
});

describe('autovoteReducer — the execution mode', () => {
    test('starts stopped; START is voting and STOP is stopped again', () => {
        expect(initialState).toMatchObject({
            executionMode: 'stopped',
            running: false,
            stopEpoch: null,
            lastStop: null,
        });
        const voting = autovoteReducer(initialState, { type: ACTIONS.START });
        expect(voting).toMatchObject({ executionMode: 'voting', running: true });
        expect(autovoteReducer(voting, { type: ACTIONS.STOP })).toMatchObject({
            executionMode: 'stopped',
            running: false,
        });
    });

    test('armed is not running: the voting stages are paused while the chain stays', () => {
        const armed = autovoteReducer(initialState, { type: ACTIONS.SET_EXECUTION_MODE, payload: 'armed' });
        expect(armed).toMatchObject({ executionMode: 'armed', running: false });
        const voting = autovoteReducer(armed, { type: ACTIONS.SET_EXECUTION_MODE, payload: 'voting' });
        expect(voting).toMatchObject({ executionMode: 'voting', running: true });
    });

    test('a mode change clears the last refusal; the Stop result, epoch and refusal are kept as given', () => {
        const refused = autovoteReducer(initialState, { type: ACTIONS.SET_START_REFUSAL, payload: 'superseded' });
        expect(refused.startRefusal).toBe('superseded');
        expect(
            autovoteReducer(refused, { type: ACTIONS.SET_EXECUTION_MODE, payload: 'armed' }).startRefusal,
        ).toBeNull();
        expect(autovoteReducer(refused, { type: ACTIONS.START }).startRefusal).toBeNull();
        const stopped = autovoteReducer(initialState, {
            type: ACTIONS.SET_STOP_RESULT,
            payload: { outcome: 'stopped-locally', durable: false, reason: 'not-saved', withdrawal: 'none' },
        });
        expect(stopped.lastStop).toEqual({
            outcome: 'stopped-locally',
            durable: false,
            reason: 'not-saved',
            withdrawal: 'none',
        });
        expect(autovoteReducer(initialState, { type: ACTIONS.SET_STOP_EPOCH, payload: 4 }).stopEpoch).toBe(4);
    });
});
