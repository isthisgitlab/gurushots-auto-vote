/**
 * Shared autovote cadence chain — the recursive "decide delay → arm timer →
 * run cycle → re-arm" loop both schedulers run (runScheduler.js for
 * CLI/Android, AutovoteContext.jsx for the GUI).
 * The MATH is shared in ./thresholdWindow and ./randomDelay; this factory
 * shares the LOOP: guard ordering, fresh-settings read per cycle, prefetched
 * challenge reuse, the normal-vs-threshold wait decision, the cadence log
 * lines, the error → plain-random-cadence fallback, and the stale-timer
 * re-arm guard.
 *
 * Hosts inject transport only — how to read settings, fetch challenges,
 * resolve per-challenge values, run a cycle, store the timer handle, and emit
 * a log line — mirroring how ./nodeResolvers.js vs
 * react/contexts/autovoteScheduler.js split the per-challenge
 * resolvers by platform. CJS on purpose: required directly by the Node hosts
 * and imported by the esbuild-bundled renderer.
 */

const { getRandomCheckFrequencyMs, anchoredWaitMs, MIN_CYCLE_GAP_MS, OFFLINE_RETRY_MS } = require('./randomDelay');
const { computeNextCycleDelayMs } = require('./thresholdWindow');
const { DEFAULT_TIMEZONE } = require('../settings/uiDefaults');

/**
 * Canonical warning emitted when deciding the next delay fails and the chain
 * falls back to the plain random cadence. Exported so each host's error log
 * keeps its exact shape (the CLI logs the bare message + a debug
 * line; the GUI appends `: ${err.message}` over IPC) without re-typing it.
 */
const DECISION_ERROR_MESSAGE = 'Error computing next cycle delay; using normal cadence';

/**
 * How late a timer may fire before the chain calls it out.
 *
 * A `setTimeout` is a floor, not a promise: an OS suspend, macOS App Nap, or
 * Chromium's hidden-page throttling/freezing can hold a renderer timer for
 * tens of minutes. That is not cosmetic here — the entire "never sleep past a
 * boundary" guarantee is void for the duration, and the challenge whose
 * auto-fill or emergency window fell inside the stall closes with an empty
 * slot and NOTHING in the log to say why.
 *
 * So: report it. The floor is a minute — below that, ordinary event-loop and
 * scheduler jitter would spam the log. Above the floor a stall qualifies two
 * ways, and it needs only ONE of them:
 *
 *   - more than half the intended wait: catches a short cadence being badly
 *     overshot (1 minute late on a 1-minute last-minute cadence is the whole
 *     story), while a minute of slip on a 45-minute wait stays quiet;
 *   - OR more than OVERSLEEP_ALWAYS_MS outright, whatever the ratio. The
 *     ratio alone has a blind spot: `checkFrequencyMin/Max` are user-settable
 *     with no upper bound, so on a 30-minute cadence a 12-minute stall is only
 *     40% and would go unreported — yet 12 minutes is longer than the tightest
 *     schedule row and the whole emergency-fill window, i.e. exactly a stall
 *     that costs a deadline. Anything on that scale is worth a line no matter
 *     what it is a fraction of.
 */
const OVERSLEEP_ABSOLUTE_MS = 60_000;
const OVERSLEEP_RELATIVE = 0.5;
const OVERSLEEP_ALWAYS_MS = 5 * 60_000;

// OFFLINE_RETRY_MS (the normal-mode wait ceiling applied while the API is
// unreachable) is defined in ./randomDelay alongside the other cadence timing
// constants so the Android headless loop can share it without importing the
// chain; imported above and re-exported below for callers/tests.

const oversleptBy = (waitMs, actualMs) => {
    const lateMs = actualMs - waitMs;
    if (lateMs <= OVERSLEEP_ABSOLUTE_MS) return 0;
    return lateMs > waitMs * OVERSLEEP_RELATIVE || lateMs > OVERSLEEP_ALWAYS_MS ? lateMs : 0;
};

/**
 * The one wording for the overslept warning, shared by every host for the same
 * reason DECISION_ERROR_MESSAGE is: two hand-copied templates drift, and this
 * one is read by a user working out why a challenge closed with an empty slot.
 *
 * It follows what happened → why → what next, because it surfaces on the GUI's
 * Logs page, not just in a file. No emoji: `logger.warning` (and the GUI's
 * logWarning) already prefix one.
 *
 * @param {number} lateMs - how far past its due time the timer fired
 * @param {number} waitMs - the delay that was armed
 * @returns {string}
 */
