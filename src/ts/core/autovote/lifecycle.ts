/**
 * The controller's start/stop lifecycle and the settings-change re-arm: the execution-mode transitions, the persisted
 * markers, the background handoff, the first-cycle hand-off to the cadence chain, and the priority full Stop.
 *
 * Execution modes (state.ts): `stopped` (no chain), `armed` (the chain runs for the installation scenario with the voting
 * stages paused) and `voting`. Every request that can arm or resume carries the capture taken when it was created (the run
 * gate, ./runGate.ts) and is admitted at the arm boundary; a full Stop latches first, so nothing created before it arms.
 */

import { ACTIONS } from './state';
import { errorMessage } from '../errorMessage';

import type { Challenge } from '../types/gurushots';
import type { createCadenceChain, TimerHandle } from '../scheduling/cadenceChain';
import type { RunCapture } from '../scheduling/cadenceChain/types';
import type { AutovoteAction } from './state';
import type { AutovotePersistence } from './persistence';
import type { ResumeHold } from './resume';
import type { RunGate, WithdrawalOutcome } from './runGate';
import type { AutovoteHost, SessionFlagWriters, SessionFlags, VotingStagesResult } from './types';

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

/** Who a request to run speaks for: the user's own Run, or the startup resume. Only the user's may lift a Stop block. */
type StartRoute = 'user' | 'startup';

/** The lifecycle the controller exposes beside the resume hold. */
export type AutovoteLifecycle = {
    start: () => Promise<void>;
    startAs: (route: StartRoute, request: RunCapture) => Promise<void>;
    stop: () => Promise<void>;
    arm: () => Promise<void>;
    requestVotingStages: (on: boolean, captured: RunCapture) => Promise<VotingStagesResult>;
    rearmSchedule: () => Promise<void>;
    /** The fence refused a timer (a Stop recorded elsewhere): this run is over, without recording another Stop. */
    endObsoleteRun: () => Promise<void>;
};

/** The controller's parts the lifecycle drives. */
type LifecycleDeps = {
    host: AutovoteHost;
    apply: (action: AutovoteAction) => void;
    flags: SessionFlags;
    writers: SessionFlagWriters;
    gate: RunGate;
    cycleTimer: { current: TimerHandle | null };
    resume: Pick<ResumeHold, 'resumeTimer' | 'clearResumeTimer'>;
    persist: AutovotePersistence;
    runCycle: () => Promise<Challenge[] | boolean>;
    scheduleNext: ReturnType<typeof createCadenceChain>['scheduleNext'];
};

