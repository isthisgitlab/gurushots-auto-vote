/**
 * Shared autovote cadence chain — the recursive "decide delay → arm timer →
 * run cycle → re-arm" loop that both schedulers used to duplicate line for
 * line (runScheduler.js for CLI/Android, AutovoteContext.jsx for the GUI).
 * The MATH was already shared (./thresholdWindow, ./randomDelay); this factory
 * shares the LOOP: guard ordering, fresh-settings read per cycle, prefetched
 * challenge reuse, the normal-vs-threshold wait decision, the cadence log
 * lines, the error → plain-random-cadence fallback, and the stale-timer
 * re-arm guard.
 *
 * Hosts inject transport only — how to read settings, fetch challenges,
 * resolve per-challenge values, run a cycle, store the timer handle, and emit
 * a log line — mirroring how ./nodeResolvers.js vs
 * react/contexts/autovoteScheduler.js already split the per-challenge
 * resolvers by platform. CJS on purpose: required directly by the Node hosts
 * and imported by the esbuild-bundled renderer.
 */

const { getRandomCheckFrequencyMs, anchoredWaitMs, MIN_CYCLE_GAP_MS } = require('./randomDelay');
const { computeNextCycleDelayMs } = require('./thresholdWindow');
const { DEFAULT_TIMEZONE } = require('../settings/uiDefaults');

/**
 * Canonical warning emitted when deciding the next delay fails and the chain
 * falls back to the plain random cadence. Exported so each host's error log
 * keeps its exact historical shape (the CLI logs the bare message + a debug
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
    `so any auto-fill, boost, turbo or emergency-fill due in that gap did not happen. ` +
    `Keep the app window open and the device awake while challenges are near their deadline, ` +
    `or run the CLI (\`cli:start\`), which is not affected.`;

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
 *   active-challenge fetch (`{challenges}` shape) used only when no prefetched
 *   list was handed over
 * @param {()=>(number|string|Promise<number|string>)} deps.resolveLastMinuteCheckMinutes -
 *   raw global `lastMinuteCheckFrequency` value (coerced + defaulted here)
 * @param {import('./thresholdWindow').ResolveThreshold} deps.resolveThreshold -
 *   per-challenge threshold resolver for the shared math
 * @param {Function} deps.resolveScheduledFill - per-challenge scheduled-fill
 *   resolver for the shared math
 * @param {()=>Promise<*>} deps.runCycle - run one voting cycle; the resolved
 *   value is handed to the next decision as the prefetched list candidate
 *   (any non-array means "fetch fresh"). A rejection is logged via
 *   `log.cycleError` and never kills the chain.
 * @param {Object} deps.log - host log adapter
 * @param {(mode:string, message:string)=>(void|Promise<void>)} deps.log.cadence -
 *   receives every cadence decision line (modes: normal / last-minute /
 *   scheduled / approaching); a host may drop modes it never logged
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
    runCycle,
    log,
    onScheduled,
}) => {
    // Decide how long to wait before the next cycle and arm the single timer.
    //
    // `prefetched` lets a just-completed cycle hand over the active list it
    // already fetched, so we skip a redundant fetch. A non-array
    // (null/undefined, a legacy boolean, or a cycle that failed before
    // fetching) falls back to a fresh fetch. In normal mode the wait is
    // anchored to the *start* of the previous cycle so the gap between cycle
    // starts ≈ the rolled delay regardless of how long the cycle took; in
    // approaching/last-minute/scheduled mode the wait runs from cycle
    // completion so the boundary is never undershot.
    const scheduleNext = async (prefetched = null, previousCycleStartMs = null) => {
        if (!isRunning()) {
            setTimer(null);
            onScheduled?.(null);
            return;
        }

        let waitMs;
        try {
            const settings = await loadSettings();
            const normalDelayMs = getRandomCheckFrequencyMs(settings);
            const challenges = Array.isArray(prefetched)
                ? prefetched
                : (await fetchChallenges(settings))?.challenges || [];
            const now = Math.floor(Date.now() / 1000);
            const lastMinuteCheckMinutes = Number(await resolveLastMinuteCheckMinutes()) || 1;

            const decision = await computeNextCycleDelayMs(challenges, now, {
                resolveThreshold,
                normalDelayMs,
                lastMinuteCheckMinutes,
                minGapMs: MIN_CYCLE_GAP_MS,
                resolveScheduledFill,
                timezone: settings.timezone || DEFAULT_TIMEZONE,
            });

            if (decision.mode === 'normal') {
                waitMs = anchoredWaitMs(decision.delayMs, previousCycleStartMs);
                await log.cadence(
                    'normal',
                    `Next cycle in ${(waitMs / 60_000).toFixed(2)} min (target ${(decision.delayMs / 60_000).toFixed(2)} min between starts, range ${settings.checkFrequencyMin}-${settings.checkFrequencyMax})`,
                );
            } else {
                waitMs = decision.delayMs;
                let message;
                if (decision.mode === 'last-minute') {
                    message = `⏰ Last-minute cadence — next cycle in ${(waitMs / 60_000).toFixed(2)} min`;
                } else if (decision.mode === 'scheduled') {
                    message = `⏰ Approaching scheduled fill for "${decision.nextScheduled?.challengeTitle}" (${decision.nextScheduled?.form}) — next cycle in ${Math.round(waitMs / 1000)}s`;
                } else {
                    message = `⏰ Approaching last-minute window for "${decision.nextEntry?.challengeTitle}" — next cycle in ${Math.round(waitMs / 1000)}s (capped to the ${decision.nextEntry?.lastMinuteThreshold}m boundary)`;
                }
                await log.cadence(decision.mode, message);
            }
        } catch (error) {
            // An error deciding the delay must never kill the loop — fall back
            // to a plain random cadence; the next cycle re-reads on success.
            await log.decisionError(error);
            try {
                waitMs = getRandomCheckFrequencyMs(await loadSettings());
            } catch {
                waitMs = getRandomCheckFrequencyMs({});
            }
        }

        if (!isRunning()) {
            setTimer(null);
            onScheduled?.(null);
            return;
        }

        // Surface the delay to hosts that want a live next-action countdown
        // (GUI only). Optional-chained: Node hosts pass no onScheduled.
        onScheduled?.(waitMs);

        const armedAtMs = Date.now();
        const timeoutId = setTimeout(() => {
            void (async () => {
                // A newer chain may have taken over (host re-armed / stopped);
                // only the timer that is still current may run + reschedule.
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
                    try {
                        void Promise.resolve(log.overslept?.(lateMs, waitMs)).catch(() => {});
                    } catch {
                        /* observability only */
                    }
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
            })();
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
};
