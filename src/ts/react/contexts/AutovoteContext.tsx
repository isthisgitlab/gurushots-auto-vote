import { createContext, useContext, useReducer, useCallback, useEffect, useMemo, useRef } from 'react';
import { createCadenceChain, DECISION_ERROR_MESSAGE, formatOversleptMessage } from '../../scheduling/cadenceChain';
import { startupResumeAt } from '../../scheduling/startupDelay';
import { finiteOr } from '../../numbers';
import * as foregroundService from '../../services/ForegroundServiceController';
import * as nativeAutovote from '../../services/NativeAutovoteBridge';
import { ACTIONS, initialState, autovoteReducer } from './autovoteReducer';
import {
    resolveThreshold,
    resolveScheduledFill,
    resolveFinalWindowTopUp,
    resolveBoostPrefill,
    resolveCurrencyAuto,
    resolveScenarioWake,
} from './autovoteScheduler';
import { createDeadlineNotifier, deliverElectronNotification } from '../notifications/deadlineNotifier';
import { createRendererScenarioNotifier } from '../notifications/scenarioNotifier';
import { useLatestRef } from '../hooks/useLatestRef';
import { rendererTranslator } from '../../translations/renderer';
import { interp } from '../utils/interp';
import * as ipc from '../api/ipc';
import { isNativePlatform } from '../api/usePlatformCapabilities';
import { dateLocale } from '../utils/formatters';

import type { ComponentChildren } from 'preact';
import type { Dispatch } from 'react';
import type { Challenge } from '../../types/gurushots';
import type { TimerHandle } from '../../scheduling/cadenceChain';
import type { AutovoteAction, AutovoteState } from './autovoteReducer';
import { errorMessage } from '../../errorMessage';

/**
 * A per-cycle notifier the cadence chain calls with the cycle's challenges.
 */
export type CycleNotifier = (challenges: Challenge[], now: number) => unknown;

/**
 * What useAutovote returns: the state machine's state plus its controls.
 */
export type AutovoteContextValue = AutovoteState & {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    toggle: () => Promise<void>;
    rearmSchedule: () => Promise<void>;
};

const AutovoteContext = createContext<AutovoteContextValue | null>(null);

/**
 * Cancel the cadence chain's armed timer, if any, leaving the slot as-is.
 */
function cancelCycleTimer(timerRef: { current: TimerHandle | null }) {
    if (timerRef.current) {
        clearTimeout(timerRef.current);
    }
}

/**
 * Cancel the armed timer and empty the slot, so the old timeout is stale under
 * the chain's generation guard.
 */
function clearCycleTimer(timerRef: { current: TimerHandle | null }) {
    cancelCycleTimer(timerRef);
    timerRef.current = null;
}

/**
 * Persist the running flag so a remount of the app (Capacitor re-launch,
 * Electron window reopen) resumes — or, once cleared, does not resume — voting.
 * Best-effort: a failure only means the next launch won't match.
 */
async function persistRunningFlag(running: boolean) {
    try {
        await ipc.setSetting('autovoteRunning', running);
    } catch {
        /* ignore */
    }
}

/**
 * Record which app launch started this session: the launch time itself, which
 * the main process compares for equality with its own to tell a session started
 * in this launch from one still held at launch. Written BEFORE the running
 * flag. 0 when the launch time can't be read, which matches no launch, so the
 * main process then treats the session as not live (no spend) rather than live.
 */
async function persistStartedLaunch() {
    try {
        const env = await ipc.callOrNull(() => ipc.getEnvironmentInfo());
        await ipc.setSetting('autovoteStartedLaunch', finiteOr(env?.launchedAt, 0));
    } catch (err) {
        void ipc.logRendererWarning(`Could not record the auto-vote launch marker: ${errorMessage(err) || err}`);
    }
}

// The hold timer re-arms in chunks this long: a renderer timer is monotonic and
// fires late after a system sleep, so the wall clock is re-read between chunks.
const HOLD_CHUNK_MS = 5000;

