/**
 * The renderer's autovote controller: the whole voting loop — start/stop
 * lifecycle, the voting-cycle outcome handling, the mount-time auto-resume
 * hold, and the transport glue handed to the shared cadence chain — as a
 * plain-TS object over an injected host. React only builds the host
 * (`AutovoteContext.tsx`), subscribes to the state, and renders; nothing here
 * may touch the DOM, a platform module, or a shell.
 *
 * The cadence chain is the shared one (src/ts/scheduling/cadenceChain.ts) —
 * the same loop the CLI/Android scheduler drives. This module supplies the
 * WebView transport: settings + challenges over the host's IPC members, the
 * per-challenge IPC resolvers (`./resolvers`), the timer slot (whose identity
 * doubles as the staleness guard for start()/rearmSchedule() takeovers), and
 * best-effort IPC logging.
 */

import { createCadenceChain, DECISION_ERROR_MESSAGE, formatOversleptMessage } from '../scheduling/cadenceChain';
import { startupResumeAt } from '../scheduling/startupDelay';
import { finiteOr } from '../numbers';
import { errorMessage } from '../errorMessage';
import { ACTIONS, autovoteReducer, initialState } from './state';
import { createResolvers } from './resolvers';

import type { Challenge } from '../types/gurushots';
import type { TimerHandle } from '../scheduling/cadenceChain';
import type { WindowApi } from '../types/ipc';
import type { AutovoteAction, AutovoteState } from './state';

/**
 * A per-cycle notifier the cadence chain calls with the cycle's challenges.
 */
export type CycleNotifier = (challenges: Challenge[], now: number) => unknown;

/**
 * The background-service seam the controller drives on start/stop. The
 * adapter injects the Capacitor bridges; tests and the web shell inject a
 * no-op.
 */
export type BackgroundHost = {
    /** Hand scheduling to the background host; `preparingText` is the initial notification body. */
    start(preparingText: string): Promise<void>;
    /** Stop the background host's loop and notification. */
    stop(): Promise<void>;
    /** Update the persistent notification text (the body is today's payload; the title stays the service's own). */
    update(title: string, body: string): Promise<void>;
    /** The service's state, so a mount-time resume can adopt one that is already running. */
    status(): Promise<{ running: boolean; available: boolean; error?: string }>;
};

/**
 * `react/api/ipc.ts`'s callOrNull, declared here so core never imports react/.
 */
export type CallOrNull = <T>(call: () => T | Promise<T>) => Promise<T | null>;

/**
 * Everything the controller needs from its environment, built once per
 * `AutovoteProvider` mount. The exact signatures come from today's call
 * sites: the IPC members are the bridge wrappers (`react/api/ipc.ts`, typed
 * `WindowApi`), the timers are injectable so tests drive them, and the
 * formatting/translation seams keep `dateLocale`/`rendererTranslator` out of
 * core.
 */
export type AutovoteHost = {
    // IPC, all built by the adapter from react/api/ipc.ts.
    runVotingCycle: WindowApi['runVotingCycle'];
    getSettings: WindowApi['getSettings'];
    getSetting: WindowApi['getSetting'];
    getEffectiveSetting: WindowApi['getEffectiveSetting'];
    getGlobalDefault: WindowApi['getGlobalDefault'];
    getActiveChallenges: WindowApi['getActiveChallenges'];
    getDeadlineActions: WindowApi['getDeadlineActions'];
    getScenarioStatus: WindowApi['getScenarioStatus'];
    setCancelVoting: WindowApi['setCancelVoting'];
    setSetting: WindowApi['setSetting'];
    getEnvironmentInfo: WindowApi['getEnvironmentInfo'];
    callOrNull: CallOrNull;
    logRendererDebug: (message: string) => Promise<void>;
    logRendererWarning: (message: string) => Promise<void>;
    logRendererError: (message: string) => Promise<void>;
    // Timers, so tests drive them through the host.
    setTimeout: (callback: () => void, ms: number) => TimerHandle;
    clearTimeout: (handle: TimerHandle) => void;
    // The platform background service (the Capacitor bridges, or a no-op).
    background: BackgroundHost;
    formatTime: (ms: number) => string;
    translate: (key: string, params?: Record<string, string>) => string;
    // Per-cycle OS deadline notifier, or null when not wired (native Android).
    notifier: CycleNotifier | null;
    // Read on each use, so a new identity never re-arms the chain.
    getOnChallengesRefresh: () => (() => unknown) | undefined;
};

