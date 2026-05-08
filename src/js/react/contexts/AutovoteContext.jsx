import { createContext, useContext, useReducer, useCallback, useEffect, useRef } from 'react';
import { getRandomCheckFrequencyMs } from '../../scheduling/randomDelay';
import * as foregroundService from '../../services/ForegroundServiceController';

// Action types
const ACTIONS = {
    START: 'START',
    STOP: 'STOP',
    INCREMENT_CYCLE: 'INCREMENT_CYCLE',
    UPDATE_LAST_RUN: 'UPDATE_LAST_RUN',
    SET_STATUS: 'SET_STATUS',
    SET_ERROR: 'SET_ERROR',
};

// Initial state
const initialState = {
    running: false,
    cycles: 0,
    lastRun: null,
    status: 'Stopped',
    statusClass: 'badge-neutral',
    error: null,
};

// Reducer
function autovoteReducer(state, action) {
    switch (action.type) {
        case ACTIONS.START:
            return {
                ...state,
                running: true,
                status: 'Running',
                statusClass: 'badge-success',
                error: null,
            };
        case ACTIONS.STOP:
            return {
                ...state,
                running: false,
                status: 'Stopped',
                statusClass: 'badge-neutral',
            };
        case ACTIONS.INCREMENT_CYCLE:
            return {
                ...state,
                cycles: state.cycles + 1,
            };
        case ACTIONS.UPDATE_LAST_RUN:
            return {
                ...state,
                lastRun: action.payload,
            };
        case ACTIONS.SET_STATUS:
            return {
                ...state,
                status: action.payload.status,
                statusClass: action.payload.statusClass,
            };
        case ACTIONS.SET_ERROR:
            return {
                ...state,
                error: action.payload,
                status: 'Error',
                statusClass: 'badge-error',
            };
        default:
            return state;
    }
}

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
     * Calculate next threshold entry time
     */
    const calculateNextThresholdEntry = useCallback(async (challenges, now) => {
        let nextEntry = null;
        let earliestEntryTime = Infinity;

        for (const challenge of challenges) {
            if (challenge.type === 'flash' || challenge.close_time <= now) {
                continue;
            }

            const effectiveLastMinuteThreshold = await window.api.getEffectiveSetting(
                'lastMinuteThreshold',
                challenge.id.toString(),
            );
            const thresholdEntryTime = challenge.close_time - effectiveLastMinuteThreshold * 60;

            if (thresholdEntryTime > now && thresholdEntryTime < earliestEntryTime) {
                earliestEntryTime = thresholdEntryTime;
                nextEntry = {
                    challengeId: challenge.id,
                    challengeTitle: challenge.title,
                    entryTime: thresholdEntryTime,
                    lastMinuteThreshold: effectiveLastMinuteThreshold,
                };
            }
        }

        return nextEntry;
    }, []);

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
    }, [calculateNextThresholdEntry, runVotingCycle]);

    /**
     * Start autovote
     */
    const start = useCallback(async () => {
        if (runningRef.current) return;

        dispatch({ type: ACTIONS.START });
        await window.api.setCancelVoting(false);

        // On Capacitor, spin up the persistent foreground notification
        // so Android does not kill the WebView process while the phone
        // is locked. No-op on Electron.
        await foregroundService.start({ body: 'Auto-vote running — preparing first cycle' });

        // Run immediately
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
            const scheduleNext = (currentSettings) => {
                if (!runningRef.current) {
                    autovoteIntervalRef.current = null;
                    return;
                }
                const delayMs = getRandomCheckFrequencyMs(currentSettings);
                const timeoutId = setTimeout(async () => {
                    if (!runningRef.current) return;
                    await runVotingCycle();
                    if (autovoteIntervalRef.current !== timeoutId) return; // threshold path took over
                    const fresh = await window.api.getSettings();
                    scheduleNext(fresh);
                }, delayMs);
                autovoteIntervalRef.current = timeoutId;
            };
            scheduleNext(settings);
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

        // Tear down the Android foreground notification. No-op on Electron.
        await foregroundService.stop();

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
