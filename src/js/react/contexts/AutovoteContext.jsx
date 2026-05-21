import { createContext, useContext, useReducer, useCallback, useEffect, useRef } from 'react';
import { getRandomCheckFrequencyMs, MIN_CYCLE_GAP_MS } from '../../scheduling/randomDelay';
import * as foregroundService from '../../services/ForegroundServiceController';
import * as nativeAutovote from '../../services/NativeAutovoteBridge';
import { ACTIONS, initialState, autovoteReducer } from './autovoteReducer';
import { calculateNextThresholdEntry, isAnyChallengeInThresholdWindow } from './autovoteScheduler';

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
    // True while the fixed last-minute setInterval is the live cadence.
    // autovoteIntervalRef alone can't tell the two modes apart (it holds either
    // a setInterval id in last-minute mode or a setTimeout id in normal mode),
    // so this flag gates the revert-to-normal path in updateThresholdScheduling.
    const lastMinuteModeRef = useRef(false);
    // Holds the latest normal-cadence starter (start()'s scheduleNext). Stored
    // in a ref so updateThresholdScheduling can resume normal cadence on revert
    // without a render-time dependency cycle between the two callbacks.
    const scheduleNormalRef = useRef(null);

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
            if (autovoteIntervalRef.current) {
                clearInterval(autovoteIntervalRef.current);
            }
            if (thresholdSchedulerRef.current) {
                clearTimeout(thresholdSchedulerRef.current);
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
     * Update threshold scheduling
     */
    const updateThresholdScheduling = useCallback(
        async (prefetched = null) => {
            if (!runningRef.current) return;

            try {
                const settings = await window.api.getSettings();
                // Reuse a just-completed cycle's challenge list when provided; a
                // non-array (standalone re-arm, or a failed cycle) fetches fresh.
                const challenges = Array.isArray(prefetched)
                    ? prefetched
                    : (await window.api.getActiveChallenges(settings.token))?.challenges || [];
                const now = Math.floor(Date.now() / 1000);

                // Revert: if the fixed last-minute interval is live but nothing is
                // currently within its last-minute window, tear it down and resume
                // the normal randomized cadence. Without this the interval is a
                // one-way door — a single challenge entering its final minutes would
                // pin the session at lastMinuteCheckFrequency forever, even after it
                // closes. Mirrors runScheduler.js's revert block.
                if (lastMinuteModeRef.current && !(await isAnyChallengeInThresholdWindow(challenges, now))) {
                    if (autovoteIntervalRef.current) {
                        clearInterval(autovoteIntervalRef.current);
                        autovoteIntervalRef.current = null;
                    }
                    lastMinuteModeRef.current = false;
                    if (scheduleNormalRef.current) {
                        scheduleNormalRef.current(settings, Date.now());
                    }
                    // Best-effort parity log (optional-chained so a host without
                    // logDebug, e.g. a minimal Capacitor bridge, can't abort the revert).
                    await window.api.logDebug?.(
                        '⏰ No challenges within last-minute window — reverting to normal check frequency',
                    );
                }

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

                        lastMinuteModeRef.current = true;
                        autovoteIntervalRef.current = setInterval(async () => {
                            if (!runningRef.current) {
                                clearInterval(autovoteIntervalRef.current);
                                autovoteIntervalRef.current = null;
                                return;
                            }
                            // Re-evaluate after every tick so the window-passed
                            // revert (above) can return us to normal cadence.
                            const cycleChallenges = await runVotingCycle();
                            await updateThresholdScheduling(cycleChallenges);
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
        },
        [runVotingCycle],
    );

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
        const initialChallenges = await runVotingCycle();

        // Setup interval
        const settings = await window.api.getSettings();
        const lastMinuteCheckFrequency = await window.api.getEffectiveSetting('lastMinuteCheckFrequency', 'global');

        let useLastThresholdInterval = false;

        // Reuse the initial cycle's challenge list rather than re-fetching it here
        // and again in updateThresholdScheduling below.
        const challenges = Array.isArray(initialChallenges)
            ? initialChallenges
            : (await window.api.getActiveChallenges(settings.token))?.challenges || [];
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

        // Normal-mode cadence starter. Defined before the branch and stored in
        // scheduleNormalRef so the revert path in updateThresholdScheduling can
        // resume normal cadence even when start() itself entered last-minute mode.
        //
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
        scheduleNormalRef.current = scheduleNext;

        if (useLastThresholdInterval) {
            // Last-minute mode keeps a fixed cadence — deadline timing matters more than randomness.
            const votingIntervalMs = lastMinuteCheckFrequency * 60000;
            lastMinuteModeRef.current = true;
            autovoteIntervalRef.current = setInterval(async () => {
                if (!runningRef.current) {
                    clearInterval(autovoteIntervalRef.current);
                    autovoteIntervalRef.current = null;
                    return;
                }
                // Re-evaluate after every tick so the window-passed revert in
                // updateThresholdScheduling can return us to normal cadence.
                const cycleChallenges = await runVotingCycle();
                await updateThresholdScheduling(cycleChallenges);
            }, votingIntervalMs);
        } else {
            lastMinuteModeRef.current = false;
            scheduleNext(settings, initialCycleStartMs);
        }

        // Setup threshold scheduling (reuse the initial cycle's list).
        await updateThresholdScheduling(initialChallenges);
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
        lastMinuteModeRef.current = false;

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