/**
 * Cancel the cadence chain's armed timer, if any, leaving the slot as-is.
 */
const cancelCycleTimer = (host: AutovoteHost, timer: { current: TimerHandle | null }) => {
    if (timer.current) {
        host.clearTimeout(timer.current);
    }
};

/**
 * Cancel the armed timer and empty the slot, so the old timeout is stale under
 * the chain's generation guard.
 */
const clearCycleTimer = (host: AutovoteHost, timer: { current: TimerHandle | null }) => {
    cancelCycleTimer(host, timer);
    timer.current = null;
};

/**
 * Cancel the hold timer of a pending auto-resume and empty its slot.
 */
const clearResumeTimer = (host: AutovoteHost, timer: { current: TimerHandle | null }) => {
    if (timer.current) {
        host.clearTimeout(timer.current);
        timer.current = null;
    }
};

/**
 * Create one autovote controller over `host`. There is no module-level
 * singleton: the adapter creates one per `AutovoteProvider` mount and calls
 * `dispose()` from the effect cleanup.
 */
export const createAutovoteController = (
    host: AutovoteHost,
): {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    rearmSchedule: () => Promise<void>;
    /** The mount-time auto-resume check; the adapter calls it once on mount. */
    maybeResume: () => Promise<void>;
    /** Cancel the timers and a pending resume; never touches persisted state. */
    dispose: () => void;
    getState: () => AutovoteState;
    subscribe: (listener: () => void) => () => void;
} => {
    // The state machine's state, applied through the pure reducer. Every
    // change notifies every subscriber.
    let state: AutovoteState = initialState;
    const listeners = new Set<() => void>();
    const apply = (action: AutovoteAction) => {
        state = autovoteReducer(state, action);
        for (const listener of listeners) listener();
    };

    // Live running flag the chain's isRunning reads. Set synchronously inside
    // start/stop (the dispatched state follows, but React-free consumers read
    // this one).
    let running = false;
    // Single recursive setTimeout handle for the whole cadence chain. Each cycle
    // decides its own next delay (fast in-window / capped approaching / normal)
    // via the shared computeNextCycleDelayMs, so there is no separate fast-mode
    // interval or boundary-switch timer to keep in sync.
    const cycleTimer: { current: TimerHandle | null } = { current: null };
    // One-shot timer of a pending auto-resume (see maybeResume). Deliberately
    // separate from cycleTimer: it is not part of the cadence chain, so the
    // scheduleNext generation guard neither sees nor cancels it. Armed means pending.
    const resumeTimer: { current: TimerHandle | null } = { current: null };
    // Set by start() and stop(): the user (or the hold itself) has acted, so a
    // mount-time resume still waiting on its awaits must not arm the hold.
    let userActed = false;
    // Set by dispose(): a pending maybeResume must not arm anything after its
    // mount went away.
    let disposed = false;

    /**
     * Record a successful cycle: bump the counter, stamp the last-run time, and
     * refresh the persistent notification text on Capacitor so the user can see
     * at a glance when the last cycle ran without opening the app (no-op on
     * Electron).
     */
    const recordCycleSuccess = () => {
        apply({ type: ACTIONS.INCREMENT_CYCLE });
        const lastRunStr = host.formatTime(Date.now());
        apply({ type: ACTIONS.UPDATE_LAST_RUN, payload: lastRunStr });
        void host.background.update(
            host.translate('app.title'),
            host.translate('app.autovoteNotificationLastCycle', { time: lastRunStr }),
        );
    };

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
    const runCycle = async (): Promise<Challenge[] | boolean> => {
        if (!running) {
            return false;
        }

        try {
            const settings = await host.getSettings();
            if (!settings.hasToken) {
                apply({ type: ACTIONS.SET_ERROR, payload: 'not-logged-in' });
                return false;
            }

            const result = await host.runVotingCycle();

            if (!running) {
                return false;
            }

            if (!result?.success) {
                void host.logRendererWarning(`Voting cycle failed: ${result?.error || 'no reason given'}`);
                apply({ type: ACTIONS.SET_ERROR, payload: result?.error || 'voting-failed' });
                return false;
            }

            recordCycleSuccess();
            const refresh = host.getOnChallengesRefresh();
            if (refresh) {
                refresh();
            }

            // Hand the fetched list back so the threshold scheduler can skip its
            // own fetch. Fall back to `true` (truthy, but not an array) when no
            // list is present so callers fetch fresh.
            return result.challenges ?? true;
        } catch (err) {
            void host.logRendererWarning(`Voting cycle threw: ${errorMessage(err) || err}`);
            apply({ type: ACTIONS.SET_ERROR, payload: 'voting-error' });
            return false;
        }
    };

    // The per-challenge IPC resolvers (`./resolvers`), built over the same host.
    const resolvers = createResolvers(host);

    /**
     * The shared cadence chain (decide delay → arm the single timer → run cycle
     * → re-arm) from src/ts/scheduling/cadenceChain.ts — the same loop the
     * CLI/Android scheduler drives. Built exactly once per controller; the
     * cycle runner reads `host.getOnChallengesRefresh()` at call time, so a
     * new refresh identity never re-arms the chain.
     */
    const chain = createCadenceChain({
        isRunning: () => running,
        getTimer: () => cycleTimer.current,
        setTimer: (handle) => {
            cycleTimer.current = handle;
        },
        loadSettings: async () => (await host.getSettings()).app,
        fetchChallenges: () => host.getActiveChallenges(),
        // The key-agnostic channel is typed `unknown`; the main process resolves
        // the schema-validated (numeric) effective value.
        resolveLastMinuteCheckMinutes: () =>
            host.getEffectiveSetting('lastMinuteCheckFrequency', 'global') as Promise<number>,
        resolveThreshold: resolvers.resolveThreshold,
        resolveScheduledFill: resolvers.resolveScheduledFill,
        resolveFinalWindowTopUp: resolvers.resolveFinalWindowTopUp,
        resolveBoostPrefill: resolvers.resolveBoostPrefill,
        resolveCurrencyAuto: resolvers.resolveCurrencyAuto,
        resolveScenarioWake: resolvers.resolveScenarioWake,
        runCycle: () => runCycle(),
        log: {
            // Best-effort parity log (the logRenderer* helpers tolerate a
            // host without the log method, e.g. a minimal Capacitor bridge,
            // so logging can't abort scheduling). Normal-mode lines stay
            // CLI-only — no IPC spam for the common case.
            cadence: (mode, message) => (mode === 'normal' ? undefined : host.logRendererDebug(message)),
            decisionError: (err) => host.logRendererWarning(`${DECISION_ERROR_MESSAGE}: ${errorMessage(err) || err}`),
            // runCycle catches internally and resolves false, so a
            // rejection here is a can't-happen TODAY — but that is an
            // invariant of a different module. Log best-effort instead
            // of swallowing so a future regression can't fail silently.
            cycleError: (err) => host.logRendererWarning(`Voting cycle failed: ${errorMessage(err) || err}`),
            // A renderer timer that fired far late means the page was
            // throttled/frozen or the machine suspended, and every
            // deadline inside that gap went unserved. Warning, not
            // debug: this is the only trace of a silently missed fill,
            // and it lands on the Logs page the user actually reads.
            // Wording is shared with the Node host so the two surfaces
            // cannot drift.
            overslept: (lateMs, waitMs) => host.logRendererWarning(formatOversleptMessage(lateMs, waitMs)),
        },
        // Surface the next armed cycle as an absolute wall-clock instant
        // for the status header's countdown; null clears it.
        onScheduled: (waitMs) =>
            apply({
                type: ACTIONS.SET_NEXT_RUN,
                payload: typeof waitMs === 'number' ? Date.now() + waitMs : null,
            }),
        // Best-effort per-cycle OS notification for upcoming deadline
        // actions. Stable instance built once by the adapter so it
        // dedupes across cycles; the chain fires it in its own isolated
        // wrapper so a throw here can never affect scheduling. `undefined` on
        // native Android (notifier not wired) so the chain skips the hook.
        onCycleChallenges: host.notifier || undefined,
    });
    const scheduleNext = chain.scheduleNext;

    /**
     * Persist the running flag so a remount of the app (Capacitor re-launch,
     * Electron window reopen) resumes — or, once cleared, does not resume — voting.
     * Best-effort: a failure only means the next launch won't match.
     */
    const persistRunningFlag = async (value: boolean) => {
        try {
            await host.setSetting('autovoteRunning', value);
        } catch {
            /* ignore */
        }
    };

    /**
     * Record which app launch started this session: the launch time itself, which
     * the main process compares for equality with its own to tell a session started
     * in this launch from one still held at launch. Written BEFORE the running
     * flag. 0 when the launch time can't be read, which matches no launch, so the
     * main process then treats the session as not live (no spend) rather than live.
     */
    const persistStartedLaunch = async () => {
        try {
            const env = await host.callOrNull(() => host.getEnvironmentInfo());
            await host.setSetting('autovoteStartedLaunch', finiteOr(env?.launchedAt, 0));
        } catch (err) {
            void host.logRendererWarning(`Could not record the auto-vote launch marker: ${errorMessage(err) || err}`);
        }
    };

    // The hold timer re-arms in chunks this long: a renderer timer is monotonic and
    // fires late after a system sleep, so the wall clock is re-read between chunks.
    const HOLD_CHUNK_MS = 5000;

    /**
     * Re-arm the cadence timer after a settings change while running. The
     * armed timer was computed from the old settings, so a newly-configured
     * threshold or scheduled-fill window could otherwise be slept past until
     * the current (possibly hours-long normal-mode) wait elapses. No-op when
     * autovote is stopped. Clearing the timer first makes the old timeout
     * stale under scheduleNext's generation guard.
     */
    const rearmSchedule = async (): Promise<void> => {
        if (!running) return;
        clearCycleTimer(host, cycleTimer);
        await scheduleNext();
    };

    /**
     * Start autovote
     */
    const start = async (): Promise<void> => {
        userActed = true;
        if (running) return;

        // A start during the hold (manual, or the hold's own timer) ends it.
        clearResumeTimer(host, resumeTimer);
        apply({ type: ACTIONS.START });
        // Mark running synchronously: the subscribers that copy the state only
        // hear back after the current async turn, so without this the awaits
        // below (and the cycle/scheduling that follow) would still
        // see running === false and bail before arming the timer.
        running = true;
        await host.setCancelVoting(false);

        // Persist the running flag so a remount can resume voting without
        // the user tapping Start again, after the launch marker (see above).
        await persistStartedLaunch();
        await persistRunningFlag(true);

        // The JS-side cycle below still runs while the app is open so the
        // user gets immediate visual feedback (cycle counter, last-run
        // timestamp) and the in-app boost / turbo / fill surfaces keep working.
        await host.background.start(host.translate('app.autovoteNotificationPreparing'));

        // Run immediately
        const initialCycleStartMs = Date.now();
        const initialChallenges = await runCycle();

        // Hand off to the unified cadence chain. The shared decision (fast
        // in-window / capped approaching / normal) means start() doesn't need
        // to special-case "already inside a window" — scheduleNext picks the
        // right cadence from the initial cycle's challenge list.
        clearCycleTimer(host, cycleTimer);
        await scheduleNext(initialChallenges, initialCycleStartMs);
    };

    /**
     * Stop autovote
     */
    const stop = async (): Promise<void> => {
        userActed = true;
        if (!running) {
            // Not running: only a pending auto-resume has anything to cancel.
            if (!resumeTimer.current) return;
            clearResumeTimer(host, resumeTimer);
            apply({ type: ACTIONS.SET_PENDING_START, payload: null });
            void host.logRendererDebug('Auto-resume cancelled');
            // Same as a stop: a relaunch must not resume it, and the host has
            // nothing to run (a native service that outlived the app is adopted
            // on mount, never held, so none is running here).
            await persistRunningFlag(false);
            await host.background.stop();
            return;
        }

        apply({ type: ACTIONS.STOP });
        // Mark stopped synchronously so an in-flight scheduleNext / timer
        // callback sees it immediately rather than after the next render flush.
        running = false;
        await host.setCancelVoting(true);

        // Clear the persisted running flag so a relaunch does not
        // auto-resume an explicitly stopped session.
        await persistRunningFlag(false);

        await host.background.stop();

        // Clear the cadence timer.
        clearCycleTimer(host, cycleTimer);

        // Trigger challenges refresh to show vote buttons
        const refresh = host.getOnChallengesRefresh();
        if (refresh) {
            refresh();
        }
    };

    /**
     * Auto-resume if a previous session left autovoteRunning persisted
     * as true (user toggled Start, then closed the app or restarted the device).
     * Skips when there is no token, otherwise the loop would error every cycle
     * until the user logs in. The adapter calls this once per mount — no extra
     * ran-once guard.
     *
     * The resume is held until `autovoteStartupDelay` seconds after the app
     * LAUNCHED (not after this mount), so a window reload continues the same hold
     * and one after it has passed resumes at once. A native service that is
     * already running is adopted at once: voting never stopped. While held,
     * `pendingStartAt` is set and a chunked timer in `resumeTimer` calls start()
     * once the wall clock reaches the resume time (see HOLD_CHUNK_MS). A dispose,
     * or any start/stop by the user during the awaits, leaves nothing armed.
     */
    const maybeResume = async (): Promise<void> => {
        try {
            const wasRunning = await host.getSetting('autovoteRunning');
            if (!wasRunning) return;
            const settings = await host.getSettings();
            if (!settings?.hasToken) return;
            const native = await host.background.status();
            if (native.running) {
                if (!disposed) await start();
                return;
            }
            // An unreadable delay or launch time still holds the session back
            // (default delay; the mount as launch), never starts it at once.
            const [delay, env] = await Promise.all([
                host.callOrNull(() => host.getGlobalDefault('autovoteStartupDelay')),
                host.callOrNull(() => host.getEnvironmentInfo()),
            ]);
            if (disposed || running || userActed) return;
            const resumeAt = startupResumeAt(finiteOr(env?.launchedAt, Date.now()), delay);
            const waitMs = resumeAt - Date.now();
            if (waitMs <= 0) {
                await start();
                return;
            }
            apply({ type: ACTIONS.SET_PENDING_START, payload: resumeAt });
            void host.logRendererDebug(`Auto-resume held for ${Math.ceil(waitMs / 1000)}s after launch`);
            const tick = () => {
                resumeTimer.current = null;
                const left = resumeAt - Date.now();
                if (left > 0) {
                    resumeTimer.current = host.setTimeout(tick, Math.min(left, HOLD_CHUNK_MS));
                    return;
                }
                void host.logRendererDebug('Auto-resume hold over — starting');
                start().catch((err) => host.logRendererError(`Auto-resume failed: ${errorMessage(err) || err}`));
            };
            resumeTimer.current = host.setTimeout(tick, Math.min(waitMs, HOLD_CHUNK_MS));
        } catch {
            /* ignore — leave UI in stopped state on failure */
        }
    };

    /**
     * Cancel the cycle timer and the resume hold, and stop a pending
     * maybeResume() from arming anything after the mount went away. Does not
     * change the persisted running flag and does not dispatch STOP: the
     * session outlives its mount.
     */
    const dispose = (): void => {
        disposed = true;
        cancelCycleTimer(host, cycleTimer);
        clearResumeTimer(host, resumeTimer);
    };

    return {
        start,
        stop,
        rearmSchedule,
        maybeResume,
        dispose,
        getState: () => state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
};
