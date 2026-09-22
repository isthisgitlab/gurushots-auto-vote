import { autovoteReducer, initialState, ACTIONS } from '@/contexts/autovoteReducer';

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
        expect(autovoteReducer(initialState, { type: 'NOPE' })).toBe(initialState);
    });
});
