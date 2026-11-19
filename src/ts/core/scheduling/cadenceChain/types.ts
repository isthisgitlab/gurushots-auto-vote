/** Host-injected dependency and result types of the cadence chain. */

import type { ActiveChallengesResponse, Challenge } from '../../types/gurushots';
import type {
    CadenceMode,
    ResolveBoostPrefill,
    ResolveCurrencyAuto,
    ResolveFinalWindowTopUp,
    ResolveScenarioWake,
    ResolveAccountWake,
    ResolveAutoSubmitClock,
    ResolveAutoSubmitSchedule,
    ResolveThreshold,
} from '../thresholdWindow';
import type { ResolveScheduledFill } from '../scheduledFill';
import type { ConfigApp } from '../../types/config';

/**
 * The host's single timer-handle slot value: Node's Timeout on Electron and the
 * CLI, a number in the WebView.
 */
export type TimerHandle = ReturnType<typeof setTimeout> | number;

/**
 * What a request to arm or continue execution captured when it was created: the local Stop generation, and the durable Stop
 * epoch last acknowledged (null where the host has no Stop fence).
 */
export type RunCapture = { readonly epoch: number | null; readonly generation: number };

/**
 * The Stop fence as the chain sees it (autovote/runGate.ts builds it): the capture of the run the chain serves, whether a
 * capture may still arm or dispatch, and the synchronous re-check made in the same step that arms.
 */
type ChainGate = {
    run: () => RunCapture;
    admits: (capture: RunCapture) => Promise<boolean>;
    current: (capture: RunCapture) => boolean;
};

/**
 * What a host's voting cycle resolves to: the fetched challenge list, or a
 * success/failure flag when it has no list (the next decision then fetches).
 */
export type CycleResult = Challenge[] | boolean | null | undefined;

/**
 * The fields of a FRESH settings snapshot the chain reads (hosts hand over their
 * whole `app` block).
 */
type CadenceSettings = Pick<ConfigApp, 'timezone' | 'checkFrequencyMin' | 'checkFrequencyMax'>;

/**
 * The host transport `createCadenceChain` is built from (documented on the factory).
 */
export type CadenceChainDeps = {
    isRunning: () => boolean;
    getTimer: () => TimerHandle | null;
    setTimer: (handle: TimerHandle | null) => void;
    loadSettings: () => CadenceSettings | Promise<CadenceSettings>;
    fetchChallenges: (
        settings: CadenceSettings,
    ) => ActiveChallengesResponse | null | Promise<ActiveChallengesResponse | null>;
    resolveLastMinuteCheckMinutes: () => number | string | Promise<number | string>;
    resolveThreshold: ResolveThreshold;
    resolveScheduledFill: ResolveScheduledFill;
    resolveAutoSubmitClock?: ResolveAutoSubmitClock | null;
    resolveAutoSubmitSchedule?: ResolveAutoSubmitSchedule | null;
    resolveFinalWindowTopUp: ResolveFinalWindowTopUp;
    resolveBoostPrefill: ResolveBoostPrefill;
    resolveCurrencyAuto?: ResolveCurrencyAuto | null;
    resolveScenarioWake?: ResolveScenarioWake | null;
    /** The account's own boundaries (installation scenario, pre-join candidates, claim throttle, mission expiry). */
    resolveAccountWake?: ResolveAccountWake | null;
    /**
     * Whether the chain is armed for the installation scenario only (the voting stages are paused): the decision then reads no
     * active challenge, and only the account's boundaries and the normal cadence decide the wait.
     */
    isArmed?: () => boolean;
    runCycle: () => Promise<CycleResult>;
    log: {
        cadence: (mode: CadenceMode, message: string) => void | Promise<void>;
        decisionError: (error: unknown) => void | Promise<void>;
        cycleError: (error: unknown) => void | Promise<void>;
        overslept?: (lateMs: number, waitMs: number) => void | Promise<void>;
    };
    onScheduled?: (waitMs: number | null) => void;
    /** The Stop fence: with it, an obsolete run arms and dispatches nothing. Absent: the chain is as it was. */
    gate?: ChainGate | null;
    /** The fence refused a timer that was armed (a Stop recorded elsewhere): the host's run is over. */
    onObsolete?: () => void;
    onCycleChallenges?: (challenges: Challenge[], now: number) => unknown;
};