let stopCounter = 0;
/** A request identity for one Stop: unique within this process, and across processes by its time. */
const newStopId = (): string => `stop-${Date.now().toString(36)}-${(stopCounter++).toString(36)}`;

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
    gate,
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

    /** The withdrawal of the installation's publication, as the host reports it; a failure is logged and reported, never thrown. */
    const withdraw = async (epoch: number): Promise<WithdrawalOutcome> => {
        if (!host.withdrawInstallation) return 'no-route';
        try {
            return await host.withdrawInstallation(epoch);
        } catch (err) {
            void host.logRendererWarning(`Installation settings could not be withdrawn: ${errorMessage(err) || err}`);
            return 'failed';
        }
    };

    /**
     * An explicit user re-arm lifts the withdrawal before the next publication; nothing else does. One that stands is said (the
     * installation then publishes nothing until the next explicit re-arm).
     */
    const reArmInstallation = async (): Promise<void> => {
        try {
            if ((await host.reArmInstallation?.()) === 'failed') {
                void host.logRendererWarning(
                    'The installation scenario could not be re-armed: its withdrawal still stands',
                );
            }
        } catch (err) {
            void host.logRendererWarning(
                `The installation scenario could not be re-armed: ${errorMessage(err) || err}`,
            );
        }
    };

    /** The epoch the fence last acknowledged, onto the state (a host without a fence has none to show). */
    const noteEpoch = (): void => {
        const epoch = gate.knownEpoch();
        if (epoch !== null) apply({ type: ACTIONS.SET_STOP_EPOCH, payload: epoch });
    };

    /** Whether the run a request started is still the live one: not stopped, not superseded by a Stop. */
    const live = (run: RunCapture): boolean => flags.running() && gate.current(run);

    /** The first cycle and the hand-off to the chain, for a run that was just admitted. */
    const firstCycle = async (run: RunCapture): Promise<void> => {
        const initialCycleStartMs = Date.now();
        const initialChallenges = await runCycle();
        // A Stop that arrived during the cycle: nothing is handed to the chain.
        if (!live(run)) return;
        clearCycleTimer(cycleTimer);
        await scheduleNext(initialChallenges, initialCycleStartMs);
    };

    /** Turns the voting stages on: the markers, the background host, and a re-armed chain under the same run. */
    const resumeVoting = async (run: RunCapture): Promise<void> => {
        apply({ type: ACTIONS.SET_EXECUTION_MODE, payload: 'voting' });
        writers.setMode('voting');
        await persist.persistStartedLaunch();
        if (!live(run)) return;
        await persist.persistRunningFlag(true);
        if (!live(run)) return;
        await host.background.start(host.translate('app.autovoteNotificationPreparing'));
        if (!live(run)) return;
        clearCycleTimer(cycleTimer);
        await scheduleNext();
    };

    /** Turns the voting stages off under the same chain: it stays armed for the installation scenario. */
    const pauseVoting = async (run: RunCapture): Promise<void> => {
        apply({ type: ACTIONS.SET_EXECUTION_MODE, payload: 'armed' });
        writers.setMode('armed');
        await persist.persistRunningFlag(false);
        if (!live(run)) return;
        await host.background.stop();
        if (!live(run)) return;
        clearCycleTimer(cycleTimer);
        await scheduleNext();
    };

    /**
     * Start autovote under a route. The user's route is the only one that lifts a Stop block; a startup resume is admitted only
     * while the fence allows it.
     */
    const startAs = async (route: StartRoute, request: RunCapture): Promise<void> => {
        writers.setUserActed();
        if (flags.mode() === 'voting') return;
        // Armed: Run is Resume voting, under the chain that is already there (never a second one).
        if (flags.mode() === 'armed') {
            if (route === 'user') {
                const admitted = gate.fenced ? await gate.admitUser(request) : gate.admitLocal('user', request);
                if (admitted.ok) await resumeVoting(admitted.capture);
                else apply({ type: ACTIONS.SET_START_REFUSAL, payload: admitted.reason });
            }
            return;
        }

        // A start during the hold (manual, or the hold's own timer) ends it.
        resume.clearResumeTimer();
        const admitted = gate.fenced
            ? route === 'user'
                ? await gate.admitUser(request)
                : await gate.admitUnattended(request)
            : gate.admitLocal(route, request);
        if (!admitted.ok) {
            apply({ type: ACTIONS.SET_START_REFUSAL, payload: admitted.reason });
            return;
        }
        const run = admitted.capture;
        // Another start (or a stop and a start) landed while this one was admitted: only one run exists.
        if (flags.running()) return;
        noteEpoch();
        apply({ type: ACTIONS.START });
        // Mark running synchronously: the subscribers that copy the state only
        // hear back after the current async turn, so without this the awaits
        // below (and the cycle/scheduling that follow) would still
        // see running === false and bail before arming the timer.
        writers.setMode('voting');
        await host.setCancelVoting(false);
        // A stop (or a remount racing the setup) must not leave the later
        // side effects behind: re-read the flag after every await and bail
        // before the next one lands.
        if (!live(run)) return;

        // Persist the running flag so a remount can resume voting without
        // the user tapping Start again, after the launch marker
        // (persistence.ts's persistStartedLaunch).
        await persist.persistStartedLaunch();
        if (!live(run)) return;
        await persist.persistRunningFlag(true);
        if (!live(run)) return;

        // The JS-side cycle below still runs while the app is open so the
        // user gets immediate visual feedback (cycle counter, last-run
        // timestamp) and the in-app boost / turbo / fill surfaces keep working.
        await host.background.start(host.translate('app.autovoteNotificationPreparing'));
        if (!live(run)) return;

        // Run immediately, then hand off to the unified cadence chain. The shared decision (fast
        // in-window / capped approaching / normal) means start() doesn't need
        // to special-case "already inside a window" — scheduleNext picks the
        // right cadence from the initial cycle's challenge list.
        // The user's own Run lifts the withdrawal a Stop made, before the first publication; a startup resume never does.
        if (route === 'user') await reArmInstallation();
        if (!live(run)) return;
        await firstCycle(run);
    };

    /** The user's Run / Resume: the capture is taken now, when the request is created. */
    const start = (): Promise<void> => startAs('user', gate.capture());

    /**
     * The user's explicit installation arm: the chain runs for the installation scenario, the voting stages paused. A host that
     * has no installation-only cycle cannot be armed.
     */
    const arm = async (): Promise<void> => {
        const request = gate.capture();
        writers.setUserActed();
        if (flags.mode() !== 'stopped') return;
        if (!host.runArmedCycle) {
            apply({ type: ACTIONS.SET_START_REFUSAL, payload: 'no-armed-cycle' });
            return;
        }
        resume.clearResumeTimer();
        const admitted = gate.fenced ? await gate.admitUser(request) : gate.admitLocal('user', request);
        if (!admitted.ok) {
            apply({ type: ACTIONS.SET_START_REFUSAL, payload: admitted.reason });
            return;
        }
        if (flags.running()) return;
        noteEpoch();
        apply({ type: ACTIONS.SET_EXECUTION_MODE, payload: 'armed' });
        writers.setMode('armed');
        await reArmInstallation();
        if (!live(admitted.capture)) return;
        await firstCycle(admitted.capture);
    };

    /**
     * A scenario's request for the voting stages (`startAutovote` / `stopAutovote`). It acts only under an armed or voting
     * chain that is already there, only while its capture is current and the fence allows it, and it never lifts a Stop.
     */
    const requestVotingStages = async (on: boolean, captured: RunCapture): Promise<VotingStagesResult> => {
        const mode = flags.mode();
        // Turning the voting stages on resumes execution: its final decision is the fence's CAS. Anything else only reads it.
        const allowed = on && mode === 'armed' ? await gate.armsAt(captured) : await gate.admits(captured);
        if (!allowed) return { ok: false, reason: 'obsolete' };
        if (mode === 'stopped') return { ok: false, reason: 'not-armed' };
        if (on === (mode === 'voting')) return { ok: true, mode, changed: false };
        // The voting stages can be paused only under a chain that can keep running without them.
        if (!on && !host.runArmedCycle) return { ok: false, reason: 'unsupported' };
        const run = gate.run();
        if (on) await resumeVoting(run);
        else await pauseVoting(run);
        return live(run) ? { ok: true, mode: flags.mode(), changed: true } : { ok: false, reason: 'obsolete' };
    };

    /**
     * Full Stop, from every caller. In this order and without waiting for any queued Start or in-flight rule: the local latch
     * (every request captured before it is obsolete), the timer, the state; then the installation's publication is withdrawn
     * and the fence is recorded together; the existing side effects follow.
     */
    const stop = async (): Promise<void> => {
        writers.setUserActed();
        gate.latch();
        clearCycleTimer(cycleTimer);
        const wasLive = flags.running();
        const hadHold = resume.resumeTimer.current !== null;
        if (hadHold) {
            resume.clearResumeTimer();
            apply({ type: ACTIONS.SET_PENDING_START, payload: null });
            void host.logRendererDebug('Auto-resume cancelled');
        }
        if (wasLive) {
            apply({ type: ACTIONS.STOP });
            // Mark stopped synchronously so an in-flight scheduleNext / timer
            // callback sees it immediately rather than after the next render flush.
            writers.setMode('stopped');
        }
        // The withdrawal and the fence are written together: neither waits for the other, and neither undoes the local cancellation.
        const withdrawn = withdraw((gate.knownEpoch() ?? 0) + 1);
        const recorded = gate.persistStop(newStopId(), Date.now());
        if (wasLive) await host.setCancelVoting(true);
        // Clear the persisted running flag so a relaunch does not
        // auto-resume an explicitly stopped session. (A pending auto-resume is held on the same flag.)
        if (wasLive || hadHold) await persist.persistRunningFlag(false);
        // Not running: only a pending auto-resume has anything to cancel; a native service that outlived the app is adopted
        // on mount, never held, so none is running here.
        if (wasLive || hadHold) await host.background.stop();
        const result = await recorded;
        apply({ type: ACTIONS.SET_STOP_RESULT, payload: { ...result, withdrawal: await withdrawn } });
        if (result.outcome === 'stopped') apply({ type: ACTIONS.SET_STOP_EPOCH, payload: result.epoch });
        if (!wasLive) return;
        // Trigger challenges refresh to show vote buttons
        const refresh = host.getOnChallengesRefresh();
        if (refresh) {
            refresh();
        }
    };

    const endObsoleteRun = async (): Promise<void> => {
        if (!flags.running()) return;
        gate.latch();
        clearCycleTimer(cycleTimer);
        apply({ type: ACTIONS.STOP });
        writers.setMode('stopped');
        await host.setCancelVoting(true);
        await persist.persistRunningFlag(false);
        await host.background.stop();
    };

    return { start, startAs, stop, arm, requestVotingStages, rearmSchedule, endObsoleteRun };
};