const formatOversleptMessage = (lateMs, waitMs) =>
    `Voting cycle ran ${(lateMs / 60_000).toFixed(1)} min later than scheduled ` +
    `(waited ${(waitMs / 60_000).toFixed(1)} min) — the app was suspended or its timers were throttled, ` +
    `so any auto-submit, boost, turbo or emergency submit due in that gap did not happen. ` +
    `Keep the app window open and the device awake while challenges are near their deadline, ` +
    `or run the CLI (\`cli:start\`), which is not affected.`;

/**
 * Run a best-effort observability hook without letting it touch scheduling: a
 * synchronous throw and an async rejection are both swallowed, and the hook is
 * never awaited.
 *
 * @param {() => *} hook
 */
const fireAndForget = (hook) => {
    try {
        void Promise.resolve(hook()).catch(() => {});
    } catch {
        /* observability only — must never affect scheduling */
    }
};

/**
 * Normal-mode wait: anchored to the previous cycle's start, and — when this
 * re-arm's own fetch failed (API still down) — capped to a short retry so
 * recovery tracks reconnection, not the full (possibly very long) normal
 * cadence. Only reachable in normal mode: a failed fetch yields an empty list,
 * and an empty list never has a threshold/scheduled window to approach.
 *
 * @param {number} delayMs - the decided delay between cycle starts
 * @param {(number|null)} previousCycleStartMs
 * @param {boolean} fetchFailed
 * @returns {number}
 */
const normalWaitMs = (delayMs, previousCycleStartMs, fetchFailed) => {
    const waitMs = anchoredWaitMs(delayMs, previousCycleStartMs);
    return fetchFailed ? Math.min(waitMs, OFFLINE_RETRY_MS) : waitMs;
};

/**
 * The cadence log line for a boundary-driven (non-normal) decision.
 *
 * @param {Object} decision - computeNextCycleDelayMs result
 * @param {number} waitMs
 * @returns {string}
 */
const describeBoundaryCadence = (decision, waitMs) => {
    const inSeconds = `next cycle in ${Math.round(waitMs / 1000)}s`;
    switch (decision.mode) {
        case 'last-minute':
            return `⏰ Last-minute cadence — next cycle in ${(waitMs / 60_000).toFixed(2)} min`;
        case 'scheduled':
            return `⏰ Approaching scheduled fill for "${decision.nextScheduled?.challengeTitle}" (${decision.nextScheduled?.form}) — ${inSeconds}`;
        case 'pre-boost':
            return `⏰ Approaching pre-boost fill for "${decision.nextBoostPrefill?.challengeTitle}" — ${inSeconds} (capped to the ${decision.nextBoostPrefill?.leadMin}m pre-boost boundary)`;
        case 'currency-rule':
            return `⏰ Approaching automatic ${decision.nextCurrencyRule?.action} rule for "${decision.nextCurrencyRule?.challengeTitle}" — ${inSeconds}`;
        case 'pre-final-window':
            return `⏰ Approaching pre-final-window top-up for "${decision.nextFinalWindowTopUp?.challengeTitle}" — ${inSeconds} (capped to the ${decision.nextFinalWindowTopUp?.leadMin}m pre-final-window boundary)`;
        default:
            return `⏰ Approaching last-minute window for "${decision.nextEntry?.challengeTitle}" — ${inSeconds} (capped to the ${decision.nextEntry?.lastMinuteThreshold}m boundary)`;
    }
};

/**
 * The one decision point: read fresh settings, resolve the active list, ask
 * computeNextCycleDelayMs how long to wait, and log the cadence line. Throws on
 * any failure — the caller owns the random-cadence fallback.
 *
 * `prefetched` lets a just-completed cycle hand over the active list it
 * already fetched, so we skip a redundant fetch. A non-array
 * (null/undefined, a boolean, or a cycle that failed before fetching) falls back to a fresh fetch. In normal mode the wait is
 * anchored to the *start* of the previous cycle so the gap between cycle
 * starts ≈ the rolled delay regardless of how long the cycle took; in
 * approaching/last-minute/scheduled mode the wait runs from cycle
 * completion so the boundary is never undershot.
 *
 * @param {Object} deps - the chain's host transport (see createCadenceChain)
 * @param {*} prefetched
 * @param {(number|null)} previousCycleStartMs
 * @returns {Promise<{waitMs: number, cycleChallenges: Array, cycleNow: number}>}
 *   the wait plus the list/clock snapshot for the onCycleChallenges hook
 */
