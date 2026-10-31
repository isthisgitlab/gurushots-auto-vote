/**
 * The controller's state store: the pure reducer (./state) applied to one
 * `AutovoteState`, with subscription. Every state change notifies every
 * subscriber.
 */

import { autovoteReducer, initialState } from './state';

import type { AutovoteAction, AutovoteState } from './state';

/** The store the controller publishes its state through. */
export type AutovoteStore = {
    /** Apply one action and notify every subscriber. */
    apply: (action: AutovoteAction) => void;
    getState: () => AutovoteState;
    subscribe: (listener: () => void) => () => void;
    /**
     * Drop every listener: a disposed controller notifies nobody, whatever is
     * still in flight on it.
     */
    clearListeners: () => void;
};

export const createAutovoteStore = (): AutovoteStore => {
    let state: AutovoteState = initialState;
    const listeners = new Set<() => void>();
    return {
        apply: (action) => {
            state = autovoteReducer(state, action);
            for (const listener of listeners) listener();
        },
        getState: () => state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        clearListeners: () => {
            listeners.clear();
        },
    };
};