/**
 * Hand scheduling to the Android background host. On Capacitor the native
 * AutoVote plugin owns the foreground notification, AlarmManager schedule and
 * per-cycle HTTP work — voting continues even when the WebView is destroyed
 * (app swiped from recents). Where the native plugin is not available, fall
 * back to the foreground-notification-only plugin so there is still a visual
 * indicator. Both are no-ops on Electron.
 */
async function startBackgroundHost() {
    const native = await nativeAutovote.start();
    if (!native.available) {
        await foregroundService.start({ body: rendererTranslator.t('app.autovoteNotificationPreparing') });
    }
}

/**
 * Stop the native background loop on Capacitor (the plugin tears down its own
 * foreground notification), falling back to the simple foreground-service
 * controller when native is not available.
 */
async function stopBackgroundHost() {
    const native = await nativeAutovote.stop();
    if (!native.available) {
        await foregroundService.stop();
    }
}

/**
 * Record a successful cycle: bump the counter, stamp the last-run time, and
 * refresh the persistent notification text on Capacitor so the user can see
 * at a glance when the last cycle ran without opening the app (no-op on
 * Electron).
 */
function recordCycleSuccess(dispatch: Dispatch<AutovoteAction>) {
    dispatch({ type: ACTIONS.INCREMENT_CYCLE });
    const lastRunStr = new Date().toLocaleTimeString(dateLocale());
    dispatch({ type: ACTIONS.UPDATE_LAST_RUN, payload: lastRunStr });
    void foregroundService.update({
        body: interp(rendererTranslator.t('app.autovoteNotificationLastCycle'), { time: lastRunStr }),
    });
}

/**
 * Run a single voting cycle. On success resolves with the active-challenge
 * list the cycle fetched, so the threshold scheduler can reuse it instead of
 * issuing a second IPC fetch; resolves falsy on failure / not-running /
 * not-logged-in (callers fall back to fetching).
 *
 * @returns The fetched challenge list on success (or
 *   `true` when the cycle succeeded without surfacing one), `false` otherwise.
 *   Consumers MUST treat any non-array as "fetch fresh" (Array.isArray guard).
 */
async function runRendererVotingCycle({
    runningRef,
    dispatch,
    onChallengesRefresh,
}: {
    runningRef: { current: boolean };
    dispatch: Dispatch<AutovoteAction>;
    onChallengesRefresh?: () => unknown;
}): Promise<Challenge[] | boolean> {
    if (!runningRef.current) {
        return false;
    }

    try {
        const settings = await ipc.getSettings();
        if (!settings.hasToken) {
            dispatch({ type: ACTIONS.SET_ERROR, payload: 'not-logged-in' });
            return false;
        }

        const result = await ipc.runVotingCycle();

        if (!runningRef.current) {
            return false;
        }

        if (!result?.success) {
            void ipc.logRendererWarning(`Voting cycle failed: ${result?.error || 'no reason given'}`);
            dispatch({ type: ACTIONS.SET_ERROR, payload: result?.error || 'voting-failed' });
            return false;
        }

        recordCycleSuccess(dispatch);
        if (onChallengesRefresh) {
            onChallengesRefresh();
        }

        // Hand the fetched list back so the threshold scheduler can skip its
        // own fetch. Fall back to `true` (truthy, but not an array) when no
        // list is present so callers fetch fresh.
        return result.challenges ?? true;
    } catch (err) {
        void ipc.logRendererWarning(`Voting cycle threw: ${errorMessage(err) || err}`);
        dispatch({ type: ACTIONS.SET_ERROR, payload: 'voting-error' });
        return false;
    }
}

/**
 * Build the per-cycle OS notifier for this platform — deadline warnings plus
 * scenario notices — on Electron; `null` on native Android, where the native
 * foreground service is authoritative — so the notifier is NOT wired there at
 * all (that both avoids a dual-loop double-fire and the per-cycle IPC that
 * would only be discarded). See deadlineNotifier.ts header.
 */
