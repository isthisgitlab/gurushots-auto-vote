import { createContext, useContext, useReducer, useCallback, useEffect, useMemo, useRef } from 'react';
import { createCadenceChain, DECISION_ERROR_MESSAGE, formatOversleptMessage } from '../../scheduling/cadenceChain';
import * as foregroundService from '../../services/ForegroundServiceController';
import * as nativeAutovote from '../../services/NativeAutovoteBridge';
import { ACTIONS, initialState, autovoteReducer } from './autovoteReducer';
import {
    resolveThreshold,
    resolveScheduledFill,
    resolveFinalWindowTopUp,
    resolveBoostPrefill,
    resolveCurrencyAuto,
} from './autovoteScheduler';
import { createDeadlineNotifier, resolveRendererDelivery } from '../notifications/deadlineNotifier';
import { useLatestRef } from '../hooks/useLatestRef';
import { rendererTranslator } from '../../translations/renderer';
import * as ipc from '../api/ipc';

const AutovoteContext = createContext(null);

/**
 * Cancel the cadence chain's armed timer, if any, leaving the slot as-is.
 *
 * @param {{ current: any }} timerRef
 */
function cancelCycleTimer(timerRef) {
    if (timerRef.current) {
        clearTimeout(timerRef.current);
    }
}

/**
 * Cancel the armed timer and empty the slot, so the old timeout is stale under
 * the chain's generation guard.
 *
 * @param {{ current: any }} timerRef
 */
function clearCycleTimer(timerRef) {
    cancelCycleTimer(timerRef);
    timerRef.current = null;
}

/**
 * Persist the running flag so a remount of the app (Capacitor re-launch,
 * Electron window reopen) resumes — or, once cleared, does not resume — voting.
 * Best-effort: a failure only means the next launch won't match.
 *
 * @param {boolean} running
 */
async function persistRunningFlag(running) {
    try {
        await ipc.setSetting('autovoteRunning', running);
    } catch {
        /* ignore */
    }
}

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
        await foregroundService.start({ body: 'Auto-vote running — preparing first cycle' });
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
 *
 * @param {Function} dispatch
 */
function recordCycleSuccess(dispatch) {
    dispatch({ type: ACTIONS.INCREMENT_CYCLE });
    const lastRunStr = new Date().toLocaleTimeString('lv-LV');
    dispatch({ type: ACTIONS.UPDATE_LAST_RUN, payload: lastRunStr });
    foregroundService.update({ body: `Last cycle: ${lastRunStr}` });
}

/**
 * Run a single voting cycle. On success resolves with the active-challenge
 * list the cycle fetched, so the threshold scheduler can reuse it instead of
 * issuing a second IPC fetch; resolves falsy on failure / not-running /
 * not-logged-in (callers fall back to fetching).
 *
 * @param {object} deps
 * @param {{ current: boolean }} deps.runningRef
 * @param {Function} deps.dispatch
 * @param {Function} [deps.onChallengesRefresh]
 * @returns {Promise<Array|boolean>} The fetched challenge list on success (or
 *   `true` when the cycle succeeded without surfacing one), `false` otherwise.
 *   Consumers MUST treat any non-array as "fetch fresh" (Array.isArray guard).
 */
