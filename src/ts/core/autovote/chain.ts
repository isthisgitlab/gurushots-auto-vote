/**
 * The controller's cadence-chain wiring: the shared chain
 * (src/ts/core/scheduling/cadenceChain.ts) over the WebView transport — settings +
 * challenges over the host's IPC members, the per-challenge IPC resolvers,
 * the timer slot (whose identity doubles as the staleness guard for
 * start()/rearmSchedule() takeovers), and best-effort IPC logging.
 */

import { createCadenceChain, DECISION_ERROR_MESSAGE, formatOversleptMessage } from '../scheduling/cadenceChain';
import { errorMessage } from '../errorMessage';
import { createResolvers } from './resolvers';
import { ACTIONS } from './state';

import type { TimerHandle } from '../scheduling/cadenceChain';
import type { AutovoteAction } from './state';
import type { AutovoteHost, SessionFlags } from './types';

type ChainDeps = Parameters<typeof createCadenceChain>[0];
type ChainLog = ChainDeps['log'];
type ChallengeList = Awaited<ReturnType<ChainDeps['runCycle']>>;

/**
 * The chain's log adapter: best-effort renderer diagnostics through the host.
 */
const createChainLog = (host: AutovoteHost): ChainLog => ({
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
});

/**
 * Build the shared cadence chain (decide delay → arm the single timer → run
 * cycle → re-arm) — the same loop the CLI/Android scheduler drives. Built
 * exactly once per controller; the cycle runner reads
 * `host.getOnChallengesRefresh()` at call time, so a new refresh identity
 * never re-arms the chain.
 */
export const createControllerChain = ({
    host,
    apply,
    flags,
    runCycle,
    cycleTimer,
}: {
    host: AutovoteHost;
    apply: (action: AutovoteAction) => void;
    flags: SessionFlags;
    runCycle: () => Promise<ChallengeList>;
    cycleTimer: { current: TimerHandle | null };
}): ReturnType<typeof createCadenceChain> => {
    // The per-challenge IPC resolvers (`./resolvers`), built over the same host.
    const resolvers = createResolvers(host);
    const chain = createCadenceChain({
        // A disposed controller must not re-arm from the chain's finally: the
        // mount went away, so even a still-true running flag stops the loop.
        isRunning: () => flags.running() && !flags.disposed(),
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
        resolveAutoSubmitClock: resolvers.resolveAutoSubmitClock,
        resolveFinalWindowTopUp: resolvers.resolveFinalWindowTopUp,
        resolveBoostPrefill: resolvers.resolveBoostPrefill,
        resolveCurrencyAuto: resolvers.resolveCurrencyAuto,
        resolveScenarioWake: resolvers.resolveScenarioWake,
        runCycle: () => runCycle(),
        log: createChainLog(host),
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
    return chain;
};