function createRendererDeadlineNotifier(): CycleNotifier | null {
    // Native Android gets `null` — the native foreground service is authoritative there.
    const deliver = isNativePlatform() ? null : deliverElectronNotification;
    if (!deliver) return null;
    const shared = {
        getSetting: (key: string) => ipc.getGlobalDefault(key),
        translate: (key: string) => rendererTranslator.t(key),
        deliver,
        log: (msg: string) => ipc.logRendererDebug(msg),
    };
    const deadlines = createDeadlineNotifier({
        ...shared,
        getDeadlineActions: (challenge) => ipc.getDeadlineActions(challenge),
    });
    const scenarios = createRendererScenarioNotifier({
        ...shared,
        getScenarioStatus: (challengeId) => ipc.getScenarioStatus(challengeId),
    });
    // Both are self-contained and never throw.
    return (challenges, now) => Promise.all([deadlines(challenges, now), scenarios(challenges)]);
}

/**
 * The shared cadence chain (decide delay → arm the single timer → run cycle
 * → re-arm) from src/ts/scheduling/cadenceChain.ts — the same loop the
 * CLI/Android scheduler drives. This only supplies the WebView transport:
 * settings + challenges over IPC, the per-challenge IPC resolvers, the timer
 * slot (`cycleTimerRef`, whose identity doubles as the staleness guard for
 * start()/rearmSchedule() takeovers), and best-effort IPC logging.
 *
 * @param deps.notifier - per-cycle deadline notifier, or null when not wired
 */
function createRendererCadenceChain({
    runningRef,
    cycleTimerRef,
    runVotingCycle,
    dispatch,
    notifier,
}: {
    runningRef: { current: boolean };
    cycleTimerRef: { current: TimerHandle | null };
    runVotingCycle: () => Promise<Challenge[] | boolean>;
    dispatch: Dispatch<AutovoteAction>;
    notifier: CycleNotifier | null;
}) {
    return createCadenceChain({
        isRunning: () => runningRef.current,
        getTimer: () => cycleTimerRef.current,
        setTimer: (handle) => {
            cycleTimerRef.current = handle;
        },
        loadSettings: async () => (await ipc.getSettings()).app,
        fetchChallenges: () => ipc.getActiveChallenges(),
        // The key-agnostic channel is typed `unknown`; the main process resolves
        // the schema-validated (numeric) effective value.
        resolveLastMinuteCheckMinutes: () =>
            ipc.getEffectiveSetting('lastMinuteCheckFrequency', 'global') as Promise<number>,
        resolveThreshold,
        resolveScheduledFill,
        resolveFinalWindowTopUp,
        resolveBoostPrefill,
        resolveCurrencyAuto,
        resolveScenarioWake,
        runCycle: () => runVotingCycle(),
        log: {
            // Best-effort parity log (the logRenderer* helpers tolerate a
            // host without the log method, e.g. a minimal Capacitor bridge,
            // so logging can't abort scheduling). Normal-mode lines stay
            // CLI-only — no IPC spam for the common case.
            cadence: (mode, message) => (mode === 'normal' ? undefined : ipc.logRendererDebug(message)),
            decisionError: (err) => ipc.logRendererWarning(`${DECISION_ERROR_MESSAGE}: ${errorMessage(err) || err}`),
            // runVotingCycle catches internally and resolves false, so a
            // rejection here is a can't-happen TODAY — but that is an
            // invariant of a different module. Log best-effort instead
            // of swallowing so a future regression can't fail silently.
            cycleError: (err) => ipc.logRendererWarning(`Voting cycle failed: ${errorMessage(err) || err}`),
            // A renderer timer that fired far late means the page was
            // throttled/frozen or the machine suspended, and every
            // deadline inside that gap went unserved. Warning, not
            // debug: this is the only trace of a silently missed fill,
            // and it lands on the Logs page the user actually reads.
            // Wording is shared with the Node host so the two surfaces
            // cannot drift.
            overslept: (lateMs, waitMs) => ipc.logRendererWarning(formatOversleptMessage(lateMs, waitMs)),
        },
        // Surface the next armed cycle as an absolute wall-clock instant
        // for the status header's countdown; null clears it. dispatch is
        // stable across renders.
        onScheduled: (waitMs) =>
            dispatch({
                type: ACTIONS.SET_NEXT_RUN,
                payload: typeof waitMs === 'number' ? Date.now() + waitMs : null,
            }),
        // Best-effort per-cycle OS notification for upcoming deadline
        // actions. Stable instance (see the provider's notifierRef) so it
        // dedupes across cycles; the chain fires it in its own isolated
        // wrapper so a throw here can never affect scheduling. `undefined` on
        // native Android (notifier not wired) so the chain skips the hook.
        onCycleChallenges: notifier || undefined,
    });
}

