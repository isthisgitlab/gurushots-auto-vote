/**
 * The autovote controller's public types: the host it is built over, the
 * surface it exposes, and the shared internals the split parts
 * (cycle/chain/resume/lifecycle) receive. Nothing here exists at runtime.
 */

import type { Challenge } from '../types/gurushots';
import type { TimerHandle } from '../scheduling/cadenceChain';
import type { RunCapture } from '../scheduling/cadenceChain/types';
import type { WindowApi } from '../types/ipc';
import type { AutovoteAction, AutovoteState, ExecutionMode } from './state';
import type { StopFencePort, WithdrawalOutcome } from './runGate';
import type { AccountWakeSources } from '../scheduling/thresholdWindow';

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
    // (src/ts/core/scheduling/cadenceChain/chain.ts), so the controller cancels
    // chain timers with the global clearTimeout — clearing them through a
    // host seam could miss the chain's own handle.
    setTimeout: (callback: () => void, ms: number) => TimerHandle;
    clearTimeout: (handle: TimerHandle) => void;
    // The platform background service (the Capacitor bridges, or a no-op).
    background: BackgroundHost;
    formatTime: (ms: number) => string;
    translate: (key: string, params?: Record<string, string>) => string;
    // The priority Stop fence, where the host can reach it (the main process owns it: the WebView reaches it over its own
    // channel). Absent: a Stop is local only, and says so (`stopped-locally`, reason `no-fence`).
    stopFence?: StopFencePort | null;
    // One installation-only cycle (the installation scenario's publication and account rules, nothing else): what an `armed`
    // controller runs each cycle. Absent: the host cannot run one, and the controller cannot be armed.
    runArmedCycle?: WindowApi['runVotingCycle'] | null;
    // The account's own scheduling boundaries (installation scenario, pre-join candidates, claim throttle, mission expiry),
    // worked out by the main process: the renderer has no route to the ledgers they come from. Absent: none are collected.
    getAccountWake?: (() => Promise<AccountWakeSources | null>) | null;
    // Withdraws the installation scenario's publication on a full Stop, under the Stop epoch it is made under (its progress is
    // kept; the saved values apply at once). Absent: the host has no such route (the Stop says `no-route`).
    withdrawInstallation?:
        | ((epoch: number) => Exclude<WithdrawalOutcome, 'no-route'> | Promise<Exclude<WithdrawalOutcome, 'no-route'>>)
        | null;
    // Lifts that withdrawal on an explicit user re-arm, before the next publication. Absent: nothing to lift.
    reArmInstallation?: (() => 'restored' | 'none' | 'failed' | Promise<'restored' | 'none' | 'failed'>) | null;
    // Per-cycle OS deadline notifier, or null when not wired (native Android).
    notifier: CycleNotifier | null;
    // Read on each use, so a new identity never re-arms the chain.
    getOnChallengesRefresh: () => (() => unknown) | undefined;
};

/**
 * The controller's public surface, as the adapter and the tests consume it.
 */
export type AutovoteController = {
    /** The user's Run / Resume. In `armed` mode it turns the voting stages on under the same chain. */
    start: () => Promise<void>;
    /**
     * Full Stop (every caller): cancels at once, withdraws the installation's publication and records the priority fence. What
     * it came to is `getState().lastStop`.
     */
    stop: () => Promise<void>;
    rearmSchedule: () => Promise<void>;
    /** The user's explicit installation arm: the chain runs for the installation scenario with the voting stages paused. */
    arm?: () => Promise<void>;
    /**
     * A scenario's request (`startAutovote` / `stopAutovote`) to turn the voting stages on or off under an armed chain. It is
     * bound to the Stop epoch captured when it was created, never creates a chain and never lifts a user Stop.
     */
    requestVotingStages?: (on: boolean, captured: RunCapture) => Promise<VotingStagesResult>;
    /** The capture a scenario request is made under (Stop generation now, and the epoch last acknowledged). */
    captureRequest?: () => RunCapture;
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
    /** the chain is live: voting stages on, or armed. (False only when stopped.) */
    running: () => boolean;
    /** exactly what the controller is doing */
    mode: () => ExecutionMode;
    /** set once the user (or the hold itself) has acted this session */
    userActed: () => boolean;
    /** whether dispose() ran */
    disposed: () => boolean;
};

/**
 * The flag transitions only the lifecycle part performs (start/stop).
 */
export type SessionFlagWriters = {
    setMode: (value: ExecutionMode) => void;
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

/** What a scenario's request for the voting stages came to. */
export type VotingStagesResult =
    | { ok: true; mode: ExecutionMode; changed: boolean }
    | { ok: false; reason: 'obsolete' | 'not-armed' | 'unsupported' };
