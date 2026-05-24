import { createContext, useContext, useReducer, useCallback, useEffect, useRef } from 'react';
import { getRandomCheckFrequencyMs, MIN_CYCLE_GAP_MS } from '../../scheduling/randomDelay';
import * as foregroundService from '../../services/ForegroundServiceController';
import * as nativeAutovote from '../../services/NativeAutovoteBridge';
import { ACTIONS, initialState, autovoteReducer } from './autovoteReducer';
import { computeNextCycleDelayMs } from './autovoteScheduler';

const AutovoteContext = createContext(null);

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

    // Keep runningRef in sync with state. Publishing through a window
    // CustomEvent lets ChallengesProvider's sibling tree react without
    // a 1-Hz polling timer. dispatchEvent + CustomEvent exist in every
    // target (Electron Chromium, Capacitor WebView, jsdom).
    useEffect(() => {
        runningRef.current = state.running;
        window.autovoteRunning = state.running;
        window.dispatchEvent(new CustomEvent('autovote:running-changed', { detail: state.running }));
    }, [state.running]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (cycleTimerRef.current) {
                clearTimeout(cycleTimerRef.current);
            }
        };
    }, []);

    /**
     * Run a single voting cycle. On success resolves with the active-challenge
     * list the cycle fetched, so the threshold scheduler can reuse it instead of
     * issuing a second IPC fetch; resolves falsy on failure / not-running /
     * not-logged-in (callers fall back to fetching).
     *
     * @returns {Promise<Array|boolean>} The fetched challenge list on success (or
     *   `true` when the cycle succeeded without surfacing one), `false` otherwise.
     *   Consumers MUST treat any non-array as "fetch fresh" (Array.isArray guard).
     */
    const runVotingCycle = useCallback(async () => {
        if (!runningRef.current) {
            return false;
        }

        try {
            const settings = await window.api.getSettings();
            if (!settings.token) {
                dispatch({ type: ACTIONS.SET_ERROR, payload: 'Not logged in' });
                return false;
            }

            const result = await window.api.runVotingCycle();

            if (!runningRef.current) {
                return false;
            }

            if (result?.success) {
                dispatch({ type: ACTIONS.INCREMENT_CYCLE });
                const lastRunStr = new Date().toLocaleTimeString('lv-LV');
                dispatch({ type: ACTIONS.UPDATE_LAST_RUN, payload: lastRunStr });

                // Refresh the persistent notification text on Capacitor
                // so the user can see at a glance when the last cycle
                // ran without opening the app. No-op on Electron.
                foregroundService.update({ body: `Last cycle: ${lastRunStr}` });

                // Trigger challenges refresh
                if (onChallengesRefresh) {
                    onChallengesRefresh();
                }

                // Hand the fetched list back so the threshold scheduler can skip
                // its own fetch. Fall back to `true` (truthy, but not an array)
                // when no list is present so callers fetch fresh.
                return result?.challenges ?? true;
            } else {
                dispatch({ type: ACTIONS.SET_ERROR, payload: result?.error || 'Voting failed' });
                return false;
            }
        } catch (err) {
            dispatch({ type: ACTIONS.SET_ERROR, payload: err.message || 'Voting error' });
            return false;
        }
    }, [onChallengesRefresh]);

    /**
     * Decide the delay until the next cycle and arm the single timer. Each cycle
     * picks its own cadence: fixed fast cadence while a challenge is in-window,
     * the rolled random delay capped to the soonest upcoming threshold entry
     * otherwise. `prefetched` reuses a just-completed cycle's challenge list; a
     * non-array (standalone re-arm or a cycle that surfaced no list) fetches
     * fresh. In normal mode the wait is anchored to the previous cycle start so
     * the gap between starts ≈ the delay; in approaching/last-minute mode it runs
     * from cycle completion so the boundary is never undershot.
     */
    const scheduleNext = useCallback(
        async (prefetched = null, previousCycleStartMs = null) => {
            if (!runningRef.current) {
                cycleTimerRef.current = null;
                return;
            }

            let waitMs;
            try {
                const settings = await window.api.getSettings();
                const normalDelayMs = getRandomCheckFrequencyMs(settings);
                const challenges = Array.isArray(prefetched)
                    ? prefetched
                    : (await window.api.getActiveChallenges(settings.token))?.challenges || [];
                const now = Math.floor(Date.now() / 1000);
                const lastMinuteCheckMinutes =
                    Number(await window.api.getEffectiveSetting('lastMinuteCheckFrequency', 'global')) || 1;

                const decision = await computeNextCycleDelayMs(challenges, now, {
                    normalDelayMs,
                    lastMinuteCheckMinutes,
                    minGapMs: MIN_CYCLE_GAP_MS,
                });

                if (decision.mode === 'normal') {
                    const anchorMs = previousCycleStartMs ?? Date.now();
                    const remainingMs = anchorMs + decision.delayMs - Date.now();
                    waitMs = Math.min(decision.delayMs, Math.max(MIN_CYCLE_GAP_MS, remainingMs));
                } else {
                    waitMs = decision.delayMs;
                    // Best-effort parity log (optional-chained so a host without
                    // logDebug, e.g. a minimal Capacitor bridge, can't abort scheduling).
                    await window.api.logDebug?.(
                        decision.mode === 'last-minute'
                            ? `⏰ Last-minute cadence — next cycle in ${Math.round(waitMs / 1000)}s`
                            : `⏰ Approaching last-minute window for "${decision.nextEntry?.challengeTitle}" — next cycle in ${Math.round(waitMs / 1000)}s`,
                    );
                }
            } catch (err) {
                await window.api.logWarning(
                    `Error computing next cycle delay; using normal cadence: ${err.message || err}`,
                );
                try {
                    waitMs = getRandomCheckFrequencyMs(await window.api.getSettings());
                } catch {
                    waitMs = getRandomCheckFrequencyMs({});
                }
            }

            if (!runningRef.current) {
                cycleTimerRef.current = null;
                return;
            }

            const timeoutId = setTimeout(async () => {
                // A newer chain may have taken over (e.g. start() re-armed); only
                // the timer that is still current may run + reschedule.
                if (!runningRef.current || cycleTimerRef.current !== timeoutId) return;
                const cycleStartMs = Date.now();
                let cycleChallenges;
                try {
                    cycleChallenges = await runVotingCycle();
                } finally {
                    if (cycleTimerRef.current === timeoutId) {
                        await scheduleNext(cycleChallenges, cycleStartMs);
                    }
                }
            }, waitMs);
            cycleTimerRef.current = timeoutId;
        },
        [runVotingCycle],
    );

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
        await window.api.setCancelVoting(false);

        // Persist the running flag so a remount of the app (Capacitor
        // re-launch, Electron window reopen) can resume voting without
        // the user tapping Start again. Best-effort; failure here just
        // means the resume on next launch won't kick in.
        try {
            await window.api.setSetting('autovoteRunning', true);
        } catch {
            /* ignore */
        }

        // On Capacitor, hand off scheduling to the native AutoVote
        // plugin. It owns the foreground notification, AlarmManager
        // schedule, and per-cycle HTTP work — voting continues even
        // when the WebView is destroyed (app swiped from recents).
        // The JS-side cycle below still runs while the app is open
        // so the user gets immediate visual feedback (cycle counter,
        // last-run timestamp) and the in-app boost / turbo / fill
        // surfaces continue to work.
        const native = await nativeAutovote.start();
        if (!native.available) {
            // Fall back to the foreground-notification-only plugin so
            // there is still a visual indicator on Android builds
            // where the native plugin is not available.
            await foregroundService.start({ body: 'Auto-vote running — preparing first cycle' });
        }

        // Run immediately
        const initialCycleStartMs = Date.now();
        const initialChallenges = await runVotingCycle();

        // Hand off to the unified cadence chain. The shared decision (fast
        // in-window / capped approaching / normal) means start() no longer needs
        // to special-case "already inside a window" — scheduleNext picks the
        // right cadence from the initial cycle's challenge list.
        if (cycleTimerRef.current) {
            clearTimeout(cycleTimerRef.current);
            cycleTimerRef.current = null;
        }
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
        await window.api.setCancelVoting(true);

        // Clear the persisted running flag so a relaunch does not
        // auto-resume an explicitly stopped session.
        try {
            await window.api.setSetting('autovoteRunning', false);
        } catch {
            /* ignore */
        }

        // Stop the native background loop on Capacitor; the plugin
        // tears down its own foreground notification. Fall back to
        // the simple foreground-service controller if native is not
        // available.
        const native = await nativeAutovote.stop();
        if (!native.available) {
            await foregroundService.stop();
        }

        // Clear the cadence timer.
        if (cycleTimerRef.current) {
            clearTimeout(cycleTimerRef.current);
            cycleTimerRef.current = null;
        }

        // Trigger challenges refresh to show vote buttons
        if (onChallengesRefresh) {
            onChallengesRefresh();
        }
    }, [onChallengesRefresh]);

    // Auto-resume on mount if a previous session left autovoteRunning
    // persisted as true (user toggled Start, then closed the app or
    // restarted the device). Runs once on mount; the runningRef guard
    // inside start() prevents double-starts. Skips when there is no
    // token, otherwise the loop would error every cycle until the user
    // logs in.
    const autoResumeRef = useRef(false);
    useEffect(() => {
        if (autoResumeRef.current) return;
        autoResumeRef.current = true;
        const maybeResume = async () => {
            try {
                const wasRunning = await window.api.getSetting('autovoteRunning');
                if (!wasRunning) return;
                const settings = await window.api.getSettings();
                if (!settings?.token) return;
                await start();
            } catch {
                /* ignore — leave UI in stopped state on failure */
            }
        };
        maybeResume();
        // start is intentionally not in deps — we want a single
        // mount-time check, not a re-trigger when start identity
        // changes due to its own dep (runVotingCycle / threshold scheduling).
    }, []);

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

    const value = {
        ...state,
        start,
        stop,
        toggle,
    };

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