/**
 * Cancel the hold timer of a pending auto-resume and empty its slot.
 */
function clearResumeTimer(timerRef: { current: TimerHandle | null }) {
    if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
    }
}

/**
 * Auto-resume on mount if a previous session left autovoteRunning persisted
 * as true (user toggled Start, then closed the app or restarted the device).
 * Skips when there is no token, otherwise the loop would error every cycle
 * until the user logs in. The deps are stable refs and a stable dispatch, so
 * this runs once per mount — no extra ran-once guard. `start` is read through
 * a ref: its identity changes with its own deps (runVotingCycle / threshold
 * scheduling), and this must stay a single mount-time check, not re-trigger
 * on each change; start()'s own running guard prevents double-starts.
 *
 * The resume is held until `autovoteStartupDelay` seconds after the app
 * LAUNCHED (not after this mount), so a window reload continues the same hold
 * and one after it has passed resumes at once. A native service that is
 * already running is adopted at once: voting never stopped. While held,
 * `pendingStartAt` is set and a chunked timer in `resumeTimerRef` calls start()
 * once the wall clock reaches the resume time (see HOLD_CHUNK_MS). An unmount,
 * or any start/stop by the user during the awaits, leaves nothing armed.
 */
function useResumeOnMount({
    start,
    dispatch,
    runningRef,
    userActedRef,
    resumeTimerRef,
}: {
    start: () => Promise<void>;
    dispatch: Dispatch<AutovoteAction>;
    runningRef: { current: boolean };
    userActedRef: { current: boolean };
    resumeTimerRef: { current: TimerHandle | null };
}) {
    const startRef = useLatestRef(start);
    useEffect(() => {
        let cancelled = false;
        const maybeResume = async () => {
            try {
                const wasRunning = await ipc.getSetting('autovoteRunning');
                if (!wasRunning) return;
                const settings = await ipc.getSettings();
                if (!settings?.hasToken) return;
                const native = await nativeAutovote.getStatus();
                if (native.running) {
                    if (!cancelled) await startRef.current();
                    return;
                }
                // An unreadable delay or launch time still holds the session back
                // (default delay; the mount as launch), never starts it at once.
                const [delay, env] = await Promise.all([
                    ipc.callOrNull(() => ipc.getGlobalDefault('autovoteStartupDelay')),
                    ipc.callOrNull(() => ipc.getEnvironmentInfo()),
                ]);
                if (cancelled || runningRef.current || userActedRef.current) return;
                const resumeAt = startupResumeAt(finiteOr(env?.launchedAt, Date.now()), delay);
                const waitMs = resumeAt - Date.now();
                if (waitMs <= 0) {
                    await startRef.current();
                    return;
                }
                dispatch({ type: ACTIONS.SET_PENDING_START, payload: resumeAt });
                void ipc.logRendererDebug(`Auto-resume held for ${Math.ceil(waitMs / 1000)}s after launch`);
                const tick = () => {
                    resumeTimerRef.current = null;
                    const left = resumeAt - Date.now();
                    if (left > 0) {
                        resumeTimerRef.current = setTimeout(tick, Math.min(left, HOLD_CHUNK_MS));
                        return;
                    }
                    void ipc.logRendererDebug('Auto-resume hold over — starting');
                    startRef
                        .current()
                        .catch((err) => ipc.logRendererError(`Auto-resume failed: ${errorMessage(err) || err}`));
                };
                resumeTimerRef.current = setTimeout(tick, Math.min(waitMs, HOLD_CHUNK_MS));
            } catch {
                /* ignore — leave UI in stopped state on failure */
            }
        };
        void maybeResume();
        return () => {
            cancelled = true;
            clearResumeTimer(resumeTimerRef);
        };
    }, [startRef, dispatch, runningRef, userActedRef, resumeTimerRef]);
}

