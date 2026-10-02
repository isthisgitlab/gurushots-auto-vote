import { decideNextWaitOrFallBack } from './decision';
import { oversleptBy } from './oversleep';

import type { CadenceChainDeps, CycleResult, TimerHandle } from './types';

/**
 * Run a best-effort observability hook without letting it touch scheduling: a
 * synchronous throw and an async rejection are both swallowed, and the hook is
 * never awaited.
 */
const fireAndForget = (hook: () => unknown) => {
    try {
        void Promise.resolve(hook()).catch(() => {});
    } catch {
        /* observability only — must never affect scheduling */
    }
};

/**
 * Create the shared cadence chain.
 *
 * @param deps - host transport
 * @param deps.isRunning - live running flag (ref-backed on React)
 * @param deps.getTimer - read the host's single timer-handle slot; the
 *   chain uses identity against it as the staleness guard (a host that clears
 *   or replaces the slot makes any in-flight timer/re-arm decline)
 * @param deps.setTimer - store/clear the timer-handle slot
 * @param deps.loadSettings - FRESH settings
 *   snapshot; called at the top of every decision (and again for the fallback)
 * @param deps.fetchChallenges -
 *   active-challenge fetch (`{challenges, fetchFailed?}` shape) used only when
 *   no prefetched list was handed over. `fetchFailed === true` (an outage:
 *   makePostRequest resolved null after retries) shortens the next normal-mode
 *   wait to OFFLINE_RETRY_MS so the loop re-probes soon after reconnection
 *   rather than waiting out the full cadence
 * @param deps.resolveLastMinuteCheckMinutes -
 *   raw global `lastMinuteCheckFrequency` value (coerced + defaulted here)
 * @param deps.resolveThreshold -
 *   per-challenge threshold resolver for the shared math
 * @param deps.resolveScheduledFill - per-challenge scheduled-fill
 *   resolver for the shared math
 * @param deps.resolveFinalWindowTopUp -
 *   per-challenge pre-final-window top-up resolver for the shared math
 * @param deps.resolveBoostPrefill -
 *   per-challenge pre-boost fill resolver for the shared math
 * @param deps.resolveCurrencyAuto -
 *   per-challenge currency-automation timing resolver for the shared math
 * @param deps.resolveScenarioWake -
 *   per-challenge scenario resolver for the shared math
 * @param deps.runCycle - run one voting cycle; the resolved
 *   value is handed to the next decision as the prefetched list candidate
 *   (any non-array means "fetch fresh"). A rejection is logged via
 *   `log.cycleError` and never kills the chain.
 * @param deps.log - host log adapter
 * @param deps.log.cadence -
 *   receives every cadence decision line (modes: normal / last-minute /
 *   scheduled / pre-final-window / pre-boost / boost-hold / currency-rule / scenario /
 *   approaching); a host may drop
 *   modes it never logged
 * @param deps.log.decisionError - decision
 *   failure (chain falls back to the random cadence)
 * @param deps.log.cycleError - a voting
 *   cycle rejected
 * @param deps.log.overslept -
 *   OPTIONAL: the armed timer fired far later than it was scheduled to (OS
 *   suspend / App Nap / hidden-page throttling), so every boundary inside that
 *   stall was missed. Hosts that omit it lose only the log line.
 * @param deps.onScheduled - OPTIONAL: called with
 *   the delay (ms) to the next armed cycle each time one is scheduled, and with
 *   null when the chain stops arming. Used by the GUI to surface a live
 *   next-action countdown; Node hosts (CLI/Android) omit it, so it is
 *   optional-chained and never required.
 * @param deps.onCycleChallenges -
 *   OPTIONAL: called once per cycle with the freshly-resolved active-challenge
 *   list and the cycle's `now` (Unix seconds), for hosts that want to react to
 *   the list without re-fetching (the OS deadline-notification layer). Invoked
 *   in its OWN isolated, never-awaited wrapper OUTSIDE the decision try/catch —
 *   a throw here must never reach the decision `catch`, whose fallback would
 *   discard the boundary-aware cadence for the cycle. Hosts that omit it lose
 *   only the notification opportunity.
 */