const decideNextWait = async (deps, prefetched, previousCycleStartMs) => {
    const settings = await deps.loadSettings();
    const normalDelayMs = getRandomCheckFrequencyMs(settings);
    // When no list was handed over we fetch fresh — and keep the
    // fetchFailed flag, not just the list. An outage resolves to
    // `{ challenges: [], fetchFailed: true }`, and that empty list would
    // otherwise decide a full normal-cadence wait indistinguishable from
    // "nothing to vote on". The flag lets the normal branch shorten
    // the wait so the loop re-probes soon after connectivity returns.
    const fetched = Array.isArray(prefetched) ? { challenges: prefetched } : await deps.fetchChallenges(settings);
    const challenges = fetched?.challenges || [];
    const fetchFailedNow = fetched?.fetchFailed === true;
    const now = Math.floor(Date.now() / 1000);
    const lastMinuteCheckMinutes = Number(await deps.resolveLastMinuteCheckMinutes()) || 1;

    const decision = await computeNextCycleDelayMs(challenges, now, {
        resolveThreshold: deps.resolveThreshold,
        normalDelayMs,
        lastMinuteCheckMinutes,
        minGapMs: MIN_CYCLE_GAP_MS,
        resolveScheduledFill: deps.resolveScheduledFill,
        timezone: settings.timezone || DEFAULT_TIMEZONE,
        resolveFinalWindowTopUp: deps.resolveFinalWindowTopUp,
        resolveBoostPrefill: deps.resolveBoostPrefill,
        resolveCurrencyAuto: deps.resolveCurrencyAuto,
    });

    if (decision.mode === 'normal') {
        const waitMs = normalWaitMs(decision.delayMs, previousCycleStartMs, fetchFailedNow);
        await deps.log.cadence(
            'normal',
            `Next cycle in ${(waitMs / 60_000).toFixed(2)} min (target ${(decision.delayMs / 60_000).toFixed(2)} min between starts, range ${settings.checkFrequencyMin}-${settings.checkFrequencyMax})`,
        );
        return { waitMs, cycleChallenges: challenges, cycleNow: now };
    }
    const waitMs = decision.delayMs;
    await deps.log.cadence(decision.mode, describeBoundaryCadence(decision, waitMs));
    return { waitMs, cycleChallenges: challenges, cycleNow: now };
};

/**
 * decideNextWait, degraded on failure: an error deciding the delay must never
 * kill the loop — fall back to a plain random cadence; the next cycle re-reads
 * on success. The fallback carries no challenge snapshot, so the
 * onCycleChallenges hook is skipped on EVERY decision failure — an early
 * fetch/settings throw and a late one (resolveLastMinuteCheckMinutes,
 * computeNextCycleDelayMs, the cadence log) alike.
 *
 * @param {Object} deps
 * @param {*} prefetched
 * @param {(number|null)} previousCycleStartMs
 * @returns {Promise<{waitMs: number, cycleChallenges: (Array|null), cycleNow: (number|null)}>}
 */
const decideNextWaitOrFallBack = async (deps, prefetched, previousCycleStartMs) => {
    try {
        return await decideNextWait(deps, prefetched, previousCycleStartMs);
    } catch (error) {
        await deps.log.decisionError(error);
        let waitMs;
        try {
            waitMs = getRandomCheckFrequencyMs(await deps.loadSettings());
        } catch {
            waitMs = getRandomCheckFrequencyMs({});
        }
        return { waitMs, cycleChallenges: null, cycleNow: null };
    }
};