/**
 * Provider for autovote state machine
 */
export function AutovoteProvider({
    children,
    onChallengesRefresh,
}: {
    children?: ComponentChildren;
    onChallengesRefresh?: () => unknown;
}) {
    const [state, dispatch] = useReducer(autovoteReducer, initialState);

    // Refs to prevent stale closures in the timer chain.
    const runningRef = useRef(state.running);
    // Single recursive setTimeout handle for the whole cadence chain. Each cycle
    // decides its own next delay (fast in-window / capped approaching / normal)
    // via the shared computeNextCycleDelayMs, so there is no separate fast-mode
    // interval or boundary-switch timer to keep in sync.
    const cycleTimerRef = useRef<TimerHandle | null>(null);
    // One-shot timer of a pending auto-resume (see useResumeOnMount). Deliberately
    // separate from cycleTimerRef: it is not part of the cadence chain, so the
    // scheduleNext generation guard neither sees nor cancels it. Armed means pending.
    const resumeTimerRef = useRef<TimerHandle | null>(null);
    // Set by start() and stop(): the user (or the hold itself) has acted, so a
    // mount-time resume still waiting on its awaits must not arm the hold.
    const userActedRef = useRef(false);

    // Per-cycle OS deadline-notifier. Created ONCE (a fresh instance each render
    // would never dedupe): it holds the fired-key Set + re-entrancy guard across
    // cycles. `undefined` = not yet initialized; the stored value is the notifier
    // on Electron or `null` on native Android.
    const notifierRef = useRef<CycleNotifier | null | undefined>(undefined);
    if (notifierRef.current === undefined) {
        notifierRef.current = createRendererDeadlineNotifier();
    }

    // Keep runningRef in sync with state. Publishing through a window
    // CustomEvent lets the ancestor tree (AppWithChallenges, which feeds
    // ChallengesProvider's autovoteRunning prop) react without a 1-Hz
    // polling timer or a window.* global. dispatchEvent + CustomEvent
    // exist in every target (Electron Chromium, Capacitor WebView,
    // happy-dom test env).
    useEffect(() => {
        runningRef.current = state.running;
        window.dispatchEvent(new CustomEvent('autovote:running-changed', { detail: state.running }));
    }, [state.running]);

    // Cleanup on unmount
    useEffect(() => () => cancelCycleTimer(cycleTimerRef), []);

    const runVotingCycle = useCallback(
        () => runRendererVotingCycle({ runningRef, dispatch, onChallengesRefresh }),
        [onChallengesRefresh],
    );

    // Re-created when runVotingCycle changes identity.
    const cadenceChain = useMemo(
        () =>
            createRendererCadenceChain({
                runningRef,
                cycleTimerRef,
                runVotingCycle,
                dispatch,
                // Initialized during the first render (above), never `undefined` here.
                notifier: notifierRef.current as CycleNotifier | null,
            }),
        [runVotingCycle],
    );
    const scheduleNext = cadenceChain.scheduleNext;

    /**
     * Re-arm the cadence timer after a settings change while running. The
     * armed timer was computed from the old settings, so a newly-configured
     * threshold or scheduled-fill window could otherwise be slept past until
     * the current (possibly hours-long normal-mode) wait elapses. No-op when
     * autovote is stopped. Clearing the timer first makes the old timeout
     * stale under scheduleNext's generation guard.
     */
    const rearmSchedule = useCallback(async () => {
        if (!runningRef.current) return;
        clearCycleTimer(cycleTimerRef);
        await scheduleNext();
    }, [scheduleNext]);

    /**
     * Start autovote
     */
    const start = useCallback(async () => {
        userActedRef.current = true;
        if (runningRef.current) return;

        // A start during the hold (manual, or the hold's own timer) ends it.
        clearResumeTimer(resumeTimerRef);
        dispatch({ type: ACTIONS.START });
        // Mark running synchronously: the dispatch-driven useEffect that syncs
        // runningRef only flushes after the current async turn, so without this
        // the awaits below (and the cycle/scheduling that follow) would still
        // see runningRef.current === false and bail before arming the timer.
        runningRef.current = true;
        await ipc.setCancelVoting(false);

        // Persist the running flag so a remount can resume voting without
        // the user tapping Start again, after the launch marker (see above).
        await persistStartedLaunch();
        await persistRunningFlag(true);

        // The JS-side cycle below still runs while the app is open so the
        // user gets immediate visual feedback (cycle counter, last-run
        // timestamp) and the in-app boost / turbo / fill surfaces keep working.
        await startBackgroundHost();

        // Run immediately
        const initialCycleStartMs = Date.now();
        const initialChallenges = await runVotingCycle();

        // Hand off to the unified cadence chain. The shared decision (fast
        // in-window / capped approaching / normal) means start() doesn't need
        // to special-case "already inside a window" — scheduleNext picks the
        // right cadence from the initial cycle's challenge list.
        clearCycleTimer(cycleTimerRef);
        await scheduleNext(initialChallenges, initialCycleStartMs);
    }, [runVotingCycle, scheduleNext]);

    /**
     * Stop autovote
     */
    const stop = useCallback(async () => {
        userActedRef.current = true;
        if (!runningRef.current) {
            // Not running: only a pending auto-resume has anything to cancel.
            if (!resumeTimerRef.current) return;
            clearResumeTimer(resumeTimerRef);
            dispatch({ type: ACTIONS.SET_PENDING_START, payload: null });
            void ipc.logRendererDebug('Auto-resume cancelled');
            // Same as a stop: a relaunch must not resume it, and the host has
            // nothing to run (a native service that outlived the app is adopted
            // on mount, never held, so none is running here).
            await persistRunningFlag(false);
            await stopBackgroundHost();
            return;
        }

        dispatch({ type: ACTIONS.STOP });
        // Mark stopped synchronously so an in-flight scheduleNext / timer
        // callback sees it immediately rather than after the next render flush.
        runningRef.current = false;
        await ipc.setCancelVoting(true);

        // Clear the persisted running flag so a relaunch does not
        // auto-resume an explicitly stopped session.
        await persistRunningFlag(false);

        await stopBackgroundHost();

        // Clear the cadence timer.
        clearCycleTimer(cycleTimerRef);

        // Trigger challenges refresh to show vote buttons
        if (onChallengesRefresh) {
            onChallengesRefresh();
        }
    }, [onChallengesRefresh]);

    useResumeOnMount({ start, dispatch, runningRef, userActedRef, resumeTimerRef });

    /**
     * Toggle autovote
     */
    const toggle = useCallback(async () => {
        if (runningRef.current) {
            await stop();
        } else {
            await start();
        }
    }, [start, stop]);

    // Memoized so consumers re-render only when the state or a control
    // actually changes, not on every provider render (e.g. when the parent
    // re-renders with the same onChallengesRefresh).
    const value = useMemo(
        () => ({
            ...state,
            start,
            stop,
            toggle,
            rearmSchedule,
        }),
        [state, start, stop, toggle, rearmSchedule],
    );

    return <AutovoteContext.Provider value={value}>{children}</AutovoteContext.Provider>;
}

/**
 * Hook to access autovote state and controls
 */
export function useAutovote(): AutovoteContextValue {
    const context = useContext(AutovoteContext);
    if (!context) {
        throw new Error('useAutovote must be used within an AutovoteProvider');
    }
    return context;
}
