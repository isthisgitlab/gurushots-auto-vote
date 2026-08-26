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