async function runRendererVotingCycle({ runningRef, dispatch, onChallengesRefresh }) {
    if (!runningRef.current) {
        return false;
    }

    try {
        const settings = await ipc.getSettings();
        if (!settings.token) {
            dispatch({ type: ACTIONS.SET_ERROR, payload: 'Not logged in' });
            return false;
        }

        const result = await ipc.runVotingCycle();

        if (!runningRef.current) {
            return false;
        }

        if (!result?.success) {
            dispatch({ type: ACTIONS.SET_ERROR, payload: result?.error || 'Voting failed' });
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
        dispatch({ type: ACTIONS.SET_ERROR, payload: err.message || 'Voting error' });
        return false;
    }
}

/**
 * Build the per-cycle OS deadline-notifier for this platform: the notifier on
 * Electron, `null` on native Android, where the native foreground service is
 * authoritative — so the notifier is NOT wired there at all (that both avoids a
 * dual-loop double-fire and the per-cycle IPC that would only be discarded).
 * See deadlineNotifier.js header.
 */
function createRendererDeadlineNotifier() {
    const isNativePlatform = globalThis.Capacitor?.isNativePlatform?.() === true;
    const deliver = resolveRendererDelivery(isNativePlatform);
    return deliver
        ? createDeadlineNotifier({
              getSettings: () => ipc.getSettings(),
              getDeadlineActions: (challenge) => ipc.getDeadlineActions(challenge),
              translate: (key) => rendererTranslator.t(key),
              deliver,
              log: (msg) => ipc.logRendererDebug(msg),
          })
        : null;
}

/**
 * The shared cadence chain (decide delay → arm the single timer → run cycle
 * → re-arm) from src/js/scheduling/cadenceChain.js — the same loop the
 * CLI/Android scheduler drives. This only supplies the WebView transport:
 * settings + challenges over IPC, the per-challenge IPC resolvers, the timer
 * slot (`cycleTimerRef`, whose identity doubles as the staleness guard for
 * start()/rearmSchedule() takeovers), and best-effort IPC logging.
 *
 * @param {object} deps
 * @param {{ current: boolean }} deps.runningRef
 * @param {{ current: any }} deps.cycleTimerRef
 * @param {() => Promise<Array|boolean>} deps.runVotingCycle
 * @param {Function} deps.dispatch
 * @param {Function|null} deps.notifier - per-cycle deadline notifier, or null when not wired
 */
function createRendererCadenceChain({ runningRef, cycleTimerRef, runVotingCycle, dispatch, notifier }) {
    return createCadenceChain({
        isRunning: () => runningRef.current,
        getTimer: () => cycleTimerRef.current,
        setTimer: (handle) => {
            cycleTimerRef.current = handle;
        },
        loadSettings: () => ipc.getSettings(),
        fetchChallenges: (settings) => ipc.getActiveChallenges(settings.token),
        resolveLastMinuteCheckMinutes: () => ipc.getEffectiveSetting('lastMinuteCheckFrequency', 'global'),
        resolveThreshold,
        resolveScheduledFill,
        resolveFinalWindowTopUp,
        resolveBoostPrefill,
        resolveCurrencyAuto,
        runCycle: () => runVotingCycle(),
        log: {
            // Best-effort parity log (the logRenderer* helpers tolerate a
            // host without the log method, e.g. a minimal Capacitor bridge,
            // so logging can't abort scheduling). Normal-mode lines stay
            // CLI-only — no IPC spam for the common case.
            cadence: (mode, message) => (mode === 'normal' ? undefined : ipc.logRendererDebug(message)),
            decisionError: (err) => ipc.logRendererWarning(`${DECISION_ERROR_MESSAGE}: ${err.message || err}`),
            // runVotingCycle catches internally and resolves false, so a
            // rejection here is a can't-happen TODAY — but that is an
            // invariant of a different module. Log best-effort instead
            // of swallowing so a future regression can't fail silently.
            cycleError: (err) => ipc.logRendererWarning(`Voting cycle failed: ${err?.message || err}`),
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
 * Auto-resume on mount if a previous session left autovoteRunning persisted
 * as true (user toggled Start, then closed the app or restarted the device).
 * Skips when there is no token, otherwise the loop would error every cycle
 * until the user logs in. The only dependency is a stable ref, so this runs
 * once per mount — no extra ran-once guard. `start` is read through that ref:
 * its identity changes with its own deps (runVotingCycle / threshold
 * scheduling), and this must stay a single mount-time check, not re-trigger
 * on each change; start()'s own running guard prevents double-starts.
 *
 * @param {() => Promise<void>} start
 */
function useResumeOnMount(start) {
    const startRef = useLatestRef(start);
    useEffect(() => {
        const maybeResume = async () => {
            try {
                const wasRunning = await ipc.getSetting('autovoteRunning');
                if (!wasRunning) return;
                const settings = await ipc.getSettings();
                if (!settings?.token) return;
                await startRef.current();
            } catch {
                /* ignore — leave UI in stopped state on failure */
            }
        };
        maybeResume();
    }, [startRef]);
}

/**
 * Provider for autovote state machine
 */
export function AutovoteProvider({ children, onChallengesRefresh }) {
    const [state, dispatch] = useReducer(autovoteReducer, initialState);

    // Refs to prevent stale closures in the timer chain.
    const runningRef = useRef(state.running);
    // Single recursive setTimeout handle for the whole cadence chain. Each cycle
    // decides its own next delay (fast in-window / capped approaching / normal)
    // via the shared computeNextCycleDelayMs, so there is no separate fast-mode
    // interval or boundary-switch timer to keep in sync.
    const cycleTimerRef = useRef(null);

    // Per-cycle OS deadline-notifier. Created ONCE (a fresh instance each render
    // would never dedupe): it holds the fired-key Set + re-entrancy guard across
    // cycles. `undefined` = not yet initialized; the stored value is the notifier
    // on Electron or `null` on native Android.
    const notifierRef = useRef(undefined);
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
                notifier: notifierRef.current,
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
        if (runningRef.current) return;

        dispatch({ type: ACTIONS.START });
        // Mark running synchronously: the dispatch-driven useEffect that syncs
        // runningRef only flushes after the current async turn, so without this
        // the awaits below (and the cycle/scheduling that follow) would still
        // see runningRef.current === false and bail before arming the timer.
        runningRef.current = true;
        await ipc.setCancelVoting(false);

        // Persist the running flag so a remount can resume voting without
        // the user tapping Start again.
        await persistRunningFlag(true);

        // The JS-side cycle below still runs while the app is open so the
        // user gets immediate visual feedback (cycle counter, last-run
        // timestamp) and the in-app boost / turbo / fill surfaces keep working.
        await startBackgroundHost();

        // Run immediately
        const initialCycleStartMs = Date.now();
        const initialChallenges = await runVotingCycle();

        // Hand off to the unified cadence chain. The shared decision (fast
        // in-window / capped approaching / normal) means start() no longer needs
        // to special-case "already inside a window" — scheduleNext picks the
        // right cadence from the initial cycle's challenge list.
        clearCycleTimer(cycleTimerRef);
        await scheduleNext(initialChallenges, initialCycleStartMs);
    }, [runVotingCycle, scheduleNext]);

    /**
     * Stop autovote
     */
    const stop = useCallback(async () => {
        if (!runningRef.current) return;

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

    useResumeOnMount(start);

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
export function useAutovote() {
    const context = useContext(AutovoteContext);
    if (!context) {
        throw new Error('useAutovote must be used within an AutovoteProvider');
    }
    return context;
}
