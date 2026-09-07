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

/**
 * A cycle failure sets the Error badge, but the cadence chain keeps looping.
 * CLEAR_ERROR is what a subsequent successful cycle uses to recover — without
 * it the status stays 'Error' forever (START is guarded off while running and
 * STOP only goes to 'Stopped').
 */
describe('autovoteReducer — CLEAR_ERROR recovery', () => {
    test('SET_ERROR then CLEAR_ERROR restores the running badge', () => {
        const running = autovoteReducer(initialState, { type: ACTIONS.START });
        const errored = autovoteReducer(running, { type: ACTIONS.SET_ERROR, payload: 'Voting failed' });
        expect(errored.status).toBe('Error');
        expect(errored.statusClass).toBe('badge-error');
        expect(errored.error).toBe('Voting failed');

        const recovered = autovoteReducer(errored, { type: ACTIONS.CLEAR_ERROR });
        expect(recovered.status).toBe('Running');
        expect(recovered.statusClass).toBe('badge-success');
        expect(recovered.error).toBeNull();
    });

    test('CLEAR_ERROR is a no-op (same reference) when already running with no error', () => {
        const running = autovoteReducer(initialState, { type: ACTIONS.START });
        const after = autovoteReducer(running, { type: ACTIONS.CLEAR_ERROR });
        expect(after).toBe(running);
    });

    test('CLEAR_ERROR never fabricates a Running badge on a stopped session', () => {
        // A stopped session (running:false) must stay stopped — CLEAR_ERROR only
        // recovers a *running* one. Otherwise a stray dispatch would show a green
        // 'Running' badge next to a 'Start' button (running drives the button,
        // status drives the badge). Guarded by the `!state.running` early-return.
        const fromInitial = autovoteReducer(initialState, { type: ACTIONS.CLEAR_ERROR });
        expect(fromInitial).toBe(initialState);

        // Even a stopped session that still holds a stale error is left untouched.
        const stoppedWithError = { ...initialState, status: 'Stopped', error: 'Voting failed' };
        const after = autovoteReducer(stoppedWithError, { type: ACTIONS.CLEAR_ERROR });
        expect(after).toBe(stoppedWithError);
    });

    test('STOP clears a lingering error so the status field matches the badge', () => {
        const running = autovoteReducer(initialState, { type: ACTIONS.START });
        const errored = autovoteReducer(running, { type: ACTIONS.SET_ERROR, payload: 'Voting failed' });
        expect(errored.error).toBe('Voting failed');

        const stopped = autovoteReducer(errored, { type: ACTIONS.STOP });
        expect(stopped.status).toBe('Stopped');
        expect(stopped.running).toBe(false);
        expect(stopped.error).toBeNull();
    });
});
