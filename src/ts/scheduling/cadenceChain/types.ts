/** Host-injected dependency and result types of the cadence chain. */

import type { ActiveChallengesResponse, Challenge } from '../../types/gurushots';
import type {
    CadenceMode,
    ResolveBoostPrefill,
    ResolveCurrencyAuto,
    ResolveFinalWindowTopUp,
    ResolveScenarioWake,
    ResolveThreshold,
} from '../thresholdWindow';
import type { ResolveScheduledFill } from '../scheduledFill';
import type { AppSettings } from '../../types/settings';

/**
 * The host's single timer-handle slot value: Node's Timeout on Electron and the
 * CLI, a number in the WebView.
 */
export type TimerHandle = ReturnType<typeof setTimeout> | number;

/**
 * What a host's voting cycle resolves to: the fetched challenge list, or a
 * success/failure flag when it has no list (the next decision then fetches).
 */
export type CycleResult = Challenge[] | boolean | null | undefined;

/**
 * The fields of a FRESH settings snapshot the chain reads (hosts hand over their
 * whole settings blob; `token` is what the GUI's fetchChallenges reads off it).
 */
type CadenceSettings = Pick<AppSettings, 'timezone' | 'checkFrequencyMin' | 'checkFrequencyMax' | 'token'>;

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
    resolveFinalWindowTopUp: ResolveFinalWindowTopUp;
    resolveBoostPrefill: ResolveBoostPrefill;
    resolveCurrencyAuto?: ResolveCurrencyAuto | null;
    resolveScenarioWake?: ResolveScenarioWake | null;
    runCycle: () => Promise<CycleResult>;
    log: {
        cadence: (mode: CadenceMode, message: string) => void | Promise<void>;
        decisionError: (error: unknown) => void | Promise<void>;
        cycleError: (error: unknown) => void | Promise<void>;
        overslept?: (lateMs: number, waitMs: number) => void | Promise<void>;
    };
    onScheduled?: (waitMs: number | null) => void;
    onCycleChallenges?: (challenges: Challenge[], now: number) => unknown;
};