/**
 * Create the shared cadence chain.
 *
 * @param {Object} deps - host transport
 * @param {()=>boolean} deps.isRunning - live running flag (ref-backed on React)
 * @param {()=>*} deps.getTimer - read the host's single timer-handle slot; the
 *   chain uses identity against it as the staleness guard (a host that clears
 *   or replaces the slot makes any in-flight timer/re-arm decline)
 * @param {(handle:*)=>void} deps.setTimer - store/clear the timer-handle slot
 * @param {()=>(Object|Promise<Object>)} deps.loadSettings - FRESH settings
 *   snapshot; called at the top of every decision (and again for the fallback)
 * @param {(settings:Object)=>(Object|Promise<Object>)} deps.fetchChallenges -
 *   active-challenge fetch (`{challenges, fetchFailed?}` shape) used only when
 *   no prefetched list was handed over. `fetchFailed === true` (an outage:
 *   makePostRequest resolved null after retries) shortens the next normal-mode
 *   wait to OFFLINE_RETRY_MS so the loop re-probes soon after reconnection
 *   rather than waiting out the full cadence
 * @param {()=>(number|string|Promise<number|string>)} deps.resolveLastMinuteCheckMinutes -
 *   raw global `lastMinuteCheckFrequency` value (coerced + defaulted here)
 * @param {import('./thresholdWindow').ResolveThreshold} deps.resolveThreshold -
 *   per-challenge threshold resolver for the shared math
 * @param {Function} deps.resolveScheduledFill - per-challenge scheduled-fill
 *   resolver for the shared math
 * @param {import('./thresholdWindow').ResolveFinalWindowTopUp} deps.resolveFinalWindowTopUp -
 *   per-challenge pre-final-window top-up resolver for the shared math
 * @param {import('./thresholdWindow').ResolveBoostPrefill} deps.resolveBoostPrefill -
 *   per-challenge pre-boost fill resolver for the shared math
 * @param {import('./thresholdWindow').ResolveCurrencyAuto|null} [deps.resolveCurrencyAuto] -
 *   per-challenge currency-automation timing resolver for the shared math
 * @param {()=>Promise<*>} deps.runCycle - run one voting cycle; the resolved
 *   value is handed to the next decision as the prefetched list candidate
 *   (any non-array means "fetch fresh"). A rejection is logged via
 *   `log.cycleError` and never kills the chain.
 * @param {Object} deps.log - host log adapter
 * @param {(mode:string, message:string)=>(void|Promise<void>)} deps.log.cadence -
 *   receives every cadence decision line (modes: normal / last-minute /
 *   scheduled / pre-final-window / pre-boost / approaching); a host may drop
 *   modes it never logged
 * @param {(error:*)=>(void|Promise<void>)} deps.log.decisionError - decision
 *   failure (chain falls back to the random cadence)
 * @param {(error:*)=>(void|Promise<void>)} deps.log.cycleError - a voting
 *   cycle rejected
 * @param {((lateMs:number, waitMs:number)=>(void|Promise<void>))} [deps.log.overslept] -
 *   OPTIONAL: the armed timer fired far later than it was scheduled to (OS
 *   suspend / App Nap / hidden-page throttling), so every boundary inside that
 *   stall was missed. Hosts that omit it lose only the log line.
 * @param {(waitMs:number|null)=>void} [deps.onScheduled] - OPTIONAL: called with
 *   the delay (ms) to the next armed cycle each time one is scheduled, and with
 *   null when the chain stops arming. Used by the GUI to surface a live
 *   next-action countdown; Node hosts (CLI/Android) omit it, so it is
 *   optional-chained and never required.
 * @param {(challenges:Array, now:number)=>(void|Promise<void>)} [deps.onCycleChallenges] -
 *   OPTIONAL: called once per cycle with the freshly-resolved active-challenge
 *   list and the cycle's `now` (Unix seconds), for hosts that want to react to
 *   the list without re-fetching (the OS deadline-notification layer). Invoked
 *   in its OWN isolated, never-awaited wrapper OUTSIDE the decision try/catch —
 *   a throw here must never reach the decision `catch`, whose fallback would
 *   discard the boundary-aware cadence for the cycle. Hosts that omit it lose
 *   only the notification opportunity.
 * @returns {{scheduleNext:(prefetched?:*, previousCycleStartMs?:(number|null))=>Promise<void>}}
 */
const createCadenceChain = ({
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
    runCycle,
    log,
    onScheduled,
    onCycleChallenges,
}) => {
    const decisionDeps = {
        loadSettings,
        fetchChallenges,
        resolveLastMinuteCheckMinutes,
        resolveThreshold,
        resolveScheduledFill,
        resolveFinalWindowTopUp,
        resolveBoostPrefill,
        resolveCurrencyAuto,
        log,
    };

    const stopArming = () => {
        setTimer(null);
        onScheduled?.(null);
    };

    // The armed timer's callback. A newer chain may have taken over (host
    // re-armed / stopped); only the timer that is still current — identity
    // against the host's slot — may run + reschedule.
    const runArmedCycle = async (timeoutId, waitMs, armedAtMs) => {
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
    const scheduleNext = async (prefetched = null, previousCycleStartMs = null) => {
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

module.exports = {
    createCadenceChain,
    DECISION_ERROR_MESSAGE,
    formatOversleptMessage,
    // exported for unit tests
    oversleptBy,
    OVERSLEEP_ABSOLUTE_MS,
    OVERSLEEP_ALWAYS_MS,
    OFFLINE_RETRY_MS,
};
