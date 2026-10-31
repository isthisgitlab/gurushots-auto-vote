/**
 * The autovote controller's public types: the host it is built over, the
 * surface it exposes, and the shared internals the split parts
 * (cycle/chain/resume/lifecycle) receive. Nothing here exists at runtime.
 */

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
 * `WindowApi`), and the formatting/translation seams keep
 * `dateLocale`/`rendererTranslator` out of core.
 */
export type AutovoteHost = {
    // IPC, all built by the adapter from react/api/ipc.ts.
    runVotingCycle: WindowApi['runVotingCycle'];
    getSettings: WindowApi['getSettings'];
    getSetting: WindowApi['getSetting'];
    getEffectiveSetting: WindowApi['getEffectiveSetting'];
    getGlobalDefault: WindowApi['getGlobalDefault'];
    getActiveChallenges: WindowApi['getActiveChallenges'];
    getScenarioStatus: WindowApi['getScenarioStatus'];
    setCancelVoting: WindowApi['setCancelVoting'];
    setSetting: WindowApi['setSetting'];
    getEnvironmentInfo: WindowApi['getEnvironmentInfo'];
    callOrNull: CallOrNull;
    logRendererDebug: (message: string) => Promise<void>;
    logRendererWarning: (message: string) => Promise<void>;
    logRendererError: (message: string) => Promise<void>;
    // Timers driving the resume hold only, injectable so tests drive the hold
    // through the host. The cycle timer is NOT theirs: the shared cadence
    // chain owns it and arms it with the global setTimeout
    // (src/ts/scheduling/cadenceChain/chain.ts), so the controller cancels
    // chain timers with the global clearTimeout — clearing them through a
    // host seam could miss the chain's own handle.
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
 * The controller's public surface, as the adapter and the tests consume it.
 */
export type AutovoteController = {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    rearmSchedule: () => Promise<void>;
    /** The mount-time auto-resume check; the adapter calls it once on mount. */
    maybeResume: () => Promise<void>;
    /** Cancel the timers and a pending resume; never touches persisted state. */
    dispose: () => void;
    getState: () => AutovoteState;
    subscribe: (listener: () => void) => () => void;
};

/**
 * The controller's live session flags, as the split parts read them. Accessor
 * functions, not values: start/stop set the real flags synchronously
 * mid-flight, and the parts must see the current one at each read.
 */
export type SessionFlags = {
    /** the live running flag the chain's isRunning reads */
    running: () => boolean;
    /** set once the user (or the hold itself) has acted this session */
    userActed: () => boolean;
    /** whether dispose() ran */
    disposed: () => boolean;
};

/**
 * The flag transitions only the lifecycle part performs (start/stop).
 */
export type SessionFlagWriters = {
    setRunning: (value: boolean) => void;
    setUserActed: () => void;
};

/**
 * The controller's shared internals, handed to the split parts: the host,
 * the store's apply (reducer + notify), and the live flags.
 */
export type ControllerCore = {
    host: AutovoteHost;
    apply: (action: AutovoteAction) => void;
    flags: SessionFlags;
};
