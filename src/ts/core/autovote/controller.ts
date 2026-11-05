/**
 * The renderer's autovote controller: the whole voting loop — start/stop
 * lifecycle, the voting-cycle outcome handling, the mount-time auto-resume
 * hold, and the transport glue handed to the shared cadence chain — as a
 * plain-TS object over an injected host. React only builds the host
 * (`AutovoteContext.tsx`), subscribes to the state, and renders; nothing here
 * may touch the DOM, a platform module, or a shell.
 *
 * This module is the composition root: it owns the session flags, the timer
 * slots, and the state store, and composes the parts that live beside it —
 * `./store` (state + subscription), `./persistence` (the persisted session
 * markers), `./cycle` (the voting-cycle runner), `./chain` (the shared
 * cadence chain over the WebView transport), `./resume` (the startup hold),
 * and `./lifecycle` (start/stop/re-arm).
 */

import type { TimerHandle } from '../scheduling/cadenceChain';
import type { AutovoteController, AutovoteHost, SessionFlags, SessionFlagWriters } from './types';
import { createAutovoteStore } from './store';
import { createPersistence } from './persistence';
import { createCycleRunner } from './cycle';
import { createControllerChain } from './chain';
import { createResumeHold } from './resume';
import { cancelCycleTimer, createLifecycle } from './lifecycle';

export type { AutovoteController, AutovoteHost, BackgroundHost, CallOrNull, CycleNotifier } from './types';

/**
 * Create one autovote controller over `host`. There is no module-level
 * singleton: the adapter creates one per `AutovoteProvider` mount and calls
 * `dispose()` from the effect cleanup.
 */
export const createAutovoteController = (host: AutovoteHost): AutovoteController => {
    const store = createAutovoteStore();

    // Live running flag the chain's isRunning reads. Set synchronously inside
    // start/stop (the dispatched state follows, but React-free consumers read
    // this one).
    let running = false;
    // Set by start() and stop(): the user (or the hold itself) has acted, so a
    // mount-time resume still waiting on its awaits must not arm the hold.
    let userActed = false;
    // Set by dispose(): a pending maybeResume must not arm anything after its
    // mount went away.
    let disposed = false;
    const flags: SessionFlags = {
        running: () => running,
        userActed: () => userActed,
        disposed: () => disposed,
    };
    const writers: SessionFlagWriters = {
        setRunning: (value) => {
            running = value;
        },
        setUserActed: () => {
            userActed = true;
        },
    };

    // Single recursive setTimeout handle for the whole cadence chain. Each cycle
    // decides its own next delay (fast in-window / capped approaching / normal)
    // via the shared computeNextCycleDelayMs, so there is no separate fast-mode
    // interval or boundary-switch timer to keep in sync.
    const cycleTimer: { current: TimerHandle | null } = { current: null };

    const { runCycle } = createCycleRunner({ host, apply: store.apply, flags });
    const { scheduleNext } = createControllerChain({ host, apply: store.apply, flags, runCycle, cycleTimer });
    const persist = createPersistence(host);
    const resume = createResumeHold({ host, apply: store.apply, flags, start: () => lifecycle.start() });
    const lifecycle = createLifecycle({
        host,
        apply: store.apply,
        flags,
        writers,
        cycleTimer,
        resume,
        persist,
        runCycle,
        scheduleNext,
    });

    /**
     * Cancel the cycle timer and the resume hold, drop every state listener,
     * and stop a pending maybeResume() from arming anything after the mount
     * went away. Does not change the persisted running flag and does not
     * dispatch STOP: the session outlives its mount. Whatever is still in
     * flight on the disposed controller (a cycle's await, a start()'s setup)
     * finds every guard closed and updates nothing.
     */
    const dispose = (): void => {
        disposed = true;
        cancelCycleTimer(cycleTimer);
        resume.clearResumeTimer();
        store.clearListeners();
    };

    return {
        start: lifecycle.start,
        stop: lifecycle.stop,
        rearmSchedule: lifecycle.rearmSchedule,
        maybeResume: resume.maybeResume,
        dispose,
        getState: store.getState,
        subscribe: store.subscribe,
    };
};
