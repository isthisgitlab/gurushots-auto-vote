/**
 * The controller's start/stop lifecycle and the settings-change re-arm: the
 * flag transitions, the persisted markers, the background handoff, and the
 * first-cycle hand-off to the cadence chain.
 */

import { ACTIONS } from './state';

import type { Challenge } from '../types/gurushots';
import type { TimerHandle } from '../scheduling/cadenceChain';
import type { AutovoteAction } from './state';
import type { AutovotePersistence } from './persistence';
import type { ResumeHold } from './resume';
import type { AutovoteHost, SessionFlagWriters, SessionFlags } from './types';

/**
 * Cancel the cadence chain's armed timer, if any, leaving the slot as-is.
 * The GLOBAL clearTimeout: the chain armed this handle itself (it owns the
 * cycle timer), so the clear must reach the same timer seam the chain used.
 */
export const cancelCycleTimer = (timer: { current: TimerHandle | null }) => {
    if (timer.current) {
        clearTimeout(timer.current);
    }
};

/**
 * Cancel the armed timer and empty the slot, so the old timeout is stale under
 * the chain's generation guard.
 */
const clearCycleTimer = (timer: { current: TimerHandle | null }) => {
    cancelCycleTimer(timer);
    timer.current = null;
};

/** The lifecycle the controller exposes beside the resume hold. */
export type AutovoteLifecycle = {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    rearmSchedule: () => Promise<void>;
};

/** The controller's parts the lifecycle drives. */
type LifecycleDeps = {
    host: AutovoteHost;
    apply: (action: AutovoteAction) => void;
    flags: SessionFlags;
    writers: SessionFlagWriters;
    cycleTimer: { current: TimerHandle | null };
    resume: Pick<ResumeHold, 'resumeTimer' | 'clearResumeTimer'>;
    persist: AutovotePersistence;
    runCycle: () => Promise<Challenge[] | boolean>;
    scheduleNext: (prefetched?: Challenge[] | boolean | null, previousCycleStartMs?: number | null) => Promise<void>;
};

/**
 * Create the lifecycle over the controller's parts. `resume` is passed for
 * its timer slot and cancel — a start during the hold (manual, or the hold's
 * own timer) ends it, and a stop with a pending resume cancels it.
 */
export const createLifecycle = ({
    host,
    apply,
    flags,
    writers,
    cycleTimer,
    resume,
    persist,
    runCycle,
    scheduleNext,
}: LifecycleDeps): AutovoteLifecycle => {
    /**
     * Re-arm the cadence timer after a settings change while running. The
     * armed timer was computed from the old settings, so a newly-configured
     * threshold or scheduled-fill window could otherwise be slept past until
     * the current (possibly hours-long normal-mode) wait elapses. No-op when
     * autovote is stopped or the controller is disposed. Clearing the timer
     * first makes the old timeout stale under scheduleNext's generation guard.
     */
    const rearmSchedule = async (): Promise<void> => {
        if (!flags.running() || flags.disposed()) return;
        clearCycleTimer(cycleTimer);
        await scheduleNext();
    };

    /**
     * Start autovote
     */
    const start = async (): Promise<void> => {
        writers.setUserActed();
        if (flags.running()) return;

        // A start during the hold (manual, or the hold's own timer) ends it.
        resume.clearResumeTimer();
        apply({ type: ACTIONS.START });
        // Mark running synchronously: the subscribers that copy the state only
        // hear back after the current async turn, so without this the awaits
        // below (and the cycle/scheduling that follow) would still
        // see running === false and bail before arming the timer.
        writers.setRunning(true);
        await host.setCancelVoting(false);
        // A stop (or a remount racing the setup) must not leave the later
        // side effects behind: re-read the flag after every await and bail
        // before the next one lands.
        if (!flags.running()) return;

        // Persist the running flag so a remount can resume voting without
        // the user tapping Start again, after the launch marker (see above).
        await persist.persistStartedLaunch();
        if (!flags.running()) return;
        await persist.persistRunningFlag(true);
        if (!flags.running()) return;

        // The JS-side cycle below still runs while the app is open so the
        // user gets immediate visual feedback (cycle counter, last-run
        // timestamp) and the in-app boost / turbo / fill surfaces keep working.
        await host.background.start(host.translate('app.autovoteNotificationPreparing'));
        if (!flags.running()) return;

        // Run immediately
        const initialCycleStartMs = Date.now();
        const initialChallenges = await runCycle();

        // Hand off to the unified cadence chain. The shared decision (fast
        // in-window / capped approaching / normal) means start() doesn't need
        // to special-case "already inside a window" — scheduleNext picks the
        // right cadence from the initial cycle's challenge list.
        clearCycleTimer(cycleTimer);
        await scheduleNext(initialChallenges, initialCycleStartMs);
    };

    /**
     * Stop autovote
     */
    const stop = async (): Promise<void> => {
        writers.setUserActed();
        if (!flags.running()) {
            // Not running: only a pending auto-resume has anything to cancel.
            if (!resume.resumeTimer.current) return;
            resume.clearResumeTimer();
            apply({ type: ACTIONS.SET_PENDING_START, payload: null });
            void host.logRendererDebug('Auto-resume cancelled');
            // Same as a stop: a relaunch must not resume it, and the host has
            // nothing to run (a native service that outlived the app is adopted
            // on mount, never held, so none is running here).
            await persist.persistRunningFlag(false);
            await host.background.stop();
            return;
        }

        apply({ type: ACTIONS.STOP });
        // Mark stopped synchronously so an in-flight scheduleNext / timer
        // callback sees it immediately rather than after the next render flush.
        writers.setRunning(false);
        await host.setCancelVoting(true);

        // Clear the persisted running flag so a relaunch does not
        // auto-resume an explicitly stopped session.
        await persist.persistRunningFlag(false);

        await host.background.stop();

        // Clear the cadence timer.
        clearCycleTimer(cycleTimer);

        // Trigger challenges refresh to show vote buttons
        const refresh = host.getOnChallengesRefresh();
        if (refresh) {
            refresh();
        }
    };

    return { start, stop, rearmSchedule };
};
