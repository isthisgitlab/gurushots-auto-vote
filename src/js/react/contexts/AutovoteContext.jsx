import { createContext, useContext, useReducer, useCallback, useEffect, useRef } from 'react';
import { getRandomCheckFrequencyMs, MIN_CYCLE_GAP_MS } from '../../scheduling/randomDelay';
import * as foregroundService from '../../services/ForegroundServiceController';
import * as nativeAutovote from '../../services/NativeAutovoteBridge';
import { ACTIONS, initialState, autovoteReducer } from './autovoteReducer';
import { calculateNextThresholdEntry } from './autovoteScheduler';

const AutovoteContext = createContext(null);

/**
 * Provider for autovote state machine
 */
export function AutovoteProvider({ children, onChallengesRefresh }) {
    const [state, dispatch] = useReducer(autovoteReducer, initialState);

    // Refs to prevent stale closures in intervals
    const runningRef = useRef(state.running);
    const autovoteIntervalRef = useRef(null);
    const thresholdSchedulerRef = useRef(null);
    const currentScheduledChallengeRef = useRef(null);

    // Keep runningRef in sync with state
    useEffect(() => {
        runningRef.current = state.running;
        window.autovoteRunning = state.running;
    }, [state.running]);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (autovoteIntervalRef.current) {
                clearInterval(autovoteIntervalRef.current);
            }
            if (thresholdSchedulerRef.current) {
                clearTimeout(thresholdSchedulerRef.current);
            }
        };
    }, []);

    /**
     * Run a single voting cycle
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

                return true;
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
     * Update threshold scheduling
     */
    const updateThresholdScheduling = useCallback(async () => {
        if (!runningRef.current) return;

        try {
            const settings = await window.api.getSettings();
            const result = await window.api.getActiveChallenges(settings.token);
            const challenges = result?.challenges || [];
            const now = Math.floor(Date.now() / 1000);

            const nextEntry = await calculateNextThresholdEntry(challenges, now);

            if (nextEntry) {
                // Check for duplicate scheduling
                if (
                    currentScheduledChallengeRef.current?.challengeId === nextEntry.challengeId &&
                    currentScheduledChallengeRef.current?.entryTime === nextEntry.entryTime
                ) {
                    return;
                }

                const timeUntilEntry = (nextEntry.entryTime - now) * 1000;

                if (timeUntilEntry <= 0) return;

                // Clear existing scheduler
                if (thresholdSchedulerRef.current) {
                    clearTimeout(thresholdSchedulerRef.current);
                }

                currentScheduledChallengeRef.current = nextEntry;

                thresholdSchedulerRef.current = setTimeout(async () => {
                    if (!runningRef.current) return;

                    // Switch to last threshold frequency
                    if (autovoteIntervalRef.current) {
                        clearInterval(autovoteIntervalRef.current);
                    }

                    const lastMinuteCheckFrequency = await window.api.getEffectiveSetting(
                        'lastMinuteCheckFrequency',
                        'global',
                    );
                    const votingIntervalMs = lastMinuteCheckFrequency * 60000;

                    autovoteIntervalRef.current = setInterval(async () => {
                        if (runningRef.current) {
                            await runVotingCycle();
                        } else {
                            clearInterval(autovoteIntervalRef.current);
                            autovoteIntervalRef.current = null;
                        }
                    }, votingIntervalMs);

                    currentScheduledChallengeRef.current = null;
                    await updateThresholdScheduling();
                }, timeUntilEntry);
            } else {
                if (thresholdSchedulerRef.current) {
                    clearTimeout(thresholdSchedulerRef.current);
                    thresholdSchedulerRef.current = null;
                    currentScheduledChallengeRef.current = null;
                }
            }
        } catch (err) {
            await window.api.logWarning(`Error updating threshold scheduling: ${err.message || err}`);
        }
    }, [runVotingCycle]);

    /**
     * Start autovote
     */
    const start = useCallback(async () => {
        if (runningRef.current) return;

        dispatch({ type: ACTIONS.START });
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
        await runVotingCycle();

        // Setup interval
        const settings = await window.api.getSettings();
        const lastMinuteCheckFrequency = await window.api.getEffectiveSetting('lastMinuteCheckFrequency', 'global');

        let useLastThresholdInterval = false;

        const result = await window.api.getActiveChallenges(settings.token);
        const challenges = result?.challenges || [];
        const now = Math.floor(Date.now() / 1000);

        for (const challenge of challenges) {
            if (challenge.type !== 'flash') {
                const effectiveLastMinuteThreshold = await window.api.getEffectiveSetting(
                    'lastMinuteThreshold',
                    challenge.id.toString(),
                );
                const timeUntilEnd = challenge.close_time - now;
                const isWithinLastMinuteThreshold =
                    timeUntilEnd <= effectiveLastMinuteThreshold * 60 && timeUntilEnd > 0;

                if (isWithinLastMinuteThreshold) {
                    useLastThresholdInterval = true;
                    break;
                }
            }
        }

        if (autovoteIntervalRef.current) {
            clearInterval(autovoteIntervalRef.current);
            autovoteIntervalRef.current = null;
        }

        if (useLastThresholdInterval) {
            // Last-minute mode keeps a fixed cadence — deadline timing matters more than randomness.
            const votingIntervalMs = lastMinuteCheckFrequency * 60000;
            autovoteIntervalRef.current = setInterval(async () => {
                if (runningRef.current) {
                    await runVotingCycle();
                } else {
                    clearInterval(autovoteIntervalRef.current);
                    autovoteIntervalRef.current = null;
                }
            }, votingIntervalMs);
        } else {
            // Normal mode re-rolls a random delay in [min, max] after every cycle, so the voting
            // pattern looks less like a metronome to anti-bot heuristics. The threshold path
            // (updateThresholdScheduling) may swap the ref out for a fixed-cadence setInterval
            // while we're mid-await — the captured timeoutId guard below stops us from clobbering it.
            //
            // The wait is anchored to the *start* of the previous cycle so the gap between
            // cycle starts ≈ delayMs regardless of how long the cycle took. Overruns pause
            // MIN_CYCLE_GAP_MS before firing again instead of immediately.
            const scheduleNext = (currentSettings, previousCycleStartMs = null) => {
                if (!runningRef.current) {
                    autovoteIntervalRef.current = null;
                    return;
                }
                const delayMs = getRandomCheckFrequencyMs(currentSettings);
                const anchorMs = previousCycleStartMs ?? Date.now();
                // Clamp into [MIN_CYCLE_GAP_MS, delayMs]: floor protects against
                // overruns; ceiling protects against wall-clock backward jumps
                // (suspend/resume, NTP) that would otherwise inflate the wait.
                const waitMs = Math.min(delayMs, Math.max(MIN_CYCLE_GAP_MS, anchorMs + delayMs - Date.now()));
                const timeoutId = setTimeout(async () => {
                    if (!runningRef.current) return;
                    const cycleStartMs = Date.now();
                    try {
                        await runVotingCycle();
                        if (autovoteIntervalRef.current !== timeoutId) return; // threshold path took over
                        const fresh = await window.api.getSettings();
                        scheduleNext(fresh, cycleStartMs);
                    } catch {
                        // Don't let an unexpected IPC / settings-fetch error
                        // kill the loop. Reschedule with the last-known
                        // settings; the next cycle will re-read on success.
                        if (autovoteIntervalRef.current === timeoutId) {
                            scheduleNext(currentSettings, cycleStartMs);
                        }
                    }
                }, waitMs);
                autovoteIntervalRef.current = timeoutId;
            };
            scheduleNext(settings, initialCycleStartMs);
        }

        // Setup threshold scheduling
        await updateThresholdScheduling();
    }, [runVotingCycle, updateThresholdScheduling]);

    /**
     * Stop autovote
     */
    const stop = useCallback(async () => {
        if (!runningRef.current) return;

        dispatch({ type: ACTIONS.STOP });
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

        // Clear interval
        if (autovoteIntervalRef.current) {
            clearInterval(autovoteIntervalRef.current);
            autovoteIntervalRef.current = null;
        }

        // Clear threshold scheduler
        if (thresholdSchedulerRef.current) {
            clearTimeout(thresholdSchedulerRef.current);
            thresholdSchedulerRef.current = null;
        }

        currentScheduledChallengeRef.current = null;

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