export const createCadenceChain = ({
    isRunning,
    getTimer,
    setTimer,
    loadSettings,
    fetchChallenges,
    resolveLastMinuteCheckMinutes,
    resolveThreshold,
    resolveScheduledFill,
    resolveFinalWindowTopUp,
    resolveBoostPrefill,
    resolveCurrencyAuto = null,
    resolveScenarioWake = null,
    runCycle,
    log,
    onScheduled,
    onCycleChallenges,
}: CadenceChainDeps): {
    scheduleNext: (prefetched?: CycleResult, previousCycleStartMs?: number | null) => Promise<void>;
} => {
    const decisionDeps = {
        loadSettings,
        fetchChallenges,
        resolveLastMinuteCheckMinutes,
        resolveThreshold,
        resolveScheduledFill,
        resolveFinalWindowTopUp,
        resolveBoostPrefill,
        resolveCurrencyAuto,
        resolveScenarioWake,
        log,
    };

    const stopArming = () => {
        setTimer(null);
        onScheduled?.(null);
    };

    // The armed timer's callback. A newer chain may have taken over (host
    // re-armed / stopped); only the timer that is still current — identity
    // against the host's slot — may run + reschedule.
    const runArmedCycle = async (timeoutId: TimerHandle, waitMs: number, armedAtMs: number) => {
        if (!isRunning() || getTimer() !== timeoutId) {
            return;
        }
        const cycleStartMs = Date.now();
        // Say so when the timer was held far past its due time (OS
        // suspend / App Nap / hidden-page freezing). Any boundary that
        // fell inside the stall was missed, and this line is the only
        // trace of it.
        //
        // Deliberately NOT awaited: on the GUI this hook is an IPC
        // round-trip with no timeout, and this branch runs exactly when
        // the host has just proved itself unresponsive — awaiting it
        // would delay an already-late cycle for a log line. Fire it,
        // swallow a sync throw and an async rejection alike, move on.
        const lateMs = oversleptBy(waitMs, cycleStartMs - armedAtMs);
        if (lateMs > 0) {
            fireAndForget(() => log.overslept?.(lateMs, waitMs));
        }
        let cycleResult;
        try {
            cycleResult = await runCycle();
        } catch (error) {
            await log.cycleError(error);
        } finally {
            if (getTimer() === timeoutId) {
                await scheduleNext(cycleResult, cycleStartMs);
            }
        }
    };

    // Decide how long to wait before the next cycle and arm the single timer.
    const scheduleNext = async (prefetched: CycleResult = null, previousCycleStartMs: number | null = null) => {
        if (!isRunning()) {
            stopArming();
            return;
        }

        const { waitMs, cycleChallenges, cycleNow } = await decideNextWaitOrFallBack(
            decisionDeps,
            prefetched,
            previousCycleStartMs,
        );

        if (!isRunning()) {
            stopArming();
            return;
        }

        // Surface the delay to hosts that want a live next-action countdown
        // (GUI only). Optional-chained: Node hosts pass no onScheduled.
        onScheduled?.(waitMs);

        // Best-effort per-cycle notification hook. Deliberately OUTSIDE the
        // decision try/catch and never awaited: this is the exact posture of
        // log.overslept — a synchronous throw or an async rejection here
        // is swallowed so it can neither kill the loop nor trip the decision
        // fallback that would discard the boundary-aware cadence. Skipped when
        // the decision failed (the fallback carries no challenge snapshot).
        if (cycleChallenges && onCycleChallenges) {
            fireAndForget(() => onCycleChallenges(cycleChallenges, cycleNow));
        }

        const armedAtMs = Date.now();
        const timeoutId = setTimeout(() => {
            void runArmedCycle(timeoutId, waitMs, armedAtMs);
        }, waitMs);
        setTimer(timeoutId);
    };

    return { scheduleNext };
};
